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


def _stat_block(vals) -> dict:
    """mean, stdev, min, max and coefficient of variation (percent) for one metric."""
    xs = [float(v) for v in vals]
    mean = statistics.mean(xs)
    sd = statistics.stdev(xs) if len(xs) > 1 else 0.0
    return {"mean": round(mean, 3), "stdev": round(sd, 3), "min": round(min(xs), 3),
            "max": round(max(xs), 3), "cv_pct": round(sd / mean * 100, 2) if mean else None,
            "n": len(xs)}


def scenario_noise_floor(tree, backend, tmp, repeats=10, subset=None):
    """Repeat a chosen subset of the existing scenarios N times and report the spread of every metric.

    Only the metrics of the repeated scenarios change; existing scenario semantics are untouched.
    Each repeat runs in its own temporary directory, so each repeat starts from a fresh store.
    """
    names = [n.strip() for n in (subset or "").split(",") if n.strip()]
    names = names or ["cli", "cap", "chaos"]
    for n in names:
        if n not in SCENARIOS:
            raise ValueError(f"unknown scenario for the noise floor: {n}")
    out = {"noise_repeats": repeats, "noise_scenarios": names, "noise_per_scenario": {}}
    for name in names:
        runs = []
        for i in range(repeats):
            with tempfile.TemporaryDirectory(prefix=f"fleetnoise-{name}-") as t:
                try:
                    runs.append(SCENARIOS[name](tree, backend, Path(t)))
                except Exception as e:  # a failed repeat still counts as a sample
                    runs.append({"_error": repr(e)[:200]})
            print(f"[noise] {name} repeat {i + 1}/{repeats} done", file=sys.stderr, flush=True)
        keys = sorted({k for r in runs for k, v in r.items() if isinstance(v, (int, float)) and not isinstance(v, bool)})
        metrics = {k: _stat_block([r[k] for r in runs if k in r]) for k in keys}
        bools = {k: _stat_block([1 if r.get(k) else 0 for r in runs]) for k in sorted(
            {k for r in runs for k, v in r.items() if isinstance(v, bool)})}
        out["noise_per_scenario"][name] = {"metrics": metrics, "bools": bools,
                                           "errors": sum(1 for r in runs if "_error" in r)}
    return out


def _acp_registry(tree: Path, tmp: Path) -> str:
    """Registry file for the stub ACP agent, used by fleet's ACP job path."""
    reg = tmp / "agents.stub.json"
    reg.write_text(json.dumps({"stub": {"command": str(tree / ".venv" / "bin" / "python"),
                                         "args": [str(Path(__file__).parent / "stub_acp_agent.py")]}}))
    return str(reg)


def _acp_fleet(tree: Path, backend: str, tmp: Path, cap: int, lease: float = 5) -> Fleet:
    """A fleet instance whose ACP lane runs the bench's stub agent through bench/acp_client.py.

    No change to fleet's adapter contract is needed: FLEET_ACP_CMD already selects the ACP
    command, so the bench points it at the stdlib client instead of fleet-acp.
    """
    f = Fleet(tree, backend, tmp, cap=cap, lease=lease)
    f.env["FLEET_ACP_CMD"] = f"{tree / '.venv' / 'bin' / 'python'} {Path(__file__).parent / 'acp_client.py'}"
    return f


def _agent_pids(db: Path) -> dict[int, int]:
    """job id -> agent pid, from the pid files fleet's daemon writes next to the store."""
    pids = {}
    pdir = db.parent / "pids"
    if pdir.is_dir():
        for pf in pdir.glob("*.agent"):
            try:
                pids[int(pf.stem)] = int(pf.read_text().strip())
            except (OSError, ValueError):
                pass
    return pids


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def _rss_kb(pid: int) -> int:
    try:
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True).stdout
        return int(out.strip() or 0)
    except ValueError:
        return 0


