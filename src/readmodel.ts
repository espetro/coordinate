// Shared read model: one semantic query surface underneath the CLI, future
// human tables and the TUI. Query results are plain records; renderers live
// elsewhere. Machine output rules (NDJSON collections, decoded-once payload,
// epoch-second timestamps) are documented in docs/machine-schema.md.

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
    for (const c of cmd) parts.push(String(c));
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
