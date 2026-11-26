import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import "koffi";
import "@cutils/sqlite/node-binding";
import { Database } from "@cutils/sqlite";
import { cleanup, cli, rig, rows, startDaemon, waitFor } from "./parity/helpers.mjs";

test("daemon startup survives a transient database lock", async () => {
  const r = rig();
  let locker = null;
  try {
    assert.equal(cli(r, "enqueue", "--", "true").status, 0);
    const setup = Database.open(r.db);
    setup.exec("PRAGMA journal_mode=DELETE");
    setup.close();

    locker = Database.open(r.db);
    locker.exec("BEGIN IMMEDIATE");
    const d = startDaemon(r);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(d.exited, false, fs.readFileSync(d.logPath, "utf8"));
    locker.exec("ROLLBACK");
    locker.close();
    locker = null;

    const ok = await waitFor(() => rows(r, "SELECT COUNT(*) AS n FROM daemon")[0]?.n > 0, 5000);
    assert.ok(ok, fs.readFileSync(d.logPath, "utf8"));
  } finally {
    if (locker !== null) {
      try {
        locker.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      locker.close();
    }
    await cleanup(r);
  }
});
