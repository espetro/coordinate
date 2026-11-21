"""Tool-level slot keys: payload.slots claims extra leases beyond the device cap."""
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
    cfg = tmp_path / "config.toml"
    cfg.write_text("[slots]\n'tool:vitest' = 1\n'tool:tsc' = 1\n'build:global' = 2\n'tool:other' = 2\n")
    monkeypatch.setenv("FLEET_CONFIG", str(cfg))
    return tmp_path


def daemon():
    return subprocess.Popen([sys.executable, "-m", "fleet", "daemon"], env=os.environ.copy(),
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def span_cmd(log, tag):
    now = "$(python3 -c 'import time;print(time.time())')"
    return f"echo s {tag} {now} >> {log}; sleep 0.8; echo e {tag} {now} >> {log}"


def enqueue(env, log, tag, slots=None):
    d = env / f"w-{tag}"
    d.mkdir(exist_ok=True)
    argv = ["enqueue", "--cwd", str(d), "--shell"]
    for s in slots or []:
        argv += ["--slot", s]
    argv += ["--", span_cmd(log, tag)]
    assert cli.main(argv) == 0


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
    c = sqlite3.connect(os.environ["FLEET_DB"])
    done, end = 0, time.time() + timeout
    while time.time() < end and done < total:
        done = c.execute("SELECT COUNT(*) FROM jobs WHERE status='done'").fetchone()[0]
        time.sleep(0.02)
    c.close()
    return done


def test_slot_key_serializes_same_tool_parallel_to_other(env):
    log = env / "spans"
    for i in range(3):
        enqueue(env, log, f"vitest{i}", slots=["tool:vitest"])
    enqueue(env, log, "other0", slots=["tool:other"])
    enqueue(env, log, "other1", slots=["tool:other"])
    dm = daemon()
    try:
        assert drain(5) == 5
    finally:
        dm.kill()
        dm.wait()
    assert peak_overlap(log, {f"vitest{i}" for i in range(3)}) == 1, "tool:vitest jobs serialized"
    assert peak_overlap(log, {"other0", "other1"}) == 2, "tool:other jobs ran in parallel"


def test_slot_limit_from_config_allows_two(env):
    log = env / "spans"
    for i in range(3):
        enqueue(env, log, f"build{i}", slots=["build:global"])  # build:global = 2
    dm = daemon()
    try:
        assert drain(3) == 3
    finally:
        dm.kill()
        dm.wait()
    assert peak_overlap(log) == 2, "build:global ran 2 at a time per [slots] config"


def test_unknown_slot_key_defaults_to_1(env, tmp_path, monkeypatch):
    cfg = env / "config.toml"
    cfg.write_text("[slots]\n'tool:vitest' = 1\n")  # no entry for tool:audit
    log = env / "spans"
    for i in range(2):
        enqueue(env, log, f"audit{i}", slots=["tool:audit"])
    dm = daemon()
    try:
        assert drain(2) == 2
    finally:
        dm.kill()
        dm.wait()
    assert peak_overlap(log) == 1, "undeclared slot keys default to limit 1"


def test_missing_config_file_still_claims(env):
    os.environ["FLEET_CONFIG"] = str(env / "nope.toml")
    try:
        log = env / "spans"
        enqueue(env, log, "a", slots=["tool:vitest"])
        dm = daemon()
        try:
            assert drain(1) == 1
        finally:
            dm.kill()
            dm.wait()
    finally:
        os.environ.pop("FLEET_CONFIG", None)
