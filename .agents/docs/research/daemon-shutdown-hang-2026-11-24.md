# Daemon shutdown hang and the statement-tracking leak

Research date: 2026-11-24. Host: Apple M4, 10 cores, 24 GB, macOS (Darwin 27.2.0). All numbers marked (M) were measured on this host; (C) marks a claim. The measured daemon binary is the v0.1.3 release binary at `~/.local/bin/coordinate` (15.9 MB, Effect v4 build).

## Summary

The v0.1.3 daemon ignores SIGTERM and SIGINT for as long as the shutdown takes, and the shutdown itself is quadratic in the number of prepared statements the daemon has accumulated since it started. After heavy job churn the shutdown took 29 s at ~100 % CPU (M). The same quadratic applies to any long-lived process that opens the queue DB and never finalizes its statements, and it is the mechanism behind the "db.close() hangs on a large WAL" hypothesis recorded earlier for v0.1.4 (M: the WAL size is irrelevant; the statement count is what matters).

Two separate defects fall out of this:

1. The shutdown path is O(n²) in tracked statements, so `coordinate daemon` takes minutes to stop on a busy queue (M).
2. The daemon leaks prepared statements continuously, so the tracked list grows without bound for the lifetime of the process (M). This is a memory leak and it makes defect 1 worse over time.

A secondary finding: the six stray `coordinate daemon` processes observed on 2026-11-24 (about 360 MB RSS at 37 to 58 % CPU each) were running a build from before the idle-spin fix (5ebd66c). Their 6 to 8 MB RSS matches the pre-Effect binary, and their start time (2026-11-24 01:42 to 01:43 UTC) precedes the cap-aware binary (2026-11-24 12:27). They were not the production daemon and not a v0.1.3 regression.

## Root cause

`@cutils/sqlite` keeps a module-level registry of live statements per `Database` (`DB_TRACK` in `node_modules/@cutils/sqlite/dist/esm/index.js`, backed by `trackOf`/`dropTrack`). Two properties combine into the quadratic:

`Database.close()` walks the tracked list backwards and calls `finalize()` on each statement (`node_modules/@cutils/sqlite/dist/esm/index.js`, `close()`). Each `finalize()` then calls `this._db._untrack(this)`, and `_untrack` is a linear scan of the same array (`node_modules/@cutils/sqlite/src/index.ts:780`). Finalizing N statements therefore costs N² comparisons.

The daemon's hot path prepares a statement for nearly every query and never finalizes it. In `src/queue.ts` the pattern is `db.prepareRaw(sql).all(binds)` or `.getOrNull([...])` or `.run([...])` with no `finalize()` call, for example the claim query at `src/queue.ts:433`, the budget query at `src/queue.ts:459`, the claim update at `src/queue.ts:475`, the runtime charge at `src/queue.ts:495` and the heartbeat at `src/queue.ts:501`. Only a few statements are finalized explicitly (`src/queue.ts:387`, `src/queue.ts:399`, `src/queue.ts:486`). Since `prepareRaw` pushes onto the tracked array and nothing removes it, the array grows by roughly 30 statements per claim-loop turn for the lifetime of the process.

## Measurements

All (M), on this host, with the v0.1.3 release binary unless stated.

Close cost against tracked statement count, measured through the `@cutils/sqlite` node binding with one unfinalized `prepareRaw` per iteration:

| Tracked statements | `db.close()` |
|---|---|
| 5 000 | 34 ms |
| 10 000 | 120 ms |
| 20 000 | 449 ms |
| 40 000 | 1 928 ms |
| 80 000 | 7 795 ms |
| 160 000 | 36 880 ms |

The doubling from 10 000 to 20 000 costs 3.7x, and from 80 000 to 160 000 costs 4.7x, which is the expected quadratic shape (C).

A daemon-shaped workload (50 000 turns of three prepares each, 150 000 tracked statements) closed in 29 225 ms.

End to end on the real daemon, in an isolated state directory with `COORDINATE_DB` pointed at a scratch DB:

| Scenario | Result |
|---|---|
| Idle daemon, 120 jobs enqueued, then 180 s idle | RSS grew 30 592 KB to 32 736 KB, about 14 KB per 30 s, CPU 0 % (M) |
| Churn: 1 800 jobs enqueued over 30 s, then SIGTERM | RSS 114 000 KB, shutdown took 29 s at ~100 % CPU (M) |
| Churn: 800 jobs, then SIGTERM | RSS 108 928 KB, shutdown took 8 s at ~100 % CPU (M) |
| Same DB, WAL grown to 4.1 MB, no churn, SIGTERM | exited in about 2 s (M) |

