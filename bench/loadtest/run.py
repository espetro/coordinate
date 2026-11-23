#!/usr/bin/env python3
"""Fleet load test harness: how many sessions does a machine handle, and does the queue manage overload.

    uv run python bench/loadtest/run.py --cap 2 --mult 3 --agent opencode --out /tmp/lt-out
    uv run python bench/loadtest/run.py --cap 2 --skip-acp        # cmd-only smoke, no LLM calls
    uv run python bench/loadtest/run.py --cap 2 --fake-acp        # acp scenarios against a zero-token stub

Everything runs in a throwaway temp dir with its own COORDINATE_DB, COORDINATE_ACP_HOME, git repos and daemon subprocess.
The real service, the real queue and ~/Documents are never touched. Stdlib only, macOS and Linux.
"""
import argparse
import atexit
import json
import math
import os
import platform
import re
import shlex
import shutil
import signal
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from collections import namedtuple
from pathlib import Path

HERE = Path(__file__).resolve().parent
COORDINATE_ROOT = HERE.parent.parent
SCENARIOS = ["overload", "contention", "priority", "failure", "cancel", "park", "chaos"]
ACP_ONLY = {"failure", "cancel", "park"}
TERMINAL = ("done", "failed", "dead")
TASK_PROMPT = ("Do these two steps in order, each as its own separate foreground shell command, never in the "
               "background. Step 1: run \"echo hello > hello.txt\". Step 2: run \"git add -A && git commit -m "
               "'loadtest: add hello'\". Never push. Reply DONE when finished.")
LONG_PROMPT = ("Run this as one foreground shell command and wait for it to finish: \"sleep 300\". "
               "Then reply DONE. Never run anything in the background.")
PARK_PROMPT = ("Do these steps in order, each as its own separate foreground shell command, never in the "
               "background. Step 1: run \"sleep 20\". Step 2: run \"echo hello > hello.txt && git add -A && "
               "git commit -m 'loadtest: add hello'\". Never push. Reply DONE when finished.")

P = namedtuple("P", "pid ppid pgid stat rss cpu cmd")


class Timebox(Exception):
    pass


# ---------------------------------------------------------------- system probes

def ps_table() -> dict:
    """pid -> P, from portable `ps` columns. rss is bytes, cpu is ps' %cpu (a decayed average, not instant)."""
    out = subprocess.run(["ps", "-axo", "pid=,ppid=,pgid=,stat=,rss=,pcpu=,command="],
                         capture_output=True, text=True).stdout
    t = {}
    for line in out.splitlines():
        f = line.split(None, 6)
        if len(f) < 6:
            continue
        try:
            t[int(f[0])] = P(int(f[0]), int(f[1]), int(f[2]), f[3], int(f[4]) * 1024, float(f[5]),
                             f[6] if len(f) > 6 else "")
        except ValueError:
            continue
    return t


def alive(table, pid) -> bool:
    return pid in table and not table[pid].stat.startswith("Z")


def descendants(table, roots) -> set:
    kids = {}
    for p in table.values():
        kids.setdefault(p.ppid, []).append(p.pid)
    seen, stack = set(), [r for r in roots if r in table]
    while stack:
        pid = stack.pop()
        if pid not in seen:
            seen.add(pid)
            stack.extend(kids.get(pid, []))
    return seen


def mem_bytes() -> tuple[int, int]:
    """(total, available) bytes. macOS: vm_stat free+inactive+speculative. Linux: MemAvailable."""
    if sys.platform == "darwin":
        out = subprocess.run(["vm_stat"], capture_output=True, text=True).stdout
        page = int(re.search(r"page size of (\d+)", out).group(1))
        pages = {k.strip(): int(v) for k, v in re.findall(r"^Pages ([^:]+):\s+(\d+)\.", out, re.M)}
        total = int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True).stdout)
        return total, (pages.get("free", 0) + pages.get("inactive", 0) + pages.get("speculative", 0)) * page
    info = {}
    with open("/proc/meminfo") as f:
        for line in f:
            k, v = line.split(":", 1)
            info[k] = int(v.split()[0]) * 1024
    return info["MemTotal"], info.get("MemAvailable", info.get("MemFree", 0))


def killpg(pg) -> None:
    if pg and pg > 1 and pg != os.getpgrp():
        try:
            os.killpg(pg, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass


def kill(pid) -> None:
    if pid and pid > 1 and pid != os.getpid():
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass


def mb(x) -> float:
    return round(x / 1048576, 1)


def stats(xs) -> dict:
    xs = sorted(xs)
    if not xs:
        return {"n": 0}
    return {"n": len(xs), "min": round(xs[0], 2), "p50": round(statistics.median(xs), 2),
            "p90": round(xs[min(len(xs) - 1, int(len(xs) * 0.9))], 2), "max": round(xs[-1], 2),
            "mean": round(statistics.fmean(xs), 2)}


def wait_for(pred, timeout, what, step=0.2):
    end = time.time() + timeout
    while time.time() < end:
        v = pred()
        if v:
            return v
        time.sleep(step)
    raise TimeoutError(f"timeout after {timeout:.0f}s waiting for {what}")


# ---------------------------------------------------------------- context and sandbox

class Ctx:
    def __init__(self, args):
        self.args = args
        self.cap, self.mult, self.agent = args.cap, args.mult, args.agent
        self.root = Path(os.path.realpath(tempfile.mkdtemp(prefix="fleet-loadtest-")))
        self.acp_home = self.root / "acp-home"
        self.acp_home.mkdir()
        self.sandboxes: list = []
        self.deadline = time.time() + args.timeout
        self.acp_cmd, self.acp_dir = self._resolve_acp()

    def dispose(self, out: Path) -> None:
        """Kill everything a scenario started, keep its daemon log, delete its temp dir."""
        for sb in self.sandboxes:
            sb.teardown()
            if (sb.dir / "daemon.log").exists():
                shutil.copy(sb.dir / "daemon.log", out / f"{sb.name}.daemon.log")
            shutil.rmtree(sb.dir, ignore_errors=True)
        self.sandboxes.clear()

    def remaining(self) -> float:
        return max(1.0, self.deadline - time.time())

    def _resolve_acp(self):
        a = self.args
        acp_dir = Path(a.acp_dir or os.environ.get("COORDINATE_ACP_DIR") or COORDINATE_ROOT.parent / "fleet-acp")
        if a.fake_acp:
            return f"{shlex.quote(sys.executable)} {shlex.quote(str(HERE / 'fake_acp.py'))}", None
        if os.environ.get("COORDINATE_ACP_CMD"):
            return os.environ["COORDINATE_ACP_CMD"], acp_dir
        js = acp_dir / "bin" / "fleet-acp.js"
        if js.exists() and shutil.which("node"):
            return f"node {shlex.quote(str(js))}", acp_dir
        if shutil.which("fleet-acp"):
            return "fleet-acp", acp_dir
        return None, acp_dir

    def registry(self, name, mutate=None) -> str:
        """Write a registry copy (agents.json with ${root} resolved) and return its path."""
        base = {}
        if self.acp_dir and (self.acp_dir / "agents.json").exists() and not self.args.fake_acp:
            text = (self.acp_dir / "agents.json").read_text().replace("${root}", str(self.acp_dir))
            base = json.loads(text)
        base.setdefault(self.agent, {"command": "sleep" if self.args.fake_acp else self.agent, "args": []})
        if self.args.model:
            base[self.agent]["model"] = self.args.model
        if mutate:
            mutate(base[self.agent])
        path = self.root / "registries" / f"{name}.json"
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(base))
        return str(path)


