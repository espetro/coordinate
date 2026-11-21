"""Backend-agnostic before/after benchmark for fleet. Stdlib only.

Drives only the public surface (`python -m fleet enqueue|stats|daemon`) and measures from timestamps the jobs
write themselves, so the same script runs against the SQLite backend and FLEET_BACKEND=dbos.

  python bench/bench.py --tree PATH_TO_CHECKOUT [--backend sqlite|dbos] --out results.json
"""
import argparse
import json
import os
import shlex
import signal
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

CLI_OVERRIDE = None  # set from --cli: the adapter command prefix, e.g. "mytool --flag"
STAMP = "perl -MTime::HiRes=time -e 'printf \"%.3f\\n\", time'"


class Fleet:
    def __init__(self, tree: Path, backend: str, workdir: Path, cap: int, lease: float = 5):
        self.tree, self.dir = tree, workdir
        self.py = str(tree / ".venv" / "bin" / "python")
        self.cmd = shlex.split(CLI_OVERRIDE) if CLI_OVERRIDE else [self.py, "-m", "fleet"]
        env = {k: v for k, v in os.environ.items() if not k.startswith("FLEET_")}
        env.update(FLEET_DB=str(workdir / "queue.db"), FLEET_CAP=str(cap), FLEET_REPO_CAP="1",
                   FLEET_MACHINE="bench", FLEET_LEASE_S=str(lease), FLEET_CONFIG=str(workdir / "none.toml"))
        if backend == "dbos":
            env["FLEET_BACKEND"] = "dbos"
        self.env, self.daemon = env, None

    def cli(self, *args) -> str:
        r = subprocess.run([*self.cmd, *args], env=self.env, capture_output=True, text=True, cwd=self.dir)
        if r.returncode:
            raise RuntimeError(r.stderr[-400:])
        return r.stdout.strip()

    def start(self):
        log = open(self.dir / "daemon.log", "ab")
        self.daemon = subprocess.Popen([*self.cmd, "daemon"], env=self.env, cwd=self.dir,
                                       stdout=log, stderr=log, start_new_session=True)
        return self.daemon

    def stop(self, sig=signal.SIGTERM):
        if self.daemon and self.daemon.poll() is None:
            try:
                os.killpg(self.daemon.pid, sig)
            except ProcessLookupError:
                pass
            self.daemon.wait()

    def kill9(self):
        self.stop(signal.SIGKILL)

    def _group(self, col: str) -> list[str]:
        """ps column for every process in the daemon's process group (the whole resident stack,
        server plus worker; job children start their own session so they are excluded)."""
        out = subprocess.run(["ps", "-axo", f"pgid=,{col}="], capture_output=True, text=True).stdout
        return [ln.split(None, 1)[1].strip() for ln in out.splitlines()
                if ln.split(None, 1)[0] == str(self.daemon.pid) and len(ln.split(None, 1)) == 2]

    def rss_mb(self) -> float:
        return sum(int(x) for x in self._group("rss") if x.isdigit()) / 1024

    def cpu_s(self) -> float:
        total = 0.0
        for t in self._group("time"):
            s = 0.0
            for x in t.replace("-", ":").split(":"):
                s = s * 60 + float(x)
            total += s
        return total

    def enqueue(self, shell: str, repo: Path | None = None, priority: int = 0):
        repo = repo or (self.dir / "repos" / f"r{time.time_ns()}")
        repo.mkdir(parents=True, exist_ok=True)
        args = ["enqueue", "--cwd", str(repo), "--shell"]
        if priority:
            args += ["--priority", str(priority)]
        return self.cli(*args, "--", shell)


def span_cmd(log: Path, tag: str, sleep: float) -> str:
    return (f"echo s {tag} $({STAMP}) >> {log}; sleep {sleep}; echo e {tag} $({STAMP}) >> {log}")


def read_spans(log: Path):
    ev = {}
    if not log.exists():
        return ev
    for line in log.read_text().split("\n"):
        p = line.split()
        if len(p) == 3:
            ev.setdefault(p[1], {}).setdefault(p[0], []).append(float(p[2]))
    return ev


def max_concurrency(ev) -> int:
    pts = []
    for tag, e in ev.items():
        for s, en in zip(sorted(e.get("s", [])), sorted(e.get("e", []))):
            pts += [(s, 1), (en, -1)]
    cur = peak = 0
    for _, d in sorted(pts):
        cur += d
        peak = max(peak, cur)
    return peak


