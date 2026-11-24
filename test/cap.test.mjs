// Runtime cap control: the machine and repo caps are read at claim time from
// the settings table, so `cap set` takes effect without a daemon restart and
// lowering never interrupts the jobs already running.
import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import "koffi";
import "@cutils/sqlite/node-binding";

async function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-cap-test-"));
  process.env["COORDINATE_LEASE_S"] = "30";
  process.env["COORDINATE_DB"] = path.join(dir, "queue.db");
  process.env["COORDINATE_MACHINE"] = "capbench";
  process.env["COORDINATE_CAP"] = "3";
  process.env["COORDINATE_REPO_CAP"] = "1";
  delete process.env["COORDINATE_CONFIG"];
  return await import("../src/queue.ts");
}

test("the stored cap overrides the environment", async () => {
  const q = await freshDb();
  const db = q.connect();
  assert.equal(q.machineCap(db), 3);
  q.setCap(db, q.SETTING_MACHINE_CAP, 7);
  assert.equal(q.machineCap(db), 7);
  q.setCap(db, q.SETTING_MACHINE_CAP, null);
  assert.equal(q.machineCap(db), 3);
});

test("raising the cap lets more jobs be claimed without a restart", async () => {
  const q = await freshDb();
  const db = q.connect();
  for (let i = 0; i < 5; i++) {
    q.enqueue(db, { cmd: ["true"], cwd: null }, 0);
  }
  let claimed = 0;
  while (q.claim(db, "o:1") !== null) {
    claimed += 1;
  }
  assert.equal(claimed, 3);
  // The cap is re-read per claim, so raising it frees the queued jobs at once.
  q.setCap(db, q.SETTING_MACHINE_CAP, 5);
  claimed = 0;
  while (q.claim(db, "o:1") !== null) {
    claimed += 1;
  }
  assert.equal(claimed, 2);
});

test("lowering the cap stops new claims but leaves the running jobs alone", async () => {
  const q = await freshDb();
  const db = q.connect();
  for (let i = 0; i < 5; i++) {
    q.enqueue(db, { cmd: ["true"], cwd: null }, 0);
  }
  const first = q.claim(db, "o:1");
  assert.notEqual(first, null);
  q.setCap(db, q.SETTING_MACHINE_CAP, 1);
  // The claimed job is untouched: still running, still holding its slot.
  const rows = db.prepareRaw("SELECT id, status FROM jobs WHERE id=?").all([first.jid]);
  assert.equal(rows[0].status, "running");
  assert.equal(q.claim(db, "o:1"), null);
});

test("the repo cap is read at claim time too", async () => {
  const q = await freshDb();
  const db = q.connect();
  q.setCap(db, q.SETTING_REPO_CAP, 3);
  assert.equal(q.repoCap(db), 3);
  q.setCap(db, q.SETTING_REPO_CAP, null);
  assert.equal(q.repoCap(db), 1);
});

test("a stored cap that is not a positive integer is ignored", async () => {
  const q = await freshDb();
  const db = q.connect();
  q.setCap(db, q.SETTING_MACHINE_CAP, 0);
  assert.equal(q.machineCap(db), 3);
  q.setCap(db, q.SETTING_MACHINE_CAP, null);
});
