"""DBOS backend (spike): durable execution + queue caps on DBOS, glue for weighted tool leases.

Mapping from the SQLite backend:
  machine cap  -> queue global_concurrency
  repo cap     -> queue partition_concurrency (partition key = repo path; jobs without a repo get a unique key)
  priority     -> DBOS priority (lower runs first), so DBOS_PRIO = 1000 - fleet priority
  lease/reaper -> DBOS executor recovery of PENDING workflows on launch
  tool leases  -> glue table in a sidecar sqlite file (weighted), polled at spawn time
  session/pgid -> glue table (survives crash so the retry resumes and kills orphans)
"""
import json
import os
import shlex
import sqlite3
import subprocess
import threading
import time
import uuid

from dbos import DBOS, DBOSClient, DBOSConfig

from fleet import queue as q
from fleet.daemon import SH, _argv0, _which

QUEUE = "fleet"
MAX_RECOVERY = 3

GLUE_SCHEMA = """
CREATE TABLE IF NOT EXISTS leases(key TEXT NOT NULL, wf TEXT NOT NULL, cost INTEGER NOT NULL, expires REAL NOT NULL);
CREATE TABLE IF NOT EXISTS procs(wf TEXT PRIMARY KEY, pgid INTEGER, pidfile TEXT, session TEXT, cancelled INTEGER DEFAULT 0);
"""


def _dir() -> str:
    return os.path.dirname(os.path.abspath(q.db_path()))


def system_url() -> str:
    return f"sqlite:///{os.path.join(_dir(), 'dbos.sqlite')}"


def glue() -> sqlite3.Connection:
    os.makedirs(_dir(), exist_ok=True)
    c = sqlite3.connect(os.path.join(_dir(), "fleet-glue.db"), timeout=10, isolation_level=None)
    c.execute("PRAGMA busy_timeout=10000")
    c.execute("PRAGMA journal_mode=WAL")
    c.executescript(GLUE_SCHEMA)
    return c


def _acquire(c, wf: str, key: str, cost: int) -> bool:
    c.execute("BEGIN IMMEDIATE")
    try:
        now = time.time()
        c.execute("DELETE FROM leases WHERE expires<?", (now,))
        used = c.execute("SELECT COALESCE(SUM(cost),0) FROM leases WHERE key=?", (key,)).fetchone()[0]
        ok = used + cost <= q.slot_limit(key)
        if ok:
            c.execute("INSERT INTO leases VALUES(?,?,?,?)", (key, wf, cost, now + q.LEASE_S))
        c.execute("COMMIT")
        return ok
    except BaseException:
        c.execute("ROLLBACK")
        raise


def _build_cmd(kind: str, payload: dict, pidfile: str | None):
    if kind == "acp":
        cmd = shlex.split(os.environ.get("FLEET_ACP_CMD", "fleet-acp")) + [
            "run", payload["agent"], "--cwd", payload["cwd"], "--prompt", payload["prompt"], "--pid-file", pidfile]
        for flag, k in (("--registry", "registry"), ("--model", "model"), ("--session", "session")):
            if payload.get(k):
                cmd += [flag, payload[k]]
        return cmd, False
    cmd = payload["cmd"]
    return cmd, isinstance(cmd, str)


def _pump(proc, wf):
    g = glue()
    try:
        for n, line in enumerate(proc.stdout):
            if n == 0:
                try:
                    sid = json.loads(line).get("sessionId")
                except (ValueError, AttributeError):
                    sid = None
                if sid:
                    g.execute("UPDATE procs SET session=? WHERE wf=?", (sid, wf))
    finally:
        g.close()


def _kill(pgid, pidfile):
    q.kill_orphans(pgid, pidfile)


