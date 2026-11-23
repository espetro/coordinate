// Queue core tests under node --test. Each test gets its own temp DB.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-ts-test-"));
  process.env["COORDINATE_DB"] = path.join(dir, "queue.db");
  process.env["COORDINATE_MACHINE"] = "bench";
  process.env["COORDINATE_CAP"] = "3";
  process.env["COORDINATE_REPO_CAP"] = "1";
  delete process.env["COORDINATE_CONFIG"];
  return await import("../src/queue.ts");
}

test("enqueue + claim respects priority and run_at order", async () => {
  const q = await freshDb();
  const db = q.connect();
  const a = q.enqueue(db, { cmd: ["true"], cwd: null }, 0);
  const b = q.enqueue(db, { cmd: ["true"], cwd: null }, 9);
  const c = q.enqueue(db, { cmd: ["true"], cwd: null }, 5);
  const got1 = q.claim(db, "o:1");
  assert.equal(got1 === null ? -1 : got1.jid, b);
  const got2 = q.claim(db, "o:1");
  assert.equal(got2 === null ? -1 : got2.jid, c);
  const got3 = q.claim(db, "o:1");
  assert.equal(got3 === null ? -1 : got3.jid, a);
  const got4 = q.claim(db, "o:1");
  assert.equal(got4, null);
});

test("machine cap blocks claims", async () => {
  const q = await freshDb();
  process.env["COORDINATE_CAP"] = "1";
  const db = q.connect();
  q.enqueue(db, { cmd: ["true"], cwd: null });
  assert.notEqual(q.claim(db, "o:1"), null);
  q.enqueue(db, { cmd: ["true"], cwd: null });
  assert.equal(q.claim(db, "o:2"), null);
  process.env["COORDINATE_CAP"] = "3";
});

test("repo cap: one repo at a time", async () => {
  const q = await freshDb();
  const db = q.connect();
  q.enqueue(db, { cmd: ["true"], cwd: null, repo: "/tmp/shared-repo" });
  q.enqueue(db, { cmd: ["true"], cwd: null, repo: "/tmp/shared-repo" });
  q.enqueue(db, { cmd: ["true"], cwd: null, repo: "/tmp/other-repo" });
  assert.notEqual(q.claim(db, "o:1"), null);
  const second = q.claim(db, "o:1");
  assert.notEqual(second, null);
  // second claim must be the OTHER repo (repo cap 1)
  assert.equal(second !== null ? second.payload.repo : "", "/tmp/other-repo");
  assert.equal(q.claim(db, "o:1"), null);
});

test("wait-on frees slots, release requeues", async () => {
  const q = await freshDb();
  const db = q.connect();
  const jid = q.enqueue(db, { cmd: ["true"], cwd: null, repo: "/tmp/wr" });
  assert.notEqual(q.claim(db, "o:1"), null);
  assert.equal(q.waitOn(db, jid, "evt"), true);
  assert.equal(q.claim(db, "o:2"), null); // slot freed... but job is waiting, nothing queued
  const woken = q.release(db, "evt");
  assert.deepEqual(woken, [jid]);
  assert.notEqual(q.claim(db, "o:3"), null);
});

test("wait-on a running job loses its lease (heartbeat fails)", async () => {
  const q = await freshDb();
  const db = q.connect();
  const jid = q.enqueue(db, { cmd: ["true"], cwd: null });
  q.claim(db, "o:1");
  q.waitOn(db, jid, "evt");
  assert.equal(q.heartbeat(db, jid, "o:1"), false);
});

test("cancel a queued job", async () => {
  const q = await freshDb();
  const db = q.connect();
  const jid = q.enqueue(db, { cmd: ["true"], cwd: null });
  assert.equal(q.cancel(db, jid), true);
  assert.deepEqual(q.stats(db), { failed: 1 });
  assert.equal(q.cancel(db, jid), false); // terminal already
});

test("finish records status and drops leases", async () => {
  const q = await freshDb();
  const db = q.connect();
  const jid = q.enqueue(db, { cmd: ["true"], cwd: null, repo: "/tmp/fr" });
  q.claim(db, "o:1");
  const event = q.finish(db, jid, "o:1", "done");
  assert.equal(event, null); // no tool slot
  assert.deepEqual(q.stats(db), { done: 1 });
  const j2 = q.enqueue(db, { cmd: ["true"], cwd: null, repo: "/tmp/fr" });
  assert.notEqual(q.claim(db, "o:2"), null); // repo slot free again
  assert.equal(j2 > 0, true);
});

test("reap requeues expired lease until max attempts", async () => {
  const q = await freshDb();
  const db = q.connect();
  const jid = q.enqueue(db, { cmd: ["true"], cwd: null }, 0, 1);
  q.claim(db, "o:1");
  // expire the lease by rewriting it into the past (LEASE_S is fixed at import time)
  db.prepareRaw("UPDATE jobs SET lease_expires_at=? WHERE id=?").run([Date.now() / 1000 - 1, jid]);
  db.prepareRaw("UPDATE concurrency_slots SET lease_expires_at=? WHERE job_id=?").run([Date.now() / 1000 - 1, jid]);
  const reaped = q.reap(db);
  assert.deepEqual(reaped, [jid]);
  assert.deepEqual(q.stats(db), { dead: 1 });
});

test("status --self reads COORDINATE_JOB_ID", async () => {
  const q = await freshDb();
  const db = q.connect();
  const jid = q.enqueue(db, { cmd: ["true"], cwd: null });
  process.env["COORDINATE_JOB_ID"] = String(jid);
  const job = q.getJob(db, Number(process.env["COORDINATE_JOB_ID"]));
  assert.notEqual(job, null);
  assert.equal(job !== null ? job.id : -1, jid);
  delete process.env["COORDINATE_JOB_ID"];
});

test("schema matches the Python queue.py tables", async () => {
  const q = await freshDb();
  const db = q.connect();
  const cols = db.prepareRaw("SELECT name FROM pragma_table_info('jobs')").all([]);
  const names = cols.map((c) => c.name).sort();
  assert.deepEqual(names, [
    "attempts", "claim_at", "created_at", "deadline_at", "id", "kind", "lease_expires_at",
    "lease_owner", "max_attempts", "max_runtime_s", "outcome", "payload", "pgid", "pidfile",
    "priority", "run_at", "runtime_used_s", "status", "waiting_on",
  ]);
});

test("events: enqueue/claim/finish emit transitions", async () => {
  const q = await freshDb();
  const db = q.connect();
  const jid = q.enqueue(db, { cmd: ["true"], cwd: null });
  const c1 = q.claim(db, "o:1");
  q.finish(db, c1.jid, "o:1", "done");
  const rows = db.prepareRaw("SELECT id,ts,job_id,kind,data FROM events ORDER BY id").all([]);
  const kinds = rows.map((r) => r.kind);
  assert.deepEqual(kinds, ["enqueued", "claimed", "done"]);
  assert.equal(Number(rows[0].job_id), jid);
  assert.deepEqual(JSON.parse(rows[0].data), { kind: "cmd" });
  q.cancel(db, q.enqueue(db, { cmd: ["true"], cwd: null }));
  const all = db.prepareRaw("SELECT kind FROM events ORDER BY id").all([]);
  assert.equal(all[all.length - 1].kind, "cancelled");
});
