// ACP protocol + job lifecycle unit tests under node --test, no real agent: the stub
// agent in test/fixtures/stub_acp_agent.mjs (a JS port of bench/stub_acp_agent.py) is
// spawned as a child process, so framing, session persistence and resume run against
// the real stdio JSON-RPC path.
import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import "koffi";
import "@cutils/sqlite/node-binding";

let counter = 0;

async function freshDb() {
  counter += 1;
  process.env["COORDINATE_LEASE_S"] = "30";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-acp-test-"));
  process.env["COORDINATE_DB"] = path.join(dir, "queue.db");
  process.env["COORDINATE_MACHINE"] = "bench";
  process.env["COORDINATE_CAP"] = "3";
  process.env["COORDINATE_REPO_CAP"] = "1";
  delete process.env["COORDINATE_CONFIG"];
  delete process.env["COORDINATE_ACP_CMD"];
  return await import("../src/acp.ts");
}

async function freshQueue() {
  counter += 1;
  process.env["COORDINATE_LEASE_S"] = "30";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-acp-q-"));
  process.env["COORDINATE_DB"] = path.join(dir, "queue.db");
  process.env["COORDINATE_MACHINE"] = "bench";
  process.env["COORDINATE_CAP"] = "3";
  process.env["COORDINATE_REPO_CAP"] = "1";
  delete process.env["COORDINATE_CONFIG"];
  delete process.env["COORDINATE_ACP_CMD"];
  return await import("../src/queue.ts");
}

const STUB = path.resolve(import.meta.dirname, "fixtures", "stub_acp_agent.mjs");

function stubRegistry(dir) {
  const file = path.join(dir, "agents.json");
  fs.writeFileSync(file, JSON.stringify({ stub: { command: process.execPath, args: [STUB] } }));
  return file;
}