def wait_done(log: Path, tags: int, timeout: float) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        ev = read_spans(log)
        if sum(1 for e in ev.values() if e.get("e")) >= tags:
            return True
        time.sleep(0.1)
    return False


def scenario_cli_latency(tree, backend, tmp):
    f = Fleet(tree, backend, tmp, cap=3)
    f.start()
    time.sleep(3)  # let the daemon initialise the store
    ts = []
    for _ in range(12):
        t = time.time()
        f.enqueue("true")
        ts.append(time.time() - t)
    f.stop()
    return {"enqueue_cli_median_ms": round(statistics.median(ts[2:]) * 1000, 1),
            "enqueue_cli_p95_ms": round(sorted(ts[2:])[-2] * 1000, 1)}


def scenario_idle(tree, backend, tmp, secs=20):
    f = Fleet(tree, backend, tmp, cap=3)
    f.start()
    time.sleep(4)
    c0, t0 = f.cpu_s(), time.time()
    time.sleep(secs)
    c1, t1 = f.cpu_s(), time.time()
    rss = f.rss_mb()
    f.stop()
    return {"idle_rss_mb": round(rss, 1), "idle_cpu_pct": round((c1 - c0) / (t1 - t0) * 100, 2)}


def scenario_throughput(tree, backend, tmp, n=60, cap=6):
    f = Fleet(tree, backend, tmp, cap=cap)
    log = tmp / "spans"
    f.start()
    time.sleep(3)
    t0 = time.time()
    for i in range(n):
        f.enqueue(span_cmd(log, f"j{i}", 0))
    t_enq = time.time() - t0
    peak = 0.0
    ok = False
    end = time.time() + 180
    while time.time() < end:
        peak = max(peak, f.rss_mb())
        ev = read_spans(log)
        if sum(1 for e in ev.values() if e.get("e")) >= n:
            ok = True
            break
        time.sleep(0.25)
    makespan = time.time() - t0
    f.stop()
    return {"throughput_jobs": n, "throughput_all_done": ok, "enqueue_total_s": round(t_enq, 2),
            "throughput_makespan_s": round(makespan, 2), "throughput_jobs_per_s": round(n / makespan, 2),
            "peak_rss_mb": round(peak, 1)}


def scenario_cap(tree, backend, tmp, cap=3, sleep=1.0):
    f = Fleet(tree, backend, tmp, cap=cap)
    log = tmp / "spans"
    n = cap * 3
    f.start()
    time.sleep(3)
    t0 = time.time()
    for i in range(n):
        f.enqueue(span_cmd(log, f"j{i}", sleep))
    ok = wait_done(log, n, 90)
    makespan = time.time() - t0
    peak = max_concurrency(read_spans(log))
    f.stop()
    return {"cap": cap, "cap_jobs": n, "cap_all_done": ok, "cap_max_concurrency": peak,
            "cap_holds": peak <= cap, "cap_makespan_s": round(makespan, 2),
            "cap_ideal_s": n / cap * sleep}


def scenario_repo_contention(tree, backend, tmp):
    f = Fleet(tree, backend, tmp, cap=4)
    shared, others = tmp / "shared", [tmp / f"o{i}" for i in range(2)]
    log_s, log_o = tmp / "spans_shared", tmp / "spans_others"
    f.start()
    time.sleep(3)
    for i in range(4):
        f.enqueue(span_cmd(log_s, f"s{i}", 1.0), repo=shared)
    for i, o in enumerate(others):
        f.enqueue(span_cmd(log_o, f"o{i}", 1.0), repo=o)
    ok = wait_done(log_s, 4, 60) and wait_done(log_o, 2, 60)
    f.stop()
    return {"repo_all_done": ok, "repo_shared_max_concurrency": max_concurrency(read_spans(log_s)),
            "repo_cap_holds": max_concurrency(read_spans(log_s)) <= 1}


def scenario_priority(tree, backend, tmp):
    f = Fleet(tree, backend, tmp, cap=1)
    log = tmp / "spans"
    f.start()
    time.sleep(3)
    f.enqueue(span_cmd(log, "blocker", 25.0))
    time.sleep(1.0)
    for tag, p in (("p0", 0), ("p5", 5), ("p1", 1), ("p9", 9)):
        f.enqueue(span_cmd(log, tag, 0.3), priority=p)
    wait_done(log, 5, 90)
    ev = read_spans(log)
    order = [t for t, _ in sorted(((t, e["s"][0]) for t, e in ev.items() if t != "blocker" and e.get("s")),
                                  key=lambda x: x[1])]
    f.stop()
    return {"priority_order": order, "priority_ok": order == ["p9", "p5", "p1", "p0"]}


