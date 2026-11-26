// Phase 2 surfaces: per-attempt output capture, `coordinate logs`, `coordinate
// why` and `coordinate health`. The daemon tests start a real daemon so the
// capture path is exercised end to end: a failing cmd job must leave its
// output inspectable through `coordinate logs`.
import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Database } from "@cutils/sqlite";
import "koffi";
import "@cutils/sqlite/node-binding";

const BIN = path.join(import.meta.dirname, "..", "bin", "coordinate.mjs");

function rig() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord-phase2-")));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("COORDINATE_") && !k.startsWith("FLEET_") && v !== undefined) env[k] = v;
  }
  Object.assign(env, {
    COORDINATE_DB: path.join(dir, "queue.db"),
    COORDINATE_CONFIG: path.join(dir, "config.toml"),
    COORDINATE_MACHINE: "phase2",
    COORDINATE_CAP: "3",
    COORDINATE_REPO_CAP: "1",
    COORDINATE_LEASE_S: "5",
    XDG_STATE_HOME: path.join(dir, "state"),
  });
  return { dir, env, db: env.COORDINATE_DB, daemons: [] };
}

function cli(r, ...args) {
  const p = spawnSync(process.execPath, [BIN, ...args], { env: r.env, encoding: "utf8", timeout: 20000 });
  return { status: p.status, stdout: p.stdout || "", stderr: p.stderr || "" };
}

function records(out) {
  return out.stdout
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

function rows(r, sql) {
  const db = Database.open(r.db);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    return db.prepareRaw(sql).all([]);
  } finally {
    db.close();
  }
}

