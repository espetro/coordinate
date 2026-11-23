// Parity suite for legacy/python:tests/test_orphans.py.
//
// Only the reaper test is in scope: test_session_persisted_in_payload belongs to the ACP lane,
// which is not ported (see .agents/docs/ts-port-test-gap.md).
//
// The Python test drives queue.reap() directly with a live child in its own process group and
// asserts the reaper kills that group before the job is requeued.
import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import "koffi";
import "@cutils/sqlite/node-binding";

function groupAlive(pgid) {
  if (!pgid || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(pred, ms, step = 50) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await new Promise((res) => setTimeout(res, step));
  }
  return await pred();
}

test("test_reaper_kills_surviving_process_group_before_requeue", { todo: "X3: reap() never signals the recorded pgid, so the old attempt keeps running beside the retry (queue.py:386 kill_orphans)" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-parity-orph-"));
  process.env["COORDINATE_DB"] = path.join(dir, "queue.db");
  process.env["COORDINATE_MACHINE"] = "parity";
  process.env["COORDINATE_CAP"] = "3";
  process.env["COORDINATE_REPO_CAP"] = "1";
  process.env["COORDINATE_LEASE_S"] = "30";
  delete process.env["COORDINATE_CONFIG"];
  const q = await import("../../src/queue.ts?orph=" + Date.now());
  const db = q.connect();
  // A child in its own session, standing in for a job's process group.
  const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  child.unref();
  let jid = -1;
  try {
    jid = q.enqueue(db, { cmd: ["sleep", "60"], cwd: dir });
    const claimed = q.claim(db, "dead-daemon");
    assert.notEqual(claimed, null);
    assert.equal(claimed.jid, jid);
    q.setProc(db, jid, "dead-daemon", child.pid);
    db.prepareRaw("UPDATE jobs SET lease_expires_at=0").run([]);
    assert.deepEqual(q.reap(db), [jid]);
    const killed = await waitFor(() => child.exitCode !== null || child.signalCode !== null, 5000);
    assert.ok(killed, "the reaper left the surviving process group running");
    assert.equal(groupAlive(child.pid), false, "the child's process group is still alive after the reap");
    const row = db.prepareRaw("SELECT status, pgid, pidfile FROM jobs WHERE id=?").getOrNull([jid]);
    assert.equal(row.status, "queued");
    assert.equal(row.pgid, null);
    assert.equal(row.pidfile, null);
  } finally {
    db.close();
    // Only the group this test started.
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
