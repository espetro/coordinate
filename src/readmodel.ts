// Shared read model: one semantic query surface underneath the CLI, future
// human tables and the TUI. Query results are plain records; renderers live
// elsewhere. Machine output rules (NDJSON collections, decoded-once payload,
// epoch-second timestamps) are documented in docs/machine-schema.md.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Database } from "@cutils/sqlite";
import * as q from "./queue.ts";

// Canonical machine record version. Additive fields are allowed within v1;
// renames and type changes require a new version.
export const MACHINE_SCHEMA_VERSION = 1;

export type SortKey = "id" | "created" | "priority" | "status" | "runtime";

export interface JobQuery {
  status?: string[] | null; // job states to include; null/empty = all
  kind?: string[] | null; // job kinds to include; null/empty = all
  search?: string | null; // case-insensitive substring over metadata
  sort?: SortKey; // default "id"
  asc?: boolean; // default false (descending)
  limit?: number | null; // max rows returned
}

export interface EventQuery {
  job?: number | null; // filter by job id
  kind?: string[] | null; // event kinds to include; null/empty = all
  sinceId?: number; // events with id > sinceId (resume cursor)
  search?: string | null; // case-insensitive substring over kind and data
  limit?: number | null;
}

// The v1 machine record for a job. `payload` is decoded once: it is the JSON
// object stored in the jobs row, not a string containing JSON.
export interface JobRecord {
  v: number;
  id: number;
  kind: string;
  status: string;
  payload: Record<string, unknown>;
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
  runtime_remaining_s: number | null;
  deadline_at: number | null;
  deadline_in_s: number | null;
  claim_at: number | null;
  outcome: string | null;
  pgid: number | null;
  pidfile: string | null;
}