def scenario_orchestrator_kill(tree, backend, tmp, k=3, turn_ms=20000, lease=4):
    """K stub ACP sessions through fleet; kill -9 the daemon group mid-turn; restart; every session must complete.

    Counts duplicate turns (the stub records completed turns per session in its state file),
    sessions resumed through ACP session/load (same session id across two agent processes)
    and sessions that were restarted from scratch (a new session id).
    """
    reg = _acp_registry(tree, tmp)
    f = _acp_fleet(tree, backend, tmp, cap=max(k, 1), lease=lease)
    f.env["STUB_TURN_MS"] = str(turn_ms)
    f.env["STUB_CHUNKS"] = "20"
    log = tmp / "acp.log"
    f.start()
    time.sleep(3)
    jids = []
    for i in range(k):
        repo = tmp / f"job{i}"
        repo.mkdir(parents=True, exist_ok=True)
        jids.append(int(f.cli("enqueue", "--acp", "stub", "--cwd", str(repo), "--prompt", f"turn {i}",
                              "--registry", reg)))
    # wait until every agent process exists (session id persisted in the payload)
    deadline = time.time() + 60
    sessions = {}
    while time.time() < deadline and len(sessions) < k:
        for jid in jids:
            if jid in sessions:
                continue
            st = json.loads(f.cli("status", str(jid)))
            payload = json.loads(st["payload"]) if isinstance(st["payload"], str) else (st["payload"] or {})
            if payload.get("session"):
                sessions[jid] = payload["session"]
        time.sleep(0.2)
    pids = _agent_pids(Path(f.env["FLEET_DB"]))
    alive_before = sum(1 for p in pids.values() if _alive(p))
    t_kill = time.time()
    f.kill9()
    time.sleep(0.3)
    alive_after_kill = sum(1 for p in pids.values() if _alive(p))
    f.start()
    # wait for every job to reach a terminal state
    done = 0
    deadline = time.time() + 180
    while time.time() < deadline:
        done = sum(1 for jid in jids if json.loads(f.cli("status", str(jid)))["status"] in ("done", "failed"))
        if done == k:
            break
        time.sleep(0.5)
    recovery = time.time() - t_kill
    dup = resumed = restarted = 0
    per_job = []
    for i, jid in enumerate(jids):
        st = json.loads(f.cli("status", str(jid)))
        sf = tmp / f"job{i}" / ".stub-acp-sessions.json"
        sid = None
        rec = {}
        if sf.exists():
            recs = json.loads(sf.read_text())["sessions"]
            if recs:
                sid = next(iter(recs))
                rec = recs[sid]
        stored = (json.loads(st["payload"]) if isinstance(st["payload"], str) else (st["payload"] or {})).get("session")
        # turns_started counts every attempt (completed or not), so a killed mid-turn
        # attempt counts as a duplicate even though no second end_turn was recorded
        dup += max(0, rec.get("turns_started", 0) - 1)
        if st["attempts"] > 1 and stored and stored == sid and rec.get("loads", 0) > 0:
            resumed += 1
        elif st["attempts"] > 1:
            restarted += 1
        per_job.append({"job": jid, "status": st["status"], "attempts": st["attempts"],
                        "session_id": sid, "payload_session": stored,
                        "turns_started": rec.get("turns_started", 0), "turns_done": rec.get("turns_done", 0),
                        "loads": rec.get("loads", 0)})
    f.stop()
    return {"orchkill_jobs": k, "orchkill_all_done": done == k, "orchkill_done": done,
            "orchkill_recovery_s": round(recovery, 2),
            "orchkill_agents_alive_before_kill": alive_before, "orchkill_agents_alive_after_kill": alive_after_kill,
            "orchkill_duplicate_turns": dup, "orchkill_resumed_via_session_load": resumed,
            "orchkill_restarted": restarted, "orchkill_per_job": per_job}


