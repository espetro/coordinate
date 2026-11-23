// Forwarder tests under node --test.
import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import "koffi";
import "@cutils/sqlite/node-binding";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fwd-test-"));
}

async function forwarder() {
  process.env["COORDINATE_LEASE_S"] = "30";
  return await import("../src/forwarder.ts");
}

test("cursor load/save roundtrip", async () => {
  const f = await forwarder();
  const d = tmpdir();
  const p = path.join(d, "sub", "cursor");
  assert.equal(f.loadCursor(p), 0);
  f.saveCursor(p, 42);
  assert.equal(f.loadCursor(p), 42);
  assert.equal(f.loadCursor(path.join(d, "missing")), 0);
  fs.writeFileSync(p, "notanumber");
  assert.equal(f.loadCursor(p), 0);
});

test("default cursor path honors XDG_STATE_HOME", async () => {
  const f = await forwarder();
  const d = tmpdir();
  process.env["XDG_STATE_HOME"] = d;
  assert.equal(f.defaultCursorPath(), path.join(d, "coordinate", "forward-cursor"));
  delete process.env["XDG_STATE_HOME"];
});

test("render formats outcome/reason/waiting_on", async () => {
  const f = await forwarder();
  const msg = f.render({ id: 1, ts: 0, job_id: 7, kind: "done", data: { outcome: "ok", reason: "exit 0" } });
  assert.ok(msg.includes("coordinate[done] job 7"));
  assert.ok(msg.includes("ok"));
  assert.ok(msg.includes("exit 0"));
  const w = f.render({ id: 2, ts: 0, job_id: 8, kind: "parked", data: { waiting_on: "build" } });
  assert.ok(w.includes("waiting_on=build"));
});

test("CLI forward: filtering, {message} substitution, cursor resume", async () => {
  const f = await forwarder();
  const q = await import("../src/queue.ts");
  const d = tmpdir();
  const dbPath = path.join(d, "queue.db");
  process.env["COORDINATE_DB"] = dbPath;
  const db = q.connect();
  q.emit(db, null, "claimed", { attempt: 1 });
  q.emit(db, null, "done", { outcome: "ok" });
  q.emit(db, null, "failed", { reason: "boom" });
  db.close();

  const log = path.join(d, "fwd.log");  const cursor = path.join(d, "cursor");
  const exe = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "coordinate.mjs");
  const env = {
    ...process.env,
    XDG_STATE_HOME: d,
    COORDINATE_DB: dbPath,
    MACHINE: "testbox",
  };
  const run = (args) => execFileSync(process.execPath, [exe, ...args], { env, encoding: "utf8" });

  // pass 1: kinds=done only; --since 0
  run(["forward", "--exec", `cat >> ${JSON.stringify(log)}; echo >> ${JSON.stringify(log)}`, "--once", "--since", "0", "--kinds", "done", "--cursor", cursor]);
  const lines1 = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.equal(lines1.length, 1);
  const ev1 = JSON.parse(lines1[0]);
  assert.equal(ev1.kind, "done");
  assert.equal(ev1.data.outcome, "ok");
  assert.equal(f.loadCursor(cursor), 3); // skipped events advance the cursor too

  // pass 2: resume from cursor file; kinds=failed; {message} substituted
  const db2 = q.connect();
  q.emit(db2, null, "failed", { reason: "boom" });
  db2.close();
  run(["forward", "--exec", `echo "{message}" >> ${JSON.stringify(log)} 2>/dev/null || cat >> ${JSON.stringify(log)}.err`, "--once", "--kinds", "failed", "--cursor", cursor]);
  const lines2 = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.ok(lines2[lines2.length-1].startsWith("[testbox] coordinate[failed] job null \u2014 boom"), lines2.join("|"));
  assert.ok(!lines2[1].includes("{message}"));
  assert.equal(f.loadCursor(cursor), 4);
});
