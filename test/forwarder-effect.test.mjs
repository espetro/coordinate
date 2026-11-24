// Forwarder Effect-machinery tests: the follow loop that the forwarder
// migration moved onto Effect (gen + Effect.sleep instead of an awaited
// setTimeout promise). The behavior contract is unchanged: the first poll
// runs immediately, the interval sits between polls, maxPolls bounds the
// run, and the cursor advances only after a successful send.
import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import "koffi";
import "@cutils/sqlite/node-binding";

async function freshForwarder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fwd-effect-"));
  process.env["COORDINATE_LEASE_S"] = "30";
  process.env["COORDINATE_DB"] = path.join(dir, "queue.db");
  const q = await import("../src/queue.ts");
  const f = await import("../src/forwarder.ts");
  return { q, f, dir };
}

test("forwarder seam: maxPolls bounds the Effect follow loop and polls run on the interval", async () => {
  const { q, f, dir } = await freshForwarder();
  const db = q.connect();
  q.emit(db, null, "done", { outcome: "ok" });
  db.close();

  const stamps = [];
  const started = Date.now();
  await f.forward({
    exec: "",
    sinkFn: () => {
      stamps.push(Date.now() - started);
      return true;
    },
    cursor: path.join(dir, "cursor"),
    since: 0,
    interval: 0.2,
    maxPolls: 3,
    verbose: false,
  });
  // The single event is sent on the first poll; the loop then sleeps the
  // interval twice more before maxPolls stops it.
  assert.equal(stamps.length, 1, "the one event is sent once");
  assert.ok(stamps[0] < 100, "the first poll must run immediately");
  assert.equal(f.loadCursor(path.join(dir, "cursor")), 1);

  // maxPolls=1 stops after the first poll: no interval elapses.
  const started1 = Date.now();
  await f.forward({
    exec: "",
    sinkFn: () => true,
    cursor: path.join(dir, "cursor1"),
    since: 0,
    interval: 0.2,
    maxPolls: 1,
  });
  assert.ok(Date.now() - started1 < 200, "maxPolls=1 must not wait out an interval");
});

test("forwarder seam: once=true polls exactly once even with unlimited polls", async () => {
  const { q, f, dir } = await freshForwarder();
  const db = q.connect();
  q.emit(db, null, "failed", { reason: "boom" });
  db.close();
  let polls = 0;
  await f.forward({
    exec: "",
    sinkFn: () => {
      polls = polls + 1;
      return true;
    },
    cursor: path.join(dir, "cursor"),
    since: 0,
    once: true,
  });
  assert.equal(polls, 1, "once=true must stop after the first poll");
});
