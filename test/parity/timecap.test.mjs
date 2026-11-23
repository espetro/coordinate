// Parity suite for legacy/python:tests/test_timecap.py.
//
// Timecaps: execution-time caps, absolute deadlines, budget accounting and identity injection.
//
// The 17th Python test of the file, test_status_self_uses_fleet_job_id, is COVERED (partial) by
// test/queue.test.mjs "status --self reads COORDINATE_JOB_ID" and is not duplicated here.
import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { Database } from "@cutils/sqlite";
import { cleanup, cli, groupAlive, jobRow, rig, rows, startDaemon, useProcessEnv, waitFor } from "./helpers.mjs";

const DAEMON_T = 120000;

function timecapRig(extra = {}) {
  const r = rig({
    COORDINATE_MACHINE: "vps",
    COORDINATE_LEASE_S: "3",
    COORDINATE_TIMECAP_GRACE_S: "1",
    ...extra,
  });
  delete r.env["COORDINATE_CAP"];
  // the Python fixture points COORDINATE_CONFIG at a file that does not exist
  r.env["COORDINATE_CONFIG"] = path.join(r.dir, "none.toml");
  return r;
}

// The Python `enqueue` helper: `coordinate enqueue --cwd <dir> [extra...] -- cmd...`.
function enqueue(r, cmd, extra = []) {
  const d = path.join(r.dir, "w");
  fs.mkdirSync(d, { recursive: true });
  const out = cli(r, "enqueue", "--cwd", d, ...extra, "--", ...cmd);
  assert.equal(out.status, 0, out.stderr);
  return Number(out.stdout.trim());
}

// The Python `q.enqueue` helper against the queue module directly. The module reads the
// environment at import time, so it is imported fresh per test.
async function freshQueue() {
  const q = await import("../../src/queue.ts?tc=" + Date.now() + "-" + Math.random());
  let db;
  try {
    db = q.connect();
  } catch (e) {
    throw new Error("connect() failed on this database: " + String(e));
  }
  return { q, db };
}

function readEnvFile(file) {
  return Object.fromEntries(
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i), l.slice(i + 1)];
      }),
  );
}

test("test_cmd_job_sleeping_forever_is_timed_out", { timeout: DAEMON_T }, async () => {
  const r = timecapRig();
  const restore = useProcessEnv(r);
  try {
    const { q, db } = await freshQueue();
    const jid = q.enqueue(db, { cmd: ["sleep", "300"], cwd: r.dir }, 0, 3, null, 2);
    startDaemon(r);
    const timedOut = await waitFor(() => jobRow(r, jid)?.status === "timed_out", 30000);
    assert.ok(timedOut, "the capped job never reached timed_out");
    const row = jobRow(r, jid);
    assert.equal(row.status, "timed_out");
    assert.equal(row.attempts, 1, "timed_out is terminal, never retried");
    assert.ok(row.outcome && row.outcome.includes("max runtime"), "outcome: " + row.outcome);
    assert.equal(row.lease_owner, null);
    assert.notEqual(row.deadline_at, null, "the deadline is kept for the post-mortem");
    // the slot is freed: a second job runs normally afterwards
    const jid2 = q.enqueue(db, { cmd: ["true"], cwd: r.dir }, 0, 3, null, null);
    const done = await waitFor(() => jobRow(r, jid2)?.status === "done", 30000);
    assert.ok(done, "the second job never ran, the slot was not freed");
    const slotRows = rows(r, "SELECT COUNT(*) AS n FROM concurrency_slots WHERE job_id=?").length > 0
      ? rows(r, "SELECT COUNT(*) AS n FROM concurrency_slots WHERE job_id=?")
      : [];
    const slots = slotRows.length > 0 ? Number(slotRows[0].n) : 0;
    assert.equal(slots, 0);
    db.close();
  } finally {
    restore();
    await cleanup(r);
  }
});

