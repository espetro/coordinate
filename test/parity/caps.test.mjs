// Parity suite for legacy/python:tests/test_caps.py.
//
// Only the vps machine cap test is in scope. The repo-cap test is COVERED (partial) by
// test/queue.test.mjs "repo cap: one repo at a time", which asserts the claim decision in the
// queue module; it does not measure real process overlap under the daemon.
import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { NOW, cleanup, cli, drain, peakOverlap, rig, startDaemon } from "./helpers.mjs";

const DAEMON_T = 120000;

test("test_vps_machine_cap_6_with_14_jobs", { timeout: DAEMON_T }, async () => {
  const r = rig({
    COORDINATE_MACHINE: "vps",
    COORDINATE_LEASE_S: "3",
  });
  delete r.env["COORDINATE_CAP"];
  delete r.env["COORDINATE_REPO_CAP"];
  const log = path.join(r.dir, "spans");
  try {
    for (let i = 0; i < 14; i++) {
      const d = path.join(r.dir, `repo${i}`);
      fs.mkdirSync(d);
      const cmd = `echo s ${i} ${NOW} >> ${log}; sleep 0.8; echo e ${i} ${NOW} >> ${log}`;
      const out = cli(r, "enqueue", "--cwd", d, "--shell", "--", cmd);
      assert.equal(out.status, 0, out.stderr);
    }
    startDaemon(r);
    const [peak, done] = drain(r, 14);
    assert.equal(done, 14, "not every job finished");
    assert.equal(peak, 6, "never above the vps cap, and the cap is actually reached");
    assert.equal(peakOverlap(log), 6, "real process overlap, not just DB rows");
  } finally {
    await cleanup(r);
  }
});
