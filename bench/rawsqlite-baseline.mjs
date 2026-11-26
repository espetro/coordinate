// Raw SQLite baseline through the project's own connection helper: the ceiling
// any coordinate operation can approach, measured on this machine.
import "koffi";
import "@cutils/sqlite/node-binding";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rawsq-"));
process.env["COORDINATE_DB"] = path.join(dir, "q.db");
process.env["COORDINATE_MACHINE"] = "bench";
const q = await import("../src/queue.ts");
const db = q.connect();
db.exec("CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, v TEXT)");

const N = 2000;
let t0 = performance.now();
for (let i = 0; i < N; i++) {
  q.qRun(db, "INSERT INTO t(v) VALUES('x')", []);
}
const singleTxMs = (performance.now() - t0) / N;

t0 = performance.now();
db.exec("BEGIN");
for (let i = 0; i < N * 10; i++) q.qRun(db, "INSERT INTO t(v) VALUES('x')", []);
db.exec("COMMIT");
const batchMs = (performance.now() - t0) / (N * 10);

// lease-like cycle: insert + read + update + delete in one transaction each
t0 = performance.now();
for (let i = 0; i < N; i++) {
  using _tx = db.transaction();
  q.qRun(db, "INSERT INTO t(v) VALUES('x')", []);
  const row = q.qOne(db, "SELECT last_insert_rowid() AS id", []);
  q.qRun(db, "UPDATE t SET v='y' WHERE id=?", [row.id]);
  q.qRun(db, "DELETE FROM t WHERE id=?", [row.id]);
}
const cycleMs = (performance.now() - t0) / N;

console.log(JSON.stringify({
  singleTxMs: Math.round(singleTxMs * 1000) / 1000,
  singleTxPerSec: Math.round(1000 / singleTxMs),
  batchOpMs: Math.round(batchMs * 10000) / 10000,
  batchPerSec: Math.round(1000 / batchMs),
  leaseLikeCycleMs: Math.round(cycleMs * 1000) / 1000,
  leaseLikePerSec: Math.round(1000 / cycleMs),
}));
db.close();