@DBOS.step()
def exec_job(kind: str, payload: dict) -> int:
    wf = DBOS.workflow_id
    g = glue()
    try:
        row = g.execute("SELECT pgid, pidfile, session FROM procs WHERE wf=?", (wf,)).fetchone()
        if row:  # recovery: kill the previous attempt's survivors, resume its ACP session
            _kill(row[0], row[1])
            if row[2]:
                payload = {**payload, "session": row[2]}
        else:
            g.execute("INSERT INTO procs(wf) VALUES(?)", (wf,))
        # --- spawn interception: weighted tool lease, park by polling ---
        key = None
        argv0 = _argv0(kind, payload)
        if argv0:
            m = q.match_tool_class(_which(argv0) or argv0)
            if m:
                cls, cost = m
                key = q.tool_slot_key(cls, q.project_key(payload.get("cwd")))
                if cost > q.slot_limit(key):
                    raise RuntimeError(f"tool lease {key} cost {cost} exceeds limit")
                while not _acquire(g, wf, key, cost):
                    time.sleep(0.25)
        pidfile = None
        if kind == "acp":
            pidfile = os.path.join(_dir(), "pids", f"{wf}.agent")
            os.makedirs(os.path.dirname(pidfile), exist_ok=True)
        cmd, shell = _build_cmd(kind, payload, pidfile)
        proc = subprocess.Popen(cmd, shell=shell, executable=SH if shell else None, cwd=payload.get("cwd"),
                                start_new_session=True, stdout=subprocess.PIPE if kind == "acp" else None,
                                text=kind == "acp")
        g.execute("UPDATE procs SET pgid=?, pidfile=? WHERE wf=?", (proc.pid, pidfile, wf))
        if kind == "acp":
            threading.Thread(target=_pump, args=(proc, wf), daemon=True).start()
        last = time.time()
        try:
            while True:
                try:
                    rc = proc.wait(timeout=1.0)
                    break
                except subprocess.TimeoutExpired:
                    pass
                if g.execute("SELECT cancelled FROM procs WHERE wf=?", (wf,)).fetchone()[0]:
                    _kill(proc.pid, pidfile)
                    proc.wait()
                    raise RuntimeError("cancelled")
                if key and time.time() - last >= q.LEASE_S / 3:
                    g.execute("UPDATE leases SET expires=? WHERE wf=?", (time.time() + q.LEASE_S, wf))
                    last = time.time()
        finally:
            g.execute("DELETE FROM leases WHERE wf=?", (wf,))
        if rc != 0:
            raise RuntimeError(f"exit {rc}")
        return rc
    finally:
        g.close()


@DBOS.workflow(max_recovery_attempts=MAX_RECOVERY)
def run_job(kind: str, payload: dict) -> int:
    return exec_job(kind, payload)


def _config() -> DBOSConfig:
    return {"name": "fleet", "system_database_url": system_url(), "log_level": "WARNING",
            "executor_id": os.environ.get("FLEET_MACHINE", "laptop")}


def run() -> None:
    DBOS(config=_config())
    DBOS.launch()
    DBOS.register_queue(QUEUE, global_concurrency=q.machine_cap(), partition_concurrency=q.repo_cap(),
                        polling_interval_sec=float(os.environ.get("FLEET_POLL_S", "0.2")))
    try:
        threading.Event().wait()
    finally:
        DBOS.destroy()


def _client() -> DBOSClient:
    return DBOSClient(system_database_url=system_url())


def enqueue(payload: dict, kind="cmd", priority=0, max_attempts=3) -> str:
    wf = f"job-{uuid.uuid4().hex[:12]}"
    repo = payload.get("repo") or payload.get("cwd")
    part = f"repo:{os.path.abspath(repo)}" if repo else f"solo:{wf}"
    _client().enqueue({"workflow_name": "run_job", "queue_name": QUEUE, "workflow_id": wf,
                       "queue_partition_key": part, "priority": max(0, 1000 - priority)}, kind, payload)
    return wf


_STATUS = {"ENQUEUED": "queued", "DELAYED": "queued", "PENDING": "running", "SUCCESS": "done",
           "ERROR": "failed", "CANCELLED": "failed", "MAX_RECOVERY_ATTEMPTS_EXCEEDED": "dead",
           "SUSPENDED": "waiting"}


def status(jid: str | None = None):
    c = _client()
    ws = c.list_workflows(workflow_ids=[jid] if jid else None, load_output=False)
    return [{"id": w.workflow_id, "status": _STATUS.get(w.status, w.status), "priority": w.priority,
             "partition": w.queue_partition_key} for w in ws]


def stats() -> dict:
    out: dict = {}
    for r in status():
        out[r["status"]] = out.get(r["status"], 0) + 1
    return out


def cancel(jid: str) -> bool:
    g = glue()
    g.execute("INSERT INTO procs(wf, cancelled) VALUES(?,1) ON CONFLICT(wf) DO UPDATE SET cancelled=1", (jid,))
    g.close()
    _client().cancel_workflow(jid)
    return True


def retry_dead(jid: str | None = None) -> list[str]:
    c = _client()
    ids = [r["id"] for r in status(jid) if r["status"] in ("dead", "failed")]
    for i in ids:
        c.resume_workflow(i)
    return ids