class Sandbox:
    """One scenario's private world: own queue DB, pid dir, repos and daemon."""

    def __init__(self, ctx: Ctx, name, cap, lease=30):
        self.ctx, self.name, self.cap, self.lease = ctx, name, cap, lease
        self.dir = ctx.root / name
        self.dir.mkdir()
        self.db = self.dir / "queue.db"
        env = {k: v for k, v in os.environ.items() if not k.startswith("COORDINATE_")}
        env.update(COORDINATE_DB=str(self.db), COORDINATE_CAP=str(cap), COORDINATE_LEASE_S=str(lease), COORDINATE_MACHINE="loadtest",
                   COORDINATE_REPO_CAP="1", COORDINATE_ACP_HOME=str(ctx.acp_home),
                   PYTHONPATH=os.pathsep.join(filter(None, [str(COORDINATE_ROOT / "src"), os.environ.get("PYTHONPATH")])))
        if ctx.acp_cmd:
            env["COORDINATE_ACP_CMD"] = ctx.acp_cmd
        self.env = env
        self.daemon: subprocess.Popen | None = None
        self.known_pgids: set[int] = set()
        self.extra_kill: set[int] = set()
        self.repos = 0
        ctx.sandboxes.append(self)

    # fleet CLI (black box, same path a user takes)
    def fleet(self, *args) -> str:
        r = subprocess.run([sys.executable, "-m", "fleet", *args], env=self.env, capture_output=True, text=True)
        if r.returncode:
            raise RuntimeError(f"fleet {' '.join(args)} failed: {r.stderr.strip() or r.stdout.strip()}")
        return r.stdout.strip()

    def make_repo(self) -> str:
        self.repos += 1
        repo = self.dir / "repos" / f"r{self.repos}"
        repo.mkdir(parents=True)
        for cmd in (["init", "-q", "-b", "main"], ["config", "user.name", "loadtest"],
                    ["config", "user.email", "loadtest@example.invalid"]):
            subprocess.run(["git", "-C", str(repo), *cmd], check=True, capture_output=True)
        (repo / "README.md").write_text("loadtest\n")
        subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-q", "-m", "init"], check=True, capture_output=True)
        return str(repo)

    def enqueue_cmd(self, repo, argv, priority=0) -> int:
        return int(self.fleet("enqueue", "--cwd", repo, "--priority", str(priority), "--", *argv))

    def enqueue_acp(self, repo, prompt, registry=None, priority=0) -> int:
        a = ["enqueue", "--acp", self.ctx.agent, "--cwd", repo, "--prompt", prompt, "--priority", str(priority)]
        if registry:
            a += ["--registry", registry]
        return int(self.fleet(*a))

    def rows(self) -> dict:
        c = sqlite3.connect(self.db, timeout=5)
        try:
            cur = c.execute("SELECT id,status,attempts,lease_expires_at,pgid,pidfile,priority,waiting_on,payload "
                            "FROM jobs ORDER BY id")
            out = {}
            for r in cur:
                out[r[0]] = dict(id=r[0], status=r[1], attempts=r[2], lease=r[3], pgid=r[4], pidfile=r[5],
                                 priority=r[6], waiting_on=r[7], payload=json.loads(r[8]))
            return out
        except sqlite3.OperationalError:
            return {}
        finally:
            c.close()

    def row(self, jid):
        return self.rows().get(jid)

    def slots(self) -> int:
        c = sqlite3.connect(self.db, timeout=5)
        try:
            return c.execute("SELECT COUNT(*) FROM concurrency_slots").fetchone()[0]
        finally:
            c.close()

    def start_daemon(self) -> None:
        log = open(self.dir / "daemon.log", "ab")
        self.daemon = subprocess.Popen([sys.executable, "-m", "fleet", "daemon"], env=self.env, stdout=log,
                                       stderr=log, start_new_session=True)

    def kill_daemon(self, sig=signal.SIGKILL) -> None:
        if self.daemon and self.daemon.poll() is None:
            os.kill(self.daemon.pid, sig)
            self.daemon.wait()

    def teardown(self) -> None:
        self.kill_daemon()
        table = ps_table()
        marker = str(self.dir)
        for j in self.rows().values():
            self.known_pgids.add(j["pgid"] or 0)
            if j["pidfile"]:
                self._kill_pidfile(j["pidfile"])
        for f in (self.dir / "pids").glob("*.agent") if (self.dir / "pids").exists() else []:
            self._kill_pidfile(str(f))
        for pg in self.known_pgids | self.extra_kill:
            killpg(pg)
            kill(pg)
        for p in table.values():
            if marker in p.cmd:
                killpg(p.pgid)
                kill(p.pid)

    @staticmethod
    def _kill_pidfile(path):
        try:
            pid = int(Path(path).read_text().strip())
            killpg(pid)
            kill(pid)
        except (OSError, ValueError):
            pass


# ---------------------------------------------------------------- monitor

