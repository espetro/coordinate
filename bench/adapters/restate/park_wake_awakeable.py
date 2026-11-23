#!/usr/bin/env python3
"""Park and wake with TRUE suspension semantics: awakeables instead of the sleep poll.

Same scenario and metrics as park_wake.py, but JobRunnerSuspended parks a job on a durable
awakeable: a failed weighted-lease acquire registers the awakeable id in the ToolLease virtual
object and the invocation awaits it, which suspends it (sys_invocation status 'suspended', the
machine slot is freed). The lease holder's release handler resolves every registered awakeable,
waking the parked population, which retries the acquire.

Resolution path: the parked invocation creates the awakeable (ctx.awakeable() yields the id),
passes the id in the acquire_or_park request to the ToolLease VO, which appends it to its
`waiters` state if the lease is full; ToolLease.release resolves each id and clears the list.

  python bench/adapters/restate/park_wake_awakeable.py --out results.json [--parked 1000]

Differences from park_wake.py are marked SUSPENSION below.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ADMIN = os.environ.get("RESTATE_ADMIN_URL", "http://127.0.0.1:5501")
CLI = os.environ.get("RESTATE_CLI", os.path.expanduser("~/.local/opt/restate/restate"))


def host_state() -> dict:
    load1, load5, load15 = os.getloadavg()
    mem = {}
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                k, v = line.split(":", 1)
                if k in ("MemTotal", "MemAvailable"):
                    mem[k] = int(v.strip().split()[0]) // 1024
    except OSError:
        pass
    return {"load_1m": round(load1, 2), "load_5m": round(load5, 2), "load_15m": round(load15, 2),
            "mem_total_mb": mem.get("MemTotal"), "mem_available_mb": mem.get("MemAvailable"),
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z")}


def stack_rss(pids: list[int]) -> float:
    total = 0
    for pid in pids:
        try:
            with open(f"/proc/{pid}/status") as f:
                for line in f:
                    if line.startswith("VmRSS:"):
                        total += int(line.split()[1])
                        break
        except OSError:
            pass
    return round(total / 1024, 1)


def dir_bytes(path: Path) -> int:
    total = 0
    for p in path.rglob("*"):
        if p.is_file():
            total += p.stat().st_size
    return total


def sql(query: str) -> list[dict]:
    env = dict(os.environ)
    env["RESTATE_ADMIN_URL"] = ADMIN
    out = subprocess.run([CLI, "sql", "--json", query], env=env,
                         capture_output=True, text=True, timeout=60).stdout
    try:
        i, j = out.index("["), out.rindex("]")
        return json.loads(out[i:j + 1])
    except ValueError:
        return []


def counts() -> dict:
    # SUSPENSION: the suspended variant runs on JobRunnerSuspended.
    rows = sql("SELECT status, COUNT(*) AS c FROM sys_invocation "
               "WHERE target_service_name='JobRunnerSuspended' GROUP BY status")
    return {r["status"]: r["c"] for r in rows}


def shim_env(workdir: Path, fakebin: Path, cap: int) -> dict:
    env = dict(os.environ)
    env.update(COORDINATE_DB=str(workdir / "queue.db"), COORDINATE_CAP=str(cap),
               COORDINATE_REPO_CAP=str(cap),
               COORDINATE_LEASE_S="30", COORDINATE_MACHINE="bench",
               COORDINATE_CONFIG=str(workdir / "config.toml"),
               RESTATE_ADMIN_URL=ADMIN, PATH=f"{fakebin}:{env['PATH']}")
    return env


def enqueue(env: dict, cwd: Path, cmd: str, service: str) -> str:
    # SUSPENSION: the scoped send targets JobRunnerSuspended/run.
    rkey = "r" + __import__("hashlib").sha1(str(cwd).encode()).hexdigest()[:16]
    url = f"http://127.0.0.1:5500/restate/scope/machine/send/{service}/run"
    job = {"id": f"job-{int(time.time() * 1000):x}-{os.getpid():x}-{len(str(time.time()))}",
           "cmd": cmd, "cwd": str(cwd), "priority": 0,
           "env": {k: v for k, v in os.environ.items()
                   if k in ("PATH", "HOME", "COORDINATE_LEASE_S")}}
    req = urllib.request.Request(url, data=json.dumps(job).encode(), method="POST")
    req.add_header("content-type", "application/json")
    req.add_header("x-restate-limit-key", rkey)
    with urllib.request.urlopen(req, timeout=60) as r:
        out = json.loads(r.read() or b"{}")
    return out.get("invocationId") or "unknown"


def set_rule(pattern: str, concurrency: int) -> None:
    req = urllib.request.Request("http://127.0.0.1:5501/limits/rules", method="PUT",
                                 data=json.dumps([{"pattern": pattern,
                                                   "limits": {"concurrency": concurrency}}]).encode())
    req.add_header("content-type", "application/json")
    urllib.request.urlopen(req, timeout=30).read()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--parked", type=int, default=1000)
    ap.add_argument("--sleep", type=int, default=90)
    ap.add_argument("--workdir", default="/tmp/restate-susp")
    ap.add_argument("--keep", action="store_true")
    a = ap.parse_args()

    workdir = Path(a.workdir)
    if workdir.exists():
        shutil.rmtree(workdir)
    workdir.mkdir(parents=True)
    fakebin = workdir / "bin"
    fakebin.mkdir()
    (fakebin / "pytest").write_text(
        "#!/bin/sh\n"
        'if [ "$1" = "hold" ]; then sleep %d; else exit 0; fi\n' % a.sleep)
    (fakebin / "pytest").chmod(0o755)
    repo = workdir / "repo"
    repo.mkdir()
    (workdir / "config.toml").write_text('[slots]\n"pytest:*" = 2\n')

    svc = "JobRunnerSuspended"
    env = shim_env(workdir, fakebin, cap=a.parked + 2)
    # SUSPENSION: jobs are sent straight to the scoped ingress (same envelope the shim uses);
    # the shim daemon is still what starts the server and the worker.
    log = open(workdir / "daemon.log", "wb")
    for line in subprocess.run(["ps", "-eo", "pid,cmd"], capture_output=True,
                               text=True).stdout.splitlines():
        if ("restate-server" in line and str(workdir) in line) or "restate serve worker:app" in line:
            pid = int(line.split()[0])
            print(f"stopping leftover restate process {pid}", file=sys.stderr)
            try:
                os.kill(pid, 15)
            except ProcessLookupError:
                pass
    time.sleep(3)
    daemon = subprocess.Popen([sys.executable, str(HERE / "shim.py"), "daemon"],
                              env=env, stdout=log, stderr=log, cwd=str(HERE),
                              start_new_session=True)
    out = {"backend": "restate-suspended-awakeable", "host": host_state(),
           "parked_target": a.parked, "service": svc}
    try:
        for _ in range(120):
            try:
                urllib.request.urlopen(f"{ADMIN}/health", timeout=2).read()
                break
            except Exception:
                time.sleep(0.5)
        else:
            raise RuntimeError("restate admin did not come up")
        time.sleep(3)
        server_pid = None
        worker_pid = None
        for line in subprocess.run(["ps", "-eo", "pid,cmd"], capture_output=True,
                                   text=True).stdout.splitlines():
            if "restate-server" in line and "--config-file" in line:
                server_pid = int(line.split()[0])
            if "restate serve worker:app" in line:
                worker_pid = int(line.split()[0])
        out["pids"] = {"server": server_pid, "worker": worker_pid, "daemon": daemon.pid}
        out["rss_idle_mb"] = stack_rss([p for p in (server_pid, worker_pid) if p])
        idle_dir_bytes = dir_bytes(workdir / "restate")

        holder = enqueue(env, repo, f"{fakebin}/pytest hold", svc)
        out["lease_holder_invocation"] = holder
        time.sleep(3)
        out["counts_after_holder"] = counts()

        t0 = time.time()
        for i in range(a.parked):
            enqueue(env, repo, f"{fakebin}/pytest short", svc)
            if i and i % 100 == 0:
                print(f"enqueued {i}", file=sys.stderr, flush=True)
        park_s = time.time() - t0
        out["park_enqueue_s"] = round(park_s, 2)
        out["park_enqueue_per_invocation_ms"] = round(park_s / a.parked * 1000, 1)

        deadline = time.time() + 180
        c = {}
        while time.time() < deadline:
            c = counts()
            if c.get("suspended", 0) >= a.parked:
                break
            time.sleep(1)
        out["counts_parked"] = counts()
        out["parked_suspended"] = c.get("suspended", 0)
        out["parked_running"] = c.get("running", 0)
        out["park_wall_s"] = round(time.time() - t0, 2)
        out["rss_parked_mb"] = stack_rss([p for p in (server_pid, worker_pid) if p])
        out["rss_delta_mb"] = round(out["rss_parked_mb"] - out["rss_idle_mb"], 1)
        out["rss_kb_per_parked"] = round((out["rss_parked_mb"] - out["rss_idle_mb"]) * 1024 / a.parked, 2)
        data_dir = workdir / "restate"
        out["data_dir_bytes"] = dir_bytes(data_dir)
        out["data_dir_bytes_per_parked"] = round(out["data_dir_bytes"] / a.parked, 1)
        out["data_dir_bytes_idle"] = idle_dir_bytes
        out["data_dir_growth_bytes"] = out["data_dir_bytes"] - idle_dir_bytes
        out["data_dir_growth_bytes_per_parked"] = round(
            (out["data_dir_bytes"] - idle_dir_bytes) / a.parked, 1)
        sub = next(iter([p for p in data_dir.glob("*") if p.is_dir()]), None)
        out["log_store_bytes"] = dir_bytes(sub / "log-store") if sub else None

        # the wake: the holder completes, release resolves the awakeables, the parked jobs wake
        deadline = time.time() + a.sleep + 180
        release_epoch = None
        while time.time() < deadline:
            c = counts()
            if c.get("completed", 0) >= 1:
                release_epoch = time.time()
                break
            time.sleep(0.02)
        out["lease_release_detected_s"] = (round(release_epoch - t0, 2) if release_epoch else None)
        woke = None
        deadline = time.time() + 180
        while time.time() < deadline:
            c = counts()
            if release_epoch and c.get("completed", 0) >= 2:
                woke = (time.time() - release_epoch) * 1000
                break
            time.sleep(0.02)
        out["wake_ms"] = round(woke, 1) if woke else None
        out["wake_def"] = "lease release (the holder invocation completing, seen as the first " \
                          "completion) -> the first parked invocation completing its job (the " \
                          "second completion); the parked invocation is woken by the release " \
                          "handler resolving its awakeable, no polling"
        out["counts_after_wake"] = counts()
        out["host_after"] = host_state()
    finally:
        if not a.keep:
            daemon.terminate()
            try:
                daemon.wait(timeout=30)
            except subprocess.TimeoutExpired:
                daemon.kill()
                daemon.wait(timeout=10)
        log.close()
    Path(a.out).write_text(json.dumps(out, indent=2))
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
