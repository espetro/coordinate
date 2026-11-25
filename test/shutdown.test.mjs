// Regression tests for the daemon shutdown hang and the prepared-statement leak.
//
// Root cause: @cutils/sqlite tracks every prepared statement for the life of the
// connection, and Database.close() finalizes that list through _untrack, which was
// a linear scan. N unfinalized statements therefore cost O(N^2) to close. The
// daemon's hot path prepared a statement per query and never finalized it, so the
// tracked list grew without bound and the shutdown took 29 s at 100% CPU after
// churn (measured on v0.1.3, macOS arm64).
//
// The fix has two halves: the queue helpers finalize every statement via `using`,
// and the daemon closes the DB after the claim loop drains instead of inside the
// signal handler.
//
// See .agents/docs/research/daemon-shutdown-hang-2026-11-24.md.
import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import "koffi";
import "@cutils/sqlite/node-binding";
import { Database } from "@cutils/sqlite";

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-close-test-"));
  return path.join(dir, "queue.db");
}

test("closing a connection with many tracked statements stays fast", () => {
  // The pre-fix close was quadratic: 160 000 tracked statements took 55 153 ms
  // (measured on this host). The fix detaches the tracked list before
  // finalizing, so the close is linear and the same pile takes 89 ms.
  //
  // The bound below is 5 s, which the unpatched build exceeds by an order of
  // magnitude at 160 000 statements, so this test fails on the old code and
  // passes on the new.
  const db = Database.open(tmpDb());
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY)");
  const N = 160000;
  for (let i = 0; i < N; i++) {
    db.prepareRaw("SELECT id FROM t WHERE id=?").getOrNull([i]);
  }
  const t0 = Date.now();
  db.close();
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, "close of " + N + " tracked statements took " + ms + "ms, expected under 5000ms");
});

test("the queue helpers do not accumulate tracked statements", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-track-test-"));
  process.env["COORDINATE_DB"] = path.join(dir, "queue.db");
  process.env["COORDINATE_MACHINE"] = "bench";
  process.env["COORDINATE_LEASE_S"] = "30";
  delete process.env["COORDINATE_CONFIG"];
  const q = await import("../src/queue.ts");
  const db = q.connect();
  // Drive the claim path hard: it is the hot path that used to leak one
  // statement per query. The count is read directly off the connection (the
  // patched @cutils/sqlite exposes trackedStatementCount), so this fails
  // deterministically on the pre-fix code, which grew the list by a few
  // thousand entries over this workload, and passes on the helpers.
  for (let i = 0; i < 500; i++) {
    q.enqueue(db, { cmd: ["true"], cwd: null }, 0);
  }
  for (let i = 0; i < 500; i++) {
    q.claim(db, "o:1");
  }
  for (let i = 0; i < 200; i++) {
    q.stats(db);
    q.reap(db);
  }
  const tracked = db.trackedStatementCount;
  // A handful is fine (one live statement inside an in-flight helper); a
  // count in the hundreds or thousands is the leak.
  assert.ok(
    tracked < 20,
    "tracked statement count after 1200 queue operations is " + tracked + ", expected under 20",
  );
  db.close();
});

test("the daemon exits promptly on SIGTERM after churn", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-term-test-"));
  const dbPath = path.join(dir, "queue.db");
  const env = {
    ...process.env,
    COORDINATE_DB: dbPath,
    COORDINATE_MACHINE: "bench",
    COORDINATE_LEASE_S: "30",
    COORDINATE_CONFIG: path.join(dir, "none.toml"),
    COORDINATE_CAP: "3",
  };
  const bin = path.join(process.cwd(), "bin", "coordinate.mjs");
  const daemon = spawn(process.execPath, [bin, "daemon"], { env, stdio: "ignore" });
  try {
    // Give the daemon time to claim and run the first jobs.
    await new Promise((res) => setTimeout(res, 1500));
    // Churn: enough claims that the pre-fix daemon accumulated thousands of
    // tracked statements and the shutdown took tens of seconds.
    for (let i = 0; i < 60; i++) {
      const child = spawn(process.execPath, [bin, "enqueue", "--id", "close-" + i, "--", "true"], {
        env,
        stdio: "ignore",
      });
      await new Promise((res) => child.on("exit", res));
    }
    await new Promise((res) => setTimeout(res, 2000));

    const t0 = Date.now();
    daemon.kill("SIGTERM");
    const code = await new Promise((res) => {
      const timer = setTimeout(() => res("timeout"), 20000);
      daemon.on("exit", (c) => {
        clearTimeout(timer);
        res(c);
      });
    });
    const ms = Date.now() - t0;
    assert.notEqual(code, "timeout", "the daemon did not exit within 20s of SIGTERM");
    // Guard against the old handler-closes-inside-signal behavior, where a
    // pathological close delayed the exit arbitrarily. The calibrated leak
    // regression is the previous test; this one asserts the contract shape.
    assert.ok(ms < 10000, "SIGTERM to exit took " + ms + "ms, expected under 10000ms");
  } finally {
    if (daemon.exitCode === null) {
      daemon.kill("SIGKILL");
    }
  }
});