def scenario_live_density(tree, backend, tmp, steps=(1, 2, 4), ballast_mb=60, turn_ms=60000):
    """Step up concurrent stub ACP sessions at a fixed ballast; report orchestrator RSS apart from agent RSS.

    Fixed overhead is the orchestrator RSS with no live session; agent RSS is the sum over the
    live agent processes (each holding `ballast_mb` MiB of ballast plus its interpreter).
    """
    reg = _acp_registry(tree, tmp)
    steps = list(steps)
    f = _acp_fleet(tree, backend, tmp, cap=max(steps), lease=120)
    f.env["STUB_BALLAST_MB"] = str(ballast_mb)
    f.env["STUB_TURN_MS"] = str(turn_ms)
    f.env["STUB_CHUNKS"] = "200"
    f.start()
    time.sleep(4)
    overhead = f.rss_mb()
    out = {"density_ballast_mb": ballast_mb, "density_fixed_overhead_mb": round(overhead, 1),
           "density_fixed_overhead_host": _host_state(), "density_steps": []}
    for n in steps:
        repos = []
        for i in range(n):
            r = tmp / f"live{n}_{i}"
            r.mkdir(parents=True, exist_ok=True)
            repos.append(r)
        for r in repos:
            f.cli("enqueue", "--acp", "stub", "--cwd", str(r), "--prompt", "hold", "--registry", reg)
        # wait until all n agents are live
        deadline = time.time() + 120
        pids = []
        while time.time() < deadline:
            pids = [p for p in _agent_pids(Path(f.env["FLEET_DB"])).values() if _alive(p)]
            if len(pids) >= n:
                break
            time.sleep(0.3)
        time.sleep(2)
        orch = f.rss_mb()
        agent_total = sum(_rss_kb(p) for p in pids) / 1024
        per_session = agent_total / n if n else None
        out["density_steps"].append({
            "live_sessions": n, "orchestrator_rss_mb": round(orch, 1),
            "agent_rss_total_mb": round(agent_total, 1),
            "agent_rss_per_session_mb": round(per_session, 1) if per_session else None,
            "total_rss_mb": round(orch + agent_total, 1),
            "live_sessions_per_gib_agents": round(1024 / per_session, 1) if per_session else None,
            "host": _host_state(),
        })
        # let this step's turns finish and the agents exit before the next step
        deadline = time.time() + turn_ms / 1000 + 60
        while time.time() < deadline:
            if not any(_alive(p) for p in pids):
                break
            time.sleep(0.5)
    f.stop()
    return out


SCENARIOS = {"cli": scenario_cli_latency, "idle": scenario_idle, "throughput": scenario_throughput,
             "cap": scenario_cap, "repo": scenario_repo_contention, "priority": scenario_priority,
             "chaos": scenario_chaos, "toolpark": scenario_tool_park,
             "orchestrator-kill": scenario_orchestrator_kill, "live-density": scenario_live_density,
             "noise-floor": scenario_noise_floor}


def _host_state() -> dict:
    """Machine state next to RSS measurements (the VPS is shared with other spike sessions)."""
    load1, load5, load15 = os.getloadavg()
    mem = {}
    try:
        for line in open("/proc/meminfo"):
            k, v = line.split(":", 1)
            if k in ("MemTotal", "MemAvailable"):
                mem[k] = int(v.strip().split()[0]) // 1024
    except OSError:
        pass
    return {"load_1m": round(load1, 2), "load_5m": round(load5, 2), "load_15m": round(load15, 2),
            "mem_total_mb": mem.get("MemTotal"), "mem_available_mb": mem.get("MemAvailable"),
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tree", default=".")
    ap.add_argument("--cli", default=None, help="adapter command prefix replacing `python -m fleet` (see docs/tool-search-rubric.md)")
    ap.add_argument("--backend", default="sqlite", choices=["sqlite", "dbos"])
    ap.add_argument("--only", default=",".join(SCENARIOS))
    ap.add_argument("--out", required=True)
    ap.add_argument("--repeats", type=int, default=10, help="noise-floor: repeats per scenario")
    ap.add_argument("--noise-scenarios", default=None, help="noise-floor: comma separated subset of scenarios")
    a = ap.parse_args()
    global CLI_OVERRIDE
    CLI_OVERRIDE = a.cli
    tree = Path(a.tree).resolve()
    res = {"backend": a.backend, "tree": str(tree), "host": _host_state()}
    for name in a.only.split(","):
        if name not in SCENARIOS:
            raise SystemExit(f"unknown scenario {name}; known: {', '.join(SCENARIOS)}")
        with tempfile.TemporaryDirectory(prefix=f"fleetbench-{name}-") as t:
            t0 = time.time()
            try:
                if name == "noise-floor":
                    res.update(SCENARIOS[name](tree, a.backend, Path(t), repeats=a.repeats,
                                             subset=a.noise_scenarios))
                else:
                    res.update(SCENARIOS[name](tree, a.backend, Path(t)))
            except Exception as e:  # keep going, record the failure
                res[f"{name}_error"] = repr(e)[:300]
            print(f"[{a.backend}] {name} done in {time.time() - t0:.1f}s", file=sys.stderr, flush=True)
    Path(a.out).write_text(json.dumps(res, indent=2))
    print(json.dumps(res, indent=2))


if __name__ == "__main__":
    main()