The last row is the control that rules out the WAL hypothesis: a large WAL alone does not hang the shutdown. The statement count is the variable that matters.

Two more controls, on a build of the pre-idle-fix commit 0eefc43 rebuilt for this test: SIGTERM and SIGINT both exited in 2 to 3 s when idle, so the pre-fix idle spin was not itself the cause of the observed shutdown latency.

## Why the signals appeared to be ignored

Node delivers JS `process.on("SIGTERM")` handlers between macrotasks. While `close()` is running its quadratic finalize loop, the process is inside one synchronous call, so the handler has not run yet. The observed behavior was that the daemon kept running and burning CPU on SIGTERM and SIGINT, and exited promptly on SIGQUIT, which has no JS handler and therefore takes the OS default path.

A control binary that spins the event loop with `setImmediate` still delivered SIGTERM and SIGINT promptly, so scriptc's event loop does not starve signal handlers on its own (M). The starvation comes from the long synchronous `close()` call.

## The `using` question

TypeScript's `using` declarations call `Symbol.dispose` at scope exit, and `@cutils/sqlite` implements `Symbol.dispose` on both `Database` (which closes) and `Statement` (which finalizes). scriptc 0.4.16 compiles `using` correctly: a test program with `using r = new Res("a")` and a `[Symbol.dispose]()` method built and ran, printing the dispose call (M).

So the mechanism exists, but `using` alone does not fix the quadratic. It fixes the leak only if every prepared statement is held in a `using` binding, and the daemon's hot path prepares statements in expressions where a `using` binding cannot reach them, for example `db.prepareRaw(sql).all(binds)`. A `using` binding on the `Database` also does not help by itself, because `close()` is precisely the quadratic operation. The fix has to change how statements are tracked, not just who calls `close()`.

## Fix plan

Two changes, in this order, both in `src/queue.ts` plus one in the dependency.

### 1. Make the tracked-statement removal O(1)

`@cutils/sqlite` is a dependency at version 0.8.0 and the fix belongs upstream. `_untrack` does a linear scan of `trackOf(this).stmts` to find the statement to splice out. Replacing that with a swap-and-pop, and having `close()` iterate a snapshot of the array while the removals mutate the original, makes the whole shutdown linear. Expected effect: the 160 000 statement close drops from 36 880 ms to well under 100 ms (C).

The alternative, if an upstream release is not acceptable for v0.1.4, is to vendor the patch locally with `patches/`, the same mechanism already used for `patches/effect@4.1.5.patch`. That is the fallback if the upstream PR does not land in time.

### 2. Stop the daemon leaking statements

Every `prepareRaw` in the daemon's hot path must either be finalized or be tracked by a structure that finalizes it. Two options:

- Explicit `finalize()` after each use, which is what the existing code does in a handful of places. This is the cheapest change but it touches a lot of call sites and is easy to regress.
- A helper that wraps the common shapes, for example `q.one(db, sql, binds)` and `q.all(db, sql, binds)`, which prepare, run and finalize in a `try`/`finally`. Then rewrite the hot-path call sites to use the helper.

The helper approach is preferred because it makes the correct pattern the default and removes the possibility of a new leak being introduced by a bare `prepareRaw`.

### 3. Make the shutdown itself non-blocking and prompt

Even with a linear `close()`, the daemon should stop accepting work the moment the signal arrives and should not leave the user waiting on a synchronous finalize pass. Two parts:

- Set a shutdown deadline. After the signal, the daemon stops the claim loop, detaches running children as it does today, and closes the DB. If the close exceeds a deadline, the process exits anyway rather than appearing to ignore the signal.
- The signal handler should do the minimum. Mark the stop, let the loop drain, and close the DB from a single place, rather than closing inside the handler while a turn is in flight. The current code closes inside the handler (`src/daemon.ts:503`), which is exactly why the handler appears not to fire.

### 4. Tests

A regression test must fail on the current code and pass on the fix:

