// ACP parity suite: the daemon-side lane against the stub agent, keeping the Python test
// names where they map (tests/test_pilot_acp.py is the real-agent pilot and stays gated
// behind COORDINATE_ACP_REAL in test/acp.test.mjs). Everything runs the real CLI and the
// real daemon as child processes against a private rig, like test/parity/helpers.mjs.

import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { rig, cli, one } from "./helpers.mjs";

// helpers.mjs has no waitFor; a local poller.
async function waitFor(fn, ms = 30000, step = 100) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) {
      return v;
    }
    if (Date.now() > deadline) {
      return null;
    }
    await new Promise((r) => setTimeout(r, step));
  }
}

const STUB = path.resolve(import.meta.dirname, "..", "..", "fixtures", "stub_acp_agent.mjs");

function stubRig(turnMs) {
  const r = rig({ COORDINATE_LEASE_S: "2", STUB_TURN_MS: String(turnMs), STUB_CHUNKS: "5" });
  const registry = path.join(r.dir, "agents.json");
  fs.writeFileSync(registry, JSON.stringify({ stub: { command: process.execPath, args: [STUB] } }));
  return { r, registry };
}

test("test_acp_enqueue_runs_and_persists_session", { timeout: 60000 }, async () => {
  const { r, registry } = stubRig(300);
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(r.dir, "job-")));
  const out = cli(r, "enqueue", "--acp", "stub", "--cwd", cwd, "--prompt", "hi", "--registry", registry);
  assert.equal(out.status, 0, out.stderr);
  const jid = Number(out.stdout.trim());
  assert.ok(jid > 0);
  const row = one(r, "SELECT kind, payload FROM jobs WHERE id=" + jid);
  assert.equal(row.kind, "acp");
  assert.equal(JSON.parse(row.payload).agent, "stub");

  const d = spawnDaemon(r);
  try {
    const session = await waitFor(() => {
      const row2 = one(r, "SELECT payload FROM jobs WHERE id=" + jid);
      return JSON.parse(row2.payload).session;
    }, 20000);
    assert.ok(session, "sessionId should be persisted in the payload while the job runs");
    const done = await waitFor(() => {
      const st = one(r, "SELECT status FROM jobs WHERE id=" + jid);
      return st.status === "done";
    }, 30000);
    assert.ok(done, "job should reach done");
    const final = one(r, "SELECT attempts, payload FROM jobs WHERE id=" + jid);
    assert.equal(final.attempts, 1);
    assert.equal(JSON.parse(final.payload).session, session);
  } finally {
    stopDaemon(d);
  }
});

test("test_acp_kill9_daemon_restarts_same_session", { timeout: 90000 }, async () => {
  const { r, registry } = stubRig(6000); // long turn: the kill lands mid-turn
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(r.dir, "job-")));
  const out = cli(r, "enqueue", "--acp", "stub", "--cwd", cwd, "--prompt", "hi", "--registry", registry);
  assert.equal(out.status, 0, out.stderr);
  const jid = Number(out.stdout.trim());

  const d1 = spawnDaemon(r);
  let session = null;
  try {
    session = await waitFor(() => {
      const row = one(r, "SELECT payload FROM jobs WHERE id=" + jid);
      return JSON.parse(row.payload).session;
    }, 20000);
    assert.ok(session, "sessionId should be persisted before the kill");
  } finally {
    killDaemon(d1);
  }
  // lease (2s) expires; the second daemon reaps, requeues and resumes the SAME session
  const d2 = spawnDaemon(r);
  try {
    const done = await waitFor(() => {
      const st = one(r, "SELECT status FROM jobs WHERE id=" + jid);
      return st.status === "done";
    }, 60000);
    assert.ok(done, "job should reach done after the restart");
    const final = one(r, "SELECT attempts, payload FROM jobs WHERE id=" + jid);
    assert.equal(final.attempts, 2, "the requeued attempt should have run");
    assert.equal(JSON.parse(final.payload).session, session, "resume keeps the same session id");
    const state = JSON.parse(fs.readFileSync(path.join(cwd, ".stub-acp-sessions.json"), "utf8"));
    assert.equal(state.sessions[session].loads, 1, "the second attempt should have session/load'ed");
    assert.equal(state.sessions[session].turns_done, 1, "only one turn should count as done");
  } finally {
    stopDaemon(d2);
  }
});

test("test_acp_enqueue_requires_cwd_and_prompt", { timeout: 30000 }, () => {
  const { r, registry } = stubRig(100);
  const out = cli(r, "enqueue", "--acp", "stub", "--prompt", "hi", "--registry", registry);
  assert.notEqual(out.status, 0);
  assert.ok(out.stderr.includes("--cwd and --prompt are required"), out.stderr);
});

// --- daemon helpers (local: helpers.mjs startDaemon waits for readiness differently) ---
import { spawn } from "node:child_process";

function spawnDaemon(r) {
  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "..", "..", "bin", "coordinate.mjs"), "daemon"], {
    env: r.env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  return child;
}

function killDaemon(child) {
  if (child.exitCode === null) {
    child.kill("SIGKILL");
  }
}

function stopDaemon(child) {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
  }
}
