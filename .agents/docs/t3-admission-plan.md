# T3 admission through coordinate leases

Date: 2026-11-26. Re-scope of [issue #1](https://github.com/espetro/coordinate/issues/1) and the plan to deliver it. Evidence tags: M = measured or verified in code or on a local binary, C = design intent or inference. Host for the measurements: macOS arm64 laptop, compiled darwin-arm64 binary, temporary queue database. Depends on the lease work in [PR #27](https://github.com/espetro/coordinate/pull/27).

## Re-scope

**Problem.** Agent turns started in T3 Code do not count against coordinate's device caps, so T3 work and queue jobs can together exhaust memory (C).

**Original proposal.** Run each T3 turn as a coordinate job through a `t3q` wrapper that starts the turn, then polls until it ends.

**Why that is not the core design.** The job bounds the polling process, not the run inside the T3 server. The T3 CLI (v0.1.10) offers `thread list|start|send|show` and no interrupt (M), so `coordinate cancel` and `--max-runtime` cannot stop the work they appear to control. A retried job sends the message twice, which `t3q` works around with `--max-attempts 1`.

**New scope.** A lease is the admission ticket. T3 owns the session; coordinate owns only the seat. A caller acquires a seat before starting a turn and holds it while the turn runs.

**New title.** "T3 admission: count T3 agent turns against coordinate caps".

**Not in scope.** A `t3` job kind in core. Admission for messages typed into the T3 app or for threads created by T3's own delegation, which needs a hook inside T3. Stopping a T3 run from coordinate.

## Carried over from t3q

`t3q` was written by the issue author and worked through real decisions that stay valid.

| t3q decision | In this design |
| --- | --- |
| A pending question frees the slot | `--wait` exits 2 when the agent waits for an answer, which releases the seat |
| In-place turns serialize per repo | The caller takes the `repo` key before the `machine` key |
| Worktree turns take only a machine slot | Worktree turns skip the `repo` key |
| Never replay a turn | No job row, so nothing retries a turn |
| Memory gate before starting | Separate follow-up, not part of this issue |
| Pause and resume | Not carried over: a queued wait can be cancelled, and a parked turn is just one not yet started |

## What blocks this today

1. A lease on `machine:<name>` has a limit of 1 whatever the machine cap is. With `cap set --machine-cap 3`, a second external acquire did not succeed and `--cost 2` was refused as ungrantable with limit 1 (M). `repo:<path>` keys fall back to the same limit of 1 (M).
2. The job claim path counts lease rows against the machine cap but never looks at queued waits (M), so the daemon can take a freed seat ahead of a queued external waiter (C, not reproduced).
3. The CLI and the daemon can disagree on the machine name. Without `COORDINATE_MACHINE`, a CLI falls back to the recorded or default name (M), and a hand-written key then misses the daemon's key.
4. CI runs Node tests only. A type cast that Node erases crashed the compiled daemon on any dead lease owner, with all tests green (M, fixed in PR #27).

## Target shape

```sh
# in place: repo seat first, then machine seat
coordinate run --key repo:. -- \
  coordinate run --key machine -- \
  t3 thread start --wait . "fix the flaky test"
```

The wrapper process stays alive as long as `--wait` blocks, refreshes the lease, and releases it on exit (M for the lease behavior of `run`, C for the T3 composition). Taking `repo` before `machine` everywhere avoids a lock-order deadlock and means a caller never sits on a machine seat while waiting for a repo.

## Pull requests

Each one is independently mergeable and leaves `main` working.

| PR | Title | Size | Depends on |
| --- | --- | --- | --- |
| A | `ci: smoke the compiled binary` | S | #27 |
| B | `docs: T3 --wait semantics` | S | none |
| C | `fix(lease): machine and repo keys honor the job caps` | S | #27 |
| D | `fix(queue): job claims do not jump queued waiters` | S | C |
| E | `feat(lease): machine and repo key shorthands` | S | C |
| F | `feat(examples): T3 turn admission` | M | B, D, E |
| G | `feat(examples): hold a seat for a running thread` | S | F, only if needed |

### A. Smoke the compiled binary in CI

Build the Linux binary in the PR workflow and run `scripts/smoke-bin.sh` against a temporary database with a temporary daemon: acquire with a dead owner, FIFO grant after release, send and inbox, enqueue, logs, health. Accept: the job fails on the partial-select crash when that fix is reverted. Open: the build time added to CI is unmeasured.

### B. Verify the T3 CLI semantics

A short note in `research/` answering: what `thread start --wait` and `thread send --wait` return on completion, failure, a pending question and cancellation from the app; whether `--wait` survives a T3 server restart; whether it returns while subagents or background tasks still run; whether a T3 workflow step can run a shell command. Accept: each answer is tagged M with the T3 version. This spends real agent turns. If `--wait` returns early or dies on restart, F polls `thread show` instead.

### C. Machine and repo keys honor the caps

Resolve the limit of `machine:*` keys from the machine cap and `repo:*` keys from the repo cap, including the runtime values written by `cap set`. Count `SUM(cost)` instead of rows in the claim path. Files: `src/queue.ts`, `src/config.ts`, `test/lease.test.mjs`. Accept: with cap 2, one running job and one external lease, nothing else is admitted; raising the cap admits the next waiter without a restart.

### D. Claims respect queued waiters

The claim path treats a key with a live queued wait as full. Files: `src/queue.ts`, tests. Accept: saturate the cap, queue an external wait, finish a job; the waiter is granted before any queued job is claimed; an expired or cancelled wait blocks nothing. Trade-off: waiters outrank job priority on that key. Merging jobs and waits into one priority order is out of scope.

### E. Key shorthands

`machine` resolves to the daemon's recorded machine name and `repo:<dir>` to the same path the claim path uses. Files: `src/main.ts`, `src/queue.ts`, `docs/cli.md`, the skill. Accept: a CLI without `COORDINATE_MACHINE` and a daemon with it contend on one key.

### F. T3 admission example

`examples/t3/t3-admit start|send`, a POSIX shell script that nests the two `run` calls, skips the repo key for `--worktree`, and passes through the exit code of `t3`. Note that `coordinate run` itself uses exit 3 and 4 for wait timeout and cancel. Tests use a fake `t3` on `PATH`. The README credits the `t3q` prototype and states what admission does not cover. Accept: with machine cap 2, one running job and one admitted turn, a second `t3-admit start` waits; killing the wrapper frees the seat within one maintenance tick.

### G. Account for turns that are already running

If a wrapper dies, the T3 run continues without a seat. `t3-admit hold <thread>` holds a seat while `thread show` reports an active run. It queues like any caller, so it cannot record an overshoot; if that matters, a forced acquire is a core change to design separately. Build this only if the gap shows up in use.

## Later, tracked separately

- Memory-pressure admission (`research/presence-aware-concurrency.md`).
- An admission hook inside T3 around its workflow agent starts, which is the only way to cover threads T3 creates itself. It is a proposal to a third-party project and needs explicit approval before it is posted.

## Done when

A, C, D, E and F are merged; B is recorded; the limits of coverage are in the user docs; issue #1 links here and is closed.

## Rejected

- A `t3` job kind or `t3q` in core: it presents a poller as the agent run and cannot cancel it.
- Waiting for the T3 hook before doing anything: it depends on an external project, and scripted and agent-started turns can be admitted now.
