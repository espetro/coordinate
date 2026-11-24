// Daemon singleton claim + doctor heartbeat tests under node --test.
import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import "koffi";
import "@cutils/sqlite/node-binding";

async function freshMods() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-singleton-"));
  process.env["COORDINATE_LEASE_S"] = "30";
  process.env["COORDINATE_DB"] = path.join(dir, "queue.db");
  process.env["COORDINATE_CONFIG"] = path.join(dir, "config.toml");
  const q = await import("../src/queue.ts");
  const doctor = await import("../src/doctor.ts");
  return { q, doctor, dir };
}

test("singleton: fresh heartbeat refuses a second claim and reports the pid", async () => {
  const { q } = await freshMods();
  const db = q.connect();
  const c1 = { v: null };
  assert.equal(q.claimDaemon(db, 111, c1), true);
  assert.equal(c1.v, null);
  const c2 = { v: null };
  assert.equal(q.claimDaemon(db, 222, c2), false);
  assert.equal(c2.v, 111);
  assert.equal(q.liveDaemonPid(db), 111);
});

test("singleton: stale heartbeat is claimable (old daemon died without cleanup)", async () => {
  const { q } = await freshMods();
  const db = q.connect();
  q.daemonHeartbeat(db, 111);
  // age the heartbeat past the stale threshold
  db.prepareRaw("UPDATE daemon SET heartbeat_ts = heartbeat_ts - ? WHERE id=1").run([q.DAEMON_HB_STALE_S + 1]);
  assert.equal(q.liveDaemonPid(db), null);
  const c = { v: null };
  assert.equal(q.claimDaemon(db, 222, c), true);
  assert.equal(q.liveDaemonPid(db), 222);
});

test("doctor: fresh heartbeat row reads as alive even with zero running jobs", async () => {
  const { q, doctor } = await freshMods();
  const db = q.connect();
  q.daemonHeartbeat(db, 4242);
  const rep = doctor.doctor();
  const row = rep.rows.find((r) => r.name === "daemon");
  assert.ok(row);
  assert.equal(row.ok, true);
  assert.match(row.detail, /pid 4242/);
});

test("doctor: stale heartbeat on an idle DB reads as no daemon running", async () => {
  const { q, doctor } = await freshMods();
  const db = q.connect();
  q.daemonHeartbeat(db, 4242);
  db.prepareRaw("UPDATE daemon SET heartbeat_ts = heartbeat_ts - ? WHERE id=1").run([q.DAEMON_HB_STALE_S + 1]);
  const rep = doctor.doctor();
  const row = rep.rows.find((r) => r.name === "daemon");
  assert.ok(row);
  assert.equal(row.ok, true);
  assert.match(row.detail, /no fresh daemon heartbeat/);
});
