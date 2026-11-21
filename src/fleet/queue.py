"""SQLite durable queue: schema, claim protocol, leases, reaper, waiting jobs.

Every state transition is one SQL statement or one BEGIN IMMEDIATE transaction.
"""
import json
import os
import signal
import sqlite3
import time

try:  # tomllib is stdlib from 3.11
    import tomllib
except ImportError:  # pragma: no cover
    tomllib = None

LEASE_S = float(os.environ.get("FLEET_LEASE_S", "30"))
MACHINE = os.environ.get("FLEET_MACHINE", "laptop")
MACHINE_CAPS = {"laptop": 3, "vps": 6}


def machine_cap() -> int:
    return int(os.environ.get("FLEET_CAP", MACHINE_CAPS.get(MACHINE, 3)))


def repo_cap() -> int:
    return int(os.environ.get("FLEET_REPO_CAP", 1))


def _slots_config() -> dict[str, int]:
    """Per-key tool-level slot limits from [slots] in ~/.fleet/config.toml (default 1 each)."""
    path = os.environ.get("FLEET_CONFIG") or os.path.expanduser("~/.fleet/config.toml")
    try:
        with open(path, "rb") as f:
            cfg = tomllib.load(f) if tomllib else {}
    except (OSError, ValueError):
        cfg = {}
    return {str(k): int(v) for k, v in (cfg.get("slots") or {}).items()}


def slot_limit(key: str) -> int:
    return _slots_config().get(key, 1)


def db_path() -> str:
    return os.environ.get("FLEET_DB") or os.path.expanduser("~/.fleet/queue.db")


SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs(
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'cmd',
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','running','waiting','done','failed','dead')),
  priority INTEGER NOT NULL DEFAULT 0,
  run_at REAL NOT NULL,
  lease_owner TEXT,
  lease_expires_at REAL,
  waiting_on TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  created_at REAL NOT NULL,
  pgid INTEGER,
  pidfile TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, priority DESC, run_at, id);
CREATE TABLE IF NOT EXISTS concurrency_slots(
  key TEXT NOT NULL,
  lease_expires_at REAL NOT NULL,
  job_id INTEGER NOT NULL REFERENCES jobs(id)
);
CREATE INDEX IF NOT EXISTS idx_slots_key ON concurrency_slots(key);
CREATE INDEX IF NOT EXISTS idx_slots_job ON concurrency_slots(job_id);
"""


def connect() -> sqlite3.Connection:
    path = db_path()
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    c = sqlite3.connect(path, timeout=5, isolation_level=None)
    c.execute("PRAGMA busy_timeout=5000")
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA synchronous=NORMAL")
    c.executescript(SCHEMA)
    have = {r[1] for r in c.execute("PRAGMA table_info(jobs)")}
    for col, typ in (("pgid", "INTEGER"), ("pidfile", "TEXT")):  # migrate pre-orphan-tracking DBs
        if col not in have:
            c.execute(f"ALTER TABLE jobs ADD COLUMN {col} {typ}")
    return c


def slot_keys(payload: dict) -> list[str]:
    keys = [f"machine:{MACHINE}"]
    repo = payload.get("repo") or payload.get("cwd")
    if repo:
        keys.append(f"repo:{os.path.abspath(repo)}")
    keys.extend(payload.get("slots") or [])  # tool-level keys, e.g. tool:vitest
    return keys


def enqueue(c, payload: dict, kind="cmd", priority=0, max_attempts=3, run_at=None) -> int:
    now = time.time()
    cur = c.execute(
        "INSERT INTO jobs(kind,payload,priority,run_at,max_attempts,created_at) VALUES(?,?,?,?,?,?)",
        (kind, json.dumps(payload), priority, run_at or now, max_attempts, now))
    return cur.lastrowid


def claim(c, owner: str):
    """Claim the best runnable queued job whose partitions all have a free slot."""
    now = time.time()
    c.execute("BEGIN IMMEDIATE")
    try:
        c.execute("DELETE FROM concurrency_slots WHERE lease_expires_at < ?", (now,))
        used = dict(c.execute("SELECT key, COUNT(*) FROM concurrency_slots GROUP BY key"))
        if used.get(f"machine:{MACHINE}", 0) >= machine_cap():
            c.execute("COMMIT")
            return None
        rows = c.execute(
            "SELECT id, payload, kind FROM jobs WHERE status='queued' AND run_at<=? "
            "ORDER BY priority DESC, run_at, id LIMIT 100", (now,)).fetchall()
        for jid, raw, kind in rows:
            payload = json.loads(raw)
            keys = slot_keys(payload)
            if any(k.startswith("repo:") and used.get(k, 0) >= repo_cap() for k in keys):
                continue
            if any(not k.startswith(("machine:", "repo:")) and used.get(k, 0) >= slot_limit(k) for k in keys):
                continue
            exp = now + LEASE_S
            c.execute(
                "UPDATE jobs SET status='running', attempts=attempts+1, lease_owner=?, "
                "lease_expires_at=? WHERE id=?", (owner, exp, jid))
            c.executemany("INSERT INTO concurrency_slots(key,lease_expires_at,job_id) VALUES(?,?,?)",
                          [(k, exp, jid) for k in keys])
            c.execute("COMMIT")
            return jid, kind, payload
        c.execute("COMMIT")
        return None
    except BaseException:
        c.execute("ROLLBACK")
        raise


def set_proc(c, jid: int, owner: str, pgid: int, pidfile: str | None) -> None:
    """Record the child's process group (and the agent pid file, for acp jobs) so a later reaper can kill it."""
    c.execute("UPDATE jobs SET pgid=?, pidfile=? WHERE id=? AND status='running' AND lease_owner=?",
              (pgid, pidfile, jid, owner))


