"""Event stream: one row per job transition, written in the same transaction.

See .agents/docs/t3-integration.md section 2 (bridge a). Kinds:
enqueued | claimed | parked | released | resumed | requeued | done | failed
| timed_out | cancelled | dead
"""
import json
import sqlite3
import time

EVENTS_DDL = """
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY,
  ts REAL NOT NULL,
  job_id INTEGER,
  kind TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_job ON events(job_id);
"""


def emit(c, jid: int | None, kind: str, data: dict | None = None) -> None:
    """Append one event. Call inside the transition's transaction (or autocommit path)."""
    c.execute("INSERT INTO events(ts,job_id,kind,data) VALUES(?,?,?,?)",
              (time.time(), jid, kind, json.dumps(data or {})))


def follow(c, since_id: int = 0):
    """Ordered events after since_id. Safe against a concurrent writer (WAL readers)."""
    return c.execute("SELECT id,ts,job_id,kind,data FROM events WHERE id>? ORDER BY id",
                     (since_id,))


def max_id(c) -> int:
    row = c.execute("SELECT COALESCE(MAX(id),0) FROM events").fetchone()
    return int(row[0])


def row_event(row) -> dict:
    """(id, ts, job_id, kind, data) -> JSON-ready dict."""
    eid, ts, jid, kind, data = row
    return {"id": eid, "ts": ts, "job_id": jid, "kind": kind,
            "data": json.loads(data) if data else {}}
