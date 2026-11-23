"""SQLite durable queue: schema, claim protocol, leases, reaper, waiting jobs.

Every state transition is one SQL statement or one BEGIN IMMEDIATE transaction.
"""
import json
import os
import signal
import sqlite3
import subprocess
import time

from . import paths
from .events import EVENTS_DDL, emit  # noqa: F401 (re-exported for callers)

try:  # tomllib is stdlib from 3.11
    import tomllib
except ImportError:  # pragma: no cover
    tomllib = None

LEASE_S = float(paths.env("LEASE_S", "30"))
TIMECAP_GRACE_S = float(paths.env("TIMECAP_GRACE_S", "30"))
TIMECAP_TERM_S = 10.0  # SIGTERM to SIGKILL gap
MACHINE = paths.env("MACHINE", "laptop")
MACHINE_CAPS = {"laptop": 3, "vps": 6}


def machine_cap() -> int:
    return int(paths.env("CAP", MACHINE_CAPS.get(MACHINE, 3)))


def repo_cap() -> int:
    return int(paths.env("REPO_CAP", 1))


def _config() -> dict:
    path = paths.config_path()
    try:
        with open(path, "rb") as f:
            return tomllib.load(f) if tomllib else {}
    except (OSError, ValueError):
        return {}


def _slots_config() -> dict[str, int]:
    """Per-key tool-level slot limits from [slots] in config.toml (default 1 each)."""
    return {str(k): int(v) for k, v in (_config().get("slots") or {}).items()}


def slot_limit(key: str) -> int:
    cfg = _slots_config()
    if key in cfg:
        return int(cfg[key])
    # tool keys are tool:<class>:<project>; allow a per-class wildcard 'tool:<class>:*'
    if key.startswith("tool:"):
        parts = key.split(":", 2)
        if len(parts) == 3:
            wl = cfg.get(f"{parts[0]}:{parts[1]}:*")
            if wl is not None:
                return int(wl)
    return 1


# Heavy tool classes: the spawn shim matches a job's resolved binary basename (and subpath
# components) against these lists; unmatched binaries are trivial by definition (D4).
# Each class maps to its slot cost (D3) and the binary names/subpaths that match it.
DEFAULT_TOOL_CLASSES: dict[str, dict] = {
    "vitest": {"cost": 2, "match": ["vitest", "jest", "playwright"]},
    "tsc-build": {"cost": 2, "match": ["tsc", "vite"]},
    "cargo": {"cost": 2, "match": ["cargo"]},
    "docker": {"cost": 2, "match": ["docker", "docker-compose"]},
    "pkg-install": {"cost": 1, "match": ["npm", "pnpm", "yarn", "uv"]},
}


def tool_classes() -> dict[str, dict]:
    """[tools] from config (class -> {cost, match}) overlaid on the shipped defaults."""
    cfg = _config().get("tools") or {}
    classes = {k: {"cost": int(v.get("cost", 1)), "match": list(v.get("match", []))}
               for k, v in cfg.items()}
    for k, v in DEFAULT_TOOL_CLASSES.items():
        classes.setdefault(k, v)
    return classes


def match_tool_class(argv0: str) -> tuple[str, int] | None:
    """Resolve a command's binary to a heavy tool class: (class, cost) or None if trivial.

    Matches the resolved binary basename plus any path component (so `.venv/bin/vitest`,
    `node_modules/.bin/tsc` and `npx vitest`-style argv all hit the same class — D2).
    """
    parts = [p for p in os.path.normpath(argv0).split(os.sep) if p]
    if parts and os.path.basename(argv0) == parts[-1] and " " not in parts[-1] and "." not in parts[-1][1:]:
        pass  # plain name like "npx" still participates via components below
    names = {os.path.basename(argv0)} | set(parts)
    for cls, spec in tool_classes().items():
        if names & set(spec["match"]):
            return cls, spec["cost"]
    return None


def project_key(cwd: str | None) -> str:
    """Main repository root above cwd; falls back to cwd itself.

    A git worktree has a `.git` *file* pointing at its gitdir; the main repo is found by
    reading the `gitdir:` line and the gitdir's `commondir` (both relative to their own
    directory). `git rev-parse --git-common-dir` is the fallback. This way worktrees of one
    repo share the repo key and different repos do not."""
    start = os.path.abspath(cwd or os.getcwd())
    d = start
    while True:
        dot = os.path.join(d, ".git")
        if os.path.isdir(dot):
            return d
        if os.path.isfile(dot):
            main = _worktree_main_repo(d, dot)
            if main:
                return main
        parent = os.path.dirname(d)
        if parent == d:
            return start  # not inside any repo: the cwd itself is the key
        d = parent