def scenario_chaos(tree, backend, tmp, cap=3, n=9):
    f = Fleet(tree, backend, tmp, cap=cap, lease=5)
    log = tmp / "spans"
    f.start()
    time.sleep(3)
    for i in range(n):
        f.enqueue(span_cmd(log, f"j{i}", 2.0))
    time.sleep(1.5)
    t_kill = time.time()
    f.kill9()
    f.start()
    ok = wait_done(log, n, 120)
    t_done = time.time() - t_kill
    time.sleep(2.5)  # let any duplicate attempt finish writing
    ev = read_spans(log)
    starts = {t: len(e.get("s", [])) for t, e in ev.items()}
    f.stop()
    return {"chaos_all_done": ok, "chaos_recovery_to_all_done_s": round(t_done, 2),
            "chaos_total_executions": sum(starts.values()),
            "chaos_duplicated_jobs": sum(1 for v in starts.values() if v > 1)}


def scenario_tool_park(tree, backend, tmp):
    """Two vitest-class jobs on one project (cost 2, limit 2): second must park; does a trivial job still run
    while it is parked at cap 2?"""
    f = Fleet(tree, backend, tmp, cap=2)
    cfg = tmp / "none.toml"
    cfg.write_text("[slots]\n'tool:vitest:*' = 2\n")
    proj = tmp / "proj"
    (proj / ".git").mkdir(parents=True)
    bindir = tmp / "bin"
    bindir.mkdir()
    log = tmp / "spans"
    v = bindir / "vitest"
    v.write_text(f"#!/bin/sh\necho s $1 $({STAMP}) >> {log}\nsleep 2\necho e $1 $({STAMP}) >> {log}\n")
    v.chmod(0o755)
    f.env["PATH"] = f"{bindir}:{f.env.get('PATH', '')}"
    f.start()
    time.sleep(3)
    f.enqueue("vitest v1", repo=proj)
    f.enqueue("vitest v2", repo=proj)
    time.sleep(0.5)
    f.enqueue(span_cmd(log, "trivial", 0.2))
    ok = wait_done(log, 3, 40)
    ev = read_spans(log)
    f.stop()
    v_conc = max_concurrency({k: e for k, e in ev.items() if k.startswith("v")})
    triv_start = (ev.get("trivial", {}).get("s") or [None])[0]
    v1_end = (ev.get("v1", {}).get("e") or [None])[0]
    return {"tool_all_done": ok, "tool_vitest_max_concurrency": v_conc, "tool_cap_holds": v_conc <= 1,
            "tool_trivial_ran_while_parked": bool(triv_start and v1_end and triv_start < v1_end)}


SCENARIOS = {"cli": scenario_cli_latency, "idle": scenario_idle, "throughput": scenario_throughput,
             "cap": scenario_cap, "repo": scenario_repo_contention, "priority": scenario_priority,
             "chaos": scenario_chaos, "toolpark": scenario_tool_park}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tree", default=".")
    ap.add_argument("--cli", default=None, help="adapter command prefix replacing `python -m fleet` (see docs/tool-search-rubric.md)")
    ap.add_argument("--backend", default="sqlite", choices=["sqlite", "dbos"])
    ap.add_argument("--only", default=",".join(SCENARIOS))
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    global CLI_OVERRIDE
    CLI_OVERRIDE = a.cli
    tree = Path(a.tree).resolve()
    res = {"backend": a.backend, "tree": str(tree)}
    for name in a.only.split(","):
        with tempfile.TemporaryDirectory(prefix=f"fleetbench-{name}-") as t:
            t0 = time.time()
            try:
                res.update(SCENARIOS[name](tree, a.backend, Path(t)))
            except Exception as e:  # keep going, record the failure
                res[f"{name}_error"] = repr(e)[:300]
            print(f"[{a.backend}] {name} done in {time.time() - t0:.1f}s", file=sys.stderr, flush=True)
    Path(a.out).write_text(json.dumps(res, indent=2))
    print(json.dumps(res, indent=2))


if __name__ == "__main__":
    main()