test("test_timed_out_job_leaves_no_orphan_process", { timeout: DAEMON_T }, async () => {
  const r = timecapRig();
  const restore = useProcessEnv(r);
  try {
    const { q, db } = await freshQueue();
    const jid = q.enqueue(db, { cmd: ["sleep", "300"], cwd: r.dir }, 0, 3, null, 2);
    startDaemon(r);
    const gotPgid = await waitFor(() => jobRow(r, jid)?.pgid, 20000);
    assert.ok(gotPgid, "the job never started");
    const pgid = Number(jobRow(r, jid).pgid);
    r.extraPgids.push(pgid);
    const timedOut = await waitFor(() => jobRow(r, jid)?.status === "timed_out", 30000);
    assert.ok(timedOut, "the capped job never reached timed_out");
    const dead = await waitFor(() => !groupAlive(pgid), 15000);
    assert.ok(dead, "the child's group was killed");
    db.close();
  } finally {
    restore();
    await cleanup(r);
  }
});

test("test_budget_excludes_parked_time", async () => {
  const r = timecapRig();
  const restore = useProcessEnv(r);
  try {
    const { q, db } = await freshQueue();
    const jid = q.enqueue(db, { cmd: ["sleep", "300"], cwd: r.dir }, 0, 3, null, 3);
    const claimed = q.claim(db, "o");
    assert.notEqual(claimed, null);
    assert.equal(claimed.jid, jid);
    await new Promise((res) => setTimeout(res, 1000));
    assert.equal(q.waitOn(db, jid, "evt"), true); // park after 1s of running
    await new Promise((res) => setTimeout(res, 2000)); // parked: no budget consumed
    const row = jobRow(r, jid);
    assert.ok(row.runtime_used_s >= 0.9 && row.runtime_used_s <= 1.5, "runtime_used_s " + row.runtime_used_s);
    assert.equal(row.deadline_at, null);
    assert.deepEqual(q.release(db, "evt"), [jid]);
    const again = q.claim(db, "o");
    assert.notEqual(again, null);
    assert.equal(again.jid, jid);
    const row2 = jobRow(r, jid);
    // remaining budget = cap - used; the new deadline reflects only the running time left
    const left = row2.deadline_at - row2.claim_at;
    assert.ok(Math.abs(left - (3 - row2.runtime_used_s)) <= 0.2, "deadline window " + left);
    db.close();
  } finally {
    restore();
    await cleanup(r);
  }
});

test("test_deadline_survives_daemon_restart", { timeout: DAEMON_T }, async () => {
  const r = timecapRig();
  const restore = useProcessEnv(r);
  try {
    const { q, db } = await freshQueue();
    const jid = q.enqueue(db, { cmd: ["sleep", "300"], cwd: r.dir }, 0, 3, null, 3);
    const d1 = startDaemon(r);
    const running = await waitFor(() => jobRow(r, jid)?.status === "running", 20000);
    assert.ok(running, "the job never started");
    const first = jobRow(r, jid);
    assert.notEqual(first.deadline_at, null);
    d1.child.kill("SIGKILL");
    await waitFor(() => d1.exited, 5000);
    // the successor sees the same absolute deadline in the DB
    const row = jobRow(r, jid);
    assert.equal(row.deadline_at, first.deadline_at);
    startDaemon(r);
    const timedOut = await waitFor(() => jobRow(r, jid)?.status === "timed_out", 30000);
    assert.ok(timedOut, "the successor daemon did not enforce the recorded deadline");
    db.close();
  } finally {
    restore();
    await cleanup(r);
  }
});

test("test_env_vars_visible_to_the_child", { timeout: DAEMON_T }, async () => {
  const r = timecapRig();
  const out = path.join(r.dir, "env.txt");
  try {
    enqueue(r, ["sh", "-c", `env > ${out}`]);
    startDaemon(r);
    const written = await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, "utf8").trim() !== "", 30000);
    assert.ok(written, "the child never wrote its environment");
    const envs = readEnvFile(out);
    assert.equal(envs["COORDINATE_MACHINE"], "vps");
    assert.equal(envs["COORDINATE_DB"], r.env["COORDINATE_DB"]);
    assert.ok(/^\d+$/.test(envs["COORDINATE_JOB_ID"] ?? ""), "COORDINATE_JOB_ID: " + envs["COORDINATE_JOB_ID"]);
  } finally {
    await cleanup(r);
  }
});