function fakeBin(r, name, body) {
  const bin = path.join(r.dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const f = path.join(bin, name);
  fs.writeFileSync(f, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(f, 0o755);
  r.env.PATH = bin + path.delimiter + r.env.PATH;
  return bin;
}

function startDaemon(r) {
  const logPath = path.join(r.dir, "daemon.log");
  const fd = fs.openSync(logPath, "w");
  const child = spawn(process.execPath, [BIN, "daemon"], { env: r.env, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  const d = { child, logPath, exited: false };
  child.once("exit", () => {
    d.exited = true;
  });
  r.daemons.push(d);
  return d;
}

async function waitFor(pred, ms, step = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((res) => setTimeout(res, step));
  }
  return pred();
}

async function cleanup(r) {
  for (const d of r.daemons) {
    if (!d.exited) {
      d.child.kill("SIGTERM");
    }
  }
  for (const d of r.daemons) {
    await waitFor(() => d.exited, 5000);
  }
  fs.rmSync(r.dir, { recursive: true, force: true });
}

test("a failing cmd job leaves its output inspectable through coordinate logs", { timeout: 60000 }, async () => {
  const r = rig();
  try {
    const id = Number(
      cli(r, "enqueue", "--cwd", r.dir, "--shell", "--", "echo out-line; echo err-line >&2; exit 7").stdout.trim(),
    );
    startDaemon(r);
    const done = await waitFor(() => rows(r, "SELECT COUNT(*) AS n FROM jobs WHERE id=" + id + " AND status='failed'")[0].n >= 1, 20000);
    assert.ok(done, "the job never failed");
    const logs = cli(r, "logs", String(id));
    assert.equal(logs.status, 0, logs.stderr);
    assert.match(logs.stdout, /out-line/);
    assert.match(logs.stdout, /err-line/);
    // the durable metadata links job, attempt and the log paths
    const meta = rows(r, "SELECT job_id,attempt,stdout_path,stderr_path FROM job_logs WHERE job_id=" + id);
    assert.equal(meta.length, 1);
    assert.equal(meta[0].job_id, id);
    assert.equal(meta[0].attempt, 1);
    assert.ok(fs.existsSync(meta[0].stdout_path), "the stdout log file is missing");
    assert.ok(fs.existsSync(meta[0].stderr_path), "the stderr log file is missing");
    assert.ok(meta[0].stdout_path.includes("logs"), "the log lives in the state directory: " + meta[0].stdout_path);
  } finally {
    await cleanup(r);
  }
});

test("the log files live under the coordinate state directory", { timeout: 60000 }, async () => {
  const r = rig();
  try {
    const id = Number(cli(r, "enqueue", "--cwd", r.dir, "--shell", "--", "echo hi").stdout.trim());
    startDaemon(r);
    const done = await waitFor(() => rows(r, "SELECT COUNT(*) AS n FROM job_logs WHERE job_id=" + id)[0].n >= 1, 20000);
    assert.ok(done, "no log metadata was recorded");
    const meta = rows(r, "SELECT stdout_path FROM job_logs WHERE job_id=" + id)[0];
    const stateDir = path.dirname(path.dirname(meta.stdout_path));
    assert.equal(stateDir, path.dirname(r.db));
    assert.ok(fs.existsSync(path.join(stateDir, "logs")));
  } finally {
    await cleanup(r);
  }
});

test("events carry log path pointers but never the raw output", { timeout: 60000 }, async () => {
  const r = rig();
  try {
    const id = Number(cli(r, "enqueue", "--cwd", r.dir, "--shell", "--", "echo SECRET-OUTPUT").stdout.trim());
    startDaemon(r);
    const done = await waitFor(() => rows(r, "SELECT COUNT(*) AS n FROM job_logs WHERE job_id=" + id)[0].n >= 1, 20000);
    assert.ok(done, "no log metadata was recorded");
    await waitFor(() => rows(r, "SELECT COUNT(*) AS n FROM events WHERE job_id=" + id + " AND kind IN ('done','failed')")[0].n >= 1, 10000);
    const events = records(cli(r, "events", "--job", String(id)));
    const terminal = events.find((e) => e.kind === "done" || e.kind === "failed");
    assert.ok(terminal, "no terminal event was emitted");
    assert.ok(terminal.data.logs, "the terminal event carries no log pointers");
    assert.ok(terminal.data.logs.stdout, "the terminal event carries no stdout path");
    assert.ok(!JSON.stringify(events).includes("SECRET-OUTPUT"), "the raw output leaked into the events");
  } finally {
    await cleanup(r);
  }
});

test("logs --json describes the attempt without the output itself", { timeout: 60000 }, async () => {
  const r = rig();
  try {
    const id = Number(cli(r, "enqueue", "--cwd", r.dir, "--shell", "--", "echo out-line").stdout.trim());
    startDaemon(r);
    const done = await waitFor(() => rows(r, "SELECT COUNT(*) AS n FROM job_logs WHERE job_id=" + id)[0].n >= 1, 20000);
    assert.ok(done, "no log metadata was recorded");
    const recs = records(cli(r, "logs", String(id), "--json"));
    assert.equal(recs.length, 1);
    assert.equal(recs[0].job_id, id);
    assert.equal(recs[0].attempt, 1);
    assert.equal(recs[0].v, 1);
    assert.ok(recs[0].stdout_bytes > 0);
    assert.ok(!recs[0].stdout.includes("out-line"), "the machine record carries the raw output");
  } finally {
    await cleanup(r);
  }
});

test("logs rejects an unknown job and an attempt without capture", async () => {
  const r = rig();
  try {
    const missing = cli(r, "logs", "999");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /no job 999/);
    const id = Number(cli(r, "enqueue", "--cwd", r.dir, "--", "true").stdout.trim());
    const noCapture = cli(r, "logs", String(id));
    assert.equal(noCapture.status, 1);
    assert.match(noCapture.stderr, /no captured output/);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("a job parked at a tool boundary records no phantom attempt log", { timeout: 60000 }, async () => {
  const r = rig();
  try {
    fakeBin(r, "vitest", "sleep 5");
    fs.writeFileSync(r.env.COORDINATE_CONFIG, "[slots]\n'tool:vitest:*' = 2\n");
    cli(r, "enqueue", "--cwd", r.dir, "--repo", "a", "--", "vitest", "run");
    const second = Number(cli(r, "enqueue", "--cwd", r.dir, "--repo", "b", "--", "vitest", "run").stdout.trim());
    startDaemon(r);
    const parked = await waitFor(
      () => rows(r, "SELECT COUNT(*) AS n FROM jobs WHERE id=" + second + " AND status='waiting'")[0].n >= 1,
      20000,
    );
    assert.ok(parked, "the second cost-2 vitest job never parked at the full tool slot");
    const meta = rows(r, "SELECT COUNT(*) AS n FROM job_logs WHERE job_id=" + second);
    assert.equal(meta[0].n, 0, "a job that never spawned must not point at an empty attempt log");
  } finally {
    await cleanup(r);
  }
});

test("why explains a queued job from the live rows", async () => {
  const r = rig();
  try {
    const id = Number(cli(r, "enqueue", "--cwd", r.dir, "--", "true").stdout.trim());
    const out = cli(r, "why", String(id), "--json");
    assert.equal(out.status, 0, out.stderr);
    const rec = JSON.parse(out.stdout);
    assert.equal(rec.v, 1);
    assert.equal(rec.id, id);
    assert.equal(rec.status, "queued");
    assert.equal(rec.state, "queued");
    assert.ok(Array.isArray(rec.blockers));
    assert.equal(typeof rec.detail, "string");
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("why names the missing daemon as the blocker of a queued job", async () => {
  const r = rig();
  try {
    const id = Number(cli(r, "enqueue", "--cwd", r.dir, "--", "true").stdout.trim());
    const rec = JSON.parse(cli(r, "why", String(id), "--json").stdout);
    // no daemon is running in this rig, so nothing will claim the job
    assert.equal(rec.blockers.length, 1);
    assert.equal(rec.blockers[0].reason, "no_daemon");
    assert.equal(rec.next, "coordinate daemon");
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("why explains a waiting job with its blocker and the next step", async () => {
  const r = rig();
  try {
    const id = Number(cli(r, "enqueue", "--cwd", r.dir, "--wait-on", "42", "--", "true").stdout.trim());
    const rec = JSON.parse(cli(r, "why", String(id), "--json").stdout);
    assert.equal(rec.status, "waiting");
    assert.equal(rec.state, "waiting");
    assert.equal(rec.blockers.length, 1);
    assert.equal(rec.blockers[0].reason, "waiting_on");
    assert.equal(rec.blockers[0].detail, "42");
    assert.match(rec.next, /release 42/);
    const human = cli(r, "why", String(id));
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /waiting/);
    assert.match(human.stdout, /blocker: waiting_on/);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("why explains a failed job with the exit code from the live row", { timeout: 60000 }, async () => {
  const r = rig();
  try {
    const id = Number(cli(r, "enqueue", "--cwd", r.dir, "--shell", "--", "exit 5").stdout.trim());
    startDaemon(r);
    const done = await waitFor(() => rows(r, "SELECT COUNT(*) AS n FROM jobs WHERE id=" + id + " AND status='failed'")[0].n >= 1, 20000);
    assert.ok(done, "the job never failed");
    const rec = JSON.parse(cli(r, "why", String(id), "--json").stdout);
    assert.equal(rec.status, "failed");
    assert.equal(rec.state, "failed");
    assert.match(rec.detail, /exit code 5/);
    assert.ok(rec.logs.length >= 1, "the failed job has no log pointer");
    assert.ok(rec.logs[0].stdout !== null);
  } finally {
    await cleanup(r);
  }
});

test("health emits one fixed JSON object in machine mode", async () => {
  const r = rig();
  try {
    cli(r, "enqueue", "--cwd", r.dir, "--", "true");
    const out = cli(r, "health", "--json");
    assert.equal(out.status, 0, out.stderr);
    const lines = out.stdout.split("\n").filter((l) => l.trim() !== "");
    assert.equal(lines.length, 1, "health must emit exactly one object");
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.v, 1);
    assert.equal(typeof rec.machine, "string");
    assert.equal(typeof rec.daemon.running, "boolean");
    assert.equal(typeof rec.machine_cap, "number");
    assert.equal(typeof rec.repo_cap, "number");
    assert.equal(rec.queued, 1);
    assert.equal(rec.running, 0);
    assert.equal(rec.total, 1);
    assert.ok(Array.isArray(rec.slots));
    // the same fixed shape every time, whatever the queue holds
    const again = JSON.parse(cli(r, "health", "--json").stdout);
    assert.deepEqual(Object.keys(again).sort(), Object.keys(rec).sort());
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("health counts every job state and reports the daemon", { timeout: 60000 }, async () => {
  const r = rig();
  try {
    const id = Number(cli(r, "enqueue", "--cwd", r.dir, "--shell", "--", "true").stdout.trim());
    startDaemon(r);
    const done = await waitFor(() => rows(r, "SELECT COUNT(*) AS n FROM jobs WHERE id=" + id + " AND status='done'")[0].n >= 1, 20000);
    assert.ok(done, "the job never finished");
    const rec = JSON.parse(cli(r, "health", "--json").stdout);
    assert.equal(rec.done, 1);
    assert.equal(rec.total, 1);
    assert.equal(rec.daemon.running, true);
    assert.equal(typeof rec.daemon.pid, "number");
    assert.equal(typeof rec.daemon.heartbeat_age_s, "number");
  } finally {
    await cleanup(r);
  }
});

test("the machine schema documents the new surfaces", async () => {
  const doc = fs.readFileSync(path.join(import.meta.dirname, "..", "docs", "machine-schema.md"), "utf8");
  for (const needle of ["job_logs", "coordinate logs", "coordinate why", "coordinate health", "logs"]) {
    assert.ok(doc.includes(needle), "the schema doc must mention " + needle);
  }
  const cliDoc = fs.readFileSync(path.join(import.meta.dirname, "..", "docs", "cli.md"), "utf8");
  for (const needle of ["logs", "why", "health"]) {
    assert.ok(cliDoc.includes(needle), "the command reference must mention " + needle);
  }
});