class Monitor(threading.Thread):
    """Samples the queue DB every 0.2s and ps/memory every 1s while a scenario runs."""

    def __init__(self, sb: Sandbox):
        super().__init__(daemon=True)
        self.sb, self.cap = sb, sb.cap
        self.stop_ev = threading.Event()
        self.enq: dict[int, float] = {}
        self.ev: dict[int, dict] = {}
        self.series: list[dict] = []
        self.max_live, self.violations = 0, []
        self.max_repo_live: dict[str, int] = {}
        self.max_procs = 0
        self.job_peak: dict[int, dict] = {}
        self.peak_total_rss = self.peak_cpu = self.peak_load = 0.0
        self.peak_per_conc = 0.0
        self.min_free = None
        self.max_queued = 0
        self.error = None
        self._last_ps = 0.0
        self.t0 = time.time()
        total, avail = mem_bytes()
        self.mem_total, self.baseline_free = total, avail
        self.idle_daemon_rss = None

    def run(self):
        while not self.stop_ev.is_set():
            try:
                self._tick()
            except Exception:  # keep sampling; surface the first error in the results
                self.error = self.error or traceback.format_exc()
            time.sleep(0.2)

    def _tick(self):
        now = time.time()
        rows = self.sb.rows()
        live = [r for r in rows.values() if r["status"] == "running" and r["lease"] and r["lease"] > now]
        self.max_live = max(self.max_live, len(live))
        if len(live) > self.cap:
            self.violations.append((round(now, 2), len(live)))
        per_repo: dict[str, int] = {}
        for r in live:
            repo = r["payload"].get("repo") or r["payload"].get("cwd") or ""
            per_repo[repo] = per_repo.get(repo, 0) + 1
        for repo, n in per_repo.items():
            self.max_repo_live[repo] = max(self.max_repo_live.get(repo, 0), n)
        for r in rows.values():
            e = self.ev.setdefault(r["id"], {"starts": [], "end": None, "final": None})
            if r["status"] == "running" and r["lease"] and (not e["starts"] or e["starts"][-1][0] != r["attempts"]):
                e["starts"].append((r["attempts"], min(now, r["lease"] - self.sb.lease)))  # claim time, exact
            if r["status"] in TERMINAL and e["end"] is None:
                e["end"], e["final"] = now, r["status"]
            if r["pgid"]:
                self.sb.known_pgids.add(r["pgid"])
        queued = sum(r["status"] == "queued" for r in rows.values())
        self.max_queued = max(self.max_queued, queued)
        if now - self._last_ps < 1.0:
            return
        self._last_ps = now
        table = ps_table()
        d = self.sb.daemon
        dpid = d.pid if d and d.poll() is None else None
        tree = descendants(table, [dpid]) if dpid else set()
        total_rss = sum(table[p].rss for p in tree)
        cpu = sum(table[p].cpu for p in tree)
        daemon_rss = table[dpid].rss if dpid in table else 0
        if self.idle_daemon_rss is None and daemon_rss:
            self.idle_daemon_rss = daemon_rss
        agents_rss = 0
        conc = 0
        for r in live:
            if r["pgid"] and alive(table, r["pgid"]):
                sub = descendants(table, [r["pgid"]])
                rss = sum(table[p].rss for p in sub)
                c = sum(table[p].cpu for p in sub)
                pk = self.job_peak.setdefault(r["id"], {"rss": 0, "cpu": 0.0, "procs": 0})
                pk["rss"], pk["cpu"], pk["procs"] = max(pk["rss"], rss), max(pk["cpu"], c), max(pk["procs"], len(sub))
                agents_rss += rss
                conc += 1
        if conc:
            self.peak_per_conc = max(self.peak_per_conc, agents_rss / conc)
        procs = sum(alive(table, pg) for pg in self.sb.known_pgids if pg > 1)
        self.max_procs = max(self.max_procs, procs)
        _, free = mem_bytes()
        load1 = os.getloadavg()[0]
        self.min_free = free if self.min_free is None else min(self.min_free, free)
        self.peak_total_rss = max(self.peak_total_rss, total_rss)
        self.peak_cpu = max(self.peak_cpu, cpu)
        self.peak_load = max(self.peak_load, load1)
        self.series.append({"t": round(now - self.t0, 1), "live": len(live), "queued": queued, "procs": procs, "rss_mb": mb(total_rss),
                            "cpu": round(cpu, 1), "load1": round(load1, 2), "free_mb": mb(free)})

    def finish(self) -> dict:
        self.stop_ev.set()
        self.join(timeout=5)
        return self.summary()

    def claim_ts(self, jid, attempt=1):
        for a, ts in self.ev.get(jid, {}).get("starts", []):
            if a == attempt:
                return ts
        return None

    def latencies(self, jids) -> list[float]:
        return [self.claim_ts(j) - self.enq[j] for j in jids if self.claim_ts(j) and j in self.enq]

    def summary(self) -> dict:
        peaks = [v["rss"] for v in self.job_peak.values()]
        return {"max_live": self.max_live, "cap_violations": self.violations, "max_queued": self.max_queued,
                "max_actual_job_procs": self.max_procs, "peak_total_rss_mb": mb(self.peak_total_rss),
                "peak_cpu_pct_sum": round(self.peak_cpu, 1), "peak_load1": round(self.peak_load, 2),
                "idle_daemon_rss_mb": mb(self.idle_daemon_rss or 0), "baseline_free_mb": mb(self.baseline_free),
                "min_free_mb": mb(self.min_free or 0), "mem_total_mb": mb(self.mem_total),
                "per_agent_peak_rss_mb": {"max": mb(max(peaks, default=0)),
                                          "mean": mb(statistics.fmean(peaks)) if peaks else 0.0},
                "peak_rss_per_concurrent_agent_mb": mb(self.peak_per_conc), "monitor_error": self.error}


# ---------------------------------------------------------------- result helpers

class Res:
    def __init__(self):
        self.metrics, self.checks, self.notes, self.headline, self.skipped = {}, [], [], "", None

    def check(self, name, ok, detail="", warn=False):
        self.checks.append({"name": name, "ok": bool(ok), "warn": warn, "detail": str(detail)})

    def status(self):
        if self.skipped:
            return "skip"
        return "fail" if any(not c["ok"] and not c["warn"] for c in self.checks) else "pass"


def wait_terminal(sb, jids, what, timeout):
    jids = list(jids)
    return wait_for(lambda: all((sb.row(j) or {}).get("status") in TERMINAL for j in jids), timeout, what, 0.3)


