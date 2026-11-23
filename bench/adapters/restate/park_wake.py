#!/usr/bin/env python3
"""Park and wake against the Restate adapter: 1,000 parked invocations, then one wake.

The SQLite backend parks a session by writing a row with status 'waiting' and no process. The
Restate adapter has no such row: a parked job there is a suspended invocation (the SDK awaits an
awakeable or sleeps, the invocation is journalled by the server and the machine slot is freed).
So the closest expression of "park 1,000 sessions, then wake one" is the tool lease: one job
holds the weighted lease, 1,000 jobs park on it (each suspended), the lease is released and the
time until a parked job is running is the wake latency.

  python bench/adapters/restate/park_wake.py --out results.json [--parked 1000] [--sleep 90]

What is measured:
- the whole stack's RSS (server plus worker) before the fill and with the parked population
- the on-disk size of the Restate data directory (the log store and the metadata store)
- the wall time to park 1,000 invocations
- the wake latency: from the lease release to the first parked invocation running
- how many invocations are suspended, pending and running at each step

The fake `pytest` on the PATH is what makes the jobs contend for the weighted tool lease: the
shim maps the first token of the command to a tool class, and `pytest` is in that map.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESTATE = os.environ.get("RESTATE_BIN", os.path.expanduser("~/.local/opt/restate/restate-server"))
CLI = os.environ.get("RESTATE_CLI", os.path.expanduser("~/.local/opt/restate/restate"))
ADMIN = os.environ.get("RESTATE_ADMIN_URL", "http://127.0.0.1:5501")


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
    """RSS of the restate-server and the worker process, in MB."""
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
    rows = sql("SELECT status, COUNT(*) AS c FROM sys_invocation "
               "WHERE target_service_name='JobRunner' GROUP BY status")
    return {r["status"]: r["c"] for r in rows}


def shim_env(workdir: Path, fakebin: Path, cap: int = 1) -> dict:
    env = dict(os.environ)
    env.update(COORDINATE_DB=str(workdir / "queue.db"), COORDINATE_CAP=str(cap),
               COORDINATE_REPO_CAP=str(cap),
               COORDINATE_LEASE_S="30", COORDINATE_MACHINE="bench",
               COORDINATE_CONFIG=str(workdir / "config.toml"),
               RESTATE_ADMIN_URL=ADMIN, PATH=f"{fakebin}:{env['PATH']}")
    return env


def enqueue(env: dict, cwd: Path, cmd: str) -> str:
    r = subprocess.run([sys.executable, str(HERE / "shim.py"), "enqueue", "--cwd", str(cwd),
                        "--shell", "--", cmd], env=env, capture_output=True, text=True, timeout=120)
    if r.returncode:
        raise RuntimeError(f"enqueue failed: {r.stderr[-300:]}")
    return r.stdout.strip()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--parked", type=int, default=1000)
    ap.add_argument("--sleep", type=int, default=90, help="how long the lease holder holds the lease")
    ap.add_argument("--workdir", default="/tmp/restate-park-wake")
    ap.add_argument("--keep", action="store_true", help="leave the stack running afterwards")
    a = ap.parse_args()

    workdir = Path(a.workdir)
    if workdir.exists():
        shutil.rmtree(workdir)
    workdir.mkdir(parents=True)
    fakebin = workdir / "bin"
    fakebin.mkdir()
    # a fake `pytest` so the jobs map to the weighted tool lease class; `pytest hold` holds the
    # lease for the whole run, `pytest short` returns as soon as the lease is granted.
    (fakebin / "pytest").write_text(
        "#!/bin/sh\n"
        'if [ "$1" = "hold" ]; then sleep %d; else exit 0; fi\n' % a.sleep)
    (fakebin / "pytest").chmod(0o755)
    repo = workdir / "repo"
    repo.mkdir()
    # the weighted tool lease: one pytest at a time on this project. The key has to be the one
    # the worker looks up: `tool:<class>:<project>` or `<class>:*`, and the project is the hash
    # of the cwd, so the wildcard form is used.
    # pytest costs 2 in the tool-class map, so the limit has to be 2 or the lease is never
    # grantable and every job sleeps forever
    (workdir / "config.toml").write_text('[slots]\n"pytest:*" = 2\n')

    # Both caps have to be high enough that every parked job reaches the tool lease and
    # suspends on it: with a cap of 1 the extra jobs wait in the flow-control vqueue instead,
    # which is Restate's "queued", not "parked" (a suspended invocation is what frees its slot).
    # The repo cap matters too: all the jobs share one cwd, so the repo key is one limit key.
    env = shim_env(workdir, fakebin, cap=a.parked + 2)
    log = open(workdir / "daemon.log", "wb")
    # a stack left behind by a previous failed run would hold ports 5500-5502; find it by its
    # config path (this workdir) and stop it by pid before starting a new one.
    for line in subprocess.run(["ps", "-eo", "pid,cmd"], capture_output=True, text=True).stdout.splitlines():
        if ("restate-server" in line and str(workdir) in line) or "restate serve worker:app" in line:
            pid = int(line.split()[0])
            print(f"stopping leftover restate process {pid}", file=sys.stderr)
            try:
                os.kill(pid, 15)
            except ProcessLookupError:
                pass
    time.sleep(3)
    daemon = subprocess.Popen([sys.executable, str(HERE / "shim.py"), "daemon"],
                               env=env, stdout=log, stderr=log, cwd=str(HERE), start_new_session=True)
    # the worker is started by the shim daemon, which passes its own environment on; the config
    # path has to be in it for the tool lease limits to be found.
    os.environ["RESTATE_ADMIN_URL"] = ADMIN
    out = {"backend": "restate", "host": host_state(), "parked_target": a.parked}
    try:
        # wait for the admin endpoint
        import urllib.request
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
        for line in subprocess.run(["ps", "-eo", "pid,cmd"], capture_output=True, text=True).stdout.splitlines():
            if "restate-server" in line and "--config-file" in line:
                server_pid = int(line.split()[0])
            if "restate serve worker:app" in line and str(59080) in line:
                worker_pid = int(line.split()[0])
        out["pids"] = {"server": server_pid, "worker": worker_pid, "daemon": daemon.pid}
        out["rss_idle_mb"] = stack_rss([p for p in (server_pid, worker_pid) if p])
        idle_dir_bytes = dir_bytes(workdir / "restate")

        # the lease holder: it takes the lease (cost 2 of 2) and holds it for the whole run
        holder = enqueue(env, repo, f"{fakebin}/pytest hold")
        out["lease_holder_invocation"] = holder
        time.sleep(3)
        out["counts_after_holder"] = counts()

        # the parked population: every job contends for the same weighted lease and parks
        t0 = time.time()
        for i in range(a.parked):
            enqueue(env, repo, f"{fakebin}/pytest short")
            if i and i % 100 == 0:
                print(f"enqueued {i}", file=sys.stderr, flush=True)
        park_s = time.time() - t0
        out["park_enqueue_s"] = round(park_s, 2)
        out["park_enqueue_per_invocation_ms"] = round(park_s / a.parked * 1000, 1)

        # wait until the population is parked (suspended on the lease)
        deadline = time.time() + 180
        parked = 0
        while time.time() < deadline:
            c = counts()
            # the SDK's sleep-poll keeps the invocation in the running state between polls, so
            # the parked population is the number of invocations that are running but blocked on
            # the lease (the journal shows the Sleep/Call entries), not the suspended count
            parked = max(0, c.get("running", 0) + c.get("suspended", 0) - 1)
            if parked >= a.parked:
                break
            time.sleep(1)
        out["counts_parked"] = counts()
        out["parked_suspended"] = c.get("suspended", 0)
        out["parked_polling"] = parked
        out["park_wall_s"] = round(time.time() - t0, 2)
        out["rss_parked_mb"] = stack_rss([p for p in (server_pid, worker_pid) if p])
        out["rss_delta_mb"] = round(out["rss_parked_mb"] - out["rss_idle_mb"], 1)
        out["rss_kb_per_parked"] = round((out["rss_parked_mb"] - out["rss_idle_mb"]) * 1024 / a.parked, 2)
        data_dir = workdir / "restate"
        out["data_dir_bytes"] = dir_bytes(data_dir)
        out["data_dir_bytes_per_parked"] = round(out["data_dir_bytes"] / a.parked, 1)
        # the data directory holds the server's own state too (the metadata store and the empty
        # log store), so the per-parked cost is the growth over the idle size
        out["data_dir_bytes_idle"] = idle_dir_bytes
        out["data_dir_growth_bytes"] = out["data_dir_bytes"] - idle_dir_bytes
        out["data_dir_growth_bytes_per_parked"] = round(
            (out["data_dir_bytes"] - idle_dir_bytes) / a.parked, 1)
        out["log_store_bytes"] = dir_bytes(data_dir / "vps-ef376962" / "log-store") if (
            data_dir / "vps-ef376962" / "log-store").exists() else None

        # the wake: the lease holder finishes on its own, so the release handler runs (killing
        # the invocation would skip it: the compensating release is not guaranteed by the
        # runtime, which is a finding in itself). The wake latency is measured from the moment
        # the holder's invocation completes (the lease is released then) to the moment a parked
        # invocation is running again.
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
            # the holder has completed; the first parked job that completes after it woke
            if release_epoch and c.get("completed", 0) >= 2:
                woke = (time.time() - release_epoch) * 1000
                break
            time.sleep(0.02)
        out["wake_ms"] = round(woke, 1) if woke else None
        out["wake_def"] = "lease release (the holder invocation completing, seen as the first "\
                          "completion) -> the first parked invocation completing its job (the "\
                          "second completion); the parked invocation polls the lease every 200ms "\
                          "(the worker's sleep loop), so this is the polling granularity plus the "\
                          "lease acquisition plus the job itself"
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
