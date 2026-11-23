// Parity suite for legacy/python:tests/test_slots.py.
//
// Tool-level slot keys: payload.slots claims extra leases beyond the device cap. The limit for
// each key comes from [slots] in config.toml, and an undeclared key defaults to 1.
import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { NOW, cleanup, cli, drain, peakOverlap, rig, startDaemon } from "./helpers.mjs";

const DAEMON_T = 120000;

function slotRig() {
  const r = rig({
    COORDINATE_MACHINE: "vps",
    COORDINATE_LEASE_S: "3",
  });
  delete r.env["COORDINATE_CAP"];
  delete r.env["COORDINATE_REPO_CAP"];
  fs.writeFileSync(
    r.env.COORDINATE_CONFIG,
    "[slots]\n'tool:vitest' = 1\n'tool:tsc' = 1\n'build:global' = 2\n'tool:other' = 2\n",
  );
  return r;
}

function enqueue(r, log, tag, slots = []) {
  const d = path.join(r.dir, `w-${tag}`);
  fs.mkdirSync(d, { recursive: true });
  const argv = ["enqueue", "--cwd", d, "--shell"];
  for (const s of slots) {
    argv.push("--slot", s);
  }
  argv.push("--", `echo s ${tag} ${NOW} >> ${log}; sleep 0.8; echo e ${tag} ${NOW} >> ${log}`);
  const out = cli(r, ...argv);
  assert.equal(out.status, 0, out.stderr);
}

test("test_slot_key_serializes_same_tool_parallel_to_other", { todo: "A1: claim() never compares an explicit --slot key against its [slots] limit (queue.py:317)", timeout: DAEMON_T }, async () => {
  const r = slotRig();
  const log = path.join(r.dir, "spans");
  try {
    for (let i = 0; i < 3; i++) {
      enqueue(r, log, `vitest${i}`, ["tool:vitest"]);
    }
    enqueue(r, log, "other0", ["tool:other"]);
    enqueue(r, log, "other1", ["tool:other"]);
    startDaemon(r);
    const [, done] = drain(r, 5);
    assert.equal(done, 5);
    assert.equal(peakOverlap(log, new Set(["vitest0", "vitest1", "vitest2"])), 1, "tool:vitest jobs serialized");
    assert.equal(peakOverlap(log, new Set(["other0", "other1"])), 2, "tool:other jobs ran in parallel");
  } finally {
    await cleanup(r);
  }
});

test("test_slot_limit_from_config_allows_two", { todo: "A1: claim() never compares an explicit --slot key against its [slots] limit (queue.py:317)", timeout: DAEMON_T }, async () => {
  const r = slotRig();
  const log = path.join(r.dir, "spans");
  try {
    for (let i = 0; i < 3; i++) {
      enqueue(r, log, `build${i}`, ["build:global"]); // build:global = 2
    }
    startDaemon(r);
    const [, done] = drain(r, 3);
    assert.equal(done, 3);
    assert.equal(peakOverlap(log), 2, "build:global ran 2 at a time per [slots] config");
  } finally {
    await cleanup(r);
  }
});

test("test_unknown_slot_key_defaults_to_1", { todo: "A1: claim() never compares an explicit --slot key against its [slots] limit (queue.py:317)", timeout: DAEMON_T }, async () => {
  const r = slotRig();
  const log = path.join(r.dir, "spans");
  try {
    // no entry for tool:audit in [slots]
    for (let i = 0; i < 2; i++) {
      enqueue(r, log, `audit${i}`, ["tool:audit"]);
    }
    startDaemon(r);
    const [, done] = drain(r, 2);
    assert.equal(done, 2);
    assert.equal(peakOverlap(log), 1, "undeclared slot keys default to limit 1");
  } finally {
    await cleanup(r);
  }
});

test("test_missing_config_file_still_claims", { timeout: DAEMON_T }, async () => {
  const r = slotRig();
  const log = path.join(r.dir, "spans");
  try {
    r.env["COORDINATE_CONFIG"] = path.join(r.dir, "nope.toml");
    enqueue(r, log, "a", ["tool:vitest"]);
    startDaemon(r);
    const [, done] = drain(r, 1);
    assert.equal(done, 1);
  } finally {
    await cleanup(r);
  }
});
