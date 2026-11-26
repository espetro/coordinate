// SQLite durable queue: schema, claim protocol, leases, reaper, waiting jobs.
// Port of src/coordinate/queue.py (subset kept: no tool-class matching, no config slots).

import * as fs from "node:fs";
import * as path from "node:path";
import { Database } from "@cutils/sqlite";
import type { Transaction } from "@cutils/sqlite";
import type { BindValue, RunResult } from "@cutils/sqlite";
import { configPath, dbPath, ensureParentDir, env } from "./env.ts";
import * as cfg from "./config.ts";
export const cfgValidate = cfg.validateConfig;

export const LEASE_S = Number(env("LEASE_S", "30"));
export const MACHINE = env("MACHINE", "laptop") as string;
const MACHINE_CAPS: Record<string, number> = { laptop: 3, vps: 6 };

// The machine and repo caps are read at claim time, not frozen at daemon start,
// so `coordinate cap set` takes effect on the next claim without a daemon
// restart and without interrupting the jobs already running. Precedence:
// the stored setting (written by `coordinate cap set`), then the environment
// (COORDINATE_CAP / COORDINATE_REPO_CAP), then the built-in default.
export const SETTING_MACHINE_CAP = "machine_cap";
export const SETTING_REPO_CAP = "repo_cap";

function storedCap(db: Database, key: string): number | null {
  const row = qOne(db, "SELECT value FROM settings WHERE key=?", [key]) as { value: string } | null;
  if (row === null) {
    return null;
  }
  const n = Number(row.value);
  if (!Number.isInteger(n) || n <= 0) {
    return null;
  }
  return n;
}

export function setCap(db: Database, key: string, value: number | null): void {
  if (value === null) {
    qRun(db, "DELETE FROM settings WHERE key=?", [key]);
    return;
  }
  qRun(db, "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [
    key,
    String(value),
  ]);
}

export function machineCap(db: Database): number {
  const stored = storedCap(db, SETTING_MACHINE_CAP);
  if (stored !== null) {
    return stored;
  }
  const raw = env("CAP");
  if (raw !== null) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) {
      return n;
    }
  }
  const known = MACHINE_CAPS[MACHINE];
  return known === undefined ? 3 : known;
}

export function repoCap(db: Database): number {
  const stored = storedCap(db, SETTING_REPO_CAP);
  if (stored !== null) {
    return stored;
  }
  const raw = env("REPO_CAP");
  if (raw !== null) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) {
      return n;
    }
  }
  return 1;
}

