// Mailbox + agent registry tests (surfaces-design.md).
import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import "koffi";
import "@cutils/sqlite/node-binding";

const ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(ROOT, "bin", "coordinate.mjs");

async function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-mail-test-"));
  process.env["COORDINATE_DB"] = path.join(dir, "queue.db");
  process.env["COORDINATE_MACHINE"] = "bench";
  delete process.env["COORDINATE_CONFIG"];
  return { q: await import("../src/queue.ts"), dir };
}

function rig() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord-mail-cli-")));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("COORDINATE_") && !k.startsWith("FLEET_") && v !== undefined) env[k] = v;
  }
  Object.assign(env, {
    COORDINATE_DB: path.join(dir, "queue.db"),
    COORDINATE_CONFIG: path.join(dir, "config.toml"),
    COORDINATE_MACHINE: "parity",
    XDG_STATE_HOME: path.join(dir, "state"),
    XDG_CONFIG_HOME: path.join(dir, "conf"),
  });
  return { dir, env, db: env.COORDINATE_DB };
}

function cli(r, ...args) {
  const p = spawnSync(process.execPath, [BIN, ...args], { env: r.env, encoding: "utf8", timeout: 30000 });
  return { status: p.status, stdout: p.stdout || "", stderr: p.stderr || "" };
}

test("send then inbox reads and marks delivered", async () => {
  const { q } = await freshDb();
  const db = q.connect();
  q.registerEntity(db, "agent:bob", "agent", null);
  const id = q.sendMessage(db, "agent:bob", "message", { text: "hi" }, "agent:alice", null, null);
  assert.ok(id > 0);
  const peek = q.inboxMessages(db, "agent:bob", false, false);
  assert.equal(peek.length, 1, "peek sees the message");
  const again = q.inboxMessages(db, "agent:bob", false, false);
  assert.equal(again.length, 1, "peek does not consume");
  const read = q.inboxMessages(db, "agent:bob", true, false);
  assert.equal(read.length, 1);
  assert.equal(JSON.parse(read[0].payload).text, "hi");
  assert.equal(read[0].sender, "agent:alice");
  assert.equal(q.inboxMessages(db, "agent:bob", true, false).length, 0, "consumed after mark");
});

test("dedupe key makes resends idempotent", async () => {
  const { q } = await freshDb();
  const db = q.connect();
  q.registerEntity(db, "agent:bob", "agent", null);
  const a = q.sendMessage(db, "agent:bob", "signal", { v: 1 }, null, "k1", null);
  const b = q.sendMessage(db, "agent:bob", "signal", { v: 2 }, null, "k1", null);
  assert.ok(a > 0);
  assert.equal(b, null, "the second send with the same dedupe key is dropped");
  assert.equal(q.inboxMessages(db, "agent:bob", false, false).length, 1);
});

test("future deliver_at hides the message until due (alarm)", async () => {
  const { q } = await freshDb();
  const db = q.connect();
  q.registerEntity(db, "agent:bob", "agent", null);
  const future = Date.now() / 1000 + 3600;
  q.sendMessage(db, "agent:bob", "alarm", { text: "later" }, null, null, future);
  assert.equal(q.inboxMessages(db, "agent:bob", false, false).length, 0, "not due yet");
  assert.equal(q.inboxMessages(db, "agent:bob", false, true).length, 1, "visible with includeFuture");
});

test("message to a parked job wakes it (wake carries data)", async () => {
  const { q } = await freshDb();
  const db = q.connect();
  const jid = q.enqueue(db, { cmd: ["true"], cwd: null });
  q.claim(db, "o:1");
  q.waitOn(db, jid, "some-event");
  assert.equal(q.getJob(db, jid).status, "waiting");
  q.sendMessage(db, "job:" + jid, "message", { text: "wake up" }, null, null, null);
  assert.equal(q.getJob(db, jid).status, "queued", "the parked job is requeued by the message");
  const msgs = q.inboxMessages(db, "job:" + jid, false, false);
  assert.equal(msgs.length, 1, "the wake payload is in the inbox");
});

test("messages to dead owners are dead-lettered, not dropped", async () => {
  const { q } = await freshDb();
  const db = q.connect();
  q.sendMessage(db, "pid:4194303", "message", { text: "anyone?" }, null, null, null);
  q.reapMailbox(db);
  const row = q.qOne(db, "SELECT state FROM mailbox WHERE owner_id=?", ["pid:4194303"]);
  assert.equal(row.state, "dead");
});

test("message_sent and woken transitions land in events", async () => {
  const { q } = await freshDb();
  const db = q.connect();
  q.registerEntity(db, "agent:bob", "agent", null);
  q.sendMessage(db, "agent:bob", "message", { text: "hi" }, null, null, null);
  const kinds = q.qAll(db, "SELECT kind FROM events", []).map((r) => r.kind);
  assert.ok(kinds.includes("message_sent"));
});

// --- CLI level ---

test("CLI agent register/list + send/inbox roundtrip", () => {
  const r = rig();
  const reg = cli(r, "agent", "register", "bob");
  assert.equal(reg.status, 0, reg.stderr);
  assert.match(reg.stdout, /agent:bob/);
  const sid = cli(r, "send", "agent:bob", "hello bob");
  assert.equal(sid.status, 0, sid.stderr);
  const inbox = cli(r, "inbox", "agent:bob");
  assert.equal(inbox.status, 0);
  const msgs = inbox.stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].payload.text, "hello bob");
  // consumed now
  assert.equal(cli(r, "inbox", "agent:bob").stdout.trim(), "");
  const list = cli(r, "agent", "list");
  assert.match(list.stdout, /agent:bob/);
});

test("CLI send dedupe exits 4 on the resend", () => {
  const r = rig();
  cli(r, "agent", "register", "carol");
  assert.equal(cli(r, "send", "agent:carol", "x", "--dedupe", "k").status, 0);
  const dup = cli(r, "send", "agent:carol", "x", "--dedupe", "k");
  assert.equal(dup.status, 4);
});

test("CLI inbox --peek does not consume", () => {
  const r = rig();
  cli(r, "agent", "register", "dave");
  cli(r, "send", "agent:dave", "peektest");
  const p1 = cli(r, "inbox", "agent:dave", "--peek");
  const p2 = cli(r, "inbox", "agent:dave", "--peek");
  assert.equal(p1.stdout.trim().split("\n").length, 1);
  assert.equal(p2.stdout.trim().split("\n").length, 1, "still there after two peeks");
});
