"""fleet shim over Restate 1.8: daemon, enqueue, stats.

COORDINATE_DB, COORDINATE_CAP, COORDINATE_REPO_CAP, COORDINATE_LEASE_S, COORDINATE_MACHINE, COORDINATE_CONFIG per the adapter
contract in .agents/docs/tool-search-rubric.md section 3.

Mapping:
- machine cap COORDINATE_CAP -> concurrency limit of the `*` flow-control rule; enqueue sends through
  the scoped ingress endpoint /restate/scope/machine/send/JobRunner/run with limit-key=<repo key>,
  and a per-scope rule caps the machine, a scope/<key> rule caps the repo at COORDINATE_REPO_CAP.
- weighted tool leases -> ToolLease VirtualObject + awakeables, one object instance per
  (tool class, project). A parked job is suspended by the server (SDK awaits the awakeable) and
  does not occupy a machine slot: flow-control counts invocations that are running, and a
  suspended invocation is not running.
- enqueue durability -> send (fire and forget) is journalled by the server before the ingress
  response, so it survives kill -9.
"""
import argparse
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.request

PORT_INGRESS = int(os.environ.get("RESTATE_SHIM_INGRESS_PORT", "5500"))
PORT_ADMIN = int(os.environ.get("RESTATE_SHIM_ADMIN_PORT", "5501"))
PORT_NODE = int(os.environ.get("RESTATE_SHIM_NODE_PORT", "15502"))
PORT_WORKER = int(os.environ.get("RESTATE_SHIM_WORKER_PORT", "59080"))
HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.environ.get("RESTATE_SHIM_PY", shutil.which("python3") or sys.executable)
RESTATE = os.environ.get("RESTATE_BIN", os.path.expanduser("~/.local/opt/restate/restate-server"))
CLI = os.environ.get("RESTATE_CLI", os.path.expanduser("~/.local/opt/restate/restate"))


def env() -> dict:
    e = dict(os.environ)
    e["RESTATE_ADMIN_URL"] = f"http://127.0.0.1:{PORT_ADMIN}"
    return e


def admin(method: str, path: str, body: dict | None = None) -> bytes:
    req = urllib.request.Request(f"http://127.0.0.1:{PORT_ADMIN}{path}", method=method,
                                 data=json.dumps(body).encode() if body else None)
    req.add_header("content-type", "application/json")
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def set_rule(pattern: str, concurrency: int) -> None:
    admin("PUT", "/limits/rules",
          [{"pattern": pattern, "limits": {"concurrency": concurrency}}])


def send_job(job: dict, repo: str, cap: int, repo_cap: int) -> str:
    """Scoped send with limit key; returns the invocation id from the response envelope."""
    # Rules are idempotent; the machine cap rides on the scope wildcard, the repo cap on machine/<key>.
    set_rule("*", cap)
    set_rule(f"machine/{repo}", repo_cap)
    url = (f"http://127.0.0.1:{PORT_INGRESS}/restate/scope/machine/send/JobRunner/run")
    body = json.dumps(job).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("content-type", "application/json")
    req.add_header("x-restate-limit-key", repo)
    with urllib.request.urlopen(req, timeout=60) as r:
        out = json.loads(r.read() or b"{}")
    return out.get("invocationId") or out.get("invocation_id") or "unknown"


def cmd_daemon(a) -> None:
    data_dir = os.path.dirname(os.environ.get("COORDINATE_DB", "/tmp/fleet.db"))
    os.makedirs(data_dir, exist_ok=True)
    cap = int(os.environ.get("COORDINATE_CAP", "4"))
    repo_cap = int(os.environ.get("COORDINATE_REPO_CAP", "1"))
    cfg = f"""base-dir = "{data_dir}/restate"
disable-prometheus = true
log-disable-ansi-codes = true
disable-telemetry = true
bind-port = {PORT_NODE}
[ingress]
bind-port = {PORT_INGRESS}
[admin]
bind-port = {PORT_ADMIN}
disable-web-ui = true
"""
    cfg_path = os.path.join(data_dir, "restate.toml")
    with open(cfg_path, "w") as f:
        f.write(cfg)

    server = subprocess.Popen([RESTATE, "--config-file", cfg_path, "--no-logo"])
    worker = None
    try:
        # Wait for admin to answer.
        for _ in range(120):
            try:
                admin("GET", "/health")
                break
            except Exception:
                time.sleep(0.25)
        venv_py = os.path.join(HERE, ".venv", "bin", "python")
        worker_py = venv_py if os.path.exists(venv_py) else PY
        worker = subprocess.Popen([worker_py, "-m", "restate", "serve",
                                   "worker:app", "--port", str(PORT_WORKER)],
                                  cwd=HERE, env=env())
        # Register the deployment.
        for _ in range(120):
            try:
                admin("POST", "/deployments",
                      {"uri": f"http://127.0.0.1:{PORT_WORKER}", "force": True})
                break
            except Exception:
                time.sleep(0.5)
        server.wait()
    finally:
        for p in (worker, server):
            if p and p.poll() is None:
                p.send_signal(signal.SIGTERM)
        for p in (worker, server):
            if p and p.poll() is None:
                try:
                    p.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    p.kill()


def cmd_enqueue(a) -> None:
    repo = os.path.abspath(a.cwd)
    rkey = "r" + hashlib.sha1(repo.encode()).hexdigest()[:16]
    job = {"id": f"job-{int(time.time() * 1000):x}-{os.getpid():x}",
           "cmd": a.cmd, "cwd": repo, "priority": a.priority,
           "env": {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "COORDINATE_LEASE_S")}}
    inv = send_job(job, rkey, int(os.environ.get("COORDINATE_CAP", "4")),
                   int(os.environ.get("COORDINATE_REPO_CAP", "1")))
    print(inv)


def cmd_stats(a) -> None:
    sql = ("SELECT status, COUNT(*) AS c FROM sys_invocation "
           "WHERE target_service_name = 'JobRunner' GROUP BY status")
    try:
        out = subprocess.run([CLI, "sql", "--json", sql], env=env(),
                             capture_output=True, text=True, timeout=30).stdout
        rows = json.loads(out[out.rindex("["):out.rindex("]") + 1]) if "[" in out else []
        counts = {row["status"]: row["c"] for row in rows}
        print(json.dumps({"by_status": counts,
                          "running": counts.get("running", 0),
                          "suspended": counts.get("suspended", 0)}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))


def main() -> None:
    ap = argparse.ArgumentParser(prog="restate-shim")
    sub = ap.add_subparsers(dest="c", required=True)
    sub.add_parser("daemon")
    e = sub.add_parser("enqueue")
    e.add_argument("--cwd", required=True)
    e.add_argument("--priority", type=int, default=0)
    e.add_argument("--shell", action="store_true")
    e.add_argument("--", dest="cmd_", nargs=argparse.REMAINDER)
    e.add_argument("cmd", nargs="?")
    sub.add_parser("stats")
    a = ap.parse_args()
    if a.c == "enqueue":
        cmd = " ".join(a.cmd_ if a.cmd_ else [a.cmd])
        a.cmd = cmd
        cmd_enqueue(a)
    elif a.c == "daemon":
        cmd_daemon(a)
    else:
        cmd_stats(a)


if __name__ == "__main__":
    main()