test("test_deadline_at_env_is_epoch_seconds_of_the_cap", { timeout: DAEMON_T }, async () => {
  const r = timecapRig();
  const restore = useProcessEnv(r);
  const out = path.join(r.dir, "env.txt");
  try {
    const { q, db } = await freshQueue();
    const jid = q.enqueue(db, { cmd: ["sh", "-c", `env > ${out}`], cwd: r.dir }, 0, 3, null, 60);
    startDaemon(r);
    const written = await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, "utf8").trim() !== "", 30000);
    assert.ok(written, "the child never wrote its environment");
    const envs = readEnvFile(out);
    const row = jobRow(r, jid);
    assert.equal(Number(envs["COORDINATE_DEADLINE_AT"]), Number(row.deadline_at));
    assert.equal(Number(envs["COORDINATE_JOB_ID"]), jid);
    db.close();
  } finally {
    restore();
    await cleanup(r);
  }
});

test("test_no_cap_means_empty_deadline", { timeout: DAEMON_T }, async () => {
  const r = timecapRig();
  const out = path.join(r.dir, "env.txt");
  try {
    enqueue(r, ["sh", "-c", `env > ${out}`]);
    startDaemon(r);
    const written = await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, "utf8").trim() !== "", 30000);
    assert.ok(written, "the child never wrote its environment");
    const envs = readEnvFile(out);
    assert.equal(envs["COORDINATE_DEADLINE_AT"], "");
  } finally {
    await cleanup(r);
  }
});

test("test_cli_max_runtime_is_stored", async () => {
  const r = timecapRig();
  try {
    const jid = enqueue(r, ["true"], ["--max-runtime", "15m"]);
    const row = jobRow(r, jid);
    assert.equal(Number(row.max_runtime_s), 900);
  } finally {
    await cleanup(r);
  }
});

test("test_status_prints_deadline_runtime_and_remaining", { timeout: DAEMON_T }, async () => {
  const r = timecapRig();
  const restore = useProcessEnv(r);
  try {
    const { q, db } = await freshQueue();
    const jid = q.enqueue(db, { cmd: ["sleep", "300"], cwd: r.dir }, 0, 3, null, 30);
    startDaemon(r);
    const running = await waitFor(() => jobRow(r, jid)?.status === "running", 20000);
    assert.ok(running, "the job never started");
    const out = cli(r, "status", String(jid));
    assert.equal(out.status, 0, out.stderr);
    const view = JSON.parse(out.stdout);
    assert.notEqual(view.deadline_at, null);
    assert.equal(view.max_runtime_s, 30);
    assert.notEqual(view.runtime_used_s, null);
    assert.notEqual(view.runtime_remaining_s, null);
    assert.ok(view.runtime_remaining_s <= 30);
    db.close();
  } finally {
    restore();
    await cleanup(r);
  }
});

test("test_config_default_max_runtime", { }, async () => {
  const r = timecapRig();
  try {
    fs.writeFileSync(r.env["COORDINATE_CONFIG"], '[defaults]\nmax_runtime = "2h"\n');
    const jid = enqueue(r, ["true"]);
    const row = jobRow(r, jid);
    assert.equal(Number(row.max_runtime_s), 7200);
  } finally {
    await cleanup(r);
  }
});

test("test_explicit_zero_disables_the_config_default", { }, async () => {
  const r = timecapRig();
  try {
    fs.writeFileSync(r.env["COORDINATE_CONFIG"], '[defaults]\nmax_runtime = "2h"\n');
    const jid = enqueue(r, ["true"], ["--max-runtime", "0"]);
    const row = jobRow(r, jid);
    assert.equal(Number(row.max_runtime_s), 0);
  } finally {
    await cleanup(r);
  }
});