def set_session(c, jid: int, owner: str, session: str) -> None:
    """Persist the ACP session id into the payload so the next attempt resumes it."""
    c.execute("UPDATE jobs SET payload=json_set(payload,'$.session',?) WHERE id=? AND lease_owner=?",
              (session, jid, owner))


def kill_orphans(pgid: int | None, pidfile: str | None) -> None:
    """SIGKILL a job's surviving process groups: the child group, plus the agent group named in its pid file.

    fleet-acp starts its agent detached (own group), so killing the child group alone would miss it.
    Caveat: a recorded pid can be reused after a long outage; we only kill groups of jobs whose lease expired.
    """
    pids = [pgid]
    if pidfile:
        try:
            with open(pidfile) as f:
                pids.append(int(f.read().strip()))
        except (OSError, ValueError):
            pass
        try:
            os.unlink(pidfile)
        except OSError:
            pass
    for pid in pids:
        if pid and pid > 1:
            try:
                os.killpg(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass


def heartbeat(c, jid: int, owner: str) -> bool:
    """Extend lease and slots. False means the lease was lost (cancelled, reaped, parked)."""
    exp = time.time() + LEASE_S
    c.execute("BEGIN IMMEDIATE")
    cur = c.execute("UPDATE jobs SET lease_expires_at=? WHERE id=? AND status='running' AND lease_owner=?",
                    (exp, jid, owner))
    if cur.rowcount:
        c.execute("UPDATE concurrency_slots SET lease_expires_at=? WHERE job_id=?", (exp, jid))
    c.execute("COMMIT")
    return bool(cur.rowcount)


def finish(c, jid: int, owner: str, status: str) -> None:
    c.execute("BEGIN IMMEDIATE")
    c.execute("UPDATE jobs SET status=?, lease_owner=NULL, lease_expires_at=NULL, pgid=NULL, pidfile=NULL "
              "WHERE id=? AND status='running' AND lease_owner=?", (status, jid, owner))
    c.execute("DELETE FROM concurrency_slots WHERE job_id=? AND EXISTS "
              "(SELECT 1 FROM jobs WHERE id=? AND status<>'running')", (jid, jid))
    c.execute("COMMIT")


def reap(c) -> list[int]:
    """Expired lease: requeue if attempts < max_attempts else dead. Returns affected ids."""
    c.execute("BEGIN IMMEDIATE")
    # Kill survivors before the requeue commits, so a retry never runs beside the old attempt.
    for _, pgid, pidfile in c.execute("SELECT id, pgid, pidfile FROM jobs "
                                      "WHERE status='running' AND lease_expires_at<?", (time.time(),)).fetchall():
        kill_orphans(pgid, pidfile)
    rows = c.execute(
        "UPDATE jobs SET status=CASE WHEN attempts<max_attempts THEN 'queued' ELSE 'dead' END, "
        "lease_owner=NULL, lease_expires_at=NULL, pgid=NULL, pidfile=NULL "
        "WHERE status='running' AND lease_expires_at<? RETURNING id", (time.time(),)).fetchall()
    c.execute("DELETE FROM concurrency_slots WHERE job_id IN (SELECT id FROM jobs WHERE status<>'running')")
    c.execute("COMMIT")
    return [r[0] for r in rows]


def wait_on(c, jid: int, event: str) -> bool:
    """Park a queued or running job on an event. Frees its slots; a running worker loses its lease."""
    c.execute("BEGIN IMMEDIATE")
    cur = c.execute("UPDATE jobs SET status='waiting', waiting_on=?, lease_owner=NULL, lease_expires_at=NULL "
                    "WHERE id=? AND status IN ('queued','running')", (event, jid))
    c.execute("DELETE FROM concurrency_slots WHERE job_id=?", (jid,))
    c.execute("COMMIT")
    return bool(cur.rowcount)


def release(c, event: str) -> list[int]:
    rows = c.execute("UPDATE jobs SET status='queued', waiting_on=NULL "
                     "WHERE status='waiting' AND waiting_on=? RETURNING id", (event,)).fetchall()
    return [r[0] for r in rows]


def cancel(c, jid: int) -> bool:
    """Cancel a non-terminal job (recorded as failed). A running worker notices at heartbeat."""
    c.execute("BEGIN IMMEDIATE")
    cur = c.execute("UPDATE jobs SET status='failed', lease_owner=NULL, lease_expires_at=NULL, waiting_on=NULL "
                    "WHERE id=? AND status IN ('queued','running','waiting')", (jid,))
    c.execute("DELETE FROM concurrency_slots WHERE job_id=?", (jid,))
    c.execute("COMMIT")
    return bool(cur.rowcount)


def retry_dead(c, jid: int | None = None) -> list[int]:
    q = ("UPDATE jobs SET status='queued', attempts=0 WHERE status IN ('dead','failed')"
         + (" AND id=?" if jid is not None else "") + " RETURNING id")
    return [r[0] for r in c.execute(q, (jid,) if jid is not None else ())]


def stats(c) -> dict:
    return dict(c.execute("SELECT status, COUNT(*) FROM jobs GROUP BY status"))