// Tool slot capacity for the static keys: what config.toml sets, else 1.
export function slotCapacity(key: string): number {
  return cfg.slotLimit(key);
}

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS jobs(
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'cmd',
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','running','waiting','done','failed','dead','timed_out')),
  priority INTEGER NOT NULL DEFAULT 0,
  run_at REAL NOT NULL,
  lease_owner TEXT,
  lease_expires_at REAL,
  waiting_on TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  created_at REAL NOT NULL,
  max_runtime_s REAL,
  runtime_used_s REAL NOT NULL DEFAULT 0,
  deadline_at REAL,
  claim_at REAL,
  outcome TEXT,
  pgid INTEGER,
  pidfile TEXT
)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, priority DESC, run_at, id)`,
  `CREATE TABLE IF NOT EXISTS concurrency_slots(
  key TEXT NOT NULL,
  lease_expires_at REAL NOT NULL,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  cost INTEGER NOT NULL DEFAULT 1
)`,
  `CREATE INDEX IF NOT EXISTS idx_slots_key ON concurrency_slots(key)`,
  `CREATE INDEX IF NOT EXISTS idx_slots_job ON concurrency_slots(job_id)`,
  // Single-row daemon registry: pid + heartbeat_ts. The daemon claims this row
  // atomically at start (singleton) and refreshes heartbeat_ts every loop tick;
  // doctor reads freshness (< 2x tick interval) to tell idle from dead.
  `CREATE TABLE IF NOT EXISTS daemon(
  id INTEGER PRIMARY KEY CHECK(id=1),
  pid INTEGER NOT NULL,
  heartbeat_ts REAL NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS spawn_audit(
  ts REAL NOT NULL,
  job_id INTEGER,
  argv0 TEXT NOT NULL,
  tool_class TEXT NOT NULL,
  project TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY,
  ts REAL NOT NULL,
  job_id INTEGER,
  kind TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}'
)`,
  `CREATE INDEX IF NOT EXISTS idx_events_job ON events(job_id)`,
  // Runtime-adjustable settings, written by `coordinate cap set` and read at
  // claim time. Keeping the cap in the DB (not the env) is what lets it change
  // without restarting the daemon.
  `CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`,
  // Durable metadata linking a captured attempt to its log files. Paths point
  // into the state directory; events never carry raw output, only these
  // pointers (docs/machine-schema.md).
  `CREATE TABLE IF NOT EXISTS job_logs(
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  attempt INTEGER NOT NULL,
  stdout_path TEXT,
  stderr_path TEXT,
  created_at REAL NOT NULL,
  PRIMARY KEY(job_id, attempt)
)`,
  // Surfaces primitives (surfaces-design.md): entities are addressable lease
  // and mailbox owners of any kind (jobs, processes, agents, endpoints);
  // leases are weighted semaphore grants; waits are the durable FIFO queue
  // for grants. concurrency_slots is the legacy job-only lease table and is
  // kept for schema compatibility, but new writes go to leases.
  `CREATE TABLE IF NOT EXISTS entities(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  device TEXT NOT NULL,
  heartbeat_ts REAL,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at REAL NOT NULL,
  expires_at REAL
)`,
  `CREATE TABLE IF NOT EXISTS leases(
  grant_id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  cost INTEGER NOT NULL DEFAULT 1,
  acquired_at REAL NOT NULL,
  lease_expires_at REAL NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_leases_key ON leases(key)`,
  `CREATE INDEX IF NOT EXISTS idx_leases_owner ON leases(owner_id)`,
  `CREATE TABLE IF NOT EXISTS waits(
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  cost INTEGER NOT NULL DEFAULT 1,
  enqueued_at REAL NOT NULL,
  deadline_at REAL,
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK(state IN ('queued','granted','cancelled','expired')),
  grant_id TEXT
)`,
  `CREATE INDEX IF NOT EXISTS idx_waits_key ON waits(key, state)`,
  // Entity-addressed mailbox (surfaces-design.md, actor-model.md): jobs,
  // agents and endpoints receive durable messages. dedupe_key is unique when
  // present, so a signal sent before the recipient parks is kept instead of
  // lost; deliver_at in the future is an alarm. Messages to dead owners are
  // reaped into state 'dead' rather than dropped.
  `CREATE TABLE IF NOT EXISTS mailbox(
  id INTEGER PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'message',
  payload TEXT NOT NULL DEFAULT '{}',
  sender TEXT,
  dedupe_key TEXT,
  deliver_at REAL NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending','delivered','dead')),
  created_at REAL NOT NULL,
  delivered_at REAL
)`,
  `CREATE INDEX IF NOT EXISTS idx_mailbox_owner ON mailbox(owner_id, state, deliver_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_mailbox_dedupe ON mailbox(dedupe_key) WHERE dedupe_key IS NOT NULL`,
];

// Statement lifecycle: every prepareRaw is tracked for the life of the
// connection, and Database.close() finalizes the tracked list through
// _untrack, which used to be a linear scan (quadratic close, measured at
// 29 s SIGTERM-to-exit on a churned daemon). The hot paths go through the
// helpers below, which finalize via `using` as the scope exits, so the
// tracked list stays near-empty and both the leak and the slow shutdown
// disappear.

// Run a statement that returns rows, finalizing it on the way out.
export function qAll(db: Database, sql: string, binds: BindValue[]): unknown[] {
  using st = db.prepareRaw(sql);
  return st.all(binds);
}

// Run a statement returning at most one row, finalizing it on the way out.
export function qOne(db: Database, sql: string, binds: BindValue[]): unknown | null {
  using st = db.prepareRaw(sql);
  return st.getOrNull(binds);
}

// Run a mutating statement, finalizing it on the way out.
export function qRun(db: Database, sql: string, binds: BindValue[]): RunResult {
  using st = db.prepareRaw(sql);
  return st.run(binds);
}

export function emit(db: Database, jid: number | null, kind: string, data: Record<string, unknown> = {}): void {
  qRun(db, "INSERT INTO events(ts,job_id,kind,data) VALUES(?,?,?,?)", [
    Date.now() / 1000,
    jid,
    kind,
    JSON.stringify(data),
  ]);
};

// Attach the attempt's log paths to an event's data (pointer only, no output).
// Kept separate from emit so existing callers stay untouched.
export function emitWithLogPaths(db: Database, jid: number, kind: string, data: Record<string, unknown>): void {
  const row = logRow(db, jid, currentAttempt(db, jid));
  if (row !== null) {
    const logs: Record<string, string | null> = {};
    if (row.stdout_path !== null) {
      logs["stdout"] = row.stdout_path;
    }
    if (row.stderr_path !== null) {
      logs["stderr"] = row.stderr_path;
    }
    if (row.stdout_path !== null || row.stderr_path !== null) {
      data["logs"] = logs;
    }
  }
  emit(db, jid, kind, data);
}

export function currentAttempt(db: Database, jid: number): number {
  const row = qOne(db, "SELECT attempts FROM jobs WHERE id=?", [jid]) as { attempts: number } | null;
  return row === null ? 0 : row.attempts;
}

export interface Job {
  id: number;
  kind: string;
  payload: string;
  status: string;
  priority: number;
  run_at: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  waiting_on: string | null;
  attempts: number;
  max_attempts: number;
  created_at: number;
  max_runtime_s: number | null;
  runtime_used_s: number;
  deadline_at: number | null;
  claim_at: number | null;
  outcome: string | null;
  pgid: number | null;
  pidfile: string | null;
}

interface IdRow {
  id: number;
}
interface KeyCostRow {
  key: string;
  c: number;
}
interface KeyRow {
  key: string;
}

// Open a transaction that holds the write lock from the start. The library
// issues a deferred BEGIN, and a deferred transaction that reads first cannot
// take the lock once another process has written: SQLite answers "database is
// locked" at once, without consulting busy_timeout. A write that matches no row,
// issued before any read, takes the lock while waiting is still possible.
export function writeTx(db: Database): Transaction {
  const tx = db.transaction();
  try {
    db.exec("DELETE FROM settings WHERE 0");
  } catch (e) {
    tx.rollback();
    throw e;
  }
  return tx;
}

function migrateJobs(db: Database): void {
  const row = qOne(db, "SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'", []) as
    | { sql: string }
    | null;
  if (row === null || row.sql.indexOf("timed_out") !== -1) {
    return;
  }
  const oldCols: string[] = [];
  const tiOld = qAll(db, "PRAGMA table_info(jobs)", []);
  for (const r of tiOld as { name: string }[]) {
    oldCols.push(r.name);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(
      `CREATE TABLE jobs_new(
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'cmd',
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','running','waiting','done','failed','dead','timed_out')),
  priority INTEGER NOT NULL DEFAULT 0,
  run_at REAL NOT NULL,
  lease_owner TEXT,
  lease_expires_at REAL,
  waiting_on TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  created_at REAL NOT NULL,
  max_runtime_s REAL,
  runtime_used_s REAL NOT NULL DEFAULT 0,
  deadline_at REAL,
  claim_at REAL,
  outcome TEXT,
  pgid INTEGER,
  pidfile TEXT
)`,
    );
    const newCols: string[] = [];
    const tiNew = qAll(db, "PRAGMA table_info(jobs_new)", []);
    for (const r of tiNew as { name: string }[]) {
      newCols.push(r.name);
    }
    const shared: string[] = [];
    for (const col of newCols) {
      if (oldCols.indexOf(col) !== -1) {
        shared.push(col);
      }
    }
    db.exec(`INSERT INTO jobs_new(${shared.join(",")}) SELECT ${shared.join(",")} FROM jobs`);
    db.exec("DROP TABLE jobs");
    db.exec("ALTER TABLE jobs_new RENAME TO jobs");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, priority DESC, run_at, id)");
}

function backupDbFile(p: string): void {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  try {
    fs.copyFileSync(p, `${p}.backup-${stamp}`);
  } catch {
    // A failed backup must not block the migration; the rebuild below is transactional.
  }
}

export function connect(): Database {  const p = dbPath();
  ensureParentDir(p);
  if (fs.existsSync(p)) {
    const db0 = Database.open(p);
    db0.exec("PRAGMA busy_timeout=5000");
    const row = qOne(db0, "SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'", []) as
      | { sql: string }
      | null;
    db0.close();
    if (row !== null && row.sql.indexOf("timed_out") === -1) {
      backupDbFile(p);
    }
  }
  const db = Database.open(p);
  db.exec("PRAGMA busy_timeout=5000");
  // Switching the journal to WAL needs a brief exclusive lock. If another
  // process holds it (a concurrent reader, another daemon starting up), the
  // pragma fails with SQLITE_BUSY and the caller dies before it can retry.
  // The database is already in WAL mode in practice, so a busy pragma means
  // "someone else did it": keep going and let busy_timeout handle the rest.
  try {
    db.exec("PRAGMA journal_mode=WAL");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/locked|busy/i.test(msg)) {
      throw e;
    }
  }
  db.exec("PRAGMA synchronous=NORMAL");
  migrateJobs(db);
  for (const ddl of SCHEMA) {
    db.exec(ddl);
  }
  const have: string[] = [];
  const tiJobs = qAll(db, "PRAGMA table_info(jobs)", []);
  for (const r of tiJobs as { name: string }[]) {
    have.push(r.name);
  }
  const cols: [string, string][] = [
    ["pgid", "INTEGER"],
    ["pidfile", "TEXT"],
    ["max_runtime_s", "REAL"],
    ["runtime_used_s", "REAL DEFAULT 0"],
    ["deadline_at", "REAL"],
    ["claim_at", "REAL"],
    ["outcome", "TEXT"],
  ];
  for (const [col, typ] of cols) {
    if (have.indexOf(col) === -1) {
      db.exec(`ALTER TABLE jobs ADD COLUMN ${col} ${typ}`);
    }
  }
  return db;
}

// --- per-job, per-attempt output capture ---

// Log directory inside the coordinate state directory, next to queue.db so an
// override of COORDINATE_DB moves its logs with it.
export function logsDir(): string {
  return path.join(path.dirname(dbPath()), "logs");
}

export interface LogPathPair {
  stdout: string | null;
  stderr: string | null;
}

// Open the per-attempt log files and return the descriptors the child
// inherits. The daemon passes them as the child's stdout/stderr fds, so the
// output lands in the files without a copy in the daemon's memory.
// ACP jobs keep stdout for the protocol, so only stderr is captured there.
export function openLogFiles(
  jid: number,
  attempt: number,
  withStdout: boolean,
): { pair: LogPathPair; stdoutFd: number; stderrFd: number } | null {
  try {
    const dir = logsDir();
    fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, String(jid) + "-" + String(attempt));
    const stdoutPath = withStdout ? base + ".stdout.log" : null;
    const stderrPath = base + ".stderr.log";
    const stdoutFd = stdoutPath === null ? -1 : fs.openSync(stdoutPath, "w");
    let stderrFd = -1;
    try {
      stderrFd = fs.openSync(stderrPath, "w");
    } catch {
      if (stdoutFd >= 0) {
        fs.closeSync(stdoutFd);
      }
      throw new Error("stderr log open failed");
    }
    return { pair: { stdout: stdoutPath, stderr: stderrPath }, stdoutFd, stderrFd };
  } catch {
    // Capture is best effort: a job must still run when the log directory is
    // not writable (read-only state mount, permissions). The daemon inherits
    // output as before and `coordinate logs` reports the missing metadata.
    return null;
  }
}

// Record the log paths of an attempt. Durable metadata links job, attempt and
// the files; events only ever reference these paths, never the output.
export function recordLogFiles(db: Database, jid: number, attempt: number, pair: LogPathPair): void {
  try {
    qRun(
      db,
      "INSERT INTO job_logs(job_id,attempt,stdout_path,stderr_path,created_at) VALUES(?,?,?,?,?) " +
        "ON CONFLICT(job_id,attempt) DO UPDATE SET stdout_path=excluded.stdout_path, stderr_path=excluded.stderr_path",
      [jid, attempt, pair.stdout, pair.stderr, Date.now() / 1000],
    );
  } catch {
    // The metadata is best effort too: the files exist even if the row does not.
  }
}

export interface JobLogRow {
  job_id: number;
  attempt: number;
  stdout_path: string | null;
  stderr_path: string | null;
  created_at: number;
}

export function logRows(db: Database, jid: number): JobLogRow[] {
  return qAll(db, "SELECT * FROM job_logs WHERE job_id=? ORDER BY attempt", [jid]) as JobLogRow[];
}

export function logRow(db: Database, jid: number, attempt: number): JobLogRow | null {
  return qOne(db, "SELECT * FROM job_logs WHERE job_id=? AND attempt=?", [jid, attempt]) as JobLogRow | null;
}

export function latestAttempt(db: Database, jid: number): number {
  const row = qOne(db, "SELECT MAX(attempt) AS a FROM job_logs WHERE job_id=?", [jid]) as { a: number | null } | null;
  if (row !== null && row.a !== null) {
    return row.a;
  }
  const j = getJob(db, jid);
  return j === null ? 0 : j.attempts;
}

// --- daemon singleton + heartbeat (single row id=1 in the daemon table) ---

interface DaemonRow {
  pid: number;
  heartbeat_ts: number;
}

// Heartbeat freshness window for doctor: the daemon refreshes at least once
// per loop tick; BACKOFF_MAX in daemon.ts is 2s, so anything fresher than 2x
// that is proof of a live dispatcher.
export const DAEMON_HB_STALE_S = 4.0;

// A killed daemon leaves a heartbeat no fresher than LEASE_S behind; restarts
// (e.g. regression test X3 with LEASE_S=2) must be able to reclaim it by then.
function claimStaleS(): number {
  return Math.min(DAEMON_HB_STALE_S, LEASE_S);
}

export function daemonHeartbeatTs(db: Database): number | null {
  const row = qOne(db, "SELECT heartbeat_ts FROM daemon WHERE id=1", []) as { heartbeat_ts: number } | null;
  return row === null ? null : row.heartbeat_ts;
}

export function daemonHeartbeat(db: Database, pid: number): void {
  const now = Date.now() / 1000;
  qRun(
    db,
    "INSERT INTO daemon(id,pid,heartbeat_ts) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid, heartbeat_ts=excluded.heartbeat_ts",
    [pid, now],
  );
}

// claimable: any heartbeat older than LEASE_S is from a daemon whose job
// leases have already expired, so it cannot be making progress. Returns the
// pid of the running daemon when a fresh-enough heartbeat exists, else null.
export function liveDaemonPid(db: Database): number | null {
  const row = qOne(db, "SELECT pid, heartbeat_ts FROM daemon WHERE id=1", []) as DaemonRow | null;
  if (row === null) {
    return null;
  }
  if (Date.now() / 1000 - row.heartbeat_ts < claimStaleS()) {
    return row.pid;
  }
  return null;
}

// Atomically claim the singleton daemon slot. Returns true when this process
// now owns row id=1; returns false when a fresh heartbeat from another daemon
// is present (that daemon's pid is written to *conflictPid).
export function claimDaemon(db: Database, pid: number, conflictPid: { v: number | null }): boolean {
  using _tx = writeTx(db);
  const other = liveDaemonPid(db);
  if (other !== null) {
    conflictPid.v = other;
    return false;
  }
  daemonHeartbeat(db, pid);
  recordMachine(db);
  return true;
}

// The daemon's machine name, recorded in the settings table on every claim so
// that `cap show` (and anything else that reads the queue from another
// process) reports the daemon's identity rather than the CLI process's env,
// which may not carry COORDINATE_MACHINE at all.
export const SETTING_MACHINE = "machine";

function recordMachine(db: Database): void {
  setSetting(db, SETTING_MACHINE, MACHINE);
}

// The generic settings writer behind setCap; kept separate so setCap's
// number-typed API stays honest.
function setSetting(db: Database, key: string, value: string): void {
  qRun(db, "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [
    key,
    value,
  ]);
}

export function recordedMachine(db: Database): string | null {
  const row = qOne(db, "SELECT value FROM settings WHERE key=?", [SETTING_MACHINE]) as { value: string } | null;
  return row === null ? null : row.value;
}

export function slotKeys(payload: Payload): string[] {
  const keys: string[] = ["machine:" + MACHINE];
  const repo = payload.repo !== null && payload.repo !== undefined ? payload.repo : payload.cwd;
  if (repo !== null && repo !== undefined && repo !== "") {
    keys.push("repo:" + path.resolve(repo));
  }
  if (payload.slots !== null && payload.slots !== undefined) {
    for (const s of payload.slots) {
      keys.push(s);
    }
  }
  return keys;
}

export interface Payload {
  cmd: string | string[];
  cwd: string | null;
  repo?: string | null;
  slots?: string[] | null;
  session?: string | null;
}

interface Parsed {
  jid: number;
  kind: string;
  payload: Payload;
}

export function enqueue(db: Database, payload: Payload, priority = 0, maxAttempts = 3, runAt: number | null = null, maxRuntimeS: number | null = null, kind: string = "cmd"): number {
  const now = Date.now() / 1000;
  const r = qRun(
    db,
    "INSERT INTO jobs(kind,payload,priority,run_at,attempts,max_attempts,created_at,max_runtime_s) VALUES(?,?,?,?,?,?,?,?)",
    [kind, JSON.stringify(payload), priority, runAt === null ? now : runAt, 0, maxAttempts, now, maxRuntimeS === null ? null : maxRuntimeS],
  );
  const jid = r.lastInsertRowid;
  registerEntity(db, "job:" + jid, "job", null);
  emit(db, jid, "enqueued", { kind: kind });
  return jid;
}

function usedByKey(db: Database): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of qAll(db, "SELECT key, COUNT(*) AS c FROM leases GROUP BY key", []) as KeyCostRow[]) {
    out[row.key] = row.c;
  }
  return out;
}

function qUsedCost(db: Database, key: string): number {
  const row = qOne(db, "SELECT COALESCE(SUM(cost),0) AS c FROM leases WHERE key=?", [key]) as { c: number } | null;
  return row === null ? 0 : row.c;
}

export function claim(db: Database, owner: string): Parsed | null {
  const now = Date.now() / 1000;
  using _tx = writeTx(db);
  db.exec("DELETE FROM concurrency_slots WHERE lease_expires_at < " + now);
  db.exec("DELETE FROM leases WHERE lease_expires_at < " + now);
  const used = usedByKey(db);
  const machineKey = "machine:" + MACHINE;
  if ((used[machineKey] === undefined ? 0 : used[machineKey]) >= machineCap(db)) {
    return null;
  }
  // Aging (config.toml [scheduler]): boost = min(ceiling, age/period) when
  // aging="linear", else 0. "off" keeps the byte-identical historical SQL.
  const sched = cfg.agingConfig();
  let sql: string;
  let binds: BindValue[];
  if (sched.aging === "off") {
    sql = "SELECT id, payload, kind FROM jobs WHERE status='queued' AND run_at<=? ORDER BY priority DESC, run_at, id LIMIT 100";
    binds = [now];
  } else {
    sql =
      "SELECT id, payload, kind FROM jobs WHERE status='queued' AND run_at<=? " +
      "ORDER BY priority + MIN(?, CAST((? - created_at) / ? AS INTEGER)) DESC, run_at, id LIMIT 100";
    binds = [now, sched.ceiling, now, sched.periodS];
  }
  const rows = qAll(db, sql, binds) as { id: number; payload: string; kind: string }[];
  for (const row of rows) {
    const jid = row.id;
    const payload = JSON.parse(row.payload) as Payload;
    const keys = slotKeys(payload);
    let blocked = false;
    for (const k of keys) {
      if (k.startsWith("repo:") && (used[k] === undefined ? 0 : used[k]) >= repoCap(db)) {
        blocked = true;
        break;
      }
    }
    if (blocked) {
      continue;
    }
    // static tool keys honor their [slots] limits at claim time (weighted, D3)
    blocked = false;
    for (const k of keys) {
      if (!k.startsWith("machine:") && !k.startsWith("repo:") && qUsedCost(db, k) + 1 > cfg.slotLimit(k)) {
        blocked = true;
        break;
      }
    }
    if (blocked) {
      continue;
    }
    const budget = qOne(db, "SELECT max_runtime_s, runtime_used_s FROM jobs WHERE id=?", [jid]) as
      | { max_runtime_s: number | null; runtime_used_s: number }
      | null;
    let deadlineAt: number | null = null;
    if (budget !== null && budget.max_runtime_s !== null && budget.max_runtime_s > 0) {
      const remaining = budget.max_runtime_s - (budget.runtime_used_s || 0);
      if (remaining <= 0) {
        db.exec(
          "UPDATE jobs SET status='timed_out', outcome='budget exhausted before claim', lease_owner=NULL, lease_expires_at=NULL WHERE id=" + jid,
        );
        emit(db, jid, "timed_out", { outcome: "budget exhausted before claim" });
        continue;
      }
      deadlineAt = now + remaining;
    }
    const exp = now + LEASE_S;
    qRun(db, "UPDATE jobs SET status='running', attempts=attempts+1, lease_owner=?, lease_expires_at=?, claim_at=?, deadline_at=? WHERE id=?", [
      owner,
      exp,
      now,
      deadlineAt,
      jid,
    ]);
    {
      using insSlot = db.prepareRaw("INSERT INTO leases(grant_id,key,owner_id,cost,acquired_at,lease_expires_at) VALUES(?,?,?,?,?,?)");
      for (const k of keys) {
        insSlot.run(["job:" + jid + ":" + k, k, "job:" + jid, 1, now, exp]);
      }
    }
    const attempt = (
      qOne(db, "SELECT attempts FROM jobs WHERE id=?", [jid]) as { attempts: number } | null
    )?.attempts;
    emit(db, jid, "claimed", { owner, attempt: attempt === undefined ? null : attempt });
    return { jid, kind: row.kind, payload };
  }
  return null;
}

export function chargeRuntime(db: Database, jid: number): void {
  const now = Date.now() / 1000;
  qRun(db, "UPDATE jobs SET runtime_used_s=runtime_used_s+? - COALESCE(claim_at, ?) WHERE id=? AND status='running' AND claim_at IS NOT NULL", [now, now, jid]);
}

export function heartbeat(db: Database, jid: number, owner: string): boolean {
  const exp = Date.now() / 1000 + LEASE_S;
  using _tx = writeTx(db);
  const cur = qRun(db, "UPDATE jobs SET lease_expires_at=? WHERE id=? AND status='running' AND lease_owner=?", [exp, jid, owner]);
  if (cur.changes > 0) {
    qRun(db, "UPDATE concurrency_slots SET lease_expires_at=? WHERE job_id=?", [exp, jid]);
    qRun(db, "UPDATE leases SET lease_expires_at=? WHERE owner_id=?", [exp, "job:" + jid]);
  }
  return cur.changes > 0;
}

export function finish(db: Database, jid: number, owner: string, status: string, outcome: string | null = null, exitCode: number | null = null): string | null {
  using _tx = writeTx(db);
  chargeRuntime(db, jid);
  qRun(db, "UPDATE jobs SET status=?, outcome=COALESCE(?, outcome), lease_owner=NULL, lease_expires_at=NULL, pgid=NULL, pidfile=NULL, claim_at=NULL WHERE id=? AND status='running' AND lease_owner=?", [
    status,
    outcome,
    jid,
    owner,
  ]);
  let event: string | null = null;
  const slots = qAll(db, "SELECT key FROM leases WHERE owner_id=? AND key LIKE 'tool:%'", ["job:" + jid]) as KeyRow[];
  for (const s of slots) {
    if (event === null) {
      event = s.key;
    }
  }
  qRun(db, "DELETE FROM concurrency_slots WHERE job_id=? AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND status<>'running')", [jid, jid]);
  qRun(db, "DELETE FROM leases WHERE owner_id=?", ["job:" + jid]);
  const data: Record<string, unknown> = { status };
  if (outcome !== null) {
    data["outcome"] = outcome;
  }
  if (exitCode !== null) {
    data["exit_code"] = exitCode;
  }
  emitWithLogPaths(db, jid, status === "done" ? "done" : status, data);
  return event;
}

// Port of queue.py kill_orphans: SIGKILL the job's surviving process group before an expired
// lease is requeued, so a retry never runs beside the old attempt after a daemon crash.
// Caveat (as in Python's docstring): a recorded pgid can be reused by an unrelated process
// group after a long outage; the PID-reuse risk is accepted because we only signal groups of
// jobs whose lease expired in this database. We never signal pid <= 1, and ESRCH (the group is
// already gone) is ignored.
function killOrphans(db: Database, pgid: number | null, _pidfile: string | null): void {
  if (pgid === null || pgid === undefined || pgid <= 1) {
    return;
  }
  try {
    // signal the group (negative pgid), not the leader pid alone
    process.kill(-pgid, "SIGKILL");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") {
      throw e;
    }
  }
}

export function reap(db: Database): number[] {
  const now = Date.now() / 1000;
  using _tx = writeTx(db);
  const expired = qAll(db, "SELECT id FROM jobs WHERE status='running' AND lease_expires_at<?", [now]) as IdRow[];
  for (const row of expired) {
    chargeRuntime(db, row.id);
  }
  // Kill survivors before the requeue commits, so a retry never runs beside the old attempt.
  for (const row of qAll(db, "SELECT id, pgid, pidfile FROM jobs WHERE status='running' AND lease_expires_at<?", [now]) as { id: number; pgid: number | null; pidfile: string | null }[]) {
    killOrphans(db, row.pgid, row.pidfile);
  }
  for (const row of qAll(
    db,
    "UPDATE jobs SET status='timed_out', outcome='lease expired after deadline', lease_owner=NULL, lease_expires_at=NULL, pgid=NULL, pidfile=NULL, claim_at=NULL WHERE status='running' AND lease_expires_at<? AND deadline_at IS NOT NULL AND deadline_at<=? RETURNING id",
    [now, now],
  ) as IdRow[]) {
    emit(db, row.id, "timed_out", { outcome: "lease expired after deadline" });
  }
  const rows = qAll(
    db,
    "UPDATE jobs SET status=CASE WHEN attempts<max_attempts THEN 'queued' ELSE 'dead' END, lease_owner=NULL, lease_expires_at=NULL, pgid=NULL, pidfile=NULL, claim_at=NULL, deadline_at=NULL WHERE status='running' AND lease_expires_at<? RETURNING id",
    [now],
  ) as IdRow[];
  for (const r of rows) {
    const st = (qOne(db, "SELECT status FROM jobs WHERE id=?", [r.id]) as { status: string } | null)?.status;
    const attempt = (
      qOne(db, "SELECT attempts FROM jobs WHERE id=?", [r.id]) as { attempts: number } | null
    )?.attempts;
    emit(db, r.id, st === "queued" ? "requeued" : "dead", {
      reason: "lease expired",
      attempt: attempt === undefined ? null : attempt,
    });
  }
  db.exec("DELETE FROM concurrency_slots WHERE job_id IN (SELECT id FROM jobs WHERE status<>'running')");
  db.exec("DELETE FROM leases WHERE owner_id IN (SELECT 'job:' || id FROM jobs WHERE status<>'running')");
  const out: number[] = [];
  for (const r of rows) {
    out.push(r.id);
  }
  return out;
}

export function waitOn(db: Database, jid: number, event: string): boolean {
  using _tx = writeTx(db);
  chargeRuntime(db, jid);
  const cur = qRun(
    db,
    "UPDATE jobs SET status='waiting', waiting_on=?, lease_owner=NULL, lease_expires_at=NULL, claim_at=NULL, deadline_at=NULL WHERE id=? AND status IN ('queued','running')",
    [event, jid],
  );
  qRun(db, "DELETE FROM concurrency_slots WHERE job_id=?", [jid]);
  qRun(db, "DELETE FROM leases WHERE owner_id=?", ["job:" + jid]);
  if (cur.changes > 0) {
    emit(db, jid, "parked", { waiting_on: event });
  }
  return cur.changes > 0;
}

export function release(db: Database, event: string): number[] {
  const rows = qAll(
    db,
    "UPDATE jobs SET status='queued', waiting_on=NULL WHERE status='waiting' AND waiting_on=? RETURNING id",
    [event],
  ) as IdRow[];
  const out: number[] = [];
  for (const r of rows) {
    out.push(r.id);
    emit(db, r.id, "released", { event });
  }
  return out;
}

export function cancel(db: Database, jid: number): boolean {
  using _tx = writeTx(db);
  chargeRuntime(db, jid);
  const cur = qRun(
    db,
    "UPDATE jobs SET status='failed', lease_owner=NULL, lease_expires_at=NULL, waiting_on=NULL, claim_at=NULL WHERE id=? AND status IN ('queued','running','waiting')",
    [jid],
  );
  qRun(db, "DELETE FROM concurrency_slots WHERE job_id=? AND cost>0", [jid]);
  qRun(db, "DELETE FROM leases WHERE owner_id=?", ["job:" + jid]);
  if (cur.changes > 0) {
    emit(db, jid, "cancelled", { recorded_as: "failed" });
  }
  return cur.changes > 0;
}

export function retryDead(db: Database, jid: number | null): number[] {
  let sql = "UPDATE jobs SET status='queued', attempts=0 WHERE status IN ('dead','failed')";
  if (jid !== null) {
    sql += " AND id=" + jid;
  }
  sql += " RETURNING id";
  const rows = qAll(db, sql, []) as IdRow[];
  const out: number[] = [];
  for (const r of rows) {
    out.push(r.id);
    emit(db, r.id, "requeued", { reason: "dead retry", attempt: 0 });
  }
  return out;
}

export function stats(db: Database): Record<string, number> {
  const out: Record<string, number> = {};
  const rows = qAll(db, "SELECT status, COUNT(*) AS c FROM jobs GROUP BY status", []) as { status: string; c: number }[];
  for (const r of rows) {
    out[r.status] = r.c;
  }
  return out;
}

export function getJob(db: Database, jid: number): Job | null {
  const row = qOne(db, "SELECT * FROM jobs WHERE id=?", [jid]) as Job | null;
  return row;
}

export function statusSelf(db: Database, jidText: string): Job | null {
  return getJob(db, Number(jidText));
}

export function expiredRunning(db: Database): { id: number; kind: string; payload: string; pgid: number | null; pidfile: string | null }[] {
  const now = Date.now() / 1000;
  return qAll(
    db,
    "SELECT id, kind, payload, pgid, pidfile FROM jobs WHERE status='running' AND deadline_at IS NOT NULL AND deadline_at<=?",
    [now],
  ) as { id: number; kind: string; payload: string; pgid: number | null; pidfile: string | null }[];
}

export function finalizeTimedOut(db: Database, jid: number, outcome: string): boolean {
  using _tx = writeTx(db);
  chargeRuntime(db, jid);
  const cur = qRun(
    db,
    "UPDATE jobs SET status='timed_out', outcome=?, claim_at=NULL, lease_owner=NULL, lease_expires_at=NULL, pgid=NULL, pidfile=NULL, waiting_on=NULL WHERE id=? AND status='running'",
    [outcome, jid],
  );
  qRun(db, "DELETE FROM concurrency_slots WHERE job_id=? AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND status<>'running')", [jid, jid]);
  qRun(db, "DELETE FROM leases WHERE owner_id=?", ["job:" + jid]);
  if (cur.changes > 0) {
    emit(db, jid, "timed_out", { outcome });
  }
  return cur.changes > 0;
}

// --- surfaces primitives: entities, weighted semaphore leases, FIFO waits ---
// Design: .agents/docs/surfaces-design.md. Jobs hold their slots through the
// same leases table (owner 'job:<id>'), so external sessions and queue jobs
// share one accounting space.

export interface Entity {
  id: string;
  kind: string;
  device: string;
  heartbeat_ts: number | null;
  meta: string;
  created_at: number;
  expires_at: number | null;
}

export interface Lease {
  grant_id: string;
  key: string;
  owner_id: string;
  cost: number;
  acquired_at: number;
  lease_expires_at: number;
}

export interface Wait {
  id: number;
  key: string;
  owner_id: string;
  cost: number;
  enqueued_at: number;
  deadline_at: number | null;
  state: string;
  grant_id: string | null;
}

let grantCounter = 0;

function newGrantId(prefix: string): string {
  grantCounter += 1;
  return prefix + ":" + process.pid + ":" + Date.now().toString(36) + ":" + grantCounter;
}

// Upsert an entity. ttlS null means no expiry backstop; job entities outlive
// their leases because the job row is their liveness source.
export function registerEntity(db: Database, id: string, kind: string, ttlS: number | null): void {
  const now = Date.now() / 1000;
  qRun(
    db,
    "INSERT INTO entities(id,kind,device,heartbeat_ts,created_at,expires_at) VALUES(?,?,?,?,?,?) " +
      "ON CONFLICT(id) DO UPDATE SET heartbeat_ts=excluded.heartbeat_ts, expires_at=excluded.expires_at",
    [id, kind, MACHINE, now, now, ttlS === null ? null : now + ttlS],
  );
}

export function heartbeatEntity(db: Database, id: string, ttlS: number | null): boolean {
  const now = Date.now() / 1000;
  const cur = qRun(db, "UPDATE entities SET heartbeat_ts=?, expires_at=? WHERE id=?", [
    now,
    ttlS === null ? null : now + ttlS,
    id,
  ]);
  return cur.changes > 0;
}

export function getEntity(db: Database, id: string): Entity | null {
  return qOne(db, "SELECT * FROM entities WHERE id=?", [id]) as Entity | null;
}

// Liveness probe for pid entities. kill(pid, 0) delivers no signal; EPERM means
// the process exists but belongs to someone else, which is still alive.
function pidAlive(pid: number): boolean {
  if (pid <= 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

// Liveness by owner kind: jobs defer to their job row, processes probe the pid,
// everything else trusts the entity row's expiry backstop.
export function ownerIsAlive(db: Database, ownerId: string): boolean {
  if (ownerId.startsWith("job:")) {
    const row = qOne(db, "SELECT status FROM jobs WHERE id=?", [Number(ownerId.slice(4))]) as { status: string } | null;
    return row !== null && (row.status === "queued" || row.status === "running" || row.status === "waiting");
  }
  if (ownerId.startsWith("pid:")) {
    return pidAlive(Number(ownerId.slice(4)));
  }
  const ent = getEntity(db, ownerId);
  if (ent === null) {
    return false;
  }
  if (ent.expires_at !== null && ent.expires_at < Date.now() / 1000) {
    return false;
  }
  return true;
}

// Reap dead owners: release their leases and cancel their queued waits, so a
// killed tool run or a Ctrl-C'd shim can never wedge capacity behind it.
// Returns the freed keys so the caller can drain waiters.
export function reapEntities(db: Database): string[] {
  const owners: string[] = [];
  for (const r of qAll(db, "SELECT DISTINCT owner_id AS o FROM leases", []) as { o: string }[]) {
    owners.push(r.o);
  }
  for (const r of qAll(db, "SELECT DISTINCT owner_id AS o FROM waits WHERE state='queued'", []) as { o: string }[]) {
    if (owners.indexOf(r.o) === -1) {
      owners.push(r.o);
    }
  }
  const freed: string[] = [];
  for (const o of owners) {
    if (ownerIsAlive(db, o)) {
      continue;
    }
    // Select every column: compiled binaries check the cast against the row at
    // run time, so a partial select typed as Lease throws and kills the daemon.
    for (const l of qAll(db, "SELECT * FROM leases WHERE owner_id=?", [o]) as Lease[]) {
      qRun(db, "DELETE FROM leases WHERE grant_id=?", [l.grant_id]);
      emit(db, null, "lease_reaped", { grant_id: l.grant_id, key: l.key, owner: o });
      if (freed.indexOf(l.key) === -1) {
        freed.push(l.key);
      }
    }
    for (const w of qAll(db, "SELECT id FROM waits WHERE owner_id=? AND state='queued'", [o]) as { id: number }[]) {
      qRun(db, "UPDATE waits SET state='cancelled' WHERE id=?", [w.id]);
      emit(db, null, "wait_cancelled", { wait_id: w.id, owner: o, reason: "owner dead" });
    }
  }
  // GC entity rows: terminal jobs and expired entities.
  qRun(
    db,
    "DELETE FROM entities WHERE id LIKE 'job:%' AND CAST(substr(id,5) AS INTEGER) IN (SELECT id FROM jobs WHERE status IN ('done','failed','dead','timed_out'))",
    [],
  );
  qRun(db, "DELETE FROM entities WHERE expires_at IS NOT NULL AND expires_at<?", [Date.now() / 1000]);
  return freed;
}

// Drop expired leases. Returns the keys that freed capacity.
export function expireLeases(db: Database): string[] {
  const now = Date.now() / 1000;
  const rows = qAll(db, "SELECT DISTINCT key AS k FROM leases WHERE lease_expires_at<?", [now]) as { k: string }[];
  if (rows.length > 0) {
    qRun(db, "DELETE FROM leases WHERE lease_expires_at<?", [now]);
  }
  const out: string[] = [];
  for (const r of rows) {
    out.push(r.k);
  }
  return out;
}

export function leaseUsedCost(db: Database, key: string): number {
  const now = Date.now() / 1000;
  const row = qOne(db, "SELECT COALESCE(SUM(cost),0) AS c FROM leases WHERE key=? AND lease_expires_at>=?", [key, now]) as {
    c: number;
  } | null;
  return row === null ? 0 : row.c;
}

// Wake jobs parked on this key (the legacy waitOn/release path) only when
// capacity might fit; waking on a saturated key just makes jobs respawn,
// fail the acquire and park again, which is churn without progress.
function wakeParkedJobs(db: Database, key: string): void {
  if (leaseUsedCost(db, key) < cfg.slotLimit(key)) {
    release(db, key);
  }
}

// Grant queued waits for one key in strict FIFO order. The head can always fit
// eventually because oversized costs are refused before enqueue, so smaller
// waiters never need to jump ahead: free units return monotonically and the
// head consumes them.
export function drainWaits(db: Database, key: string): void {
  const limit = cfg.slotLimit(key);
  const now = Date.now() / 1000;
  for (;;) {
    const head = qOne(db, "SELECT * FROM waits WHERE key=? AND state='queued' ORDER BY id LIMIT 1", [key]) as Wait | null;
    if (head === null) {
      break;
    }
    if (head.deadline_at !== null && head.deadline_at < now) {
      qRun(db, "UPDATE waits SET state='expired' WHERE id=?", [head.id]);
      emit(db, null, "wait_expired", { wait_id: head.id, key, owner: head.owner_id });
      continue;
    }
    if (leaseUsedCost(db, key) + head.cost > limit) {
      break;
    }
    const grantId = newGrantId("g");
    qRun(db, "INSERT INTO leases(grant_id,key,owner_id,cost,acquired_at,lease_expires_at) VALUES(?,?,?,?,?,?)", [
      grantId,
      key,
      head.owner_id,
      head.cost,
      now,
      now + LEASE_S,
    ]);
    qRun(db, "UPDATE waits SET state='granted', grant_id=? WHERE id=?", [grantId, head.id]);
    emit(db, null, "lease_granted", { grant_id: grantId, key, owner: head.owner_id, cost: head.cost, wait_id: head.id });
  }
}

// Capacity maintenance shared by every path that can free or consume units:
// expire TTLs, reap dead owners, drain the waiters of every affected key and
// wake legacy parked jobs. Safe to call inside an outer transaction.
export function maintainLeases(db: Database, keys: string[]): void {
  const affected: string[] = [];
  for (const k of expireLeases(db)) {
    if (affected.indexOf(k) === -1) {
      affected.push(k);
    }
  }
  for (const k of reapEntities(db)) {
    if (affected.indexOf(k) === -1) {
      affected.push(k);
    }
  }
  for (const k of keys) {
    if (affected.indexOf(k) === -1) {
      affected.push(k);
    }
  }
  // Capacity freed by job finish/park/cancel does not surface through expire or
  // reap, so always consider keys that have queued waiters; draining a key with
  // no free units is a no-op.
  for (const r of qAll(db, "SELECT DISTINCT key AS k FROM waits WHERE state='queued'", []) as { k: string }[]) {
    if (affected.indexOf(r.k) === -1) {
      affected.push(r.k);
    }
  }
  for (const k of affected) {
    drainWaits(db, k);
    wakeParkedJobs(db, k);
  }
  reapMailbox(db);
}

// Try an immediate grant with no barging: queued waiters for the key mean the
// caller must queue behind them even when units are free. Returns the grant id
// or null. Caller checks cost against slotLimit first (a cost above the limit
// can never grant and is a config error, not contention).
export function acquireLease(db: Database, key: string, owner: string, cost: number): string | null {
  using _tx = writeTx(db);
  maintainLeases(db, [key]);
  const queued = qOne(db, "SELECT COUNT(*) AS c FROM waits WHERE key=? AND state='queued'", [key]) as { c: number };
  if (queued.c === 0 && leaseUsedCost(db, key) + cost <= cfg.slotLimit(key)) {
    const now = Date.now() / 1000;
    const grantId = newGrantId("g");
    qRun(db, "INSERT INTO leases(grant_id,key,owner_id,cost,acquired_at,lease_expires_at) VALUES(?,?,?,?,?,?)", [
      grantId,
      key,
      owner,
      cost,
      now,
      now + LEASE_S,
    ]);
    emit(db, null, "lease_granted", { grant_id: grantId, key, owner, cost });
    return grantId;
  }
  return null;
}

export function enqueueWait(db: Database, key: string, owner: string, cost: number, deadlineAt: number | null): number {
  const r = qRun(db, "INSERT INTO waits(key,owner_id,cost,enqueued_at,deadline_at) VALUES(?,?,?,?,?)", [
    key,
    owner,
    cost,
    Date.now() / 1000,
    deadlineAt,
  ]);
  const id = Number(r.lastInsertRowid);
  emit(db, null, "wait_enqueued", { wait_id: id, key, owner, cost });
  return id;
}

export function releaseLease(db: Database, grantId: string): boolean {
  using _tx = writeTx(db);
  const row = qOne(db, "SELECT key FROM leases WHERE grant_id=?", [grantId]) as { key: string } | null;
  if (row === null) {
    return false;
  }
  qRun(db, "DELETE FROM leases WHERE grant_id=?", [grantId]);
  emit(db, null, "lease_released", { grant_id: grantId, key: row.key });
  maintainLeases(db, [row.key]);
  return true;
}

// Extend a grant's TTL. Holders heartbeat through this; a lease nobody
// refreshes evaporates after LEASE_S, which is the backstop for volatile runs.
export function refreshLease(db: Database, grantId: string): boolean {
  const cur = qRun(db, "UPDATE leases SET lease_expires_at=? WHERE grant_id=?", [Date.now() / 1000 + LEASE_S, grantId]);
  return cur.changes > 0;
}

export function cancelWait(db: Database, waitId: number): boolean {
  const cur = qRun(db, "UPDATE waits SET state='cancelled' WHERE id=? AND state='queued'", [waitId]);
  if (cur.changes > 0) {
    emit(db, null, "wait_cancelled", { wait_id: waitId, reason: "explicit" });
  }
  return cur.changes > 0;
}

export function getWait(db: Database, waitId: number): Wait | null {
  return qOne(db, "SELECT * FROM waits WHERE id=?", [waitId]) as Wait | null;
}

export function listLeases(db: Database): Lease[] {
  return qAll(db, "SELECT * FROM leases ORDER BY key, acquired_at", []) as Lease[];
}

export function listWaits(db: Database): Wait[] {
  return qAll(db, "SELECT * FROM waits WHERE state='queued' ORDER BY key, id", []) as Wait[];
}

// --- mailbox: durable messages addressed to entities ---
// deliver_at in the future is an alarm; dedupe_key makes re-sends idempotent;
// a message to a parked job wakes it, so the wake carries data instead of the
// pre-park signal being lost (the pre-mailbox release() only matched rows
// already waiting).

export interface MailMessage {
  id: number;
  owner_id: string;
  kind: string;
  payload: string;
  sender: string | null;
  dedupe_key: string | null;
  deliver_at: number;
  state: string;
  created_at: number;
  delivered_at: number | null;
}

// Delivered messages are garbage-collected after this many seconds (bounded
// storage: the queue is state with a TTL, not an archive).
export const MAIL_DELIVERED_TTL_S = 7 * 24 * 3600;

// Returns the new message id, or null when the dedupe key already exists.
export function sendMessage(
  db: Database,
  owner: string,
  kind: string,
  payload: Record<string, unknown>,
  sender: string | null,
  dedupeKey: string | null,
  deliverAt: number | null,
): number | null {
  const now = Date.now() / 1000;
  const r = qRun(
    db,
    "INSERT OR IGNORE INTO mailbox(owner_id,kind,payload,sender,dedupe_key,deliver_at,created_at) VALUES(?,?,?,?,?,?,?)",
    [owner, kind, JSON.stringify(payload), sender, dedupeKey, deliverAt === null ? now : deliverAt, now],
  );
  if (r.changes === 0) {
    return null;
  }
  const id = Number(r.lastInsertRowid);
  emit(db, null, "message_sent", { message_id: id, owner, kind, sender });
  // Wake carries data: a parked recipient job is requeued so it can read its
  // inbox on resume. Running and queued jobs are not interrupted; they read
  // the mailbox at their own boundary.
  if (owner.startsWith("job:")) {
    const jid = Number(owner.slice(4));
    const cur = qRun(db, "UPDATE jobs SET status='queued', waiting_on=NULL WHERE id=? AND status='waiting'", [jid]);
    if (cur.changes > 0) {
      emit(db, jid, "woken", { message_id: id });
    }
  }
  return id;
}

// Visible messages for an owner: pending and due. mark=true transitions them
// to delivered in the same transaction (read-and-consume); otherwise peeking.
export function inboxMessages(db: Database, owner: string, mark: boolean, includeFuture: boolean): MailMessage[] {
  const now = Date.now() / 1000;
  const sql = includeFuture
    ? "SELECT * FROM mailbox WHERE owner_id=? AND state='pending' ORDER BY id"
    : "SELECT * FROM mailbox WHERE owner_id=? AND state='pending' AND deliver_at<=? ORDER BY id";
  const binds: BindValue[] = [];
  binds.push(owner);
  if (!includeFuture) {
    binds.push(now);
  }
  using _tx = db.transaction();
  const rows = qAll(db, sql, binds) as MailMessage[];
  if (mark && rows.length > 0) {
    using upd = db.prepareRaw("UPDATE mailbox SET state='delivered', delivered_at=? WHERE id=?");
    for (const m of rows) {
      upd.run([now, m.id]);
    }
  }
  return rows;
}

// Dead-letter pending messages whose owner is gone, and GC delivered rows past
// the TTL. Called from the same maintenance cadence as lease reaping.
export function reapMailbox(db: Database): void {
  const owners = qAll(db, "SELECT DISTINCT owner_id AS o FROM mailbox WHERE state='pending'", []) as { o: string }[];
  for (const r of owners) {
    if (!ownerIsAlive(db, r.o)) {
      const cur = qRun(db, "UPDATE mailbox SET state='dead' WHERE owner_id=? AND state='pending'", [r.o]);
      if (cur.changes > 0) {
        emit(db, null, "message_dead", { owner: r.o, count: cur.changes });
      }
    }
  }
  qRun(db, "DELETE FROM mailbox WHERE state='delivered' AND delivered_at<?", [Date.now() / 1000 - MAIL_DELIVERED_TTL_S]);
}

// Persist the ACP session id into the payload (port of queue.py set_session): the next
// attempt after a dispatcher crash resumes the SAME session via session/load.
export function setSession(db: Database, jid: number, owner: string, session: string): void {
  qRun(db, "UPDATE jobs SET payload=json_set(payload,'$.session',?) WHERE id=? AND lease_owner=?", [session, jid, owner]);
}

export function setProc(db: Database, jid: number, owner: string, pgid: number): void {
  qRun(db, "UPDATE jobs SET pgid=? WHERE id=? AND status='running' AND lease_owner=?", [pgid, jid, owner]);
}

export { configPath, dbPath };