export interface EventRecord {
  v: number;
  id: number;
  ts: number;
  job_id: number | null;
  kind: string;
  data: Record<string, unknown>;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

// Decode the stored payload exactly once. A row whose payload is not a JSON
// object surfaces as `{"_raw": <text>}` so a single bad row cannot break a
// collection consumer.
export function decodePayload(payload: string): Record<string, unknown> {
  try {
    const v = JSON.parse(payload) as unknown;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
    return { _raw: payload };
  } catch {
    return { _raw: payload };
  }
}

// The canonical v1 job record: the full row plus the derived timecap fields
// an agent needs (runtime_remaining_s, deadline_in_s). Epoch seconds.
export function jobRecord(job: q.Job): JobRecord {
  const cap = job.max_runtime_s;
  const used = job.runtime_used_s;
  const dl = job.deadline_at;
  return {
    v: MACHINE_SCHEMA_VERSION,
    id: job.id,
    kind: job.kind,
    status: job.status,
    payload: decodePayload(job.payload),
    priority: job.priority,
    run_at: job.run_at,
    lease_owner: job.lease_owner,
    lease_expires_at: job.lease_expires_at,
    waiting_on: job.waiting_on,
    attempts: job.attempts,
    max_attempts: job.max_attempts,
    created_at: job.created_at,
    max_runtime_s: job.max_runtime_s,
    runtime_used_s: job.runtime_used_s,
    runtime_remaining_s: cap === null || cap <= 0 ? null : round3(Math.max(0, cap - used)),
    deadline_at: job.deadline_at,
    deadline_in_s: dl === null || dl <= 0 ? null : round3(dl - Date.now() / 1000),
    claim_at: job.claim_at,
    outcome: job.outcome,
    pgid: job.pgid,
    pidfile: job.pidfile,
  };
}

// Searchable metadata for --search: id, command summary, cwd, repo key,
// waiting_on, outcome and agent name. Case-insensitive substring match.
function jobHaystack(job: q.Job, payload: Record<string, unknown>): string {
  const parts: string[] = [String(job.id), job.kind, job.status];
  const cmd = payload["cmd"];
  if (typeof cmd === "string") {
    parts.push(cmd);
  } else if (Array.isArray(cmd)) {
    for (const c of cmd as string[]) parts.push(String(c));
  }
  for (const k of ["cwd", "repo", "agent", "session"]) {
    const v = payload[k];
    if (typeof v === "string" && v !== "") parts.push(v);
  }
  if (job.waiting_on !== null) parts.push(job.waiting_on);
  if (job.outcome !== null) parts.push(job.outcome);
  return parts.join("\n").toLowerCase();
}

// The sort key each ordering reads from the row.
function sortValue(job: q.Job, key: SortKey): number | string {
  if (key === "id") return job.id;
  if (key === "created") return job.created_at;
  if (key === "priority") return job.priority;
  if (key === "status") return job.status;
  return job.runtime_used_s;
}

// One JobQuery answers `coordinate jobs`, the future table renderer and the
// TUI: all of them must filter, search, sort and limit identically.
export function queryJobs(db: Database, query: JobQuery): JobRecord[] {
  const rows = q.qAll(db, "SELECT * FROM jobs", []) as q.Job[];
  const wantStatus = query.status === null || query.status === undefined ? null : query.status;
  const wantKind = query.kind === null || query.kind === undefined ? null : query.kind;
  const needle = query.search === null || query.search === undefined ? null : query.search.toLowerCase();
  const matched: { job: q.Job; payload: Record<string, unknown> }[] = [];
  for (const job of rows) {
    if (wantStatus !== null && wantStatus.indexOf(job.status) === -1) continue;
    if (wantKind !== null && wantKind.indexOf(job.kind) === -1) continue;
    const payload = decodePayload(job.payload);
    if (needle !== null && jobHaystack(job, payload).indexOf(needle) === -1) continue;
    matched.push({ job, payload });
  }
  const key = query.sort === undefined ? "id" : query.sort;
  const dir = query.asc === true ? 1 : -1;
  matched.sort((a, b) => {
    const av = sortValue(a.job, key);
    const bv = sortValue(b.job, key);
    if (av < bv) return -dir;
    if (av > bv) return dir;
    // Ties break on id in the same direction as the sort, so the ordering is
    // total and stable for equal keys.
    return (a.job.id - b.job.id) * dir;
  });
  let out = matched.map((m) => jobRecord(m.job));
  if (query.limit !== null && query.limit !== undefined && query.limit >= 0) {
    out = out.slice(0, query.limit);
  }
  return out;
}

function eventHaystack(ev: EventRecord): string {
  const parts: string[] = [String(ev.id), ev.kind];
  if (ev.job_id !== null) parts.push(String(ev.job_id));
  parts.push(JSON.stringify(ev.data));
  return parts.join("\n").toLowerCase();
}

// One EventQuery answers `coordinate events` and any event consumer that
// wants server-side filtering instead of post-processing with jq.
export function queryEvents(db: Database, query: EventQuery): EventRecord[] {
  const rows = q.qAll(db, "SELECT id,ts,job_id,kind,data FROM events WHERE id>? ORDER BY id", [
    query.sinceId || 0,
  ]) as { id: number; ts: number; job_id: number | null; kind: string; data: string }[];
  const wantKind = query.kind === null || query.kind === undefined ? null : query.kind;
  const needle = query.search === null || query.search === undefined ? null : query.search.toLowerCase();
  const out: EventRecord[] = [];
  for (const r of rows) {
    if (query.job !== null && query.job !== undefined && r.job_id !== query.job) continue;
    if (wantKind !== null && wantKind.indexOf(r.kind) === -1) continue;
    const rec: EventRecord = {
      v: MACHINE_SCHEMA_VERSION,
      id: r.id,
      ts: r.ts,
      job_id: r.job_id,
      kind: r.kind,
      data: r.data ? (JSON.parse(r.data) as Record<string, unknown>) : {},
    };
    if (needle !== null && eventHaystack(rec).indexOf(needle) === -1) continue;
    out.push(rec);
    if (query.limit !== null && query.limit !== undefined && query.limit >= 0 && out.length >= query.limit) {
      break;
    }
  }
  return out;
}

// --- log surface ---

// One captured attempt: the log files and their sizes. The paths point into
// the coordinate state directory; the sizes are read from disk on demand.
export interface AttemptLogs {
  attempt: number;
  stdout: string | null;
  stderr: string | null;
  stdout_bytes: number;
  stderr_bytes: number;
  created_at: number;
}

function fileSize(p: string | null): number {
  if (p === null) {
    return 0;
  }
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

// The captured attempts of one job, newest last. The rows come from the
// durable job_logs metadata; the sizes come from the files themselves.
export function jobLogs(db: Database, jid: number): AttemptLogs[] {
  const rows = q.logRows(db, jid);
  const out: AttemptLogs[] = [];
  for (const r of rows) {
    out.push({
      attempt: r.attempt,
      stdout: r.stdout_path,
      stderr: r.stderr_path,
      stdout_bytes: fileSize(r.stdout_path),
      stderr_bytes: fileSize(r.stderr_path),
      created_at: r.created_at,
    });
  }
  return out;
}

// --- why: explain a job's live state from the current rows ---

export interface WhyBlocker {
  reason: string;
  detail: string;
}

export interface WhyRecord {
  v: number;
  id: number;
  status: string;
  attempts: number;
  max_attempts: number;
  blockers: WhyBlocker[];
  state: string;
  detail: string;
  next: string | null;
  logs: AttemptLogs[];
}

// The blockers a job is held by, computed from the live rows: the slot it
// waits on, the caps that are saturated, its own schedule and its budget.
// Nothing is inferred from history: a requeued job reads as "queued" again.
export function whyJob(db: Database, jid: number): WhyRecord | null {
  const job = q.getJob(db, jid);
  if (job === null) {
    return null;
  }
  const payload = decodePayload(job.payload);
  const now = Date.now() / 1000;
  const blockers: WhyBlocker[] = [];
  let state = job.status;
  let detail = "";
  let next: string | null = null;

  if (job.status === "waiting") {
    const key = job.waiting_on === null ? "" : job.waiting_on;
    blockers.push({ reason: "waiting_on", detail: key });
    state = "waiting";
    detail = "parked until the event " + key + " is released";
    next = "coordinate release " + key;
  } else if (job.status === "queued") {
    if (job.run_at > now) {
      blockers.push({ reason: "run_at", detail: String(job.run_at) });
      state = "scheduled";
      detail = "held back until its run_at time";
      next = null;
    } else if (q.liveDaemonPid(db) === null) {
      // No dispatcher is claiming: the job is not queued behind a cap, it is
      // queued because nothing is running the queue.
      blockers.push({ reason: "no_daemon", detail: "no daemon heartbeat in the queue DB" });
      state = "queued";
      detail = "no daemon is running on this queue, so nothing will claim it";
      next = "coordinate daemon";
    } else {
      const capReason = capBlocker(db, job, payload);
      if (capReason !== null) {
        blockers.push(capReason);
        state = "queued";
        detail = capReason.detail;
        next = null;
      } else {
        state = "queued";
        detail = "waiting for a free slot on the machine";
        next = null;
      }
    }
  } else if (job.status === "running") {
    const remaining = job.max_runtime_s === null ? null : job.max_runtime_s - job.runtime_used_s;
    if (remaining !== null && remaining <= 0) {
      blockers.push({ reason: "runtime_budget", detail: "budget exhausted" });
      state = "running";
      detail = "the runtime budget is spent; the daemon will time it out";
    } else {
      state = "running";
      detail = "running on " + (job.lease_owner === null ? "the daemon" : job.lease_owner);
    }
  } else if (job.status === "failed") {
    state = "failed";
    detail = job.outcome === null ? "the attempt exited non-zero" : job.outcome;
    next = "coordinate dead retry " + String(job.id);
  } else if (job.status === "dead") {
    state = "dead";
    detail = job.outcome === null ? "the attempts are exhausted" : job.outcome;
    next = "coordinate dead retry " + String(job.id);
  } else if (job.status === "timed_out") {
    state = "timed_out";
    detail = job.outcome === null ? "the runtime budget was spent" : job.outcome;
    next = "coordinate dead retry " + String(job.id);
  } else if (job.status === "done") {
    state = "done";
    detail = job.outcome === null ? "the attempt exited zero" : job.outcome;
  }

  return {
    v: MACHINE_SCHEMA_VERSION,
    id: job.id,
    status: job.status,
    attempts: job.attempts,
    max_attempts: job.max_attempts,
    blockers,
    state,
    detail,
    next,
    logs: jobLogs(db, jid),
  };
}

// The saturated cap that keeps a queued job from being claimed, or null when
// a slot is free. The machine cap counts the running jobs, the repo cap the
// running jobs of the same repo key, the static tool slots their leases.
function capBlocker(db: Database, job: q.Job, payload: Record<string, unknown>): WhyBlocker | null {
  const running = q.qAll(db, "SELECT COUNT(*) AS c FROM jobs WHERE status='running'", []) as { c: number }[];
  const runningCount = running.length === 0 ? 0 : running[0].c;
  if (runningCount >= q.machineCap(db)) {
    return {
      reason: "machine_cap",
      detail: runningCount + " job(s) running, the machine cap is " + String(q.machineCap(db)),
    };
  }
  const repo = typeof payload["repo"] === "string" ? (payload["repo"] as string) : null;
  const cwd = typeof payload["cwd"] === "string" ? (payload["cwd"] as string) : null;
  const repoValue = repo !== null && repo !== "" ? repo : cwd;
  const repoKey = repoValue === null || repoValue === "" ? null : "repo:" + path.resolve(repoValue);
  if (repoKey !== null) {
    const used = q.qAll(db, "SELECT COUNT(*) AS c FROM concurrency_slots WHERE key=?", [repoKey]) as { c: number }[];
    const usedCount = used.length === 0 ? 0 : used[0].c;
    if (usedCount >= q.repoCap(db)) {
      return {
        reason: "repo_cap",
        detail: "the repo slot " + repoKey + " is full (" + String(q.repoCap(db)) + " allowed)",
      };
    }
  }
  for (const key of q.slotKeys(payload as unknown as q.Payload)) {
    if (key.startsWith("machine:") || key.startsWith("repo:")) {
      continue;
    }
    const used = q.qAll(db, "SELECT COALESCE(SUM(cost),0) AS c FROM concurrency_slots WHERE key=?", [key]) as { c: number }[];
    const usedCost = used.length === 0 ? 0 : used[0].c;
    const limit = q.slotCapacity(key);
    if (usedCost + 1 > limit) {
      return { reason: "tool_slot", detail: "the slot " + key + " is full (" + String(usedCost) + "/" + String(limit) + ")" };
    }
  }
  return null;
}

// --- health: one fixed summary object ---

export interface HealthRecord {
  v: number;
  ts: number;
  machine: string;
  daemon: { running: boolean; pid: number | null; heartbeat_age_s: number | null };
  machine_cap: number;
  repo_cap: number;
  running: number;
  queued: number;
  waiting: number;
  failed: number;
  dead: number;
  done: number;
  timed_out: number;
  total: number;
  oldest_queued_age_s: number | null;
  slots: { key: string; cost: number; limit: number }[];
}

// The fixed health summary. One object, always the same keys, so a panel or
// a script can read it without guessing which fields exist.
export function health(db: Database): HealthRecord {
  const counts: Record<string, number> = {
    queued: 0,
    running: 0,
    waiting: 0,
    done: 0,
    failed: 0,
    dead: 0,
    timed_out: 0,
  };
  const rows = q.qAll(db, "SELECT status, COUNT(*) AS c FROM jobs GROUP BY status", []) as { status: string; c: number }[];
  let total = 0;
  for (const r of rows) {
    counts[r.status] = r.c;
    total += r.c;
  }
  const oldest = q.qOne(db, "SELECT MIN(created_at) AS a FROM jobs WHERE status='queued'", []) as { a: number | null } | null;
  const oldestAge = oldest === null || oldest.a === null ? null : round3(Date.now() / 1000 - oldest.a);
  const pid = q.liveDaemonPid(db);
  const hb = q.daemonHeartbeatTs(db);
  const hbAge = hb === null ? null : round3(Date.now() / 1000 - hb);
  const slotRows = q.qAll(db, "SELECT key, COALESCE(SUM(cost),0) AS c FROM concurrency_slots GROUP BY key ORDER BY key", []) as {
    key: string;
    c: number;
  }[];
  const slots: { key: string; cost: number; limit: number }[] = [];
  const mCap = q.machineCap(db);
  const rCap = q.repoCap(db);
  for (const r of slotRows) {
    slots.push({ key: r.key, cost: r.c, limit: slotLimitFor(r.key, mCap, rCap) });
  }
  return {
    v: MACHINE_SCHEMA_VERSION,
    ts: Date.now() / 1000,
    machine: q.recordedMachine(db) ?? q.MACHINE,
    daemon: { running: pid !== null, pid: pid, heartbeat_age_s: hbAge },
    machine_cap: q.machineCap(db),
    repo_cap: q.repoCap(db),
    running: counts["running"],
    queued: counts["queued"],
    waiting: counts["waiting"],
    failed: counts["failed"],
    dead: counts["dead"],
    done: counts["done"],
    timed_out: counts["timed_out"],
    total,
    oldest_queued_age_s: oldestAge,
    slots,
  };
}

// The capacity of a slot key: the machine cap for the machine key, the repo
// cap for a repo key, the configured limit for the static tool slots.
function slotLimitFor(key: string, machineCap: number, repoCap: number): number {
  if (key.startsWith("machine:")) {
    return machineCap;
  }
  if (key.startsWith("repo:")) {
    return repoCap;
  }
  return q.slotCapacity(key);
}
