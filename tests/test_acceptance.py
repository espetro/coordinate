import json
import os
import signal
import socket
import sqlite3
import subprocess
import sys
import time

import pytest

from fleet import cli, queue as q


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("FLEET_DB", str(tmp_path / "queue.db"))
    monkeypatch.setenv("FLEET_LEASE_S", "3")
    monkeypatch.setenv("FLEET_CAP", "3")
    monkeypatch.setattr(q, "LEASE_S", 3.0)
    return tmp_path


def daemon():
    return subprocess.Popen([sys.executable, "-m", "fleet", "daemon"], env=os.environ.copy(),
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def job_row(jid):
    c = sqlite3.connect(os.environ["FLEET_DB"])
    row = c.execute("SELECT status, attempts FROM jobs WHERE id=?", (jid,)).fetchone()
    c.close()
    return row


def wait_for(pred, timeout):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.1)
    return False


def test_kill9_daemon_mid_job_retries(env):
    marker = env / "marker"
    cli.main(["enqueue", "--cwd", str(env), "--shell", "--", f"echo run >> {marker}; sleep 2"])
    d = daemon()
    assert wait_for(lambda: job_row(1)[0] == "running", 10)
    d.send_signal(signal.SIGKILL)
    d.wait()
    assert job_row(1)[0] == "running"  # orphaned lease, nobody to finish it
    d2 = daemon()
    try:
        assert wait_for(lambda: job_row(1)[0] == "done", 30)
    finally:
        d2.kill()
        d2.wait()
    assert job_row(1) == ("done", 2)
    assert len(marker.read_text().splitlines()) == 2


def test_cap_never_exceeded(env):
    log = env / "spans"
    now = "$(python3 -c 'import time;print(time.time())')"
    for i in range(10):
        d = env / f"repo{i}"
        d.mkdir()
        cmd = f"echo s {now} >> {log}; sleep 0.6; echo e {now} >> {log}"
        cli.main(["enqueue", "--cwd", str(d), "--shell", "--", cmd])
    dm = daemon()
    peak = 0
    c = sqlite3.connect(os.environ["FLEET_DB"])
    try:
        end = time.time() + 60
        done = 0
        while time.time() < end and done < 10:
            running = c.execute("SELECT COUNT(*) FROM jobs WHERE status='running' AND lease_expires_at>?",
                                (time.time(),)).fetchone()[0]
            peak = max(peak, running)
            done = c.execute("SELECT COUNT(*) FROM jobs WHERE status='done'").fetchone()[0]
            time.sleep(0.02)
        assert done == 10
    finally:
        dm.kill()
        dm.wait()
    assert peak == 3
    events = sorted((float(t), 1 if k == "s" else -1)
                    for k, t in (ln.split() for ln in log.read_text().splitlines()))
    live = peak_live = 0
    for _, delta in events:
        live += delta
        peak_live = max(peak_live, live)
    assert peak_live == 3  # real process overlap, not just DB rows


def test_enqueue_offline(env, monkeypatch):
    def no_net(*a, **k):
        raise OSError("network disabled")
    monkeypatch.setattr(socket.socket, "connect", no_net)
    monkeypatch.setattr(socket, "getaddrinfo", no_net)
    assert cli.main(["enqueue", "--cwd", str(env), "--", "true"]) == 0
    assert job_row(1) == ("queued", 0)


def test_waiting_release_and_reaper_dead(env):
    c = q.connect()
    j = q.enqueue(c, {"cmd": ["true"], "cwd": str(env)})
    assert q.wait_on(c, j, "ev1")
    assert q.claim(c, "o") is None  # parked job is not claimable and holds no slot
    assert q.release(c, "ev1") == [j]
    assert q.claim(c, "o")[0] == j
    c.execute("UPDATE jobs SET lease_expires_at=0, max_attempts=1")
    assert q.reap(c) == [j]
    assert q.stats(c) == {"dead": 1}
    assert q.retry_dead(c) == [j]
    assert q.stats(c) == {"queued": 1}


def test_shell_string_is_stored_and_run_verbatim(env):
    out = env / "out.txt"
    cmd = f"sh -c 'printf \"%s|%s\" \"a  b\" c > {out}'"
    assert cli.main(["enqueue", "--cwd", str(env), "--shell", "--", cmd]) == 0
    c = q.connect()
    assert json.loads(c.execute("SELECT payload FROM jobs WHERE id=1").fetchone()[0])["cmd"] == cmd
    d = daemon()
    try:
        assert wait_for(lambda: job_row(1)[0] == "done", 30)
    finally:
        d.kill()
        d.wait()
    assert out.read_text() == "a  b|c"
    with pytest.raises(SystemExit):  # unquoted multi-token argv is ambiguous, refuse instead of flattening
        cli.main(["enqueue", "--shell", "--", "sh", "-c", "echo hi"])
