---
title: Machine output schema
---

# Machine output schema

coordinate's machine output is newline-delimited JSON. This page is the published contract for the v1 records. Additive fields are allowed within v1; renames and type changes require a new version number.

## Rules

1. Collection queries (`coordinate jobs`) emit one JSON object per line, so `jq`, `while read` and line-oriented consumers work without a special parser.
2. Single-object queries (`coordinate status ID`) emit one JSON document.
3. Nested JSON is decoded once. A job's `payload` is an object in machine output, never a string containing JSON.
4. stdout in machine mode contains data only. Warnings and progress go to stderr.
5. Timestamps are epoch seconds as numbers. Human renderers derive relative or ISO forms; machine records do not duplicate both.
6. Direct SQLite access is an unsupported escape hatch, not a public API.

## Job record (v1)

`coordinate jobs` emits one record per line with `v: 1`:

| Field | Type | Meaning |
| --- | --- | --- |
| `v` | number | Schema version, `1` |
| `id` | number | Job id |
| `kind` | string | `cmd` or `acp` |
| `status` | string | `queued`, `running`, `waiting`, `done`, `failed`, `dead` or `timed_out` |
| `payload` | object | The decoded job payload (`cmd`, `cwd`, `repo`, `slots`, `session`, plus `agent`, `prompt`, `registry` for ACP jobs). A row whose stored payload is not a JSON object surfaces as `{"_raw": "<text>"}` |
| `priority` | number | Higher claims first |
| `run_at` | number | Earliest start, epoch seconds |
| `lease_owner` | string or null | Daemon lease owner while running |
| `lease_expires_at` | number or null | Lease expiry, epoch seconds |
| `waiting_on` | string or null | Event id a parked job waits for |
| `attempts` | number | Starts so far |
| `max_attempts` | number | Starts allowed |
| `created_at` | number | Enqueue time, epoch seconds |
| `max_runtime_s` | number or null | Runtime budget in seconds |
| `runtime_used_s` | number | Budget already consumed |
| `runtime_remaining_s` | number or null | Derived: remaining budget |
| `deadline_at` | number or null | Current attempt's deadline, epoch seconds |
| `deadline_in_s` | number or null | Derived: seconds until the deadline |
| `claim_at` | number or null | Current attempt's claim time |
| `outcome` | string or null | Terminal outcome note |
| `pgid` | number or null | Process group of the running attempt |
| `pidfile` | string or null | Pidfile of the running attempt |

`coordinate status ID` prints the same fields without `v`, pretty-printed.

## Event record

`coordinate events` emits one record per line. The shape predates the versioning rule and stays as-is for compatibility: `{id, ts, job_id, kind, data}`, where `data` is the decoded kind-specific object (see `skills/coordinate-extensions/SKILL.md` for the per-kind fields).

## Query semantics

`coordinate jobs` accepts:

| Flag | Meaning |
| --- | --- |
| `--status a,b` | Keep only these states |
| `--kind a,b` | Keep only these job kinds |
| `--search TEXT` | Case-insensitive substring over id, kind, status, command, cwd, repo key, waiting_on, outcome, agent and session |
| `--sort id\|created\|priority\|status\|runtime` | Sort key, default `id` |
| `--asc` / `--desc` | Sort direction, default `--desc` |
| `--limit N` | Return at most N records |

`coordinate events` accepts `--job ID`, `--kind a,b`, `--since ID` and `--search TEXT` in addition to `--follow`.

Search is metadata search, not log search. Once per-job logs exist, `rg` over the log files is the right tool for full-text search.
