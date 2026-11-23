// Parity suite for legacy/python:tests/test_acceptance.py.
//
// The Python suite drives the real daemon: a job is enqueued, the daemon runs it, the daemon is
// killed with SIGKILL mid job, and a second daemon finishes the job.
//
// All 5 Python tests of the file are ported here. test_waiting_release_and_reaper_dead is also
// partially covered by test/queue.test.mjs ("wait-on frees slots, release requeues" and "reap
// requeues expired lease until max attempts"); this file adds the missing retryDead assertion and
// keeps the whole flow in one place so the Python test can be traced line by line.
import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  BIN,
  NOW,
  cleanup,
  cli,
  drain,
  jobRow,
  peakOverlap,
  rig,
  rows,
  startDaemon,
  useProcessEnv,
  waitFor,
} from "./helpers.mjs";

const DAEMON_T = 120000;

// The Python fixture: COORDINATE_DB, COORDINATE_LEASE_S=3, COORDINATE_CAP=3.
function acceptanceRig(extra = {}) {
  return rig({
    COORDINATE_LEASE_S: "3",
    COORDINATE_CAP: "3",
    ...extra,
  });
}

test("test_kill9_daemon_mid_job_retries", { timeout: DAEMON_T }, async () => {
  const r = acceptanceRig();
  try {
    const marker = path.join(r.dir, "marker");
    const out = cli(r, "enqueue", "--cwd", r.dir, "--shell", "--", `echo run >> ${marker}; sleep 2`);
    assert.equal(out.status, 0, out.stderr);
    const d = startDaemon(r);
    const running = await waitFor(() => jobRow(r, 1)?.status === "running", 10000);
    assert.ok(running, "the job never started");
    // the command is already running: its first line is in the marker
    const started = await waitFor(() => fs.existsSync(marker) && fs.readFileSync(marker, "utf8").trim() !== "", 10000);
    assert.ok(started, "the job never ran its command");
    d.child.kill("SIGKILL");
    await waitFor(() => d.exited, 5000);
    assert.equal(jobRow(r, 1).status, "running", "orphaned lease, nobody to finish it");
    const d2 = startDaemon(r);
    const done = await waitFor(() => jobRow(r, 1)?.status === "done", 30000);
    assert.ok(done, "the second daemon never finished the job");
    const row = jobRow(r, 1);
    assert.equal(row.status, "done");
    assert.equal(row.attempts, 2);
    assert.equal(fs.readFileSync(marker, "utf8").split("\n").filter((l) => l !== "").length, 2);
  } finally {
    await cleanup(r);
  }
});

test("test_cap_never_exceeded", { timeout: DAEMON_T }, async () => {
  const r = acceptanceRig();
  const log = path.join(r.dir, "spans");
  try {
    for (let i = 0; i < 10; i++) {
      const d = path.join(r.dir, `repo${i}`);
      fs.mkdirSync(d);
      const cmd = `echo s ${NOW} >> ${log}; sleep 0.6; echo e ${NOW} >> ${log}`;
      const out = cli(r, "enqueue", "--cwd", d, "--shell", "--", cmd);
      assert.equal(out.status, 0, out.stderr);
    }
    startDaemon(r);
    const [peak, done] = drain(r, 10);
    assert.equal(done, 10);
    assert.equal(peak, 3);
    // real process overlap, not just DB rows
    assert.equal(peakOverlap(log), 3);
  } finally {
    await cleanup(r);
  }
});

test("test_enqueue_offline", async () => {
  const r = acceptanceRig();
  try {
    // The Python test disables socket.socket.connect and socket.getaddrinfo, then enqueues.
    // The Node equivalent is a preload that makes every outbound connection and every name
    // lookup throw, so the CLI runs with the network disabled.
    const preload = path.join(r.dir, "nonet.mjs");
    fs.writeFileSync(
      preload,
      [
        'import net from "node:net";',
        'import dns from "node:dns";',
        'net.Socket.prototype.connect = function () { throw new Error("network disabled"); };',
        'dns.lookup = () => { throw new Error("network disabled"); };',
        'dns.getaddrinfo = () => { throw new Error("network disabled"); };',
        "",
      ].join("\n"),
    );
    const p = spawnSync(process.execPath, [BIN, "enqueue", "--cwd", r.dir, "--", "true"], {
      env: { ...r.env, NODE_OPTIONS: "--import file://" + preload },
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(p.status, 0, p.stderr);
    const row = jobRow(r, 1);
    assert.equal(row.status, "queued");
    assert.equal(row.attempts, 0);
  } finally {
    await cleanup(r);
  }
});

test("test_waiting_release_and_reaper_dead", async () => {
  // Full port. The wait-on, release and reap-to-dead halves are also asserted by
  // test/queue.test.mjs "wait-on frees slots, release requeues" and "reap requeues expired lease
  // until max attempts"; the retryDead half was not asserted anywhere.
  const r = acceptanceRig();
  const restore = useProcessEnv(r);
  try {
    const q = await import("../../src/queue.ts?acc=" + Date.now() + "-" + Math.random());
    const db = q.connect();
    const j = q.enqueue(db, { cmd: ["true"], cwd: r.dir });
    assert.equal(q.waitOn(db, j, "ev1"), true);
    assert.equal(q.claim(db, "o"), null, "parked job is not claimable and holds no slot");
    assert.deepEqual(q.release(db, "ev1"), [j]);
    const claimed = q.claim(db, "o");
    assert.notEqual(claimed, null);
    assert.equal(claimed.jid, j);
    db.prepareRaw("UPDATE jobs SET lease_expires_at=0, max_attempts=1").run([]);
    assert.deepEqual(q.reap(db), [j]);
    assert.deepEqual(q.stats(db), { dead: 1 });
    assert.deepEqual(q.retryDead(db, j), [j]);
    assert.deepEqual(q.stats(db), { queued: 1 });
    db.close();
  } finally {
    restore();
    await cleanup(r);
  }
});

test("test_shell_string_is_stored_and_run_verbatim", { timeout: DAEMON_T }, async () => {
  const r = acceptanceRig();
  const out = path.join(r.dir, "out.txt");
  try {
    const cmd = `sh -c 'printf "%s|%s" "a  b" c > ${out}'`;
    const enq = cli(r, "enqueue", "--cwd", r.dir, "--shell", "--", cmd);
    assert.equal(enq.status, 0, enq.stderr);
    const payload = JSON.parse(rows(r, "SELECT payload FROM jobs WHERE id=1")[0].payload);
    assert.equal(payload.cmd, cmd);
    startDaemon(r);
    const done = await waitFor(() => jobRow(r, 1)?.status === "done", 30000);
    assert.ok(done, "the shell job never finished");
    assert.equal(fs.readFileSync(out, "utf8"), "a  b|c");
    // an unquoted multi-token argv is ambiguous, refuse instead of flattening
    const bad = cli(r, "enqueue", "--shell", "--", "sh", "-c", "echo hi");
    assert.notEqual(bad.status, 0, "a multi-token --shell command must be refused");
  } finally {
    await cleanup(r);
  }
});
