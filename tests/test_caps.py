"""Cap behaviour with the real daemon: vps machine cap (6) and the per-repo cap (1)."""
import os
import sqlite3
import subprocess
import sys
import time

import pytest

from fleet import cli


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("FLEET_DB", str(tmp_path / "queue.db"))
    monkeypatch.setenv("FLEET_LEASE_S", "3")
    monkeypatch.delenv("FLEET_CAP", raising=False)
    monkeypatch.delenv("FLEET_REPO_CAP", raising=False)
    monkeypatch.setenv("FLEET_MACHINE", "vps")
    return tmp_path


def daemon():
    return subprocess.Popen([sys.executable, "-m", "fleet", "daemon"], env=os.environ.copy(),
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def span_cmd(log, tag):
    now = "$(python3 -c 'import time;print(time.time())')"
    return f"echo s {tag} {now} >> {log}; sleep 0.8; echo e {tag} {now} >> {log}"


def peak_overlap(log, tags=None):
    ev = sorted((float(t), 1 if k == "s" else -1)
                for k, tag, t in (ln.split() for ln in log.read_text().splitlines())
                if tags is None or tag in tags)
    live = peak = 0
    for _, d in ev:
        live += d
        peak = max(peak, live)
    return peak


def drain(total, timeout=90):
    """Sample live running rows (lease still valid) until `total` jobs are done; return the peak."""
    c = sqlite3.connect(os.environ["FLEET_DB"])
    peak, done, end = 0, 0, time.time() + timeout
    while time.time() < end and done < total:
        peak = max(peak, c.execute("SELECT COUNT(*) FROM jobs WHERE status='running' AND lease_expires_at>?",
                                   (time.time(),)).fetchone()[0])
        done = c.execute("SELECT COUNT(*) FROM jobs WHERE status='done'").fetchone()[0]
        time.sleep(0.02)
    c.close()
    return peak, done


def test_vps_machine_cap_6_with_14_jobs(env):
    log = env / "spans"
    for i in range(14):
        d = env / f"repo{i}"
        d.mkdir()
        assert cli.main(["enqueue", "--cwd", str(d), "--shell", "--", span_cmd(log, i)]) == 0
    dm = daemon()
    try:
        peak, done = drain(14)
    finally:
        dm.kill()
        dm.wait()
    assert done == 14
    assert peak == 6, "never above the vps cap, and the cap is actually reached"
    assert peak_overlap(log) == 6  # real process overlap, not just DB rows


def test_repo_cap_1_holds_while_other_jobs_run_in_parallel(env):
    log = env / "spans"
    shared = env / "shared"
    shared.mkdir()
    for i in range(4):  # same payload.repo, distinct cwds so only the repo key ties them together
        d = env / f"w{i}"
        d.mkdir()
        assert cli.main(["enqueue", "--cwd", str(d), "--repo", str(shared), "--shell", "--",
                         span_cmd(log, f"shared{i}")]) == 0
    for i in range(6):
        d = env / f"o{i}"
        d.mkdir()
        assert cli.main(["enqueue", "--cwd", str(d), "--shell", "--", span_cmd(log, f"other{i}")]) == 0
    dm = daemon()
    c = sqlite3.connect(os.environ["FLEET_DB"])
    peak_shared = peak_total = 0
    try:
        end, done = time.time() + 90, 0
        while time.time() < end and done < 10:
            now = time.time()
            rows = c.execute("SELECT payload FROM jobs WHERE status='running' AND lease_expires_at>?", (now,)).fetchall()
            shared_n = sum(1 for (p,) in rows if '"repo"' in p)
            peak_shared = max(peak_shared, shared_n)
            peak_total = max(peak_total, len(rows))
            done = c.execute("SELECT COUNT(*) FROM jobs WHERE status='done'").fetchone()[0]
            time.sleep(0.02)
        assert done == 10
    finally:
        c.close()
        dm.kill()
        dm.wait()
    assert peak_shared == 1
    assert peak_total > 1, "other repos ran in parallel with the capped one"
    shared_tags = {f"shared{i}" for i in range(4)}
    assert peak_overlap(log, shared_tags) == 1
    assert peak_overlap(log) > 1
