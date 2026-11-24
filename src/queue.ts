// SQLite durable queue: schema, claim protocol, leases, reaper, waiting jobs.
// Port of src/coordinate/queue.py (subset kept: no tool-class matching, no config slots).

import * as fs from "node:fs";
import * as path from "node:path";
import { Database } from "@cutils/sqlite";
import type { BindValue } from "@cutils/sqlite";
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
  const row = db.prepareRaw("SELECT value FROM settings WHERE key=?").getOrNull([key]) as { value: string } | null;
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
    db.prepareRaw("DELETE FROM settings WHERE key=?").run([key]);
    return;
  }
  db.prepareRaw("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run([
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
];

export function emit(db: Database, jid: number | null, kind: string, data: Record<string, unknown> = {}): void {
  db.prepareRaw("INSERT INTO events(ts,job_id,kind,data) VALUES(?,?,?,?)").run([
    Date.now() / 1000,
    jid,
    kind,
    JSON.stringify(data),
  ]);
};

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

function migrateJobs(db: Database): void {
  const row = db.prepareRaw("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'").get([]) as
    | { sql: string }
    | undefined;
  if (row === undefined || row.sql.indexOf("timed_out") !== -1) {
    return;
  }
  const oldCols: string[] = [];
  const tiOld = db.prepareRaw("PRAGMA table_info(jobs)").all([]);
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
    const tiNew = db.prepareRaw("PRAGMA table_info(jobs_new)").all([]);
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
    const row = db0
      .prepareRaw("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'")
      .get([]) as { sql: string } | undefined;
    db0.close();
    if (row !== undefined && row.sql.indexOf("timed_out") === -1) {
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
  const tiJobs = db.prepareRaw("PRAGMA table_info(jobs)").all([]);
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
  const row = db.prepareRaw("SELECT heartbeat_ts FROM daemon WHERE id=1").getOrNull([]) as { heartbeat_ts: number } | null;
  return row === null ? null : row.heartbeat_ts;
}

export function daemonHeartbeat(db: Database, pid: number): void {
  const now = Date.now() / 1000;
  db.prepareRaw(
    "INSERT INTO daemon(id,pid,heartbeat_ts) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid, heartbeat_ts=excluded.heartbeat_ts",
  ).run([pid, now]);
}

// claimable: any heartbeat older than LEASE_S is from a daemon whose job
// leases have already expired, so it cannot be making progress. Returns the
// pid of the running daemon when a fresh-enough heartbeat exists, else null.
export function liveDaemonPid(db: Database): number | null {
  const row = db.prepareRaw("SELECT pid, heartbeat_ts FROM daemon WHERE id=1").getOrNull([]) as DaemonRow | null;
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
  using _tx = db.transaction();
  const other = liveDaemonPid(db);
  if (other !== null) {
    conflictPid.v = other;
    return false;
  }
  daemonHeartbeat(db, pid);
  return true;
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
  const ins = db.prepareRaw(
    "INSERT INTO jobs(kind,payload,priority,run_at,attempts,max_attempts,created_at,max_runtime_s) VALUES(?,?,?,?,?,?,?,?)",
  );
  const r = ins.run([kind, JSON.stringify(payload), priority, runAt === null ? now : runAt, 0, maxAttempts, now, maxRuntimeS === null ? null : maxRuntimeS]);
  ins.finalize();
  const jid = r.lastInsertRowid;
  emit(db, jid, "enqueued", { kind: kind });
  return jid;
}

function usedByKey(db: Database): Record<string, number> {
  const out: Record<string, number> = {};
  const sel = db.prepareRaw("SELECT key, COUNT(*) AS c FROM concurrency_slots GROUP BY key");
  for (const row of sel.all([]) as KeyCostRow[]) {
    out[row.key] = row.c;
  }
  sel.finalize();
  return out;
}

function qUsedCost(db: Database, key: string): number {
  const sel = db.prepareRaw("SELECT COALESCE(SUM(cost),0) AS c FROM concurrency_slots WHERE key=?");
  const row = sel.getOrNull([key]) as { c: number } | null;
  sel.finalize();
  return row === null ? 0 : row.c;
}

export function claim(db: Database, owner: string): Parsed | null {
  const now = Date.now() / 1000;
  using _tx = db.transaction();
  db.exec("DELETE FROM concurrency_slots WHERE lease_expires_at < " + now);
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
  const rows = db.prepareRaw(sql).all(binds) as { id: number; payload: string; kind: string }[];
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
    const budget = db.prepareRaw("SELECT max_runtime_s, runtime_used_s FROM jobs WHERE id=?").getOrNull([jid]) as
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
    db.prepareRaw("UPDATE jobs SET status='running', attempts=attempts+1, lease_owner=?, lease_expires_at=?, claim_at=?, deadline_at=? WHERE id=?").run([
      owner,
      exp,
      now,
      deadlineAt,
      jid,
    ]);
    const insSlot = db.prepareRaw("INSERT INTO concurrency_slots(key,lease_expires_at,job_id) VALUES(?,?,?)");
    for (const k of keys) {
      insSlot.run([k, exp, jid]);
    }
    insSlot.finalize();
    emit(db, jid, "claimed", { owner });
    return { jid, kind: row.kind, payload };
  }
  return null;
}

