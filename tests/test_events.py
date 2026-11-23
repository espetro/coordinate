"""Events table: emission per transition and the events CLI verb (bridge a)."""
import json
import subprocess
import sys

import pytest

from coordinate import queue as q
from coordinate import events as events_mod


@pytest.fixture()
def conn(tmp_path, monkeypatch):
    monkeypatch.setenv("COORDINATE_DB", str(tmp_path / "q.db"))
    monkeypatch.setenv("COORDINATE_MACHINE", "bench")
    monkeypatch.setenv("COORDINATE_CAP", "3")
    monkeypatch.delenv("COORDINATE_CONFIG", raising=False)
    c = q.connect()
    yield c
    c.close()


def kinds(c, jid=None):
    sql = "SELECT kind FROM events"
    args = ()
    if jid is not None:
        sql += " WHERE job_id=?"
        args = (jid,)
    return [r[0] for r in c.execute(sql + " ORDER BY id", args)]


def test_enqueue_claim_finish_emits(conn):
    jid = q.enqueue(conn, {"cmd": ["true"]})
    assert kinds(conn, jid) == ["enqueued"]
    got = q.claim(conn, "o:1")
    assert got and got[0] == jid
    q.finish(conn, jid, "o:1", "done")
    assert kinds(conn, jid) == ["enqueued", "claimed", "done"]


def test_fail_and_cancel(conn):
    jid = q.enqueue(conn, {"cmd": ["false"]})
    q.claim(conn, "o:1")
    q.finish(conn, jid, "o:1", "failed")
    jid2 = q.enqueue(conn, {"cmd": ["true"]})
    q.cancel(conn, jid2)
    assert kinds(conn, jid2) == ["enqueued", "cancelled"]
    assert kinds(conn, jid) == ["enqueued", "claimed", "failed"]


def test_park_release(conn):
    jid = q.enqueue(conn, {"cmd": ["true"]})
    assert q.wait_on(conn, jid, "ev1")
    assert q.release(conn, "ev1") == [jid]
    assert kinds(conn, jid) == ["enqueued", "parked", "released"]


def test_reap_requeue_and_dead(conn):
    conn.execute("UPDATE jobs SET attempts=0")
    jid = q.enqueue(conn, {"cmd": ["true"]})
    conn.execute("UPDATE jobs SET max_attempts=2")
    q.claim(conn, "o:1")
    conn.execute("UPDATE jobs SET lease_expires_at=1 WHERE id=?", (jid,))
    q.reap(conn)
    evs = kinds(conn, jid)
    assert evs == ["enqueued", "claimed", "requeued"]
    q.claim(conn, "o:2")
    conn.execute("UPDATE jobs SET lease_expires_at=1 WHERE id=?", (jid,))
    q.reap(conn)
    assert kinds(conn, jid)[-1] == "dead"


def test_follow_and_maxid(conn):
    assert q.enqueue(conn, {"cmd": ["true"]})
    assert q.enqueue(conn, {"cmd": ["true"]})
    rows = list(events_mod.follow(conn, 0))
    assert len(rows) == 2
    assert events_mod.max_id(conn) == rows[-1][0]
    assert len(list(events_mod.follow(conn, rows[0][0]))) == 1


def test_cli_events_jsonl(conn):
    jid = q.enqueue(conn, {"cmd": ["true"]})
    r = subprocess.run([sys.executable, "-m", "coordinate", "events"],
                       capture_output=True, text=True, check=True)
    lines = [json.loads(l) for l in r.stdout.strip().splitlines()]
    assert [e["kind"] for e in lines] == ["enqueued"]
    assert lines[0]["job_id"] == jid
    assert set(lines[0]) == {"id", "ts", "job_id", "kind", "data"}
