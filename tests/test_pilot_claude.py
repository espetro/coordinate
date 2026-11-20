"""Pilot on the `claude` agent: acp job, kill -9 daemon and agent group mid-task, restart, same session resumes.

Real Claude via fleet-acp's registry (isolated CLAUDE_CONFIG_DIR, bypassPermissions), throwaway git repo
with a local branch, nothing pushed. Skips without Claude credentials (env token, macOS Keychain entry, or ~/.claude/.credentials.json on Linux).
The isolated config dir lives under tmp (FLEET_ACP_HOME) and is deleted afterwards. Model defaults to haiku
to keep the cost down; override with FLEET_PILOT_CLAUDE_MODEL.
"""
import os
import shutil
import signal
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

from fleet import cli
from pilot_helpers import Sampler, git, row, wait_for

FLEET_ACP = Path(os.environ.get("FLEET_ACP_DIR", Path(__file__).resolve().parents[2] / "fleet-acp"))
BIN = FLEET_ACP / "bin" / "fleet-acp.js"


def have_credentials():
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"):
        return True
    if sys.platform != "darwin":
        return (Path.home() / ".claude" / ".credentials.json").is_file()
    # metadata lookup only: no -w, so the secret is never read here
    return subprocess.run(["security", "find-generic-password", "-s", "Claude Code-credentials"],
                          capture_output=True).returncode == 0


pytestmark = pytest.mark.skipif(
    shutil.which("node") is None or not BIN.exists()
    or not (FLEET_ACP / "node_modules" / "@zed-industries").exists() or not have_credentials(),
    reason="needs node, a fleet-acp checkout with deps and Claude credentials")


def test_claude_job_survives_daemon_and_agent_kill9(tmp_path, monkeypatch):
    slug = f"pilot-{uuid.uuid4().hex[:8]}"
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.name", "pilot")
    git(repo, "config", "user.email", "pilot@example.invalid")
    (repo / "README.md").write_text("pilot\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "init")
    git(repo, "checkout", "-q", "-b", f"pilot/{slug}")

    acp_home = tmp_path / "fleet-acp-home"
    monkeypatch.setenv("FLEET_ACP_HOME", str(acp_home))
    monkeypatch.setenv("ANTHROPIC_MODEL", os.environ.get("FLEET_PILOT_CLAUDE_MODEL", "claude-haiku-5-5"))
    monkeypatch.setenv("FLEET_DB", str(tmp_path / "queue.db"))
    monkeypatch.setenv("FLEET_LEASE_S", "3")
    monkeypatch.setenv("FLEET_CAP", "3")
    monkeypatch.setenv("FLEET_ACP_CMD", f"node {BIN}")
    prompt = (
        "Do these steps in order, each as its own separate foreground Bash command, never in the background. "
        + " ".join(f"Step {n}: run \"echo {n} > file{n}.txt; sleep 8\"." for n in range(1, 5))
        + " Step 5: run \"git add -A && git commit -m 'pilot: add files'\". Never push. Reply DONE when finished.")
    sampler = Sampler(str(repo))
    d1 = d2 = None
    try:
        assert cli.main(["enqueue", "--acp", "claude", "--cwd", str(repo), "--prompt", prompt]) == 0
        env = os.environ.copy()
        d1 = subprocess.Popen([sys.executable, "-m", "fleet", "daemon"], env=env,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        sampler.start()

        session = wait_for(lambda: row(1)[2].get("session"), 120)
        assert session, "sessionId should be persisted in the payload while the job runs"
        pidfile = tmp_path / "pids" / "1.agent"
        assert wait_for(lambda: len(list(repo.glob("file*.txt"))) >= 2, 180), "task should be underway"
        assert not (repo / "file4.txt").exists(), "task must not finish before the kill"
        attempt1 = {p for _, ps in sampler.samples for p in ps}
        assert attempt1, "fleet-acp process should have been visible"

        agent_pid = int(pidfile.read_text())
        d1.send_signal(signal.SIGKILL)
        d1.wait()
        os.killpg(agent_pid, signal.SIGKILL)
        assert row(1)[0] == "running", "lease is orphaned, nobody finished the job"

        d2 = subprocess.Popen([sys.executable, "-m", "fleet", "daemon"], env=env,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        assert wait_for(lambda: row(1)[0] in ("done", "failed", "dead"), 400, 1), "job should reach a terminal state"
        status, attempts, payload = row(1)
        assert (status, attempts) == ("done", 2)
        assert payload["session"] == session, "resume keeps the same session id"
    finally:
        sampler.stop.set()
        for d in (d1, d2):
            if d and d.poll() is None:
                d.kill()
                d.wait()
        subprocess.run(["pkill", "-9", "-f", f"fleet-acp.js run.*{repo}"], check=False)
        shutil.rmtree(acp_home, ignore_errors=True)  # holds a copy of the credentials

    # never two attempts at once, and attempt 1 was gone before attempt 2 appeared
    assert max(len(ps) for _, ps in sampler.samples) <= 1
    attempt2 = {p for _, ps in sampler.samples for p in ps} - attempt1
    assert attempt2, "a second fleet-acp process should have run"
    first_seen2 = min(t for t, ps in sampler.samples if ps & attempt2)
    assert not any(ps & attempt1 for t, ps in sampler.samples if t >= first_seen2)

    branch = f"pilot/{slug}"
    log = git(repo, "log", branch, "--format=%s").splitlines()
    assert "pilot: add files" in log and log[-1] == "init"
    assert set(git(repo, "ls-tree", "-r", "--name-only", branch).split()) >= {f"file{n}.txt" for n in range(1, 5)}