export function chargeRuntime(db: Database, jid: number): void {
  const now = Date.now() / 1000;
  db.prepareRaw("UPDATE jobs SET runtime_used_s=runtime_used_s+? - COALESCE(claim_at, ?) WHERE id=? AND status='running' AND claim_at IS NOT NULL").run([now, now, jid]);
}

export function heartbeat(db: Database, jid: number, owner: string): boolean {
  const exp = Date.now() / 1000 + LEASE_S;
  using _tx = db.transaction();
  const cur = db.prepareRaw("UPDATE jobs SET lease_expires_at=? WHERE id=? AND status='running' AND lease_owner=?").run([exp, jid, owner]);
  if (cur.changes > 0) {
    db.prepareRaw("UPDATE concurrency_slots SET lease_expires_at=? WHERE job_id=?").run([exp, jid]);
  }
  return cur.changes > 0;
}

export function finish(db: Database, jid: number, owner: string, status: string, outcome: string | null = null): string | null {
  using _tx = db.transaction();
  chargeRuntime(db, jid);
  db.prepareRaw("UPDATE jobs SET status=?, outcome=COALESCE(?, outcome), lease_owner=NULL, lease_expires_at=NULL, pgid=NULL, pidfile=NULL, claim_at=NULL WHERE id=? AND status='running' AND lease_owner=?").run([
    status,
    outcome,
    jid,
    owner,
  ]);
  let event: string | null = null;
  const slots = db.prepareRaw("SELECT key FROM concurrency_slots WHERE job_id=? AND key LIKE 'tool:%'").all([jid]) as KeyRow[];
  for (const s of slots) {
    if (event === null) {
      event = s.key;
    }
  }
  db.prepareRaw("DELETE FROM concurrency_slots WHERE job_id=? AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND status<>'running')").run([jid, jid]);
  emit(db, jid, status === "done" ? "done" : status, { status });
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
  using _tx = db.transaction();
  const expired = db.prepareRaw("SELECT id FROM jobs WHERE status='running' AND lease_expires_at<?").all([now]) as IdRow[];
  for (const row of expired) {
    chargeRuntime(db, row.id);
  }
  // Kill survivors before the requeue commits, so a retry never runs beside the old attempt.
  for (const row of db.prepareRaw("SELECT id, pgid, pidfile FROM jobs WHERE status='running' AND lease_expires_at<?").all([now]) as { id: number; pgid: number | null; pidfile: string | null }[]) {
    killOrphans(db, row.pgid, row.pidfile);
  }
  for (const row of db
    .prepareRaw(
      "UPDATE jobs SET status='timed_out', outcome='lease expired after deadline', lease_owner=NULL, lease_expires_at=NULL, pgid=NULL, pidfile=NULL, claim_at=NULL WHERE status='running' AND lease_expires_at<? AND deadline_at IS NOT NULL AND deadline_at<=? RETURNING id",
    )
    .all([now, now]) as IdRow[]) {
    emit(db, row.id, "timed_out", { outcome: "lease expired after deadline" });
  }
  const rows = db
    .prepareRaw(
      "UPDATE jobs SET status=CASE WHEN attempts<max_attempts THEN 'queued' ELSE 'dead' END, lease_owner=NULL, lease_expires_at=NULL, pgid=NULL, pidfile=NULL, claim_at=NULL, deadline_at=NULL WHERE status='running' AND lease_expires_at<? RETURNING id",
    )
    .all([now]) as IdRow[];
  for (const r of rows) {
    const st = (db.prepareRaw("SELECT status FROM jobs WHERE id=?").getOrNull([r.id]) as { status: string } | null)?.status;
    emit(db, r.id, st === "queued" ? "requeued" : "dead", { reason: "lease expired" });
  }
  db.exec("DELETE FROM concurrency_slots WHERE job_id IN (SELECT id FROM jobs WHERE status<>'running')");
  const out: number[] = [];
  for (const r of rows) {
    out.push(r.id);
  }
  return out;
}

