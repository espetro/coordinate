// Surfaces primitives tests: weighted semaphore leases, FIFO waits, cancellation,
// volatile-owner reaping. Each test gets its own temp DB; CLI-level cases use the
// real bin through node, like the parity suites.
import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import "koffi";
import "@cutils/sqlite/node-binding";

const ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(ROOT, "bin", "coordinate.mjs");

async function freshDb() {
  process.env["COORDINATE_LEASE_S"] = "30";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-lease-test-"));
  process.env["COORDINATE_DB"] = path.join(dir, "queue.db");
  process.env["COORDINATE_MACHINE"] = "bench";
  process.env["COORDINATE_CAP"] = "3";
  delete process.env["COORDINATE_CONFIG"];
  return { q: await import("../src/queue.ts"), dir };
}

// agent: owners are alive while their entity row is unexpired; register once per test use.
async function regent(q, db, id) {
  q.registerEntity(db, id, "agent", null);
}

function writeConfig(dir, text) {
  const p = path.join(dir, "config.toml");
  fs.writeFileSync(p, text);
  process.env["COORDINATE_CONFIG"] = p;
  return p;
}

function rig() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord-lease-cli-")));
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

test("immediate acquire grants when capacity is free", async () => {
  const { q } = await freshDb();
  const db = q.connect();
  await regent(q, db, "agent:a1");
  const g = q.acquireLease(db, "tool:vitest:proj", "agent:a1", 1);
  assert.notEqual(g, null);
  assert.equal(q.leaseUsedCost(db, "tool:vitest:proj"), 1);
});

test("weighted semaphore: cost sums against the key limit", async () => {
  const { q, dir } = await freshDb();
  writeConfig(dir, '[slots]\n"tool:vitest:*" = 4\n');
  const db = q.connect();
  for (const o of ["agent:a1", "agent:a2", "agent:a3"]) await regent(q, db, o);
  const g1 = q.acquireLease(db, "tool:vitest:p", "agent:a1", 2);
  const g2 = q.acquireLease(db, "tool:vitest:p", "agent:a2", 2);
  assert.notEqual(g1, null);
  assert.notEqual(g2, null);
  // 4 units used; a third cost-2 acquire cannot proceed immediately
  const g3 = q.acquireLease(db, "tool:vitest:p", "agent:a3", 2);
  assert.equal(g3, null);
  // a different key has its own independent semaphore
  const g4 = q.acquireLease(db, "tool:tsc:p", "agent:a3", 1);
  assert.notEqual(g4, null, "default limit 1 on an unused key grants");
  const g5 = q.acquireLease(db, "tool:tsc:p", "agent:a1", 1);
  assert.equal(g5, null, "and the second unit of the default-1 key does not");
  delete process.env["COORDINATE_CONFIG"];
});

test("FIFO waits drain in order when capacity frees", async () => {
  const { q, dir } = await freshDb();
  writeConfig(dir, '[slots]\n"tool:cargo:*" = 2\n');
  const db = q.connect();
  for (const o of ["agent:a1", "agent:a2", "agent:a3"]) await regent(q, db, o);
  const g = q.acquireLease(db, "tool:cargo:p", "agent:a1", 2);
  assert.notEqual(g, null);
  const w1 = q.enqueueWait(db, "tool:cargo:p", "agent:a2", 2, null);
  const w2 = q.enqueueWait(db, "tool:cargo:p", "agent:a3", 2, null);
  // release the initial grant: w1 must win, w2 still queued (FIFO)
  q.releaseLease(db, g);
  assert.equal(q.getWait(db, w1).state, "granted");
  assert.equal(q.getWait(db, w2).state, "queued");
  // releasing w1's grant then feeds w2
  const w1grant = q.getWait(db, w1).grant_id;
  q.releaseLease(db, w1grant);
  assert.equal(q.getWait(db, w2).state, "granted");
  delete process.env["COORDINATE_CONFIG"];
});

test("no barging: a newcomer queues behind waiters even when units are free", async () => {
  const { q, dir } = await freshDb();
  writeConfig(dir, '[slots]\n"tool:docker:*" = 3\n');
  const db = q.connect();
  for (const o of ["agent:a1", "agent:a2", "agent:a3"]) await regent(q, db, o);
  // one unit free (2 of 3 used), but a cost-2 waiter is already queued for the key
  q.acquireLease(db, "tool:docker:p", "agent:a1", 2);
  q.enqueueWait(db, "tool:docker:p", "agent:a2", 2, null);
  // a newcomer must not jump the queue even though its cost 1 would fit
  const g = q.acquireLease(db, "tool:docker:p", "agent:a3", 1);
  assert.equal(g, null);
  delete process.env["COORDINATE_CONFIG"];
});