def _worktree_main_repo(workdir: str, dot: str, _probe=None) -> str | None:
    """Main repo of the worktree described by `.git` file `dot`, or None.

    `_probe` lets tests inject a fake `git` (must accept ["rev-parse", "--git-common-dir"]
    and return the path on stdout); production uses git with a 2s timeout."""
    try:
        with open(dot) as f:
            for line in f:
                if line.startswith("gitdir:"):
                    gitdir = os.path.normpath(os.path.join(
                        workdir, line.split(":", 1)[1].strip()))
                    break
            else:
                return None
        with open(os.path.join(gitdir, "commondir")) as f:
            commondir = os.path.normpath(os.path.join(gitdir, f.read().strip()))
        return os.path.dirname(commondir)
    except OSError:
        pass
    probe = _probe or subprocess.run
    try:
        r = probe(["git", "-C", workdir, "rev-parse", "--git-common-dir"],
                  capture_output=True, text=True, timeout=2)
        if r is not None and r.returncode == 0 and r.stdout.strip():
            p = os.path.normpath(os.path.join(workdir, r.stdout.strip()))
            # a bare common dir has no worktree parent; use its parent (the repo dir)
            if os.path.basename(p) == ".git":
                return os.path.dirname(p)
            return p if os.path.isdir(os.path.join(p, ".git")) else os.path.dirname(p)
    except (subprocess.TimeoutExpired, OSError):
        pass
    return None


def audit_spawn(c, jid: int | None, argv0: str, cls: str, proj: str) -> None:
    """D9 audit log: every heavy match and every unmatched spawn of a heavy-class binary."""
    c.execute("INSERT INTO spawn_audit(ts,job_id,argv0,tool_class,project) VALUES(?,?,?,?,?)",
              (time.time(), jid, argv0, cls, proj))


def db_path() -> str:
    return paths.db_path()


def parse_duration(text: str) -> float:
    """'15m' style suffix (s/m/h, plain number = seconds) to seconds. 0 = no cap."""
    t = str(text).strip().lower()
    mult = {"s": 1.0, "m": 60.0, "h": 3600.0}
    if t and t[-1] in mult:
        return float(t[:-1]) * mult[t[-1]]
    return float(t)


def default_max_runtime() -> float:
    """[defaults] max_runtime from config.toml, so no job is unbounded unless capped at 0."""
    raw = (_config().get("defaults") or {}).get("max_runtime")
    return parse_duration(raw) if raw is not None else 0.0


SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs(
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'cmd',
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','running','waiting','done','failed','dead','timed_out')),
  priority INTEGER NOT NULL DEFAULT 0,
  run_at REAL NOT NULL,
  lease_owner TEXT,
  lease_expires_at REAL,
  waiting_on TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  created_at REAL NOT NULL,
  max_runtime_s REAL,
  runtime_used_s REAL NOT NULL DEFAULT 0,
  deadline_at REAL,
  claim_at REAL,
  outcome TEXT,
  pgid INTEGER,
  pidfile TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, priority DESC, run_at, id);