export function waitOn(db: Database, jid: number, event: string): boolean {
  using _tx = db.transaction();
  chargeRuntime(db, jid);
  const cur = db
    .prepareRaw("UPDATE jobs SET status='waiting', waiting_on=?, lease_owner=NULL, lease_expires_at=NULL, claim_at=NULL, deadline_at=NULL WHERE id=? AND status IN ('queued','running')")
    .run([event, jid]);
  db.prepareRaw("DELETE FROM concurrency_slots WHERE job_id=?").run([jid]);
  if (cur.changes > 0) {
    emit(db, jid, "parked", { waiting_on: event });
  }
  return cur.changes > 0;
}

export function release(db: Database, event: string): number[] {
  const rows = db
    .prepareRaw("UPDATE jobs SET status='queued', waiting_on=NULL WHERE status='waiting' AND waiting_on=? RETURNING id")
    .all([event]) as IdRow[];
  const out: number[] = [];
  for (const r of rows) {
    out.push(r.id);
    emit(db, r.id, "released", { event });
  }
  return out;
}

export function cancel(db: Database, jid: number): boolean {
  using _tx = db.transaction();
  chargeRuntime(db, jid);
  const cur = db
    .prepareRaw("UPDATE jobs SET status='failed', lease_owner=NULL, lease_expires_at=NULL, waiting_on=NULL, claim_at=NULL WHERE id=? AND status IN ('queued','running','waiting')")
    .run([jid]);
  db.prepareRaw("DELETE FROM concurrency_slots WHERE job_id=? AND cost>0").run([jid]);
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
  const rows = db.prepareRaw(sql).all([]) as IdRow[];
  const out: number[] = [];
  for (const r of rows) {
    out.push(r.id);
    emit(db, r.id, "requeued", { reason: "dead retry" });
  }
  return out;
}

export function stats(db: Database): Record<string, number> {
  const out: Record<string, number> = {};
  const rows = db.prepareRaw("SELECT status, COUNT(*) AS c FROM jobs GROUP BY status").all([]) as { status: string; c: number }[];
  for (const r of rows) {
    out[r.status] = r.c;
  }
  return out;
}

export function getJob(db: Database, jid: number): Job | null {
  const row = db.prepareRaw("SELECT * FROM jobs WHERE id=?").getOrNull([jid]) as Job | null;
  return row;
}

export function statusSelf(db: Database, jidText: string): Job | null {
  return getJob(db, Number(jidText));
}

export function expiredRunning(db: Database): { id: number; kind: string; payload: string; pgid: number | null; pidfile: string | null }[] {
  const now = Date.now() / 1000;
  return db
    .prepareRaw("SELECT id, kind, payload, pgid, pidfile FROM jobs WHERE status='running' AND deadline_at IS NOT NULL AND deadline_at<=?")
    .all([now]) as { id: number; kind: string; payload: string; pgid: number | null; pidfile: string | null }[];
}

export function finalizeTimedOut(db: Database, jid: number, outcome: string): boolean {
  using _tx = db.transaction();
  chargeRuntime(db, jid);
  const cur = db
    .prepareRaw("UPDATE jobs SET status='timed_out', outcome=?, claim_at=NULL, lease_owner=NULL, lease_expires_at=NULL, pgid=NULL, pidfile=NULL, waiting_on=NULL WHERE id=? AND status='running'")
    .run([outcome, jid]);
  db.prepareRaw("DELETE FROM concurrency_slots WHERE job_id=? AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND status<>'running')").run([jid, jid]);
  if (cur.changes > 0) {
    emit(db, jid, "timed_out", { outcome });
  }
  return cur.changes > 0;
}

// Persist the ACP session id into the payload (port of queue.py set_session): the next
// attempt after a dispatcher crash resumes the SAME session via session/load.
export function setSession(db: Database, jid: number, owner: string, session: string): void {
  db.prepareRaw("UPDATE jobs SET payload=json_set(payload,'$.session',?) WHERE id=? AND lease_owner=?").run([session, jid, owner]);
}

export function setProc(db: Database, jid: number, owner: string, pgid: number): void {
  db.prepareRaw("UPDATE jobs SET pgid=? WHERE id=? AND status='running' AND lease_owner=?").run([pgid, jid, owner]);
}

export { configPath, dbPath };