- A close-cost test that opens a DB, prepares N statements without finalizing, closes, and asserts the close completes under a bound. N of 20 000 gives 449 ms today, which is comfortably above a 250 ms bound and still fast enough to keep the test cheap.
- A daemon shutdown test that sends SIGTERM to a daemon that has churned through enough turns to accumulate statements, and asserts the process exits within a few seconds. The current code needs 8 to 29 s after churn.
- A leak test that measures the tracked statement count across daemon turns. This needs a way to observe the count. The cleanest route is an upstream `@cutils/sqlite` accessor for the tracked count, which the same upstream PR can provide.

## What is not in scope

- The WAL size. It is not the cause (M, the 4.1 MB WAL control exited in 2 s).
- The idle-spin fix, 5ebd66c. It works (M, idle CPU 0.05 %).
- The six stray daemons. They were pre-fix leftovers, not a v0.1.3 defect.

## Cost estimate

The upstream fix in `@cutils/sqlite` is a small change to one function. The daemon-side fix is a helper plus a call-site rewrite in `src/queue.ts`, roughly 30 call sites. The shutdown-path change is a few lines in `src/daemon.ts`. Total, on the order of a day of work including tests, and it splits cleanly across the two repositories.

## Related

- `.agents/docs/effect-migration.md`, for the Effect v4 seams this touches in the daemon.
- `.agents/docs/bench-ci.md`, for the chaos and orchestrator-kill scenarios that will exercise the new shutdown path.


## Addendum: what to do about the 3 orchestrator-kill loop failures

The bench results file `benchmarks/results/results-effect-v0.1.3-macos-arm64.json` records 3 failures out of 24 runs in the orchestrator-kill determinism loop, with the failure signature: `all_done=false`, recovery about 190.5 s, `resumed_via_session_load=0`, `status=running`, `turns_started=1`, `turns_done=0`, loads 0. The stub agent was never relaunched by the restarted daemon.

The same signature appears on the pre-Effect build (2 of the 7 cross-binary failing runs), so it is not an Effect regression. The question is whether it is purely host starvation, or whether there is a latent defect the starvation exposed.

### The mechanism

The daemon relaunches an ACP job after a restart through the normal claim path: the restarted daemon's first turns reap expired leases and re-claim the `running` jobs whose leases lapsed, then `spawnJob` starts a fresh agent process that resumes via `session/load`. Three things must all happen: the lease must be judged expired, the job must be re-claimed, and the agent spawn must succeed.

The failures ran at host free memory of 20 to 538 MB with 1-minute load of 10 to 73 (M, recorded per run). Under that pressure the stub agent (`node fixtures/stub_acp_agent.mjs`) either fails to start or starts so slowly that the 180 s recovery deadline expires before the first turn completes. The failing runs show `turns_started=1` and `loads=0`, which means the agent process never got as far as answering `session/load`. That is starvation at spawn, not a logic error in the resume path.

Two latent weaknesses are worth noting, without claiming they caused these failures:

1. The recovery deadline is a fixed 180 s wall clock, so a busy host can turn a slow-but-correct recovery into a recorded failure. A load-aware deadline, or simply a longer one for the loop leg, would separate "slow because the host is thrashing" from "wrong".
2. If the agent process fails to spawn, the job stays `running` with an expired lease until the next daemon turn reaps it, and the run's harness counts it as failed at the deadline rather than the daemon marking the job failed. The daemon has no "agent failed to spawn N times, give up and mark the job failed" path. That is a robustness gap, not a correctness one: at-least-once still holds.

### Recommendation

Treat the 3 failures as environmental, and do not block the v0.1.4 release on them. Concretely:

1. Rerun the orchestrator-kill loop on a quiet host before the release. The current results never ran the loop at low load (M), so 3/24 is an upper bound for a contended host, not the expected rate. If the loop passes 24/24 on a quiet host, the environmental explanation is confirmed and no code change is needed.
2. If it fails again on a quiet host, file it as a defect with the per-run JSON, because then the starvation explanation no longer holds.
3. Separately, as a small hardening item for a later release (not v0.1.4): give the daemon a spawn-failure escalation path, so a job whose agent cannot be spawned N consecutive times is marked failed with an outcome string instead of sitting in `running` until the harness deadline. This also makes the bench's failure signature distinguishable: a spawn-escalation failure shows `attempts` incrementing, which the current signature does not.
4. For the bench harness itself, record the daemon's own view (attempts, attempts since restart) next to the pass/fail verdict in the loop leg, so the next run of the loop can tell "agent never started" from "agent started and hung" without re-deriving it from SQLite by hand.

Items 3 and 4 are bench and robustness improvements, not release blockers.
