# Timecap: execution-time caps for jobs

Date: 2026-11-23. Branch `feat/job-timecap` in `~/.worktrees/fleet-spikes/timecap`, based on `spike/dbos`. Scope: the SQLite backend (`src/fleet/queue.py`, `src/fleet/daemon.py`, `src/fleet/cli.py`); the dbos backend is untouched. Evidence tags: M = measured by us, C = claimed or specified by the task, R = read in the project's own docs.

## Why

A research session must not be able to run for hours or hang. Every job can carry an execution-time cap, and the agent running the job knows its own identity and deadline so it can query the dispatcher read-only (`fleet status --self`, `fleet stats`) and decide to wrap up before it is killed (C).

## Semantics [C, implemented as specified]

`fleet enqueue ... --max-runtime 15m` accepts a duration with a `s`, `m` or `h` suffix (a plain number is seconds; `0` means unbounded). The value is stored in the jobs row as `max_runtime_s`.

The budget counts running time only. A job that is parked (waiting on an event) or queued does not consume its budget: the elapsed running time is charged to `runtime_used_s` when the job is parked, finished, cancelled or reaped, and `claim_at` is cleared whenever the job stops running. When the job is claimed the daemon writes an absolute `deadline_at` = claim time + remaining budget (cap minus `runtime_used_s`) into SQLite. The deadline is never only in memory, so a `kill -9` of the daemon and a restart still enforce it: the successor reads the same absolute deadline out of the store.

On expiry the daemon sends `session/cancel` for ACP jobs, waits the grace period `FLEET_TIMECAP_GRACE_S` (default 30s), then SIGTERMs the process group and SIGKILLs it 10s later. cmd jobs skip the cancel step and are terminated without the grace wait. The final status is the new terminal status `timed_out`, which is never retried, the slot is freed, and the reason is recorded in the `outcome` column of the row. A job whose lease expired after its deadline goes straight to `timed_out` in the reaper, never back to `queued`.

The `timed_out` status was added to the CHECK constraint of the jobs table. SQLite cannot ALTER a CHECK constraint, so the migration rebuilds the table: the rows are copied into a fresh table with the current schema, the old table is dropped and the new one is renamed (M, `tests/test_timecap.py::test_old_database_is_migrated_and_keeps_rows`). Older stores also gain the new columns (`max_runtime_s`, `runtime_used_s`, `deadline_at`, `claim_at`, `outcome`) through `ALTER TABLE ADD COLUMN`.

A per-machine default lives in `~/.fleet/config.toml` as `[defaults] max_runtime = "2h"`, so no job is unbounded unless the cap is explicitly set to 0. The flag wins over the config default; `--max-runtime 0` disables the default for one job.

## Env contract for agents [C]

At spawn the daemon sets these variables in the child's environment:

| Variable | Meaning |
|---|---|
| `FLEET_JOB_ID` | the job id, so the agent can ask the dispatcher about itself |
| `FLEET_DEADLINE_AT` | the absolute deadline of this attempt as epoch seconds, empty when the job has no cap |
| `FLEET_MACHINE` | the machine name the job runs on |
| `FLEET_DB` | the path of the store the dispatcher uses |

`fleet status --self` reads `FLEET_JOB_ID` and prints that job's row as JSON. `fleet status <id>` prints the same row, including `max_runtime_s`, `runtime_used_s`, `deadline_at`, the derived `runtime_remaining_s` and `deadline_in_s`, and the `outcome` text. `fleet stats` prints the status histogram. All three are read-only: they open the store, read, and change nothing.

## Measured results [M]

`bench/results-timecap-vps.json`, produced by the new `timecap` scenario in `bench/bench.py` on the shared VPS (Linux x86_64, 11 GB RAM, load 1.24 over 1 minute and 0.83 over 5 minutes at the start of the run, 8535 MB memory available, 2026-11-23). The scenario uses the stub ACP agent (`bench/stub_acp_agent.py`) with `STUB_FOREVER=1`, which opens a turn and never answers it, so only the dispatcher can end it. The cap is 3s and the grace period is 2s (the default 30s would dominate the measurement).