// wait until fn() returns non-null-ish
async function waitFor(fn, ms = 15000, step = 50) {
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

test("parseAgentLine: responses, notifications and noise", async () => {
  const acp = await freshDb();
  const r = acp.parseAgentLine('{"jsonrpc":"2.0","id":1,"result":{"sessionId":"s1"}}');
  assert.ok(r !== null && r.response !== null);
  assert.equal(r.response.id, 1);
  assert.equal(r.response.result["sessionId"], "s1");
  const e = acp.parseAgentLine('{"jsonrpc":"2.0","id":2,"error":{"code":-32001,"message":"nope"}}');
  assert.ok(e !== null && e.response !== null && e.response.error !== null);
  assert.equal(e.response.error.code, -32001);
  const n = acp.parseAgentLine('{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1"}}');
  assert.ok(n !== null && n.notification !== null);
  assert.equal(n.notification.method, "session/update");
  assert.equal(n.notification.params["sessionId"], "s1");
  assert.equal(acp.parseAgentLine(""), null);
  assert.equal(acp.parseAgentLine("not json at all"), null);
  assert.equal(acp.parseAgentLine("  "), null);
});

test("stopReasonOf defaults to end_turn", async () => {
  const acp = await freshDb();
  assert.equal(acp.stopReasonOf(null), "end_turn");
  assert.equal(acp.stopReasonOf({}), "end_turn");
  assert.equal(acp.stopReasonOf({ stopReason: "cancelled" }), "cancelled");
});

test("acp client runs a full turn against the stub agent", { timeout: 30000 }, async () => {
  const acp = await freshDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-acp-turn-"));
  const registry = stubRegistry(dir);
  const specs = acp.loadRegistry(registry);
  assert.ok("stub" in specs);
  const cmd = acp.agentCommand(specs["stub"]);
  assert.equal(cmd[0], process.execPath);

  const cp = await import("node:child_process");
  const proc = cp.spawn(cmd[0], cmd.slice(1), { cwd: dir, stdio: ["pipe", "pipe", "inherit"] });
  const updates = [];
  const client = new acp.AcpClient(proc, (n) => {
    updates.push(n.method);
  });
  await client.initialize();
  const sid = await client.newSession(dir);
  assert.ok(sid.startsWith("stub-"));
  const stop = await client.prompt(sid, "do the thing");
  assert.equal(stop, "end_turn");
  assert.ok(updates.indexOf("session/update") >= 0, "streamed updates should have arrived");
  // resume path: the SAME session id loads in a fresh agent process
  const proc2 = cp.spawn(cmd[0], cmd.slice(1), { cwd: dir, stdio: ["pipe", "pipe", "inherit"] });
  const client2 = new acp.AcpClient(proc2, () => {});
  await client2.initialize();
  await client2.loadSession(sid, dir);
  const stop2 = await client2.prompt(sid, "continue");
  assert.equal(stop2, "end_turn");
  const state = JSON.parse(fs.readFileSync(path.join(dir, ".stub-acp-sessions.json"), "utf8"));
  assert.equal(state.sessions[sid].turns_done, 2);
  assert.equal(state.sessions[sid].loads, 1);
  for (const p of [proc, proc2]) {
    p.kill("SIGKILL");
  }
});

test("loadSession rejects an unknown session", { timeout: 15000 }, async () => {
  const acp = await freshDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-acp-unk-"));
  const registry = stubRegistry(dir);
  const specs = acp.loadRegistry(registry);
  const cmd = acp.agentCommand(specs["stub"]);
  const cp = await import("node:child_process");
  const proc = cp.spawn(cmd[0], cmd.slice(1), { cwd: dir, stdio: ["pipe", "pipe", "inherit"] });
  const client = new acp.AcpClient(proc, () => {});
  await client.initialize();
  await assert.rejects(() => client.loadSession("nope", dir), /unknown session/);
  proc.kill("SIGKILL");
});

test("acpPayloadOf reads the enqueue payload shape", async () => {
  const acp = await freshDb();
  const p = acp.acpPayloadOf({
    cmd: [],
    cwd: "/tmp/x",
    repo: null,
    slots: null,
    session: null,
    agent: "stub",
    prompt: "hi",
    registry: "/tmp/agents.json",
  });
  assert.equal(p.agent, "stub");
  assert.equal(p.cwd, "/tmp/x");
  assert.equal(p.prompt, "hi");
  assert.equal(p.registry, "/tmp/agents.json");
  assert.equal(p.session, null);
  const noSession = acp.acpPayloadOf({ cmd: [], cwd: null, agent: "stub", prompt: "hi" });
  assert.equal(noSession.session, null);
});

test("enqueue persists kind=acp and setSession persists the session id", async () => {
  const q = await freshQueue();
  const db = q.connect();
  const payload = { cmd: [], cwd: "/tmp/x", repo: null, slots: null, session: null, agent: "stub", prompt: "hi" };
  const jid = q.enqueue(db, payload, 0, 3, null, null, "acp");
  const job = q.getJob(db, jid);
  assert.equal(job.kind, "acp");
  assert.equal(JSON.parse(job.payload)["agent"], "stub");
  const got = q.claim(db, "o:1");
  assert.equal(got.jid, jid);
  assert.equal(got.kind, "acp");
  q.setSession(db, jid, "o:1", "stub-123");
  const after = q.getJob(db, jid);
  assert.equal(JSON.parse(after.payload)["session"], "stub-123");
});

test("startAcpJob persists the session and reports completion", { timeout: 30000 }, async () => {
  const acp = await freshDb();
  const q = await import("../src/queue.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-acp-job-"));
  const registry = stubRegistry(dir);
  const db = q.connect();
  const payload = { cmd: [], cwd: dir, repo: null, slots: null, session: null, agent: "stub", prompt: "hi", registry };
  const jid = q.enqueue(db, payload, 0, 3, null, null, "acp");
  const got = q.claim(db, "o:1");
  assert.equal(got.jid, jid);
  const env = { PATH: process.env["PATH"] || "", STUB_TURN_MS: "200" };
  const handle = acp.startAcpJob(db, jid, "o:1", acp.acpPayloadOf(got.payload), env);
  const sid = await waitFor(() => (handle.sessionId === null ? null : handle.sessionId));
  assert.ok(sid !== null, "sessionId should be known after session/new");
  await waitFor(() => handle.settled);
  assert.equal(handle.done, true);
  assert.equal(handle.failure, null);
  // the session id was persisted into the job payload for the resume path
  const job = q.getJob(db, jid);
  assert.equal(JSON.parse(job.payload)["session"], sid);
  const state = JSON.parse(fs.readFileSync(path.join(dir, ".stub-acp-sessions.json"), "utf8"));
  assert.equal(state.sessions[sid].turns_done, 1);
});

// Real-agent test, ported from legacy/python tests/test_pilot_acp.py. Gated behind
// COORDINATE_ACP_REAL=1 plus a COORDINATE_ACP_REAL_AGENT spec (see docs); skipped
// otherwise because it needs a real ACP harness on PATH.
test("real agent job (gated)", { timeout: 120000 }, async () => {
  const spec = process.env["COORDINATE_ACP_REAL_AGENT"];
  if (process.env["COORDINATE_ACP_REAL"] !== "1" || spec === undefined || spec === "") {
    return; // skipped
  }
  const parsed = JSON.parse(spec);
  const acp = await freshDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-acp-real-"));
  const registry = path.join(dir, "agents.json");
  fs.writeFileSync(registry, JSON.stringify({ real: parsed }));
  const q = await import("../src/queue.ts");
  const db = q.connect();
  const payload = { cmd: [], cwd: dir, repo: null, slots: null, session: null, agent: "real", prompt: "Reply with the single word DONE.", registry };
  const jid = q.enqueue(db, payload, 0, 3, null, null, "acp");
  const got = q.claim(db, "o:1");
  const handle = acp.startAcpJob(db, jid, "o:1", acp.acpPayloadOf(got.payload), process.env);
  await waitFor(() => handle.settled, 90000);
  assert.equal(handle.done, true);
  assert.equal(handle.failure, null);
});
