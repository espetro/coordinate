// Reproducers for the regressions found by the port audit (.agents/docs/ts-port-regressions.md).
//
// Every test asserts the behavior the legacy Python implementation had (legacy/python, 4e371ef)
// and is marked `todo`, so it documents the failure without turning CI red. node:test still
// runs a todo test and prints `not ok ... # TODO` when it fails. When a regression is fixed,
// delete its `todo` option so the test becomes a real gate.
//
// Daemon tests start `bin/coordinate.mjs daemon` as a child with a private COORDINATE_DB and
// stop only the child they started (by handle). Job process groups are killed by the pgids
// recorded in that private DB.
import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import "koffi";
import "@cutils/sqlite/node-binding";
import { Database } from "@cutils/sqlite";

const ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(ROOT, "bin", "coordinate.mjs");

// Oracle mode: REGRESS_PYTHON_SRC=<legacy checkout>/src runs the CLI and daemon tests against the
// legacy Python implementation (`python3 -m coordinate`), to show that each assertion holds for
// the behavior it claims to reproduce. The three in-process tests (A1, B8, S1) import the
// TypeScript modules and are not meaningful in this mode.
const ORACLE = process.env.REGRESS_PYTHON_SRC || null;

function command(args) {
  if (ORACLE) {
    return { cmd: "python3", args: ["-m", "coordinate", ...args], env: { PYTHONPATH: ORACLE, PYTHONDONTWRITEBYTECODE: "1" } };
  }
  return { cmd: process.execPath, args: [BIN, ...args], env: {} };
}

// ---- harness -------------------------------------------------------------------------------

function rig(extraEnv = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord-regress-")));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("COORDINATE_") && !k.startsWith("FLEET_") && v !== undefined) env[k] = v;
  }
  Object.assign(env, {
    COORDINATE_DB: path.join(dir, "queue.db"),
    COORDINATE_CONFIG: path.join(dir, "config.toml"),
    COORDINATE_MACHINE: "regress",
    COORDINATE_CAP: "3",
    COORDINATE_REPO_CAP: "1",
    COORDINATE_LEASE_S: "3",
    XDG_STATE_HOME: path.join(dir, "state"),
    ...extraEnv,
  });
  const r = { dir, env, db: env.COORDINATE_DB, daemons: [] };
  return r;
}