| Part | Status | Attempts | Enqueue to `timed_out` | Pids gone after | Slot reused | Orphan pids |
|---|---|---|---|---|---|---|
| ACP agent that never answers | `timed_out` | 1 | 4.21s | 0.13s | yes | none |
| cmd job that sleeps forever | `timed_out` | 1 | 4.17s | 0.11s | yes | none |
| ACP agent, daemon `kill -9` mid-turn | `timed_out` | 1 | 4.29s after the kill | 0.09s | yes | none |

All three ended `timed_out` after one attempt (never retried), the freed slot was taken by a follow-up job that completed normally, and no recorded child or agent pid survived: the process group was gone within about 0.1s of the status change. The ACP parts ended at about 4.2s, that is cap (3s) plus grace (2s) minus about 0.8s, which is the daemon's poll interval; the cmd part ended at the same time because its grace is zero and the daemon loop was already inside its 2s backoff sleep.

In the third part the daemon was SIGKILLed while the agent was mid-turn; the successor daemon found the deadline in SQLite and enforced it 4.29s after the kill, with the job still on attempt 1, so the deadline survived the restart (M).

The pytest suite (`tests/test_timecap.py`, 17 tests) covers the same ground at unit level: a cmd job that sleeps forever is timed out and frees its slot, the parked time is excluded from the budget (about 1.0s of running time charged after 1s of running and 2s of parking), the deadline is identical across a daemon restart, the four env variables reach the child, and an old database is migrated with its rows intact. The full suite is 34 passed and 2 skipped (M, 2026-11-23, on the same host).

## Verdict

The cap works end to end in the SQLite backend: a hung agent or command is terminated within cap plus grace, the terminal status is `timed_out` and never retried, the slot returns to the pool, no orphan process survives, and the guarantee holds across a daemon `kill -9` (M). The identity injection lets an agent read its own deadline and the store path, which is the precondition for an agent to behave well near its deadline (C, not yet implemented).

## Open questions (not implemented)

Should an agent be warned before its deadline? The dispatcher knows the deadline, and the agent can read it, but the agent has to poll for it. Options, none implemented:

1. A prompt at a fraction of the budget (for example 80% of the cap): the dispatcher sends an ACP message with the remaining time. Cheap to add, but it burns a turn and competes for the model; a turn that is already long may not finish the warning before the deadline.
2. An ACP notification that does not consume a turn: a `session/update` with a custom payload carrying the remaining budget. Cheaper for the model, but it depends on the harness surfacing unknown update kinds to the agent.
3. A wall-clock signal (SIGUSR1) to the agent process: the agent decides what to do. No model cost, but it needs cooperation from every harness and is invisible to agents that do not handle it.
4. Nothing, and let the agent poll `fleet status --self`: the contract already supports it, the agent decides its own pace, and the cost is one subprocess call per check.
5. A soft cap at 80% and a hard cap at 100%: the hard cap is the timer we already have, the soft cap is any of options 1 to 3. The open question is which combination of harness support and turn cost is worth it.

Two smaller open questions: whether a `timed_out` job should be retryable on demand (today it is not, and `fleet dead retry` only covers `dead` and `failed`), and whether a job that is cancelled by the operator before its deadline should keep its accumulated runtime, so that a re-enqueue of the same work continues the same budget.

## Caveats

- The stub agent is not a real harness: it opens a turn and never answers, so the measurement covers the dispatcher's kill path, not how Claude Code or Codex react to `session/cancel`.
- The ACP cancel path is best effort. The dispatcher writes a `session/cancel` notification to the ACP command's stdin; whether the agent stops depends on that command forwarding it to the agent. `bench/acp_client.py` was extended to forward it, so the grace path is exercised in the bench, but a real `fleet-acp` must do the same.
- The grace period was 2s in the measurement instead of the 30s default, so the reported times are lower bounds for a production setting.
- The host is shared with three other spike sessions, so the absolute times carry the noise of that load.
