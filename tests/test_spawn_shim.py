"""Spawn shim: heavy-class matcher, weighted tool leases, park-at-boundary, audit log."""
import json
import os
import sqlite3
import subprocess
import sys
import time

import pytest

from coordinate import cli, queue as q


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("COORDINATE_DB", str(tmp_path / "queue.db"))
    monkeypatch.setenv("COORDINATE_LEASE_S", "3")
    monkeypatch.setenv("COORDINATE_CAP", "4")
    monkeypatch.setenv("FAKE_SLEEP", "2")  # heavy jobs run 2s so lease contention is observable
    monkeypatch.setenv("COORDINATE_REPO_CAP", "4")  # isolate tool-cap contention from repo serialization
    monkeypatch.setenv("COORDINATE_MACHINE", "vps")
    cfg = tmp_path / "config.toml"
    cfg.write_text(
        "[slots]\n"
        "'tool:vitest:*' = 2\n"
        "'build:global' = 2\n"
        "'tool:sqlload:*' = 2\n"
        "[tools]\n"
        "sqlload = { cost = 1, match = [\"sqlload\"] }\n")
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    monkeypatch.setenv("COORDINATE_CONFIG", str(cfg))
    make_fake_bins(repo)
    return repo


def daemon():
    return subprocess.Popen([sys.executable, "-m", "coordinate", "daemon"], env=os.environ.copy(),
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


_BIN_DONE = False


def make_fake_bins(env):
    """Fake heavy binaries so tests never hit the user's real vitest/tsc shims."""
    bind = env / "bin"
    bind.mkdir(exist_ok=True)
    for name in ("vitest", "sqlload", "tsc"):
        f = bind / name
        f.write_text("#!/bin/sh\nsleep ${FAKE_SLEEP:-0}; exit 0\n")
        f.chmod(0o755)
    os.environ["PATH"] = f"{bind}:{os.environ['PATH']}"


def enqueue(env, tag, cmd, cwd=None):
    d = env / f"w-{tag}"
    d.mkdir(exist_ok=True)
    assert cli.main(["enqueue", "--cwd", str(cwd or d), "--shell", "--", cmd]) == 0


def drain(total, timeout=90):
    c = sqlite3.connect(os.environ["COORDINATE_DB"])
    done, end = 0, time.time() + timeout
    while time.time() < end and done < total:
        row = c.execute("SELECT COUNT(*) FROM jobs WHERE status IN ('done','failed')").fetchone()
        done = row[0]
        time.sleep(0.02)
    c.close()
    return done


def audit(env):
    c = sqlite3.connect(os.environ["COORDINATE_DB"])
    rows = c.execute("SELECT argv0, tool_class, project, job_id FROM spawn_audit").fetchall()
    c.close()
    return rows


def spans(log):
    now = "$(python3 -c 'import time;print(time.time())')"
    return f"echo s %s {now} >> {log}; sleep 0.8; echo e %s {now} >> {log}"


def peak_overlap(log, tags=None):
    ev = sorted((float(t), 1 if k == "s" else -1)
                for k, tag, t in (ln.split() for ln in log.read_text().splitlines())
                if tags is None or tag in tags)
    live = peak = 0
    for _, d in ev:
        live += d
        peak = max(peak, live)
    return peak


def wait_parked(jid, timeout=30):
    c = sqlite3.connect(os.environ["COORDINATE_DB"])
    end = time.time() + timeout
    while time.time() < end:
        row = c.execute("SELECT status, waiting_on FROM jobs WHERE id=?", (jid,)).fetchone()
        if row and row[0] == "waiting":
            c.close()
            return row[1]
        time.sleep(0.02)
    c.close()
    return None


def job_ids():
    c = sqlite3.connect(os.environ["COORDINATE_DB"])
    ids = [r[0] for r in c.execute("SELECT id FROM jobs ORDER BY id")]
    c.close()
    return ids


def test_heavy_parks_at_cap_and_resumes_on_release(env):
    log = env / "spans"
    cmd = spans(log)
    for i in range(3):  # tool:vitest limit 2, cost 2 + 2s jobs: first runs, later ones park
        enqueue(env, f"v{i}", f"vitest run {cmd % (f'v{i}', f'v{i}')}", cwd=env)
    ids = job_ids()
    dm = daemon()
    try:
        parked = wait_parked(ids[2])
        assert parked and parked.startswith("tool:vitest:"), "third vitest parked at boundary"
        assert drain(3) == 3, "all three complete as leases free up (park -> resume path)"
    finally:
        dm.kill()
        dm.wait()
    rows = audit(env)
    assert {r[1] for r in rows} == {"vitest"}, "heavy spawns audited with their class"


def test_unmatched_tool_audited_never_blocked(env):
    # unmatched binary: runs immediately without a lease or audit row
    enqueue(env, "triv", f"echo t0 $(date +%s.%N) >> {env / 'spans'}", cwd=env)
    dm = daemon()
    try:
        assert drain(1) == 1
    finally:
        dm.kill()
        dm.wait()
    assert audit(env) == [], "unmatched binary: no audit row, no lease"


def test_weighted_cost_excludes_cheaper_sibling(env):
    # weighted semantics: two tsc (cost 2, limit 2) serialize, while the cheap sqlload
    # (its own key) runs freely alongside - weights bind within a key (D3)
    log = env / "spans"
    cfg = env.parent / "config.toml"
    cfg.write_text("[tools]\nsqlload = { cost = 1, match = [\"sqlload\"] }\n"
                   "[slots]\n'tool:tsc-build:*' = 2\n'tool:sqlload:*' = 2\n")
    enqueue(env, "t0", f"tsc --build; {spans(log) % ('t0', 't0')}", cwd=env)
    enqueue(env, "t1", f"tsc --build; {spans(log) % ('t1', 't1')}", cwd=env)
    enqueue(env, "s0", f"sqlload run; {spans(log) % ('s0', 's0')}", cwd=env)
    dm = daemon()
    try:
        assert drain(3) == 3
    finally:
        dm.kill()
        dm.wait()
    ov_tsc = peak_overlap(log, {"t0", "t1"})
    ov_any = peak_overlap(log)
    assert ov_tsc == 1, "cost-2 tsc runs serialize within their key at limit 2"
    assert ov_any == 2, "cheap sqlload on its own key overlaps a running tsc"
    rows = audit(env)
    assert {r[1] for r in rows} == {"tsc-build", "sqlload"}, "both heavy classes audited"


def test_trivial_tools_pay_nothing(env):
    enqueue(env, "g", f"grep -r x {env} > /dev/null; echo done", cwd=env)
    dm = daemon()
    try:
        t0 = time.time()
        assert drain(1) == 1
        assert time.time() - t0 < 60
    finally:
        dm.kill()
        dm.wait()
    assert audit(env) == [], "grep-class spawn: no audit row, no lease"