CREATE TABLE IF NOT EXISTS concurrency_slots(
  key TEXT NOT NULL,
  lease_expires_at REAL NOT NULL,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  cost INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_slots_key ON concurrency_slots(key);
CREATE INDEX IF NOT EXISTS idx_slots_job ON concurrency_slots(job_id);
CREATE TABLE IF NOT EXISTS spawn_audit(
  ts REAL NOT NULL,
  job_id INTEGER,
  argv0 TEXT NOT NULL,
  tool_class TEXT NOT NULL,
  project TEXT NOT NULL
);
"""


def connect() -> sqlite3.Connection:
    path = db_path()
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    c = sqlite3.connect(path, timeout=5, isolation_level=None)
    c.execute("PRAGMA busy_timeout=5000")
    c.execute("PRAGMA foreign_keys=OFF")
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA synchronous=NORMAL")
    _migrate_jobs(c)
    c.executescript(SCHEMA)
    c.executescript(EVENTS_DDL)
    have = {r[1] for r in c.execute("PRAGMA table_info(jobs)")}
    for col, typ in (("pgid", "INTEGER"), ("pidfile", "TEXT"), ("max_runtime_s", "REAL"),
                     ("runtime_used_s", "REAL DEFAULT 0"), ("deadline_at", "REAL"),
                     ("claim_at", "REAL"), ("outcome", "TEXT")):  # migrate older DBs
        if col not in have:
            c.execute(f"ALTER TABLE jobs ADD COLUMN {col} {typ}")
    return c


def _migrate_jobs(c) -> None:
    """Rebuild the jobs table when its CHECK constraint predates 'timed_out'.

    SQLite cannot ALTER a CHECK constraint, so the table is copied into a fresh one with the
    current schema and swapped in. Every row is preserved."""
    row = c.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'").fetchone()
    if not row or "timed_out" in row[0]:
        return
    new_ddl = SCHEMA[SCHEMA.index("CREATE TABLE IF NOT EXISTS jobs("):]
    new_ddl = new_ddl[:new_ddl.index(");") + 2].replace("IF NOT EXISTS jobs(", "jobs_new(")
    old_cols = [r[1] for r in c.execute("PRAGMA table_info(jobs)")]
    c.execute("BEGIN IMMEDIATE")
    try:
        c.execute(new_ddl)
        new_cols = [r[1] for r in c.execute("PRAGMA table_info(jobs_new)")]
        shared = [col for col in new_cols if col in old_cols]
        c.execute(f"INSERT INTO jobs_new({','.join(shared)}) SELECT {','.join(shared)} FROM jobs")
        c.execute("DROP TABLE jobs")
        c.execute("ALTER TABLE jobs_new RENAME TO jobs")
        c.execute("COMMIT")
    except BaseException:
        c.execute("ROLLBACK")
        raise
    c.execute("CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, priority DESC, run_at, id)")


def slot_keys(payload: dict) -> list[str]:
    keys = [f"machine:{MACHINE}"]
    repo = payload.get("repo") or payload.get("cwd")
    if repo:
        keys.append(f"repo:{os.path.abspath(repo)}")
    keys.extend(payload.get("slots") or [])  # tool-level keys, e.g. tool:vitest
    return keys


def enqueue(c, payload: dict, kind="cmd", priority=0, max_attempts=3, run_at=None,
            max_runtime_s: float | None = None) -> int:
    now = time.time()
    cur = c.execute(
        "INSERT INTO jobs(kind,payload,priority,run_at,max_attempts,created_at,max_runtime_s) "
        "VALUES(?,?,?,?,?,?,?)",
        (kind, json.dumps(payload), priority, run_at or now, max_attempts, now, max_runtime_s))
    jid = cur.lastrowid
    emit(c, jid, "enqueued", {"kind": kind})
    return jid


def q_used_cost(c, key: str) -> int:
    """Sum of live lease costs for a key (expired rows pruned first by the caller)."""
    return c.execute("SELECT COALESCE(SUM(cost),0) FROM concurrency_slots WHERE key=?",
                     (key,)).fetchone()[0]


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
            # static tool keys honor their [slots] limits at claim time (weighted, D3)
            if any(not k.startswith(("machine:", "repo:"))
                   and q_used_cost(c, k) + 1 > slot_limit(k) for k in keys):
                continue
            exp = now + LEASE_S
            remaining = None
            row = c.execute("SELECT max_runtime_s, runtime_used_s FROM jobs WHERE id=?", (jid,)).fetchone()
            if row[0] is not None and row[0] > 0:
                remaining = row[0] - (row[1] or 0.0)
                if remaining <= 0:  # budget exhausted while parked/queued: never claim again
                    c.execute("UPDATE jobs SET status='timed_out', outcome='budget exhausted before claim', "
                              "lease_owner=NULL, lease_expires_at=NULL WHERE id=?", (jid,))
                    emit(c, jid, "timed_out", {"outcome": "budget exhausted before claim"})
                    continue
            c.execute(
                "UPDATE jobs SET status='running', attempts=attempts+1, lease_owner=?, "
                "lease_expires_at=?, claim_at=?, deadline_at=? WHERE id=?",
                (owner, exp, now, None if remaining is None else now + remaining, jid))
            c.executemany("INSERT INTO concurrency_slots(key,lease_expires_at,job_id) VALUES(?,?,?)",
                          [(k, exp, jid) for k in keys])
            emit(c, jid, "claimed", {"owner": owner})
            c.execute("COMMIT")
            return jid, kind, payload
        c.execute("COMMIT")
        return None
    except BaseException:
        c.execute("ROLLBACK")
        raise


def tool_slot_key(cls: str, proj: str) -> str:
    return f"tool:{cls}:{proj}"  # D2: tool-class x project-dir


def acquire_tool_lease(c, jid: int, key: str, cost: int) -> bool:
    """Weighted tool lease (D3) inside one transaction; False = at cap.

    Called at spawn time, after the job already holds its machine/repo leases in
    concurrency_slots — ordered acquisition (D5) holds by construction.
    """
    limit = slot_limit(key)
    c.execute("BEGIN IMMEDIATE")
    try:
        c.execute("DELETE FROM concurrency_slots WHERE lease_expires_at < ?", (time.time(),))
        used = sum(r[0] for r in c.execute(
            "SELECT COALESCE(SUM(cost), 0) FROM concurrency_slots WHERE key=?", (key,)))
        if used + cost > limit:
            c.execute("COMMIT")
            return False
        c.execute("INSERT INTO concurrency_slots(key,lease_expires_at,job_id,cost) VALUES(?,?,?,?)",
                  (key, time.time() + LEASE_S, jid, cost))
        c.execute("COMMIT")
        return True
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


def _charge_runtime(c, jid: int, where: str = "status='running'", args: tuple = ()) -> None:
    """Charge elapsed running time to the budget. Parked/waiting time never counts: the clock
    only runs between claim_at and now, and claim_at is cleared when the job stops running."""
    now = time.time()
    c.execute("UPDATE jobs SET runtime_used_s=runtime_used_s+? - COALESCE(claim_at, ?) "
              f"WHERE id=? AND {where} AND claim_at IS NOT NULL", (now, now, jid, *args))


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


def finish(c, jid: int, owner: str, status: str) -> str | None:
    """Mark a running job terminal and drop its leases. Returns the tool-slot event key
    whose release should wake parked jobs (the first freed tool: key), or None.

    Running time used is charged to the budget here."""
    c.execute("BEGIN IMMEDIATE")
    _charge_runtime(c, jid, "status='running'", ())
    # deadline_at is kept after the transition: it documents when the attempt was due to end.
    c.execute("UPDATE jobs SET status=?, lease_owner=NULL, lease_expires_at=NULL, pgid=NULL, pidfile=NULL, "
              "claim_at=NULL WHERE id=? AND status='running' AND lease_owner=?",
              (status, jid, owner))
    event = None
    for (key,) in c.execute(
            "SELECT key FROM concurrency_slots WHERE job_id=? AND key LIKE 'tool:%'", (jid,)).fetchall():
        if event is None:
            event = key
    c.execute("DELETE FROM concurrency_slots WHERE job_id=? AND EXISTS "
              "(SELECT 1 FROM jobs WHERE id=? AND status<>'running')", (jid, jid))
    emit(c, jid, "done" if status == "done" else status, {"status": status})
    c.execute("COMMIT")
    return event


def reap(c) -> list[int]:
    """Expired lease: requeue if attempts < max_attempts else dead. Returns affected ids.

    A job whose deadline has passed is never requeued: it goes straight to timed_out."""
    c.execute("BEGIN IMMEDIATE")
    for jid, in c.execute("SELECT id FROM jobs WHERE status='running' AND lease_expires_at<?",
                          (time.time(),)).fetchall():
        _charge_runtime(c, jid, "status='running'", ())
    # Kill survivors before the requeue commits, so a retry never runs beside the old attempt.
    for _, pgid, pidfile in c.execute("SELECT id, pgid, pidfile FROM jobs "
                                      "WHERE status='running' AND lease_expires_at<?", (time.time(),)).fetchall():
        kill_orphans(pgid, pidfile)
    rows_deadline = c.execute("UPDATE jobs SET status='timed_out', outcome='lease expired after deadline', "
                              "lease_owner=NULL, lease_expires_at=NULL, pgid=NULL, pidfile=NULL, claim_at=NULL "
                              "WHERE status='running' AND lease_expires_at<? AND deadline_at IS NOT NULL AND deadline_at<=? "
                              "RETURNING id", (time.time(), time.time())).fetchall()
    for (jid,) in rows_deadline:
        emit(c, jid, "timed_out", {"outcome": "lease expired after deadline"})
    rows = c.execute(
        "UPDATE jobs SET status=CASE WHEN attempts<max_attempts THEN 'queued' ELSE 'dead' END, "
        "lease_owner=NULL, lease_expires_at=NULL, pgid=NULL, pidfile=NULL, claim_at=NULL, deadline_at=NULL "
        "WHERE status='running' AND lease_expires_at<? RETURNING id", (time.time(),)).fetchall()
    for (jid,) in rows:
        st = c.execute("SELECT status FROM jobs WHERE id=?", (jid,)).fetchone()[0]
        emit(c, jid, "timed_out" if st == "timed_out" else "requeued" if st == "queued" else "dead",
             {"reason": "lease expired"})
    c.execute("DELETE FROM concurrency_slots WHERE job_id IN (SELECT id FROM jobs WHERE status<>'running')")
    c.execute("COMMIT")
    return [r[0] for r in rows]


def release_tool_lease(c, jid: int) -> None:
    """Drop a job's tool leases (spawn failure path; terminal transitions use finish/reap/wait_on)."""
    c.execute("DELETE FROM concurrency_slots WHERE job_id=?", (jid,))


def wait_on(c, jid: int, event: str) -> bool:
    """Park a queued or running job on an event. Frees its slots; a running worker loses its lease.

    Running time used so far is charged to the budget before parking."""
    c.execute("BEGIN IMMEDIATE")
    _charge_runtime(c, jid, "status='running'", ())
    cur = c.execute("UPDATE jobs SET status='waiting', waiting_on=?, lease_owner=NULL, "
                    "lease_expires_at=NULL, claim_at=NULL, deadline_at=NULL "
                    "WHERE id=? AND status IN ('queued','running')", (event, jid))
    c.execute("DELETE FROM concurrency_slots WHERE job_id=?", (jid,))
    if cur.rowcount:
        emit(c, jid, "parked", {"waiting_on": event})
    c.execute("COMMIT")
    return bool(cur.rowcount)


def release(c, event: str) -> list[int]:
    rows = c.execute("UPDATE jobs SET status='queued', waiting_on=NULL "
                     "WHERE status='waiting' AND waiting_on=? RETURNING id", (event,)).fetchall()
    for (jid,) in rows:
        emit(c, jid, "released", {"event": event})
    return [r[0] for r in rows]


def finalize_timed_out(c, jid: int, outcome="max runtime exceeded") -> bool:
    """Terminal timecap transition: status timed_out (never retried), budget charged, slot freed.

    Does not require the lease: a restarted daemon enforces deadlines recorded by its predecessor.
    """
    c.execute("BEGIN IMMEDIATE")
    _charge_runtime(c, jid, "status='running'", ())
    cur = c.execute("UPDATE jobs SET status='timed_out', outcome=?, claim_at=NULL, "
                    "lease_owner=NULL, lease_expires_at=NULL, pgid=NULL, pidfile=NULL, waiting_on=NULL "
                    "WHERE id=? AND status='running'", (outcome, jid))
    if cur.rowcount:
        emit(c, jid, "timed_out", {"outcome": outcome})
    c.execute("DELETE FROM concurrency_slots WHERE job_id=? AND EXISTS "
              "(SELECT 1 FROM jobs WHERE id=? AND status<>'running')", (jid, jid))
    c.execute("COMMIT")
    return bool(cur.rowcount)


def expired_running(c) -> list[tuple]:
    """Running jobs past their deadline: (id, kind, payload, pgid, pidfile). Deadline lives in
    SQLite, so any daemon (including one that just restarted) sees and enforces it."""
    return c.execute("SELECT id, kind, payload, pgid, pidfile FROM jobs "
                     "WHERE status='running' AND deadline_at IS NOT NULL AND deadline_at<=?",
                     (time.time(),)).fetchall()


def cancel(c, jid: int) -> bool:
    """Cancel a non-terminal job (recorded as failed). A running worker notices at heartbeat."""
    c.execute("BEGIN IMMEDIATE")
    _charge_runtime(c, jid, "status='running'", ())
    cur = c.execute("UPDATE jobs SET status='failed', lease_owner=NULL, lease_expires_at=NULL, waiting_on=NULL, "
                    "claim_at=NULL "
                    "WHERE id=? AND status IN ('queued','running','waiting')", (jid,))
    c.execute("DELETE FROM concurrency_slots WHERE job_id=? AND cost>0", (jid,))
    if cur.rowcount:
        emit(c, jid, "cancelled", {"recorded_as": "failed"})
    c.execute("COMMIT")
    return bool(cur.rowcount)


def retry_dead(c, jid: int | None = None) -> list[int]:
    q = ("UPDATE jobs SET status='queued', attempts=0 WHERE status IN ('dead','failed')"
         + (" AND id=?" if jid is not None else "") + " RETURNING id")
    rows = c.execute(q, (jid,) if jid is not None else ()).fetchall()
    for (rid,) in rows:
        emit(c, rid, "requeued", {"reason": "dead retry"})
    return [r[0] for r in rows]


def stats(c) -> dict:
    return dict(c.execute("SELECT status, COUNT(*) FROM jobs GROUP BY status"))