test("wait deadlines expire the wait instead of granting", async () => {
  const { q, dir } = await freshDb();
  writeConfig(dir, '[slots]\n"tool:vitest:*" = 1\n');
  const db = q.connect();
  for (const o of ["agent:a1", "agent:a2"]) await regent(q, db, o);
  q.acquireLease(db, "tool:vitest:p", "agent:a1", 1);
  const past = Date.now() / 1000 - 1;
  const w = q.enqueueWait(db, "tool:vitest:p", "agent:a2", 1, past);
  q.drainWaits(db, "tool:vitest:p");
  assert.equal(q.getWait(db, w).state, "expired");
  delete process.env["COORDINATE_CONFIG"];
});

test("cancelWait transitions queued waits and grants skip them", async () => {
  const { q, dir } = await freshDb();
  writeConfig(dir, '[slots]\n"tool:vitest:*" = 1\n');
  const db = q.connect();
  for (const o of ["agent:a1", "agent:a2", "agent:a3"]) await regent(q, db, o);
  q.acquireLease(db, "tool:vitest:p", "agent:a1", 1);
  const w1 = q.enqueueWait(db, "tool:vitest:p", "agent:a2", 1, null);
  const w2 = q.enqueueWait(db, "tool:vitest:p", "agent:a3", 1, null);
  assert.equal(q.cancelWait(db, w1), true);
  assert.equal(q.getWait(db, w1).state, "cancelled");
  // free the unit: the cancelled w1 is skipped, w2 grants
  const leases = q.listLeases(db);
  q.releaseLease(db, leases[0].grant_id);
  assert.equal(q.getWait(db, w2).state, "granted");
  delete process.env["COORDINATE_CONFIG"];
});

test("dead pid owners are reaped: leases released and waits cancelled", async () => {
  const { q, dir } = await freshDb();
  writeConfig(dir, '[slots]\n"tool:vitest:*" = 2\n');
  const db = q.connect();
  // pid 2^22 almost certainly does not exist; use a definitely-dead high pid
  const dead = "pid:4194303";
  q.registerEntity(db, dead, "process", null);
  const g = q.acquireLease(db, "tool:vitest:p", dead, 1);
  assert.notEqual(g, null);
  const w = q.enqueueWait(db, "tool:vitest:p", dead, 1, null);
  const freed = q.reapEntities(db);
  assert.deepEqual(freed, ["tool:vitest:p"]);
  assert.equal(q.leaseUsedCost(db, "tool:vitest:p"), 0);
  assert.equal(q.getWait(db, w).state, "cancelled");
  delete process.env["COORDINATE_CONFIG"];
});

test("live pid owners are not reaped", async () => {
  const { q } = await freshDb();
  const db = q.connect();
  const me = "pid:" + process.pid;
  q.registerEntity(db, me, "process", null);
  const g = q.acquireLease(db, "tool:vitest:p2", me, 1);
  assert.notEqual(g, null);
  q.reapEntities(db);
  assert.equal(q.leaseUsedCost(db, "tool:vitest:p2"), 1, "the live owner's lease survives");
});

test("lease TTL expiry frees the units", async () => {
  const { q } = await freshDb();
  const db = q.connect();
  await regent(q, db, "agent:a1");
  const g = q.acquireLease(db, "tool:vitest:p3", "agent:a1", 1);
  assert.notEqual(g, null);
  // force the grant into the past and re-run maintenance
  q.qRun(db, "UPDATE leases SET lease_expires_at=?", [Date.now() / 1000 - 1]);
  const freed = q.expireLeases(db);
  assert.deepEqual(freed, ["tool:vitest:p3"]);
  assert.equal(q.leaseUsedCost(db, "tool:vitest:p3"), 0);
});

test("refresh extends the lease so it survives expiry sweeps", async () => {
  const { q } = await freshDb();
  const db = q.connect();
  const g = q.acquireLease(db, "tool:vitest:p4", "pid:" + process.pid, 1);
  q.qRun(db, "UPDATE leases SET lease_expires_at=?", [Date.now() / 1000 + 0.5]);
  assert.equal(q.refreshLease(db, g), true);
  q.expireLeases(db);
  assert.equal(q.leaseUsedCost(db, "tool:vitest:p4"), 1, "refreshed lease still counted");
});

