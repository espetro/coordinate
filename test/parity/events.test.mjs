// Parity suite for legacy/python:tests/test_events.py.
//
// The Python suite drives the queue module directly (q.enqueue / q.claim / q.finish / q.wait_on /
// q.release / q.reap) plus the `coordinate events` CLI verb. TypeScript has the same module
// (src/queue.ts) and the same verb.
//
// The two COVERED Python tests are not duplicated here:
//   test_enqueue_claim_finish_emits -> test/queue.test.mjs "events: enqueue/claim/finish emit transitions"
//   test_fail_and_cancel             -> test/queue.test.mjs "events: enqueue/claim/finish emit transitions"
//                                       (it asserts the `cancelled` kind; the `failed` kind is not
//                                        asserted there either, see the Port status table)
import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { BIN } from "./helpers.mjs";
import "koffi";
import "@cutils/sqlite/node-binding";

// Fresh queue module per test: src/queue.ts reads the env at import time (LEASE_S, MACHINE).
let counter = 0;
async function freshQueue() {
  counter += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-parity-ev-"));
  process.env["COORDINATE_DB"] = path.join(dir, "queue.db");
  process.env["COORDINATE_MACHINE"] = "bench";
  process.env["COORDINATE_CAP"] = "3";
  process.env["COORDINATE_REPO_CAP"] = "1";
  process.env["COORDINATE_LEASE_S"] = "30";
  delete process.env["COORDINATE_CONFIG"];
  const q = await import("../../src/queue.ts?v=" + counter);
  return { q, db: q.connect(), dir };
}

function kinds(db, jid = null) {
  const sql = "SELECT kind FROM events" + (jid === null ? "" : " WHERE job_id=?") + " ORDER BY id";
  const rows = db.prepareRaw(sql).all(jid === null ? [] : [jid]);
  return rows.map((r) => r.kind);
}

test("test_park_release", async () => {
  const { q, db, dir } = await freshQueue();
  try {
    const jid = q.enqueue(db, { cmd: ["true"], cwd: null });
    assert.equal(q.waitOn(db, jid, "ev1"), true);
    assert.deepEqual(q.release(db, "ev1"), [jid]);
    assert.deepEqual(kinds(db, jid), ["enqueued", "parked", "released"]);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("test_reap_requeue_and_dead", async () => {
  const { q, db, dir } = await freshQueue();
  try {
    db.prepareRaw("UPDATE jobs SET attempts=0").run([]);
    const jid = q.enqueue(db, { cmd: ["true"], cwd: null });
    db.prepareRaw("UPDATE jobs SET max_attempts=2 WHERE id=?").run([jid]);
    q.claim(db, "o:1");
    db.prepareRaw("UPDATE jobs SET lease_expires_at=1 WHERE id=?").run([jid]);
    q.reap(db);
    assert.deepEqual(kinds(db, jid), ["enqueued", "claimed", "requeued"]);
    q.claim(db, "o:2");
    db.prepareRaw("UPDATE jobs SET lease_expires_at=1 WHERE id=?").run([jid]);
    q.reap(db);
    assert.equal(kinds(db, jid)[kinds(db, jid).length - 1], "dead");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("test_follow_and_maxid", async () => {
  const { q, db, dir } = await freshQueue();
  try {
    q.enqueue(db, { cmd: ["true"], cwd: null });
    q.enqueue(db, { cmd: ["true"], cwd: null });
    // events_mod.follow(conn, 0) -> the ordered rows after an id
    const rows = db.prepareRaw("SELECT id,ts,job_id,kind,data FROM events WHERE id>? ORDER BY id").all([0]);
    assert.equal(rows.length, 2);
    // events_mod.max_id(conn)
    const maxId = Number(db.prepareRaw("SELECT COALESCE(MAX(id),0) AS m FROM events").getOrNull([]).m);
    assert.equal(maxId, rows[rows.length - 1].id);
    // follow(conn, rows[0][0]) -> only the rows after the first one
    const after = db.prepareRaw("SELECT id,ts,job_id,kind,data FROM events WHERE id>? ORDER BY id").all([rows[0].id]);
    assert.equal(after.length, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("test_cli_events_jsonl", async () => {
  const { q, db, dir } = await freshQueue();
  try {
    const jid = q.enqueue(db, { cmd: ["true"], cwd: null });
    const r = spawnSync(process.execPath, [BIN, "events"], {
      env: { ...process.env },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split("\n").filter((l) => l !== "");
    const events = lines.map((l) => JSON.parse(l));
    assert.deepEqual(events.map((e) => e.kind), ["enqueued"]);
    assert.equal(events[0].job_id, jid);
    assert.deepEqual(Object.keys(events[0]).sort(), ["data", "id", "job_id", "kind", "ts"]);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
