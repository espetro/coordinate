import json
import os
import signal
import subprocess
import sys
import time

import pytest

from coordinate import queue as q


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("COORDINATE_DB", str(tmp_path / "queue.db"))
    monkeypatch.setattr(q, "LEASE_S", 3.0)
    return tmp_path


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def wait_for(pred, timeout):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.1)
    return False


def test_reaper_kills_surviving_process_group_before_requeue(env):
    """Daemon dies, job child survives in its own group; the reaper kills it, then the job is retryable."""
    c = q.connect()
    pidfile = env / "agent.pid"
    jid = q.enqueue(c, {"cmd": ["sleep", "60"], "cwd": str(env)})
    assert q.claim(c, "dead-daemon")[0] == jid
    child = subprocess.Popen(["sleep", "60"], start_new_session=True)
    agent = subprocess.Popen(["sleep", "60"], start_new_session=True)  # stands in for a detached ACP agent
    pidfile.write_text(str(agent.pid))
    q.set_proc(c, jid, "dead-daemon", child.pid, str(pidfile))
    c.execute("UPDATE jobs SET lease_expires_at=0")
    try:
        assert q.reap(c) == [jid]
        assert wait_for(lambda: child.poll() is not None and agent.poll() is not None, 5)
        row = c.execute("SELECT status, pgid, pidfile FROM jobs WHERE id=?", (jid,)).fetchone()
        assert row == ("queued", None, None)
        assert not pidfile.exists()
    finally:
        for p in (child, agent):
            if p.poll() is None:
                os.killpg(p.pid, signal.SIGKILL)
                p.wait()


def test_session_persisted_in_payload(env):
    c = q.connect()
    jid = q.enqueue(c, {"agent": "x", "cwd": str(env), "prompt": "p"}, kind="acp")
    q.claim(c, "o")
    q.set_session(c, jid, "o", "ses_123")
    kind, payload = c.execute("SELECT kind, payload FROM jobs WHERE id=?", (jid,)).fetchone()
    assert kind == "acp" and json.loads(payload)["session"] == "ses_123"