test("test_old_database_is_migrated_and_keeps_rows", { }, async () => {
  const r = timecapRig();
  const restore = useProcessEnv(r);
  try {
    const db = path.join(r.dir, "old.db");
    r.env["COORDINATE_DB"] = db;
    r.db = db;
    process.env["COORDINATE_DB"] = db;
    const old = Database.open(db);
    old.exec(`CREATE TABLE jobs(
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'cmd',
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK(status IN ('queued','running','waiting','done','failed','dead')),
      priority INTEGER NOT NULL DEFAULT 0,
      run_at REAL NOT NULL,
      lease_owner TEXT,
      lease_expires_at REAL,
      waiting_on TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      created_at REAL NOT NULL,
      pgid INTEGER,
      pidfile TEXT)`);
    old.exec("INSERT INTO jobs(kind,payload,run_at,created_at,status) VALUES('cmd','{}',1,2,'done')");
    old.close();
    const { q, db: c } = await freshQueue();
    assert.equal(Number(rows(r, "SELECT COUNT(*) AS n FROM jobs")[0].n), 1, "the old row must survive");
    let jid = -1;
    try {
      jid = q.enqueue(c, { cmd: ["true"] }, 0, 3, null, 60);
    } catch (e) {
      throw new Error("enqueue on a pre-timecap database failed: " + String(e));
    }
    assert.equal(Number(rows(r, `SELECT max_runtime_s AS m FROM jobs WHERE id=${jid}`)[0].m), 60);
    const claimed = q.claim(c, "o");
    assert.notEqual(claimed, null);
    assert.equal(claimed.jid, jid);
    assert.deepEqual(q.expiredRunning(c), []);
    c.close();
  } finally {
    restore();
    await cleanup(r);
  }
});

test("test_parse_duration_units", { }, async () => {
  const r = timecapRig();
  try {
    const cases = [
      ["90s", 90],
      ["15m", 900],
      ["2h", 7200],
      ["45", 45],
      ["0", 0],
    ];
    for (const [text, seconds] of cases) {
      const jid = enqueue(r, ["true"], ["--max-runtime", text]);
      const row = jobRow(r, jid);
      assert.equal(Number(row.max_runtime_s), seconds, `--max-runtime ${text}`);
    }
  } finally {
    await cleanup(r);
  }
});

test("test_timed_out_job_is_not_retried_by_reaper", async () => {
  const r = timecapRig();
  const restore = useProcessEnv(r);
  try {
    const { q, db } = await freshQueue();
    const jid = q.enqueue(db, { cmd: ["sleep", "300"], cwd: r.dir }, 0, 3, null, 1);
    const claimed = q.claim(db, "o");
    assert.notEqual(claimed, null);
    assert.equal(claimed.jid, jid);
    assert.equal(q.finalizeTimedOut(db, jid, "max runtime exceeded"), true);
    db.prepareRaw("UPDATE jobs SET lease_expires_at=0").run([]);
    assert.deepEqual(q.reap(db), []);
    assert.equal(jobRow(r, jid).status, "timed_out");
    db.close();
  } finally {
    restore();
    await cleanup(r);
  }
});

test("test_expired_job_that_exhausted_its_budget_is_not_claimed", async () => {
  const r = timecapRig();
  const restore = useProcessEnv(r);
  try {
    const { q, db } = await freshQueue();
    const jid = q.enqueue(db, { cmd: ["true"], cwd: r.dir }, 0, 3, null, 5);
    const claimed = q.claim(db, "o");
    assert.notEqual(claimed, null);
    assert.equal(claimed.jid, jid);
    db.prepareRaw("UPDATE jobs SET runtime_used_s=5 WHERE id=?").run([jid]);
    q.finish(db, jid, "o", "failed");
    db.prepareRaw("UPDATE jobs SET status='queued' WHERE id=?").run([jid]);
    assert.equal(q.claim(db, "o"), null);
    assert.equal(jobRow(r, jid).status, "timed_out");
    db.close();
  } finally {
    restore();
    await cleanup(r);
  }
});

test("test_signals_only_reach_our_own_process_group", { timeout: DAEMON_T }, async () => {
  const r = timecapRig();
  const restore = useProcessEnv(r);
  const marker = path.join(r.dir, "marker");
  try {
    const { q, db } = await freshQueue();
    const jid = q.enqueue(db, { cmd: ["sleep", "300"], cwd: r.dir }, 0, 3, null, 1);
    startDaemon(r);
    const gotPgid = await waitFor(() => jobRow(r, jid)?.pgid, 20000);
    assert.ok(gotPgid, "the job never started");
    const pgid = Number(jobRow(r, jid).pgid);
    r.extraPgids.push(pgid);
    const timedOut = await waitFor(() => jobRow(r, jid)?.status === "timed_out", 30000);
    assert.ok(timedOut, "the capped job never reached timed_out");
    const dead = await waitFor(() => !groupAlive(pgid), 15000);
    assert.ok(dead, "the sleeping child group was killed");
    assert.equal(fs.existsSync(marker), false);
    db.close();
  } finally {
    restore();
    await cleanup(r);
  }
});