def extrapolate(m: dict) -> dict:
    per = max(m["per_agent_peak_rss_mb"]["max"], m["peak_rss_per_concurrent_agent_mb"])
    if per <= 0:
        return {"note": "no per-agent RSS observed"}
    budget = m["baseline_free_mb"] * 0.7
    return {"per_agent_rss_mb": per, "free_mb_before": m["baseline_free_mb"], "headroom": 0.30,
            "budget_mb": round(budget, 1), "safe_cap_by_memory": int(budget // per)}


# ---------------------------------------------------------------- scenarios

def sc_overload(ctx: Ctx, res: Res):
    mixes = ["cmd"] + ([] if ctx.args.skip_acp else ["acp"])
    n = ctx.mult * ctx.cap
    res.metrics["mixes"] = {}
    for mix in mixes:
        sb = Sandbox(ctx, f"overload-{mix}", ctx.cap)
        repos = [sb.make_repo() for _ in range(n)]
        registry = ctx.registry(f"overload-{mix}") if mix == "acp" else None
        mon = Monitor(sb)
        try:
            sb.start_daemon()
            mon.start()
            time.sleep(1.5)  # idle baseline
            t0 = time.time()
            jids = []
            for repo in repos:
                if mix == "cmd":
                    jid = sb.enqueue_cmd(repo, ["sleep", str(ctx.args.sleep)])
                else:
                    jid = sb.enqueue_acp(repo, TASK_PROMPT, registry)
                mon.enq[jid] = time.time()
                jids.append(jid)
            enq_s = time.time() - t0
            wait_terminal(sb, jids, f"overload {mix} jobs", min(ctx.remaining(), ctx.args.job_timeout * math.ceil(n / ctx.cap)))
            time.sleep(1.2)
            makespan = max(mon.ev[j]["end"] for j in jids) - t0
            final = {j: sb.row(j) for j in jids}
            m = mon.finish()
            lat = mon.latencies(jids)
            first_wave = [x for x in lat if x is not None][:ctx.cap]
            m.update({"jobs": n, "enqueue_seconds": round(enq_s, 2), "makespan_s": round(makespan, 1),
                      "queue_to_start_s": stats(lat), "first_wave_start_max_s": round(max(first_wave, default=0), 2),
                      "statuses": {s: sum(r["status"] == s for r in final.values()) for s in TERMINAL},
                      "per_job": [{"id": j, "queue_to_start_s": round(mon.claim_ts(j) - mon.enq[j], 2) if mon.claim_ts(j) else None,
                                   "run_s": round(mon.ev[j]["end"] - mon.claim_ts(j), 1) if mon.claim_ts(j) else None,
                                   "status": final[j]["status"], "peak_rss_mb": mb(mon.job_peak.get(j, {}).get("rss", 0))}
                                  for j in jids],
                      "extrapolation": extrapolate(m) if mix == "acp" else {"note": "cmd mix RSS is not representative, use the acp mix"},
                      "series": mon.series})
            if mix == "cmd":
                m["ideal_makespan_s"] = math.ceil(n / ctx.cap) * ctx.args.sleep
            res.metrics["mixes"][mix] = m
            res.check(f"{mix}: live leased rows never exceed cap {ctx.cap}", not m["cap_violations"] and m["max_live"] <= ctx.cap,
                      f"max_live={m['max_live']} violations={m['cap_violations'][:3]}")
            res.check(f"{mix}: cap was saturated (max_live == cap)", m["max_live"] == ctx.cap, f"max_live={m['max_live']}", warn=True)
            res.check(f"{mix}: all {n} jobs done", m["statuses"]["done"] == n, m["statuses"])
            res.check(f"{mix}: no more job processes than cap at once", m["max_actual_job_procs"] <= ctx.cap,
                      f"max_actual_job_procs={m['max_actual_job_procs']}", warn=True)
            if mix == "acp":
                good = sum(int(subprocess.run(["git", "-C", r, "rev-list", "--count", "HEAD"], capture_output=True,
                                              text=True).stdout.strip() or 0) >= 2 for r in repos)
                m["repos_with_commit"] = good
                res.check("acp: each repo got its commit", good == n, f"{good}/{n}", warn=True)
        finally:
            mon.finish() if mon.is_alive() else None
            sb.teardown()
    best = res.metrics["mixes"]["cmd"]
    res.headline = (f"cap {ctx.cap}, {n} jobs: makespan {best['makespan_s']}s (ideal {best.get('ideal_makespan_s')}s), "
                    f"max_live {best['max_live']}, start latency p50 {best['queue_to_start_s'].get('p50')}s max {best['queue_to_start_s'].get('max')}s")
    if "acp" in res.metrics["mixes"]:
        a = res.metrics["mixes"]["acp"]
        res.headline += (f"; acp makespan {a['makespan_s']}s, per-agent peak {a['per_agent_peak_rss_mb']['max']}MB, "
                         f"safe cap by memory {a['extrapolation'].get('safe_cap_by_memory')}")


def sc_contention(ctx: Ctx, res: Res):
    sb = Sandbox(ctx, "contention", ctx.cap)
    shared = sb.make_repo()
    others = [sb.make_repo() for _ in range(max(ctx.cap, 2))]
    mon = Monitor(sb)
    try:
        sb.start_daemon()
        mon.start()
        s = str(ctx.args.sleep // 2 or 1)
        t0 = time.time()
        sj = []
        for _ in range(4):
            sj.append(sb.enqueue_cmd(shared, ["sleep", s]))
            mon.enq[sj[-1]] = time.time()
        oj = []
        for r in others:
            oj.append(sb.enqueue_cmd(r, ["sleep", s]))
            mon.enq[oj[-1]] = time.time()
        wait_terminal(sb, sj + oj, "contention jobs", ctx.remaining())
        time.sleep(1)
        m = mon.finish()
        iv = lambda j: (mon.claim_ts(j), mon.ev[j]["end"])
        sjs = sorted(iv(j) for j in sj)
        serial = all(b[0] >= a[1] - 0.5 for a, b in zip(sjs, sjs[1:]))
        overlap = any(iv(o)[0] < iv(x)[1] and iv(x)[0] < iv(o)[1] for o in oj for x in sj)
        m.update({"shared_jobs": 4, "other_jobs": len(oj), "max_live_on_shared_repo": mon.max_repo_live.get(shared, 0),
                  "shared_jobs_serialized": serial, "others_overlapped_shared": overlap,
                  "makespan_s": round(max(mon.ev[j]["end"] for j in sj + oj) - t0, 1)})
        res.metrics = m
        res.check("at most 1 running job on the shared repo", mon.max_repo_live.get(shared, 0) <= 1, f"max={mon.max_repo_live.get(shared)}")
        res.check("shared-repo jobs ran strictly one after another", serial)
        res.check("all jobs done", all(mon.ev[j]["final"] == "done" for j in sj + oj))
        res.check("live leased rows never exceed cap", not mon.violations, mon.violations[:3])
        if ctx.cap >= 2:
            res.check("other repos ran in parallel with a shared-repo job", overlap)
        else:
            res.notes.append("cap 1: parallelism check not applicable")
        res.headline = f"shared repo max live {m['max_live_on_shared_repo']}, others overlapped: {overlap}, makespan {m['makespan_s']}s"
    finally:
        if mon.is_alive():
            mon.finish()
        sb.teardown()


def sc_priority(ctx: Ctx, res: Res):
    sb = Sandbox(ctx, "priority", ctx.cap)
    n = ctx.mult * ctx.cap
    mon = Monitor(sb)
    try:
        prios = [(0, 0, 5, 10)[i % 4] for i in range(n)]
        jids = []
        for i in range(n):  # enqueue everything BEFORE the daemon starts so the claim order is fully determined
            jids.append(sb.enqueue_cmd(sb.make_repo(), ["sleep", "2"], priority=prios[i]))
            mon.enq[jids[-1]] = time.time()
        sb.start_daemon()
        mon.start()
        wait_terminal(sb, jids, "priority jobs", ctx.remaining())
        time.sleep(0.5)
        m = mon.finish()
        expected = [j for j, _ in sorted(zip(jids, prios), key=lambda t: (-t[1], t[0]))]
        observed = sorted(jids, key=lambda j: mon.claim_ts(j))
        fifo_ok = True
        for p in set(prios):
            grp = [j for j, q in zip(jids, prios) if q == p]
            fifo_ok &= all(observed.index(x) < observed.index(y) for x, y in zip(grp, grp[1:]))
        m.update({"priorities": dict(zip(jids, prios)), "expected_start_order": expected, "observed_start_order": observed})
        res.metrics = m
        res.check("start order equals (priority desc, FIFO)", observed == expected, f"expected={expected} observed={observed}")
        res.check("FIFO within each priority", fifo_ok)
        res.check("all jobs done", all(mon.ev[j]["final"] == "done" for j in jids))
        res.check("live leased rows never exceed cap", not mon.violations, mon.violations[:3])
        res.headline = f"{n} jobs, order {'correct' if observed == expected else 'WRONG'}"
    finally:
        if mon.is_alive():
            mon.finish()
        sb.teardown()


def sc_failure(ctx: Ctx, res: Res):
    sb = Sandbox(ctx, "failure", ctx.cap)
    mon = Monitor(sb)
    try:
        broken = ctx.registry("broken", lambda s: s.update(command="/nonexistent/fleet-loadtest-binary", args=[]))
        badmodel = ctx.registry("badmodel", lambda s: s.update(model="fleet-loadtest/does-not-exist"))
        sb.start_daemon()
        mon.start()
        j1 = sb.enqueue_acp(sb.make_repo(), TASK_PROMPT, broken)
        j2 = sb.enqueue_acp(sb.make_repo(), TASK_PROMPT, badmodel)
        good = [sb.enqueue_cmd(sb.make_repo(), ["sleep", "2"]) for _ in range(ctx.cap + 2)]
        for j in (j1, j2, *good):
            mon.enq[j] = time.time()
        t_limit = min(ctx.remaining(), ctx.args.job_timeout)
        try:
            wait_terminal(sb, [j1, j2, *good], "failure-injection jobs", t_limit)
        except TimeoutError as e:
            res.notes.append(str(e))
        time.sleep(1)
        rows = {j: sb.row(j) for j in (j1, j2, *good)}
        stuck = [j for j, r in rows.items() if r["status"] not in TERMINAL]
        for j in stuck:  # do not leave a hung injection job behind
            sb.fleet("cancel", str(j))
        time.sleep(1.5)
        m = mon.finish()
        t = lambda j: (round(mon.ev[j]["end"] - mon.claim_ts(j), 1) if mon.claim_ts(j) else "<0.3") if mon.ev[j]["end"] else None
        m.update({"broken_agent": {"status": rows[j1]["status"], "attempts": rows[j1]["attempts"], "seconds_to_fail": t(j1)},
                  "bad_model": {"status": rows[j2]["status"], "attempts": rows[j2]["attempts"], "seconds_to_fail": t(j2)},
                  "good_jobs_done": sum(rows[j]["status"] == "done" for j in good), "good_jobs": len(good),
                  "slots_left": sb.slots()})
        res.metrics = m
        res.check("broken agent command ends failed", rows[j1]["status"] == "failed", m["broken_agent"])
        res.check("bad model id ends failed", rows[j2]["status"] == "failed", m["bad_model"])
        res.check("no retry storm (attempts == 1)", rows[j1]["attempts"] == 1 and rows[j2]["attempts"] == 1, f"{rows[j1]['attempts']},{rows[j2]['attempts']}", warn=True)
        res.check("queue not blocked: all healthy jobs done", m["good_jobs_done"] == len(good), f"{m['good_jobs_done']}/{len(good)}")
        res.check("slots released", m["slots_left"] == 0 and not [r for r in sb.rows().values() if r["status"] == "running"], f"slots={m['slots_left']}")
        res.check("live leased rows never exceed cap", not mon.violations, mon.violations[:3])
        res.headline = f"broken: {rows[j1]['status']} in {t(j1)}s, bad model: {rows[j2]['status']} in {t(j2)}s, healthy jobs {m['good_jobs_done']}/{len(good)}"
    finally:
        if mon.is_alive():
            mon.finish()
        sb.teardown()


def agent_snapshot(sb, jid, table):
    """Everything that belongs to a running acp job: its fleet-acp group and the detached agent group plus subtrees."""
    row = sb.row(jid)
    roots = {row["pgid"]} if row["pgid"] else set()
    agent_pid = None
    pf = row["pidfile"] or str(sb.dir / "pids" / f"{jid}.agent")
    try:
        agent_pid = int(Path(pf).read_text().strip())
        roots.add(agent_pid)
    except (OSError, ValueError):
        pass
    pgs = set(roots)
    pids = descendants(table, roots) | {p.pid for p in table.values() if p.pgid in pgs}
    return row["pgid"], agent_pid, pids


def orphans_of(table, root, agent_pid, snap):
    pgs = {x for x in (root, agent_pid) if x}
    now = {p.pid for p in table.values() if p.pgid in pgs} | descendants(table, [agent_pid] if agent_pid else [])
    return sorted(p for p in (snap | now) if alive(table, p))


def describe(table, pids):
    return [{"pid": p, "ppid": table[p].ppid, "pgid": table[p].pgid, "rss_mb": mb(table[p].rss), "cmd": table[p].cmd[:110]}
            for p in pids if p in table]


def sc_cancel(ctx: Ctx, res: Res):
    lease = 9
    sb = Sandbox(ctx, "cancel", ctx.cap, lease=lease)
    mon = Monitor(sb)
    try:
        reg = ctx.registry("cancel")
        sb.start_daemon()
        mon.start()
        jid = sb.enqueue_acp(sb.make_repo(), LONG_PROMPT, reg)
        pidfile = sb.dir / "pids" / f"{jid}.agent"
        wait_for(lambda: (sb.row(jid) or {}).get("status") == "running" and pidfile.exists() and sb.row(jid)["payload"].get("session"),
                 min(ctx.remaining(), 180), "acp job running with session and agent pid file")
        time.sleep(4)  # let the agent start its long tool call
        table = ps_table()
        root, agent_pid, snap = agent_snapshot(sb, jid, table)
        sb.extra_kill |= {x for x in (root, agent_pid) if x} | snap
        before = describe(table, snap)
        t_cancel = time.time()
        sb.fleet("cancel", str(jid))
        hb = lease / 3
        root_gone = None
        end = t_cancel + 2 * hb + 1.5
        while time.time() < end:
            if root_gone is None and not alive(ps_table(), root):
                root_gone = round(time.time() - t_cancel, 1)
            time.sleep(0.2)
        table = ps_table()
        orphan_pids = orphans_of(table, root, agent_pid, snap)
        orphan_info = describe(table, orphan_pids)
        row = sb.row(jid)
        for p in orphan_pids:  # clean up the leak so later scenarios start clean
            killpg(table[p].pgid)
            kill(p)
        killpg(agent_pid)
        time.sleep(1)
        left = [p for p in orphan_pids if alive(ps_table(), p)]
        m = mon.finish()
        m.update({"status_after_cancel": row["status"], "slots_after_cancel": sb.slots(),
                  "fleet_acp_gone_after_s": root_gone, "waited_s": round(2 * hb + 1.5, 1),
                  "processes_before_cancel": before, "orphan_processes": orphan_info,
                  "orphans_left_after_cleanup": len(left)})
        res.metrics = m
        res.check("cancelled job recorded (failed, slot released)", row["status"] == "failed" and m["slots_after_cancel"] == 0,
                  f"status={row['status']} slots={m['slots_after_cancel']}")
        res.check("fleet-acp process killed within 2 heartbeats", root_gone is not None, f"gone after {root_gone}s")
        res.check("no orphan agent processes after cancel", not orphan_pids,
                  f"{len(orphan_pids)} orphan(s): " + "; ".join(f"{o['pid']} {o['cmd'][:60]}" for o in orphan_info[:4]))
        res.check("orphans cleaned up", not left, f"left={left}")
        res.headline = (f"after cancel + {m['waited_s']}s: {len(orphan_pids)} orphan process(es), "
                        f"fleet-acp gone after {root_gone}s")
    finally:
        if mon.is_alive():
            mon.finish()
        sb.teardown()


def sc_park(ctx: Ctx, res: Res):
    lease = 9
    sb = Sandbox(ctx, "park", 1, lease=lease)  # cap 1 so a free slot is directly visible as the next job starting
    mon = Monitor(sb)
    try:
        reg = ctx.registry("park")
        sb.start_daemon()
        mon.start()
        repo_a, repo_b = sb.make_repo(), sb.make_repo()
        a = sb.enqueue_acp(repo_a, PARK_PROMPT, reg)
        pidfile = sb.dir / "pids" / f"{a}.agent"
        wait_for(lambda: (sb.row(a) or {}).get("status") == "running" and pidfile.exists() and sb.row(a)["payload"].get("session"),
                 min(ctx.remaining(), 180), "acp job running with session")
        session0 = sb.row(a)["payload"]["session"]
        time.sleep(3)
        b = sb.enqueue_cmd(repo_b, ["sleep", "3"])
        mon.enq[b] = time.time()
        time.sleep(1)
        assert sb.row(b)["status"] == "queued", "cap 1: B must wait behind A"
        root, agent_pid, snap = agent_snapshot(sb, a, ps_table())
        sb.extra_kill |= {x for x in (root, agent_pid) if x} | snap
        t_park = time.time()
        sb.fleet("wait-on", str(a), "loadtest-evt")
        wait_for(lambda: mon.claim_ts(b), 30, "queued job to start after park")
        b_start_s = round(mon.claim_ts(b) - t_park, 2)
        hb = lease / 3
        root_gone = None
        while time.time() < t_park + 2 * hb + 1.5:
            if root_gone is None and not alive(ps_table(), root):
                root_gone = round(time.time() - t_park, 1)
            time.sleep(0.2)
        table = ps_table()
        orphan_pids = orphans_of(table, root, agent_pid, snap)
        orphan_info = describe(table, orphan_pids)
        for p in orphan_pids:
            killpg(table[p].pgid)
            kill(p)
        wait_terminal(sb, [b], "queued job B to finish", 60)
        parked = sb.row(a)
        t_rel = time.time()
        released = sb.fleet("release", "loadtest-evt")
        wait_for(lambda: (sb.row(a) or {}).get("attempts") == 2 and sb.row(a)["status"] == "running", 60, "parked job to resume")
        resume_claim_s = round(time.time() - t_rel, 2)
        flag_seen = False
        end = time.time() + 6
        while time.time() < end and not flag_seen:
            flag_seen = any(f"--session {session0}" in p.cmd and " run " in p.cmd for p in ps_table().values())
            time.sleep(0.2)
        wait_terminal(sb, [a], "resumed job to finish", min(ctx.remaining(), ctx.args.job_timeout))
        done_s = round(time.time() - t_rel, 1)
        final = sb.row(a)
        committed = int(subprocess.run(["git", "-C", repo_a, "rev-list", "--count", "HEAD"], capture_output=True, text=True).stdout.strip() or 0) >= 2
        m = mon.finish()
        m.update({"parked_status": parked["status"], "queued_job_started_after_park_s": b_start_s,
                  "fleet_acp_gone_after_park_s": root_gone, "orphans_after_park": orphan_info,
                  "released_ids": released, "resume_claim_s": resume_claim_s, "resume_to_done_s": done_s,
                  "attempts": final["attempts"], "session_before": session0, "session_after": final["payload"].get("session"),
                  "session_flag_seen_in_ps": flag_seen, "commit_present": committed})
        res.metrics = m
        res.check("wait-on parks the running job", parked["status"] == "waiting", parked["status"])
        res.check("freed slot let the queued job start", b_start_s is not None and sb.row(b)["status"] == "done", f"started {b_start_s}s after park")
        res.check("no orphan agent processes after park", not orphan_pids,
                  f"{len(orphan_pids)} orphan(s): " + "; ".join(f"{o['pid']} {o['cmd'][:60]}" for o in orphan_info[:4]))
        res.check("release requeues the job and it resumes", str(a) in released.split() and final["attempts"] == 2, f"attempts={final['attempts']}")
        res.check("resumed with --session <same id>", flag_seen and final["payload"].get("session") == session0,
                  f"flag_in_ps={flag_seen} session_same={final['payload'].get('session') == session0}")
        res.check("resumed job finishes done", final["status"] == "done", final["status"])
        res.check("work committed after resume", committed, warn=True)
        res.headline = (f"queued job started {b_start_s}s after park, resume claimed {resume_claim_s}s after release, "
                        f"done {done_s}s after release, orphans after park: {len(orphan_pids)}")
    finally:
        if mon.is_alive():
            mon.finish()
        sb.teardown()


def sc_chaos(ctx: Ctx, res: Res):
    sb = Sandbox(ctx, "chaos", ctx.cap, lease=5)
    n = ctx.mult * ctx.cap
    mon = Monitor(sb)
    try:
        jids = [sb.enqueue_cmd(sb.make_repo(), ["sleep", str(ctx.args.sleep)]) for _ in range(n)]
        sb.start_daemon()
        mon.start()
        t0 = time.time()
        for j in jids:
            mon.enq[j] = t0
        wait_for(lambda: sum(1 for r in sb.rows().values() if r["status"] == "running") >= ctx.cap, 30, "cap jobs running")
        time.sleep(2.5)
        live_at_kill = sum(1 for r in sb.rows().values() if r["status"] == "running")
        t_kill = time.time()
        sb.kill_daemon(signal.SIGKILL)
        time.sleep(1.0)
        sb.start_daemon()
        t_restart = time.time()
        wait_terminal(sb, jids, "all jobs after daemon restart", min(ctx.remaining(), ctx.args.job_timeout * n))
        time.sleep(1)
        m = mon.finish()
        rows = sb.rows()
        resumed = [j for j in jids if rows[j]["attempts"] > 1]
        post = sorted(ts for j in jids for a, ts in mon.ev[j]["starts"] if ts > t_restart)
        m.update({"jobs": n, "running_at_kill": live_at_kill, "jobs_retried": len(resumed),
                  "attempts": {str(j): rows[j]["attempts"] for j in jids},
                  "statuses": {s: sum(rows[j]["status"] == s for j in jids) for s in TERMINAL},
                  "restart_to_first_claim_s": round(post[0] - t_restart, 1) if post else None,
                  "kill_to_all_done_s": round(max(mon.ev[j]["end"] for j in jids) - t_kill, 1)})
        res.metrics = m
        res.check("all jobs eventually done", m["statuses"]["done"] == n, m["statuses"])
        res.check("live leased rows never exceed cap across the crash", not m["cap_violations"] and m["max_live"] <= ctx.cap,
                  f"max_live={m['max_live']} violations={m['cap_violations'][:3]}")
        res.check("killed jobs were retried (attempts > 1)", len(resumed) >= 1, f"{len(resumed)} retried")
        res.check("no more job processes than cap at once (orphans reaped before replacements)", m["max_actual_job_procs"] <= ctx.cap,
                  f"max_actual_job_procs={m['max_actual_job_procs']}", warn=True)
        res.headline = (f"{live_at_kill} running at kill, {len(resumed)} retried, all done {m['kill_to_all_done_s']}s after kill, "
                        f"max_live {m['max_live']}, max real procs {m['max_actual_job_procs']}")
    finally:
        if mon.is_alive():
            mon.finish()
        sb.teardown()


RUNNERS = {"overload": sc_overload, "contention": sc_contention, "priority": sc_priority,
           "failure": sc_failure, "cancel": sc_cancel, "park": sc_park, "chaos": sc_chaos}


# ---------------------------------------------------------------- reporting

def render_md(results: dict) -> str:
    meta = results["meta"]
    lines = [f"# Fleet load test: cap {meta['cap']}, mult {meta['mult']}, agent {meta['agent']}", "",
             f"{meta['host']} ({meta['platform']}), {meta['mem_total_mb']} MB RAM, run {meta['started']}, {meta['seconds']}s total.", "",
             "| Scenario | Result | Numbers |", "|---|---|---|"]
    for name, r in results["scenarios"].items():
        txt = r.get("headline") or r.get("skipped") or (r.get("error", "").strip().splitlines() or [""])[-1]
        lines.append(f"| {name} | {r['status'].upper()} | {txt.replace('|', '/')} |")
    lines += ["", "## Checks", "", "| Scenario | Check | Result | Detail |", "|---|---|---|---|"]
    for name, r in results["scenarios"].items():
        for c in r.get("checks", []):
            res = "ok" if c["ok"] else ("WARN" if c["warn"] else "FAIL")
            lines.append(f"| {name} | {c['name']} | {res} | {c['detail'][:140].replace('|', '/')} |")
    ov = results["scenarios"].get("overload", {}).get("metrics", {}).get("mixes", {})
    if ov:
        lines += ["", "## Capacity estimate", "", "| Mix | Makespan s | p50 / max start latency s | Peak RSS MB | Per-agent peak MB | Peak CPU % (sum) | Peak load1 | Free MB before | Safe cap by memory |",
                  "|---|---|---|---|---|---|---|---|---|"]
        for mix, m in ov.items():
            e = m["extrapolation"]
            lines.append(f"| {mix} | {m['makespan_s']} | {m['queue_to_start_s'].get('p50')} / {m['queue_to_start_s'].get('max')} | "
                         f"{m['peak_total_rss_mb']} | {m['per_agent_peak_rss_mb']['max']} | {m['peak_cpu_pct_sum']} | {m['peak_load1']} | "
                         f"{m['baseline_free_mb']} | {e.get('safe_cap_by_memory', 'n/a')} |")
        lines += ["", "Safe cap = floor(0.7 * free memory before the run / peak per-agent RSS). RSS double counts shared pages, so it is conservative. "
                  "CPU is ps `%cpu` (a decayed average), not an instantaneous reading. The cmd mix only measures queue behaviour."]
    notes = [f"{n}: {x}" for n, r in results["scenarios"].items() for x in r.get("notes", [])]
    if notes:
        lines += ["", "## Notes", ""] + [f"- {n}" for n in notes]
    return "\n".join(lines) + "\n"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cap", type=int, default=int(os.environ.get("COORDINATE_CAP", 2)), help="machine cap under test (COORDINATE_CAP)")
    ap.add_argument("--mult", type=int, default=3, help="queue mult*cap jobs (max 3 unless --allow-big)")
    ap.add_argument("--agent", default="opencode")
    ap.add_argument("--model", default=None, help="model id written into the registry copy (prefer free or haiku)")
    ap.add_argument("--out", default=None, help="output dir for results.json and results.md")
    ap.add_argument("--only", default=None, help=f"comma list of: {','.join(SCENARIOS)}")
    ap.add_argument("--skip-acp", action="store_true", help="cmd-only smoke mode, no LLM calls")
    ap.add_argument("--fake-acp", action="store_true", help="run acp scenarios against a zero-token stub (harness self-test)")
    ap.add_argument("--timeout", type=int, default=1800, help="overall safety timeout in seconds")
    ap.add_argument("--job-timeout", type=int, default=240, help="per-wave wait for acp jobs, seconds")
    ap.add_argument("--sleep", type=int, default=10, help="seconds the cmd jobs sleep")
    ap.add_argument("--acp-dir", default=None, help="fleet-acp checkout (default ../fleet-acp or COORDINATE_ACP_DIR)")
    ap.add_argument("--allow-big", action="store_true", help="allow mult > 3 (costs real money with acp)")
    a = ap.parse_args(argv)
    if a.cap < 1 or a.mult < 1:
        ap.error("--cap and --mult must be >= 1")
    if a.mult > 3 and not a.allow_big:
        ap.error("refusing mult > 3 (pass --allow-big if you really mean it)")
    wanted = [s.strip() for s in a.only.split(",")] if a.only else SCENARIOS
    bad = [s for s in wanted if s not in SCENARIOS]
    if bad:
        ap.error(f"unknown scenario(s) {bad}; choose from {SCENARIOS}")
    out = Path(a.out or f"loadtest-out/{time.strftime('%Y%m%d-%H%M%S')}").resolve()
    out.mkdir(parents=True, exist_ok=True)

    ctx = Ctx(a)
    atexit.register(lambda: shutil.rmtree(ctx.root, ignore_errors=True))

    def on_signal(sig, _frame):
        raise Timebox("global --timeout reached" if sig == signal.SIGALRM else f"interrupted by signal {sig}")
    for s in (signal.SIGTERM, signal.SIGINT, signal.SIGALRM):
        signal.signal(s, on_signal)
    signal.alarm(a.timeout)

    started = time.time()
    total, _ = mem_bytes()
    results = {"meta": {"cap": a.cap, "mult": a.mult, "agent": a.agent, "model": a.model, "host": platform.node(),
                        "platform": f"{platform.system()} {platform.machine()}", "mem_total_mb": mb(total),
                        "started": time.strftime("%Y-%m-%d %H:%M:%S"), "skip_acp": a.skip_acp, "fake_acp": a.fake_acp,
                        "acp_cmd": ctx.acp_cmd, "seconds": 0}, "scenarios": {}}
    try:
        for name in wanted:
            r = Res()
            t0 = time.time()
            print(f"== {name} ...", flush=True)
            if name in ACP_ONLY and a.skip_acp:
                r.skipped = "skipped (--skip-acp)"
            elif (name in ACP_ONLY or (name == "overload" and not a.skip_acp)) and not ctx.acp_cmd:
                r.skipped = "skipped (no fleet-acp found; set --acp-dir, COORDINATE_ACP_CMD or use --fake-acp)"
            entry = {}
            try:
                if not r.skipped:
                    RUNNERS[name](ctx, r)
            except Timebox as e:
                entry["error"] = str(e)
                r.check("finished within the time box", False, str(e))
                results["scenarios"][name] = entry
            except Exception:
                entry["error"] = traceback.format_exc()
                r.check("scenario ran without harness error", False, entry["error"].strip().splitlines()[-1])
            finally:
                ctx.dispose(out)
            m = r.metrics
            entry.update({"status": "error" if "error" in entry else r.status(), "headline": r.headline, "skipped": r.skipped,
                          "checks": r.checks, "notes": r.notes, "metrics": m, "seconds": round(time.time() - t0, 1)})
            results["scenarios"][name] = entry
            print(f"   {entry['status'].upper()} {r.headline or r.skipped or entry.get('error', '').strip().splitlines()[-1:]}", flush=True)
            if entry.get("error", "").startswith(("global", "interrupted")):
                break
    finally:
        signal.alarm(0)
        ctx.dispose(out)
        results["meta"]["seconds"] = round(time.time() - started, 1)
        (out / "results.json").write_text(json.dumps(results, indent=2, default=str))
        md = render_md(results)
        (out / "results.md").write_text(md)
        shutil.rmtree(ctx.root, ignore_errors=True)
        print("\n" + md)
        print(f"results: {out}/results.json, {out}/results.md")
    bad = [n for n, r in results["scenarios"].items() if r["status"] in ("fail", "error")]
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