test("jobs and external owners share one accounting space", async () => {
  const { q, dir } = await freshDb();
  writeConfig(dir, '[slots]\n"tool:shared" = 1\n');
  const db = q.connect();
  // external owner holds the only unit
  const g = q.acquireLease(db, "tool:shared", "pid:" + process.pid, 1);
  assert.notEqual(g, null);
  // a job whose static slot is the same key cannot be claimed
  const jid = q.enqueue(db, { cmd: ["true"], cwd: null, slots: ["tool:shared"] });
  assert.equal(q.claim(db, "o:1"), null, "the external lease blocks the job claim");
  q.releaseLease(db, g);
  const got = q.claim(db, "o:1");
  assert.equal(got === null ? -1 : got.jid, jid, "after release the job claims");
  delete process.env["COORDINATE_CONFIG"];
});

test("job claims write leases rows owned by the job entity", async () => {
  const { q } = await freshDb();
  const db = q.connect();
  const jid = q.enqueue(db, { cmd: ["true"], cwd: "/tmp" });
  const got = q.claim(db, "o:1");
  assert.equal(got.jid, jid);
  const leases = q.listLeases(db).filter((l) => l.owner_id === "job:" + jid);
  assert.ok(leases.length >= 2, "machine + repo leases at minimum");
  const ent = q.getEntity(db, "job:" + jid);
  assert.notEqual(ent, null, "the job is a registered entity");
});

test("job finish drops leases and dead job owners read as not alive", async () => {
  const { q } = await freshDb();
  const db = q.connect();
  const jid = q.enqueue(db, { cmd: ["true"], cwd: "/tmp" });
  q.claim(db, "o:1");
  assert.equal(q.ownerIsAlive(db, "job:" + jid), true);
  q.finish(db, jid, "o:1", "done");
  assert.equal(q.listLeases(db).filter((l) => l.owner_id === "job:" + jid).length, 0);
  assert.equal(q.ownerIsAlive(db, "job:" + jid), false);
});

// --- CLI-level tests against the real binary ---

test("CLI acquire prints a grant and release accepts it", () => {
  const r = rig();
  fs.writeFileSync(path.join(r.dir, "config.toml"), '[slots]\n"tool:cli" = 2\n');
  const out = cli(r, "lease", "acquire", "tool:cli", "--cost", "1", "--owner", "pid:" + process.pid);
  assert.equal(out.status, 0, out.stderr);
  const grant = JSON.parse(out.stdout);
  assert.equal(grant.key, "tool:cli");
  assert.equal(grant.cost, 1);
  const rel = cli(r, "lease", "release", grant.grant_id);
  assert.equal(rel.status, 0, rel.stderr);
});

test("CLI acquire with cost above the limit exits 4 without waiting", () => {
  const r = rig();
  fs.writeFileSync(path.join(r.dir, "config.toml"), '[slots]\n"tool:cli" = 1\n');
  const out = cli(r, "lease", "acquire", "tool:cli", "--cost", "2", "--owner", "pid:" + process.pid);
  assert.equal(out.status, 4);
  assert.match(out.stderr, /ungrantable/);
});