function cli(r, ...args) {
  const c = command(args);
  const p = spawnSync(c.cmd, c.args, { env: { ...r.env, ...c.env }, encoding: "utf8", timeout: 20000 });
  return { status: p.status, stdout: p.stdout || "", stderr: p.stderr || "" };
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

function startDaemon(r, env = {}) {
  const logPath = path.join(r.dir, `daemon-${r.daemons.length}.log`);
  const fd = fs.openSync(logPath, "w");
  const c = command(["daemon"]);
  const child = spawn(c.cmd, c.args, { env: { ...r.env, ...c.env, ...env }, stdio: ["ignore", fd, fd] });
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

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

// Kill daemons we started (by handle) and any job group recorded in our private DB.
async function cleanup(r) {
  for (const d of r.daemons) {
    if (!d.exited) {
      d.child.kill("SIGKILL");
      await waitFor(() => d.exited, 3000);
    }
  }
  let recorded = [];
  try {
    recorded = rows(r, "SELECT pgid FROM jobs WHERE pgid IS NOT NULL").map((x) => Number(x.pgid));
  } catch {
    // database never created
  }
  for (const pg of [...recorded, ...(r.extraPgids || [])]) {
    if (pg > 1) {
      try {
        process.kill(-pg, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  fs.rmSync(r.dir, { recursive: true, force: true });
}

function status(r, id) {
  return rows(r, `SELECT status FROM jobs WHERE id=${id}`)[0]?.status ?? null;
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

const DAEMON_T = 60000;

// ---- queue module and config reader (in process) -----------------------------------------------

test("A1: explicit --slot keys are limit-checked at claim (queue.py:317)", { todo: "claim() only bounds repo: keys; --slot gets lease rows but no limit check" }, async () => {
  const r = rig();
  Object.assign(process.env, { COORDINATE_DB: r.db, COORDINATE_MACHINE: "regress", COORDINATE_CAP: "3", COORDINATE_REPO_CAP: "1" });
  delete process.env.COORDINATE_CONFIG;
  try {
    const q = await import("../src/queue.ts");
    const db = q.connect();
    q.enqueue(db, { cmd: ["true"], cwd: null, slots: ["tool:regress:x"] });
    q.enqueue(db, { cmd: ["true"], cwd: null, slots: ["tool:regress:x"] });
    assert.notEqual(q.claim(db, "o:1"), null);
    assert.equal(q.claim(db, "o:2"), null, "second job on the same limit-1 slot key must stay queued");
    db.close();
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("B8: [slots] accepts the TOML spellings tomllib accepts", { todo: "src/daemon.ts slotsConfig() is a line matcher: only single-quoted keys without trailing comments work" }, async () => {
  const r = rig();
  Object.assign(process.env, { COORDINATE_DB: r.db, COORDINATE_CONFIG: r.env.COORDINATE_CONFIG });
  try {
    const d = await import("../src/daemon.ts");
    const forms = {
      "double-quoted key": '[slots]\n"tool:vitest:*" = 2\n',
      "trailing comment": "[slots]\n'tool:vitest:*' = 2 # two\n",
      "header comment": "[slots] # limits\n'tool:vitest:*' = 2\n",
      "inline table": "slots = { 'tool:vitest:*' = 2 }\n",
      "dotted key": "slots.'tool:vitest:*' = 2\n",
    };
    const wrong = [];
    for (const [name, body] of Object.entries(forms)) {
      fs.writeFileSync(r.env.COORDINATE_CONFIG, body);
      const got = d.slotLimit("tool:vitest:/p");
      if (got !== 2) wrong.push(`${name} -> ${got}`);
    }
    assert.deepEqual(wrong, [], "every spelling must give limit 2 (Python gave 2 for all of them)");
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("S1: jobs.attempts defaults to 0 like queue.py", { todo: "src/queue.ts:38 has DEFAULT 3; test 'schema matches the Python queue.py tables' compares names only" }, async () => {
  const r = rig();
  Object.assign(process.env, { COORDINATE_DB: r.db });
  try {
    const q = await import("../src/queue.ts");
    const db = q.connect();
    const col = db.prepareRaw("SELECT name, type, \"notnull\" AS nn, dflt_value AS d FROM pragma_table_info('jobs') WHERE name='attempts'").all([])[0];
    db.close();
    assert.equal(String(col.d), "0");
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

// ---- CLI -------------------------------------------------------------------------------------

test("X5: a database created before the timecap columns is migrated, not rejected", { todo: "connect() has no _migrate_jobs / ALTER TABLE ADD COLUMN (queue.py:236-268)" }, async () => {
  const r = rig();
  try {
    const old = Database.open(r.db);
    old.exec(`CREATE TABLE jobs(id INTEGER PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'cmd', payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','waiting','done','failed','dead')),
      priority INTEGER NOT NULL DEFAULT 0, run_at REAL NOT NULL, lease_owner TEXT, lease_expires_at REAL, waiting_on TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, created_at REAL NOT NULL, pgid INTEGER, pidfile TEXT)`);
    old.exec("INSERT INTO jobs(kind,payload,run_at,created_at,status) VALUES('cmd','{}',1,2,'done')");
    old.close();
    const out = cli(r, "enqueue", "--max-runtime", "60s", "--", "true");
    assert.equal(out.status, 0, out.stderr.split("\n").find((l) => /SqliteError:|Error:/.test(l)) || out.stderr);
    assert.equal(rows(r, "SELECT COUNT(*) AS n FROM jobs")[0].n, 2, "the old row must survive");
  } finally {
    await cleanup(r);
  }
});

test("X6: [defaults] max_runtime from config.toml caps jobs enqueued without --max-runtime", { todo: "src/main.ts never reads config; jobs are unbounded by default (cli.py:12-21)" }, async () => {
  const r = rig();
  try {
    fs.writeFileSync(r.env.COORDINATE_CONFIG, '[defaults]\nmax_runtime = "15m"\n');
    assert.equal(cli(r, "enqueue", "--", "true").status, 0);
    assert.equal(Number(rows(r, "SELECT max_runtime_s AS m FROM jobs")[0].m), 900);
  } finally {
    await cleanup(r);
  }
});

test("X6: a malformed --max-runtime is rejected, not stored as NULL", { todo: "parseDuration only validates the no-suffix path; 'xs' becomes NaN, stored as NULL (unbounded)" }, async () => {
  const r = rig();
  try {
    const out = cli(r, "enqueue", "--max-runtime", "xs", "--", "true");
    assert.notEqual(out.status, 0, "Python exits 1 with: enqueue --max-runtime: bad duration 'xs'");
  } finally {
    await cleanup(r);
  }
});

test("X8: status prints runtime_remaining_s and deadline_in_s", { todo: "src/main.ts prints the raw row (cli.py:24-31 added the derived fields)" }, async () => {
  const r = rig();
  try {
    const id = cli(r, "enqueue", "--max-runtime", "30s", "--", "true").stdout.trim();
    const job = JSON.parse(cli(r, "status", id).stdout);
    assert.ok("runtime_remaining_s" in job, "runtime_remaining_s missing");
    assert.ok("deadline_in_s" in job, "deadline_in_s missing");
    assert.ok(job.runtime_remaining_s !== null && job.runtime_remaining_s <= 30);
  } finally {
    await cleanup(r);
  }
});

test("X9: enqueue accepts --opt=value like argparse", { todo: "hand-rolled parser: 'unknown option --cwd=/tmp'" }, async () => {
  const r = rig();
  try {
    const out = cli(r, "enqueue", `--cwd=${r.dir}`, "--", "true");
    assert.equal(out.status, 0, out.stderr);
  } finally {
    await cleanup(r);
  }
});

test("X9: enqueue accepts the command without a -- separator (argparse REMAINDER)", { todo: "hand-rolled parser: 'unknown option echo'" }, async () => {
  const r = rig();
  try {
    const out = cli(r, "enqueue", "--priority", "1", "echo", "hi");
    assert.equal(out.status, 0, out.stderr);
  } finally {
    await cleanup(r);
  }
});

// ---- daemon ----------------------------------------------------------------------------------

test("X1: worktrees of one repo share the project key (queue.py:124-155)", { timeout: DAEMON_T }, async () => {
  const r = rig();
  try {
    const git = (cwd, ...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" });
    const main = path.join(r.dir, "main");
    const wt = path.join(r.dir, "wt");
    fs.mkdirSync(main);
    assert.equal(git(main, "init", "-q").status, 0);
    assert.equal(git(main, "commit", "-q", "--allow-empty", "-m", "i").status, 0);
    assert.equal(git(main, "worktree", "add", "-q", wt).status, 0);
    fakeBin(r, "vitest", "sleep 2");
    fs.writeFileSync(r.env.COORDINATE_CONFIG, "[slots]\n'tool:vitest:*' = 2\n");
    cli(r, "enqueue", "--cwd", main, "--repo", "a", "--", "vitest", "run");
    cli(r, "enqueue", "--cwd", wt, "--repo", "b", "--", "vitest", "run");
    startDaemon(r);
    await waitFor(() => rows(r, "SELECT COUNT(*) AS n FROM spawn_audit")[0].n >= 2, 8000);
    const projects = rows(r, "SELECT DISTINCT project FROM spawn_audit").map((x) => x.project);
    assert.equal(projects.length, 1, `worktree and main repo must share one key, got ${JSON.stringify(projects)}`);
  } finally {
    await cleanup(r);
  }
});

test("A3: a shell-string 'sh -c \\'vitest run\\'' is matched to the vitest tool class", { todo: "argv0Of splits on a single space, so the inner token keeps its quote (daemon.py:60 uses shlex)", timeout: DAEMON_T }, async () => {
  const r = rig();
  try {
    fakeBin(r, "vitest", "sleep 2");
    fs.writeFileSync(r.env.COORDINATE_CONFIG, "[slots]\n'tool:vitest:*' = 2\n");
    cli(r, "enqueue", "--cwd", r.dir, "--repo", "a", "--shell", "--", "sh -c 'vitest run'");
    cli(r, "enqueue", "--cwd", r.dir, "--repo", "b", "--shell", "--", "sh -c 'vitest run'");
    startDaemon(r);
    const parked = await waitFor(() => status(r, 2) === "waiting", 6000);
    assert.ok(parked, "second vitest (cost 2, limit 2) must park; it ran unthrottled");
  } finally {
    await cleanup(r);
  }
});

test("X2: a missing binary fails the job and the daemon stays up", { todo: "cp.spawn reports ENOENT as an unhandled 'error' event; the daemon dies and the row stays running", timeout: DAEMON_T }, async () => {
  const r = rig();
  try {
    cli(r, "enqueue", "--", "/nonexistent/regress-binary-xyz", "arg");
    const d = startDaemon(r);
    await waitFor(() => d.exited || status(r, 1) === "failed", 8000);
    assert.equal(d.exited, false, "daemon crashed: " + fs.readFileSync(d.logPath, "utf8").split("\n").find((l) => /Error/.test(l)));
    assert.equal(status(r, 1), "failed");
  } finally {
    await cleanup(r);
  }
});

test("X2: a nonexistent cwd fails the job and the daemon stays up", { todo: "same unhandled 'error' event as the missing binary", timeout: DAEMON_T }, async () => {
  const r = rig();
  try {
    cli(r, "enqueue", "--cwd", path.join(r.dir, "does-not-exist"), "--", "true");
    const d = startDaemon(r);
    await waitFor(() => d.exited || status(r, 1) === "failed", 8000);
    assert.equal(d.exited, false, "daemon crashed on a bad cwd");
    assert.equal(status(r, 1), "failed");
  } finally {
    await cleanup(r);
  }
});

test("X3: reap kills the surviving process group before the job is requeued (queue.py:386-465)", { todo: "reap() only updates rows; the old attempt keeps running beside the retry", timeout: DAEMON_T }, async () => {
  const r = rig({ COORDINATE_LEASE_S: "2" });
  r.extraPgids = [];
  try {
    cli(r, "enqueue", "--", "sleep", "317");
    const d1 = startDaemon(r);
    assert.ok(await waitFor(() => rows(r, "SELECT pgid FROM jobs WHERE id=1")[0]?.pgid, 8000), "job never started");
    const oldPgid = Number(rows(r, "SELECT pgid FROM jobs WHERE id=1")[0].pgid);
    r.extraPgids.push(oldPgid);
    d1.child.kill("SIGKILL");
    await waitFor(() => d1.exited, 3000);
    await new Promise((res) => setTimeout(res, 3000)); // lease (2s) expires
    startDaemon(r);
    assert.ok(await waitFor(() => Number(rows(r, "SELECT attempts AS a FROM jobs WHERE id=1")[0].a) >= 2, 10000), "job was never reclaimed");
    assert.equal(groupAlive(oldPgid), false, "the first attempt is still running next to the retry");
  } finally {
    await cleanup(r);
  }
});

test("X4: SIGTERM stops the daemon even while a job is running", { todo: "stopping is only checked at the top of loop(), which the idle pump never re-enters", timeout: DAEMON_T }, async () => {
  const r = rig();
  try {
    cli(r, "enqueue", "--", "sleep", "318");
    const d = startDaemon(r);
    assert.ok(await waitFor(() => status(r, 1) === "running", 8000), "job never started");
    await new Promise((res) => setTimeout(res, 500)); // let the loop settle into its idle pump
    d.child.kill("SIGTERM");
    assert.ok(await waitFor(() => d.exited, 6000), "daemon is still alive 6s after SIGTERM (Python exited immediately)");
  } finally {
    await cleanup(r);
  }
});

test("X7: job stdout reaches the daemon's stdout (Python inherited stdio)", { todo: "spawnRaw uses stdio: 'ignore'", timeout: DAEMON_T }, async () => {
  const r = rig();
  try {
    cli(r, "enqueue", "--shell", "--", "echo OUT-FROM-JOB; echo ERR-FROM-JOB >&2");
    const d = startDaemon(r);
    assert.ok(await waitFor(() => status(r, 1) === "done", 8000), "job did not finish");
    const log = fs.readFileSync(d.logPath, "utf8");
    assert.match(log, /OUT-FROM-JOB/);
    assert.match(log, /ERR-FROM-JOB/);
  } finally {
    await cleanup(r);
  }
});
