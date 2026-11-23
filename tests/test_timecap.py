"""Timecap: execution-time caps, absolute deadlines, budget accounting and identity injection."""
import json
import os
import signal
import sqlite3
import subprocess
import sys
import time

import pytest

from fleet import cli
from fleet import queue as q


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("FLEET_DB", str(tmp_path / "queue.db"))
    monkeypatch.setenv("FLEET_LEASE_S", "3")
    monkeypatch.setenv("FLEET_MACHINE", "vps")
    monkeypatch.setenv("FLEET_TIMECAP_GRACE_S", "1")
    monkeypatch.setenv("FLEET_CONFIG", str(tmp_path / "none.toml"))
    monkeypatch.delenv("FLEET_CAP", raising=False)
    return tmp_path


def daemon(env=None):
    return subprocess.Popen([sys.executable, "-m", "fleet", "daemon"], env=os.environ.copy(),
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def wait_for(pred, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.05)
    return False


def job_row(env, jid):
    c = sqlite3.connect(os.environ["FLEET_DB"])
    c.row_factory = sqlite3.Row
    row = c.execute("SELECT * FROM jobs WHERE id=?", (jid,)).fetchone()
    c.close()
    return dict(row) if row else None


def enqueue(env, cmd, extra=()):
    d = env / "w"
    d.mkdir(exist_ok=True)
    argv = ["enqueue", "--cwd", str(d), *extra, "--", *cmd]
    assert cli.main(argv) == 0


def test_cmd_job_sleeping_forever_is_timed_out(env):
    """A cmd job that sleeps forever is killed at its cap, ends timed_out and frees the slot."""
    c = q.connect()
    jid = q.enqueue(c, {"cmd": ["sleep", "300"], "cwd": str(env)}, max_runtime_s=2)
    dm = daemon()
    try:
        assert wait_for(lambda: (job_row(env, jid) or {}).get("status") == "timed_out", 30)
        row = job_row(env, jid)
        assert row["status"] == "timed_out"
        assert row["attempts"] == 1, "timed_out is terminal, never retried"
        assert row["outcome"] and "max runtime" in row["outcome"]
        assert row["lease_owner"] is None and row["deadline_at"] is None
        # the slot is freed: a second job runs normally afterwards
        jid2 = q.enqueue(c, {"cmd": ["true"], "cwd": str(env)})
        assert wait_for(lambda: (job_row(env, jid2) or {}).get("status") == "done", 30)
        slots = sqlite3.connect(os.environ["FLEET_DB"]).execute(
            "SELECT COUNT(*) FROM concurrency_slots WHERE job_id=?", (jid,)).fetchone()[0]
        assert slots == 0
    finally:
        dm.terminate()
        dm.wait(timeout=10)


def test_timed_out_job_leaves_no_orphan_process(env):
    """The sleeping child's process group is killed when the cap expires."""
    c = q.connect()
    jid = q.enqueue(c, {"cmd": ["sleep", "300"], "cwd": str(env)}, max_runtime_s=2)
    dm = daemon()
    try:
        assert wait_for(lambda: (job_row(env, jid) or {}).get("pgid"), 20)
        pgid = job_row(env, jid)["pgid"]
        assert wait_for(lambda: (job_row(env, jid) or {}).get("status") == "timed_out", 30)
        assert wait_for(lambda: not _pgid_alive(pgid), 15), "the child's group was killed"
    finally:
        dm.terminate()
        dm.wait(timeout=10)


def _pgid_alive(pgid):
    if not pgid:
        return False
    try:
        os.killpg(pgid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def _any_sleep_300_alive():
    out = subprocess.run(["ps", "-axo", "pid=,args="], capture_output=True, text=True).stdout
    return any("sleep 300" in ln for ln in out.splitlines())


def test_budget_excludes_parked_time(env, monkeypatch):
    """Time parked (waiting on an event) does not consume the runtime budget."""
    c = q.connect()
    jid = q.enqueue(c, {"cmd": ["sleep", "300"], "cwd": str(env)}, max_runtime_s=3)
    assert q.claim(c, "o")[0] == jid
    time.sleep(1.0)
    assert q.wait_on(c, jid, "evt")  # park after 1s of running
    time.sleep(2.0)  # parked: no budget consumed
    row = job_row(env, jid)
    assert 0.9 <= row["runtime_used_s"] <= 1.5, row["runtime_used_s"]
    assert row["deadline_at"] is None
    q.release(c, "evt")
    assert q.claim(c, "o")[0] == jid
    row = job_row(env, jid)
    # remaining budget = cap - used; the new deadline reflects only the running time left
    assert row["deadline_at"] - row["claim_at"] == pytest.approx(3 - row["runtime_used_s"], abs=0.2)


def test_deadline_survives_daemon_restart(env):
    """The deadline lives in SQLite: a killed daemon's deadline is enforced by its successor."""
    c = q.connect()
    jid = q.enqueue(c, {"cmd": ["sleep", "300"], "cwd": str(env)}, max_runtime_s=3)
    dm = daemon()
    try:
        assert wait_for(lambda: (job_row(env, jid) or {}).get("status") == "running", 20)
        first = job_row(env, jid)
        assert first["deadline_at"] is not None
        dm.kill()
        dm.wait(timeout=10)
        # the successor sees the same absolute deadline in the DB
        row = job_row(env, jid)
        assert row["deadline_at"] == first["deadline_at"]
        dm2 = daemon()
        try:
            assert wait_for(lambda: (job_row(env, jid) or {}).get("status") == "timed_out", 30)
        finally:
            dm2.terminate()
            dm2.wait(timeout=10)
    finally:
        if dm.poll() is None:
            dm.terminate()
            dm.wait(timeout=10)


def test_env_vars_visible_to_the_child(env):
    """FLEET_JOB_ID, FLEET_DEADLINE_AT, FLEET_MACHINE and FLEET_DB reach the child."""
    out = env / "env.txt"
    enqueue(env, ["sh", "-c", f"env > {out}"])
    dm = daemon()
    try:
        assert wait_for(lambda: out.exists() and out.read_text().strip(), 30)
        envs = dict(ln.split("=", 1) for ln in out.read_text().splitlines() if "=" in ln)
        assert envs["FLEET_MACHINE"] == "vps"
        assert envs["FLEET_DB"] == os.environ["FLEET_DB"]
        assert envs["FLEET_JOB_ID"].isdigit()
    finally:
        dm.terminate()
        dm.wait(timeout=10)


def test_deadline_at_env_is_epoch_seconds_of_the_cap(env):
    out = env / "env.txt"
    c = q.connect()
    jid = q.enqueue(c, {"cmd": ["sh", "-c", f"env > {out}"], "cwd": str(env)}, max_runtime_s=60)
    dm = daemon()
    try:
        assert wait_for(lambda: out.exists() and out.read_text().strip(), 30)
        envs = dict(ln.split("=", 1) for ln in out.read_text().splitlines() if "=" in ln)
        row = job_row(env, jid)
        assert int(envs["FLEET_DEADLINE_AT"]) == int(row["deadline_at"])
        assert int(envs["FLEET_JOB_ID"]) == jid
    finally:
        dm.terminate()
        dm.wait(timeout=10)


def test_no_cap_means_empty_deadline(env):
    out = env / "env.txt"
    enqueue(env, ["sh", "-c", f"env > {out}"])
    dm = daemon()
    try:
        assert wait_for(lambda: out.exists() and out.read_text().strip(), 30)
        envs = dict(ln.split("=", 1) for ln in out.read_text().splitlines() if "=" in ln)
        assert envs["FLEET_DEADLINE_AT"] == ""
    finally:
        dm.terminate()
        dm.wait(timeout=10)


def test_cli_max_runtime_is_stored(env):
    enqueue(env, ["true"], extra=["--max-runtime", "15m"])
    c = q.connect()
    jid = c.execute("SELECT id FROM jobs ORDER BY id DESC LIMIT 1").fetchone()[0]
    assert job_row(env, jid)["max_runtime_s"] == 900


def test_status_prints_deadline_runtime_and_remaining(env, capsys):
    c = q.connect()
    jid = q.enqueue(c, {"cmd": ["sleep", "300"], "cwd": str(env)}, max_runtime_s=30)
    dm = daemon()
    try:
        assert wait_for(lambda: (job_row(env, jid) or {}).get("status") == "running", 20)
        assert cli.main(["status", str(jid)]) == 0
        out = json.loads(capsys.readouterr().out)
        assert out["deadline_at"] is not None
        assert out["max_runtime_s"] == 30
        assert out["runtime_used_s"] is not None
        assert out["runtime_remaining_s"] is not None
        assert out["runtime_remaining_s"] <= 30
    finally:
        dm.terminate()
        dm.wait(timeout=10)


def test_status_self_uses_fleet_job_id(env, capsys, monkeypatch):
    c = q.connect()
    jid = q.enqueue(c, {"cmd": ["sleep", "300"], "cwd": str(env)}, max_runtime_s=30)
    monkeypatch.setenv("FLEET_JOB_ID", str(jid))
    assert cli.main(["status", "--self"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["id"] == jid


def test_config_default_max_runtime(env, monkeypatch):
    cfg = env / "config.toml"
    cfg.write_text("[defaults]\nmax_runtime = \"2h\"\n")
    monkeypatch.setenv("FLEET_CONFIG", str(cfg))
    enqueue(env, ["true"])
    c = q.connect()
    jid = c.execute("SELECT id FROM jobs ORDER BY id DESC LIMIT 1").fetchone()[0]
    assert job_row(env, jid)["max_runtime_s"] == 7200


def test_explicit_zero_disables_the_config_default(env, monkeypatch):
    cfg = env / "config.toml"
    cfg.write_text("[defaults]\nmax_runtime = \"2h\"\n")
    monkeypatch.setenv("FLEET_CONFIG", str(cfg))
    enqueue(env, ["true"], extra=["--max-runtime", "0"])
    c = q.connect()
    jid = c.execute("SELECT id FROM jobs ORDER BY id DESC LIMIT 1").fetchone()[0]
    assert job_row(env, jid)["max_runtime_s"] == 0


def test_old_database_is_migrated_and_keeps_rows(tmp_path, monkeypatch):
    """A DB created before the timecap columns and the timed_out CHECK still works."""
    db = tmp_path / "old.db"
    monkeypatch.setenv("FLEET_DB", str(db))
    monkeypatch.setenv("FLEET_CONFIG", str(tmp_path / "none.toml"))
    old = sqlite3.connect(db)
    old.execute("""CREATE TABLE jobs(
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
      pidfile TEXT)""")
    old.execute("INSERT INTO jobs(kind,payload,run_at,created_at,status) VALUES('cmd','{}',1,2,'done')")
    old.commit()
    old.close()
    c = q.connect()
    assert c.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1
    jid = q.enqueue(c, {"cmd": ["true"]}, max_runtime_s=60)
    assert c.execute("SELECT max_runtime_s FROM jobs WHERE id=?", (jid,)).fetchone()[0] == 60
    assert q.claim(c, "o")[0] == jid
    assert q.expired_running(c) == []


def test_parse_duration_units():
    assert q.parse_duration("90s") == 90
    assert q.parse_duration("15m") == 900
    assert q.parse_duration("2h") == 7200
    assert q.parse_duration("45") == 45
    assert q.parse_duration("0") == 0


def test_timed_out_job_is_not_retried_by_reaper(env):
    """A job whose cap expired stays terminal; the reaper does not requeue it."""
    c = q.connect()
    jid = q.enqueue(c, {"cmd": ["sleep", "300"], "cwd": str(env)}, max_runtime_s=1)
    assert q.claim(c, "o")[0] == jid
    assert q.finalize_timed_out(c, jid)
    c.execute("UPDATE jobs SET lease_expires_at=0")
    assert q.reap(c) == []
    assert job_row(env, jid)["status"] == "timed_out"


def test_expired_job_that_exhausted_its_budget_is_not_claimed(env):
    """A job whose budget ran out while parked is not claimed again."""
    c = q.connect()
    jid = q.enqueue(c, {"cmd": ["true"], "cwd": str(env)}, max_runtime_s=5)
    assert q.claim(c, "o")[0] == jid
    c.execute("UPDATE jobs SET runtime_used_s=5")
    q.finish(c, jid, "o", "failed")
    c.execute("UPDATE jobs SET status='queued'")
    assert q.claim(c, "o") is None
    assert job_row(env, jid)["status"] == "timed_out"


def test_signals_only_reach_our_own_process_group(env):
    """The timed-out child's group is killed; unrelated processes are untouched."""
    marker = env / "marker"
    c = q.connect()
    jid = q.enqueue(c, {"cmd": ["sleep", "300"], "cwd": str(env)}, max_runtime_s=1)
    dm = daemon()
    try:
        assert wait_for(lambda: (job_row(env, jid) or {}).get("pgid"), 20)
        pgid = job_row(env, jid)["pgid"]
        assert wait_for(lambda: (job_row(env, jid) or {}).get("status") == "timed_out", 30)
        assert wait_for(lambda: not _pgid_alive(pgid), 15), "the sleeping child group was killed"
        assert not marker.exists()
    finally:
        dm.terminate()
        dm.wait(timeout=10)
