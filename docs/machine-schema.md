---
title: Machine output schema
---

# Machine output schema

coordinate's machine output is newline-delimited JSON. This page is the published contract for the v1 records. Additive fields are allowed within v1; renames and type changes require a new version number.

The human table printed by `coordinate jobs` without `--json` is presentation only: it is explicitly **not the machine contract**. Its columns, truncation and age formats can change at any time without a version bump. Scripts and agents must read `coordinate jobs --json`. The historical no-id `coordinate status` output remains tab-separated for compatibility and is not the machine contract either.

## Rules

1. Collection queries (`coordinate jobs --json`) emit one JSON object per line, so `jq`, `while read` and line-oriented consumers work without a special parser.
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

`coordinate events` emits one record per line. The shape predates the versioning rule and stays as-is for compatibility: `{id, ts, job_id, kind, data}`, where `data` is the decoded kind-specific object:

| Kind | `data` fields |
| --- | --- |
| `enqueued` | `kind` (the job kind, `cmd` or `acp`) |
| `claimed` | `owner` (the daemon's lease owner string), `attempt` (the attempt number just started, 1-based) |
| `done`, `failed` | `status`; `outcome` when the exit carried one; `exit_code` when the attempt exited with a code; `logs` when the attempt was captured |
| `timed_out` | `outcome` (why the budget or deadline ended the job) |
| `cancelled` | `recorded_as` (always `"failed"`) |
| `dead`, `requeued` | `reason` (e.g. `"lease expired"`, `"dead retry"`), `attempt` when known |
| `parked` | `waiting_on` (the event id the job waits for) |
| `released` | `event` (the released event id) |

Events carry no raw prompts and no raw job output.

## Log record

The daemon captures each cmd attempt's stdout and stderr into files under the coordinate state directory and records the paths in the durable `job_logs` table (`job_id`, `attempt`, `stdout_path`, `stderr_path`, `created_at`). ACP jobs capture stderr only: their stdout carries the protocol stream.

`coordinate logs ID --json` emits one record per attempt:

| Field | Type | Meaning |
| --- | --- | --- |
| `v` | number | Schema version, `1` |
| `job_id` | number | Job id |
| `attempt` | number | Attempt number, 1-based |
| `stdout` | string or null | Path of the captured stdout file |
| `stderr` | string or null | Path of the captured stderr file |
| `stdout_bytes` | number | Size of the stdout file in bytes |
| `stderr_bytes` | number | Size of the stderr file in bytes |
| `created_at` | number | When the attempt started, epoch seconds |

The record carries paths and sizes, never the output itself. A terminal event's `data.logs` points at the same two files.

## Why record

`coordinate why ID --json` emits one object that explains the job from the live rows, not from its history:

| Field | Type | Meaning |
| --- | --- | --- |
| `v` | number | Schema version, `1` |
| `id` | number | Job id |
| `status` | string | The job's current state |
| `attempts`, `max_attempts` | number | Starts so far and starts allowed |
| `state` | string | The readable state (`queued`, `scheduled`, `waiting`, `running`, `failed`, `dead`, `timed_out`, `done`) |
| `detail` | string | One line saying what holds the job |
| `blockers` | object array | `{reason, detail}` per blocker: `waiting_on`, `run_at`, `no_daemon`, `machine_cap`, `repo_cap`, `tool_slot`, `runtime_budget` |
| `next` | string or null | The next step, e.g. the release command |
| `logs` | object array | The captured attempts, in the log record's shape |

## Health record

`coordinate health --json` emits exactly one object with a fixed shape, whatever the queue holds:

| Field | Type | Meaning |
| --- | --- | --- |
| `v` | number | Schema version, `1` |
| `ts` | number | When the summary was taken, epoch seconds |
| `machine` | string | The machine name the daemon recorded |
| `daemon` | object | `{running, pid, heartbeat_age_s}` |
| `machine_cap`, `repo_cap` | number | The effective caps |
| `running`, `queued`, `waiting`, `done`, `failed`, `dead`, `timed_out`, `total` | number | The job counts |
| `oldest_queued_age_s` | number or null | Age of the oldest queued job |
| `slots` | object array | `{key, cost, limit}` per held slot |

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
| `--json` | Emit the v1 NDJSON machine records; the default is the human table |
| `--watch` | Repaint the human table every second with plain ANSI cursor moves; not a scripting surface (combine with `--json` is refused) |

`coordinate events` accepts `--job ID`, `--kind a,b`, `--since ID` and `--search TEXT` in addition to `--follow`.

`coordinate logs` accepts `--attempt N`, `--json` and `--follow`. `coordinate why` accepts `--json`. `coordinate health` accepts `--json`, which is the machine form.

Search is metadata search, not log search. Once per-job logs exist, `rg` over the log files is the right tool for full-text search.
