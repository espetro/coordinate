// SQLite durable queue: schema, claim protocol, leases, reaper, waiting jobs.
// Port of src/coordinate/queue.py (subset kept: no tool-class matching, no config slots).

import * as path from "node:path";
import { Database } from "@cutils/sqlite";
import { configPath, dbPath, ensureParentDir, env } from "./env.ts";

export const LEASE_S = Number(env("LEASE_S", "30"));
export const MACHINE = env("MACHINE", "laptop") as string;
const MACHINE_CAPS: Record<string, number> = { laptop: 3, vps: 6 };

export function machineCap(): number {
  const raw = env("CAP");
  if (raw !== null) {
    return Number(raw);
  }
  const known = MACHINE_CAPS[MACHINE];
  return known === undefined ? 3 : known;
}

export function repoCap(): number {
  const raw = env("REPO_CAP");
  return raw === null ? 1 : Number(raw);
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
  attempts INTEGER NOT NULL DEFAULT 3,
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
  `CREATE TABLE IF NOT EXISTS spawn_audit(
  ts REAL NOT NULL,
  job_id INTEGER,
  argv0 TEXT NOT NULL,
  tool_class TEXT NOT NULL,
  project TEXT NOT NULL
)`,
];

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

export function connect(): Database {
  const p = dbPath();
  ensureParentDir(p);
  const db = Database.open(p);
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  for (const ddl of SCHEMA) {
    db.exec(ddl);
  }
  return db;
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

export function enqueue(db: Database, payload: Payload, priority = 0, maxAttempts = 3, runAt: number | null = null, maxRuntimeS: number | null = null): number {
  const now = Date.now() / 1000;
  const ins = db.prepareRaw(
    "INSERT INTO jobs(kind,payload,priority,run_at,attempts,max_attempts,created_at,max_runtime_s) VALUES(?,?,?,?,?,?,?,?)",
  );
  const r = ins.run(["cmd", JSON.stringify(payload), priority, runAt === null ? now : runAt, 0, maxAttempts, now, maxRuntimeS === null ? null : maxRuntimeS]);
  ins.finalize();
  return r.lastInsertRowid;
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
  if ((used[machineKey] === undefined ? 0 : used[machineKey]) >= machineCap()) {
    return null;
  }
  const rows = db
    .prepareRaw("SELECT id, payload, kind FROM jobs WHERE status='queued' AND run_at<=? ORDER BY priority DESC, run_at, id LIMIT 100")
    .all([now]) as { id: number; payload: string; kind: string }[];
  for (const row of rows) {
    const jid = row.id;
    const payload = JSON.parse(row.payload) as Payload;
    const keys = slotKeys(payload);
    let blocked = false;
    for (const k of keys) {
      if (k.startsWith("repo:") && (used[k] === undefined ? 0 : used[k]) >= repoCap()) {
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

export function finish(db: Database, jid: number, owner: string, status: string): string | null {
  using _tx = db.transaction();
  chargeRuntime(db, jid);
  db.prepareRaw("UPDATE jobs SET status=?, lease_owner=NULL, lease_expires_at=NULL, pgid=NULL, pidfile=NULL, claim_at=NULL WHERE id=? AND status='running' AND lease_owner=?").run([
    status,
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
  return event;
}

export function reap(db: Database): number[] {
  const now = Date.now() / 1000;
  using _tx = db.transaction();
  const expired = db.prepareRaw("SELECT id FROM jobs WHERE status='running' AND lease_expires_at<?").all([now]) as IdRow[];
  for (const row of expired) {
    chargeRuntime(db, row.id);
  }
  db.prepareRaw(
    "UPDATE jobs SET status='timed_out', outcome='lease expired after deadline', lease_owner=NULL, lease_expires_at=NULL, pgid=NULL, pidfile=NULL, claim_at=NULL WHERE status='running' AND lease_expires_at<? AND deadline_at IS NOT NULL AND deadline_at<=?",
  ).run([now, now]);
  const rows = db
    .prepareRaw(
      "UPDATE jobs SET status=CASE WHEN attempts<max_attempts THEN 'queued' ELSE 'dead' END, lease_owner=NULL, lease_expires_at=NULL, pgid=NULL, pidfile=NULL, claim_at=NULL, deadline_at=NULL WHERE status='running' AND lease_expires_at<? RETURNING id",
    )
    .all([now]) as IdRow[];
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
  return cur.changes > 0;
}

export function release(db: Database, event: string): number[] {
  const rows = db
    .prepareRaw("UPDATE jobs SET status='queued', waiting_on=NULL WHERE status='waiting' AND waiting_on=? RETURNING id")
    .all([event]) as IdRow[];
  const out: number[] = [];
  for (const r of rows) {
    out.push(r.id);
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
  return cur.changes > 0;
}

export function setProc(db: Database, jid: number, owner: string, pgid: number): void {
  db.prepareRaw("UPDATE jobs SET pgid=? WHERE id=? AND status='running' AND lease_owner=?").run([pgid, jid, owner]);
}

export { configPath, dbPath };