test("CLI waiter eventually grants after the holder releases", async () => {
  const r = rig();
  fs.writeFileSync(path.join(r.dir, "config.toml"), '[slots]\n"tool:cli" = 1\n');
  const first = cli(r, "lease", "acquire", "tool:cli", "--owner", "pid:" + process.pid);
  assert.equal(first.status, 0);
  const grant = JSON.parse(first.stdout);
  // a second acquirer in the background must wait, then grant on release
  const child = spawn(process.execPath, [BIN, "lease", "acquire", "tool:cli", "--wait", "20s", "--owner", "pid:" + process.pid], {
    env: r.env,
    encoding: "utf8",
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const done = new Promise((res) => child.on("exit", res));
  // still waiting after a moment
  await new Promise((res) => setTimeout(res, 600));
  assert.equal(child.exitCode, null, "the second acquirer is parked behind the first grant");
  cli(r, "lease", "release", grant.grant_id);
  const code = await done;
  assert.equal(code, 0, "granted after release; stderr: " + stderr);
  const g2 = JSON.parse(stdout);
  assert.ok(g2.wait_id !== null, "grant came through the wait queue");
});

test("CLI acquire times out with exit 3 when capacity never frees", async () => {
  const r = rig();
  fs.writeFileSync(path.join(r.dir, "config.toml"), '[slots]\n"tool:cli" = 1\n');
  const first = cli(r, "lease", "acquire", "tool:cli", "--owner", "pid:" + process.pid);
  assert.equal(first.status, 0);
  const out = cli(r, "lease", "acquire", "tool:cli", "--wait", "1s", "--owner", "pid:" + process.pid);
  assert.equal(out.status, 3, "stdout: " + out.stdout + " stderr: " + out.stderr);
  assert.match(out.stderr, /timeout/);
}, { timeout: 20000 });

test("CLI lease list and waits show live state as NDJSON", () => {
  const r = rig();
  const a = cli(r, "lease", "acquire", "tool:cli2", "--owner", "pid:" + process.pid);
  assert.equal(a.status, 0);
  const list = cli(r, "lease", "list");
  assert.equal(list.status, 0);
  const rows = list.stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, "tool:cli2");
});

test("CLI events carry lease lifecycle transitions", () => {
  const r = rig();
  const a = cli(r, "lease", "acquire", "tool:cli3", "--owner", "pid:" + process.pid);
  const grant = JSON.parse(a.stdout);
  cli(r, "lease", "release", grant.grant_id);
  const ev = cli(r, "events");
  assert.match(ev.stdout, /lease_granted/);
  assert.match(ev.stdout, /lease_released/);
});

// --- coordinate run: the enforcement adapter ---

function fakeTool(r, name, body) {
  const bin = path.join(r.dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const p = path.join(bin, name);
  fs.writeFileSync(p, "#!/bin/sh\n" + body + "\n");
  fs.chmodSync(p, 0o755);
  r.env["PATH"] = bin + ":" + r.env["PATH"];
  return p;
}

test("run passes unmatched commands through with their exit code", () => {
  const r = rig();
  const out = cli(r, "run", "--", "sh", "-c", "exit 3");
  assert.equal(out.status, 3);
  const ok = cli(r, "run", "--", "sh", "-c", "echo hi");
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /hi/);
  // no lease state created
  assert.equal(cli(r, "lease", "list").stdout.trim(), "");
});

test("run wraps a heavy tool in a lease and releases it at exit", () => {
  const r = rig();
  fs.writeFileSync(path.join(r.dir, "config.toml"), '[slots]\n"tool:vitest:*" = 2\n');
  fakeTool(r, "vitest", "echo ran-vitest");
  const out = cli(r, "run", "--", "vitest", "run");
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /ran-vitest/);
  assert.equal(cli(r, "lease", "list").stdout.trim(), "", "the lease is released when the tool exits");
});

test("two concurrent heavy runs serialize on the semaphore", async () => {
  const r = rig();
  fs.writeFileSync(path.join(r.dir, "config.toml"), '[slots]\n"tool:vitest:*" = 2\n');
  fakeTool(r, "vitest", "sleep 1; echo done-$1");
  const spawnRun = (tag) => {
    const child = spawn(process.execPath, [BIN, "run", "--", "vitest", tag], { env: r.env, encoding: "utf8" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    return { child, done: new Promise((res) => child.on("exit", res)), out: () => stdout, err: () => stderr };
  };
  const a = spawnRun("a");
  await new Promise((res) => setTimeout(res, 400));
  const b = spawnRun("b");
  await new Promise((res) => setTimeout(res, 300));
  assert.match(b.err(), /waiting for tool:vitest/, "the second run waits instead of double-booking");
  const ca = await a.done;
  const cb = await b.done;
  assert.equal(ca, 0);
  assert.equal(cb, 0);
  assert.match(a.out(), /done-a/);
  assert.match(b.out(), /done-b/);
  assert.equal(cli(r, "lease", "list").stdout.trim(), "", "no lease leaks after both runs");
}, { timeout: 20000 });

test("run --key/--cost bypass classification for unlisted heavy commands", () => {
  const r = rig();
  fs.writeFileSync(path.join(r.dir, "config.toml"), '[slots]\n"deploy:prod" = 1\n');
  const out = cli(r, "run", "--key", "deploy:prod", "--cost", "1", "--", "sh", "-c", "echo deploying");
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /deploying/);
});
