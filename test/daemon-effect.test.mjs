// Daemon Effect-machinery tests: the idle backoff wake and the singleton
// takeover probe, the parts the daemon migration moved onto Effect. The
// SIGTERM/SIGINT stop contract itself is X4 in test/regressions.test.mjs,
// which runs the daemon as a child process; these tests exercise the same
// seams in-process so the wake path has a test that does not need a spawn.
import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import "koffi";
import "@cutils/sqlite/node-binding";

// The daemon's stop signal and takeover probe both follow the same shape:
// a Deferred completed from a plain signal handler races a timer. This test
// pins the seam the daemon relies on: completing the Deferred from outside
// the Effect world wakes the racing sleep at once, and the race reports
// the winner's value ("stop"), which is what the daemon loop checks.
test("daemon wake seam: completing the Deferred from a callback wakes the race at once", async () => {
  const { runPromise, race, sleep, succeed } = await import("effect/Effect");
  const { millis } = await import("effect/Duration");
  const { makeUnsafe, await: awaitDeferred, doneUnsafe } = await import("effect/Deferred");
  const stop = makeUnsafe();
  const started = Date.now();
  const pending = runPromise(
    race(sleep(millis(30_000)), awaitDeferred(stop)),
  );
  setTimeout(() => {
    assert.equal(doneUnsafe(stop, succeed("stop")), true);
  }, 50);
  const winner = await pending;
  const elapsed = Date.now() - started;
  assert.equal(winner, "stop");
  assert.ok(elapsed < 5000, "the wake must not wait out the sleep (took " + String(elapsed) + "ms)");
});

test("daemon wake seam: a Deferred completed before the race is the winner", async () => {
  const { runPromise, race, sleep, succeed } = await import("effect/Effect");
  const { millis } = await import("effect/Duration");
  const { makeUnsafe, await: awaitDeferred, doneUnsafe } = await import("effect/Deferred");
  const stop = makeUnsafe();
  assert.equal(doneUnsafe(stop, succeed("stop")), true);
  const winner = await runPromise(
    race(sleep(millis(30_000)), awaitDeferred(stop)),
  );
  assert.equal(winner, "stop");
});

test("singleton: the takeover probe gives up early when SIGINT fires mid-probe", async () => {
  // The probe loop is inside run(), so this tests it through the module:
  // claim the row with a foreign daemon, then send SIGINT to this process
  // while run() is probing. The probe must exit the loop and report the
  // conflict instead of waiting out all 8 attempts.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-probe-"));
  process.env["COORDINATE_LEASE_S"] = "30";
  process.env["COORDINATE_DB"] = path.join(dir, "queue.db");
  process.env["COORDINATE_CONFIG"] = path.join(dir, "config.toml");
  const q = await import("../src/queue.ts");
  const db = q.connect();
  // A daemon that is 'alive': a fresh heartbeat this start cannot claim.
  q.daemonHeartbeat(db, 999);
  const conflict = { v: null };
  assert.equal(q.claimDaemon(db, process.pid, conflict), false);

  const daemon = await import("../src/daemon.ts");
  // SIGINT mid-probe: the probe loop must leave early.
  const t = setTimeout(() => process.kill(process.pid, "SIGINT"), 300);
  const started = Date.now();
  // run() calls process.exit(1) when the probe fails, so swallow that.
  const code0 = process.exitCode;
  let exited = false;
  const realExit = process.exit;
  process.exit = (c) => {
    exited = true;
    throw new Error("exit " + String(c));
  };
  try {
    await daemon.run();
  } catch (e) {
    assert.match(String(e && e.message), /exit/);
  } finally {
    clearTimeout(t);
    process.exit = realExit;
    process.exitCode = code0;
  }
  const elapsed = Date.now() - started;
  assert.ok(exited, "the probe should have ended with the conflict report");
  assert.ok(elapsed < 3000, "SIGINT must cut the probe short (took " + String(elapsed) + "ms)");
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
