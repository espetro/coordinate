# Effect v4 in coordinate: the seam migration

Date: 2026-11-24. Branch `feat/effect-seams`, effect 4.1.5, scriptc 0.4.16. Companion to the orchestrator decision to prove Effect under static compilation before the other features. This is a refactor, not a redesign: the daemon's observable contract is unchanged (same claim order, same lease semantics, same heartbeats, same park/wake release rules, same SIGTERM/SIGINT stop contract, same event kinds, same DB schema, same CLI surface).

## Result

Three seams migrated (daemon, acp, forwarder), zero scriptc build blockers, all 119 tests pass (69 in `test/`, 50 in `test/parity/`), and the binary runs the full loop (enqueue -> daemon claims -> job runs -> done) compiled statically with Effect in the program.

## The two scriptc blockers and the patch

Effect 4.1.5 did not build under scriptc out of the box. Both blockers are solved by `patches/effect@4.1.5.patch` (a pnpm patch), committed separately so it can be dropped when either side fixes their part.

1. ICU. `effect/Effect` statically imports `internal/schedule.js`, which imports `Schedule.js`, which imports `Cron.js`, whose internal `dateTime.js` constructs `new Intl.DateTimeFormat`. The macos-arm64 scriptc runtime pack ships no ICU objects (only linux-x64-gnu does), so any program that imports `effect/Effect` failed with SC3002 on macOS. Scriptc tree-shakes at function granularity, and `Schedule.cron` was the only Intl-reachable call, so the patch deletes the unused `Cron` import and turns `Schedule.cron` into a throw. coordinate does not use cron schedules. An upstream note for scriptc (ship ICU in the darwin packs, or gate the feature) or for Effect (lazy-import Cron) would remove the need for this.
2. AsyncResource. Effect's fiber runtime captures an async context per yield: `process.getBuiltinModule("node:async_hooks").AsyncResource`, then `new AsyncResource(...)` around each fiber evaluation. Scriptc's builtin-module loader answers a value for `node:async_hooks`, but the `AsyncResource` it hands back is not constructible, so every fiber that yielded crashed with "constructor is not a constructor". The patch probes the constructor once at module load and skips the capture when it does not work. The capture is an optional async_hooks integration (vitest's leak detector), not load-bearing.

With both patched, `Effect.gen`, `sleep`, `Deferred`, `Effect.callback`, `Effect.scoped`, `acquireRelease`, `race`, `forkChild`, `Schedule.spaced` and `retry` run correctly in a static binary (the last three verified in a probe binary, not used in the shipped seams).

## Coverage numbers (M)

`scriptc coverage src/main-elf.ts --npm-static effect,@cutils/sqlite,@cutils/cli --ffi node_modules/@cutils/sqlite/ffi.json`:

| Point | Statements analyzed | Compile statically | Blockers |
|---|---|---|---|
| Baseline, before any migration | 2350 | 2348 (99%) | 2 SC1090 (`delete obj[numberKey]` in src/acp.ts) |
| After daemon migration | 7828 | 7815 (99%) | 2 SC1090 (same) |
| After acp + forwarder migration | 7852 | 7841 (99%) | 0 |
| Final, after the acp EPIPE fix and the new seam tests | 7856 | 7845 (99%) | 0 |

The two SC1090 blockers were pre-existing on this tree (the ACP lane landed before this job), not introduced by Effect; they fell out of the acp seam's migration because the pending map became a `Map` (`Map.delete` compiles, `delete obj[numberKey]` does not). Statement count grows because Effect's compiled modules enter the graph.

Effect compiles statically in the same build (`effect  static`); the residual sites scriptc reports are all inside effect's own Formatter/Hash modules, deferred to runtime (36 sites, the same "deferred-to-runtime sites only in effect's own Formatter/Hash" the pre-migration probe reported). One Node-island note remains report-only (object-model prototype mutation in effect's Context.js and 32 more sites in 14 modules); the build is unchanged by it and the binary runs.

Binary: `scriptc build src/main-elf.ts ... -o out` produces a 15.6M macOS arm64 executable that passes the CLI smoke test and runs the daemon loop end to end.

## Which Effect modules are used, and their compile status (M)

All imported through deep paths with function-style named imports (`import { gen } from "effect/Effect"`), which is what Effect v4's tree-shaking wants and what keeps the static build small.

| Module | Used by | Status |
|---|---|---|
| effect/Effect | daemon, acp, forwarder | static (gen, runPromise, race, sleep, sync, succeed, fail, flatMap, callback, scoped) |
| effect/Deferred | daemon (stop signal, takeover probe) | static (makeUnsafe, await, doneUnsafe, succeed) |
| effect/Duration | daemon, forwarder | static (millis) |

Modules proven compilable and runnable but not used in the final seams: effect/Fiber (join), effect/Schedule (spaced). effect/Queue and effect/Semaphore compile statically too (verified during the probe) but the daemon's worker tracking stayed with plain arrays: the loop's claim/spawn/finish sequence is synchronous SQLite, and a Queue would add concurrency machinery around calls that cannot run concurrently anyway.

## Seam 1: src/daemon.ts

The claim loop, the backoff sleep, the stop contract and the singleton-takeover probe move to Effect. Why here: this is the daemon's whole async surface, and every hand-rolled piece of it had a bug class (issue #5's busy spin) or an awkward contract (the stop path clearing timers by hand).

- The idle backoff: `race(sleep(delay), awaitDeferred(stopSignal))`. The issue-#5 property holds, because `Effect.sleep` is a real timer: the thread parks in the kernel while idle and signals still deliver between macrotasks. The gain over the plain setTimeout loop is that a stop signal wakes the sleep at once instead of the next timer tick, and the loop reads as "turn, then sleep, repeat".
- The stop contract: SIGTERM/SIGINT complete a Deferred from the plain signal handler (`Deferred.doneUnsafe` works from outside the Effect world; there is a test pinning that shape). The loop sees `"stop"` and returns; running children were unref'd by the handler and outlive the process, exactly as before.
- The takeover probe: one Deferred per probe run, completed by SIGINT, so an interrupted start leaves the probe loop at once instead of waiting out up to eight one-second attempts.

Left in plain TypeScript on purpose: everything inside one loop turn. Reaping timed-out jobs, settling finished ones, heartbeating leases, claiming and spawning are synchronous SQLite calls through the @cutils/sqlite FFI. They cannot overlap, so concurrency primitives would be decoration; and the SQL stays exactly the SQL that the parity tests cover.

Test: `test/daemon-effect.test.mjs` (the wake seam twice, plus SIGINT cutting the probe short), `test/regressions.test.mjs` X4 (SIGTERM stop contract against a spawned daemon), X2/X3 (spawn failure and reap).

## Seam 2: src/acp.ts

The JSON-RPC request/response lifetime and the agent-session turn move to Effect. Why here: the old `request()` polled a mutable slot every 10ms with a `Date.now` deadline check, which is exactly the shape `Effect.callback` exists to replace, and the turn's teardown ran in a `finally` block that a future edit could easily skip.

- `requestEffect`: send the frame, then `Effect.callback((resume) => {...})`. The response resumes the effect directly; the timeout is one `setTimeout` instead of a 10ms poll re-checking the clock. The pending slot map became a `Map`, which is also what removed the two pre-existing SC1090 blockers.
- The turn program (`initialize -> session/new | session/load -> session/prompt`) runs under `Effect.scoped`, with the agent teardown kept as one plain function (`releaseAgent`) shared by the success and failure paths. `acquireRelease` was evaluated and left out deliberately: the handle the daemon polls (`settled`, `done`, `failure`) is mutable state on the AcpHandle, so scoping the process inside the Effect would hide the release from the handle's own finally. The scope wraps the protocol work; the release stays explicit next to the state it coordinates with.
- The async wrappers (`initialize`, `newSession`, `loadSession`, `prompt`) stay as thin `runPromise` forms over the Effect versions, so the tests and any external caller keep their promise-shaped API.

The protocol subset, the session persistence (q.setSession the moment the id exists), the resume guarantee and the completion poll are untouched. Test: `test/acp.test.mjs` (8 tests, including a full turn against the stub agent and kill -9 resume through the parity suite `test/parity/acp.test.mjs`).

## Seam 3: src/forwarder.ts

The `events --follow` loop becomes one Effect program: `gen` with `Effect.sleep` as the interval, replacing the awaited `new Promise(setTimeout)`. Smallest seam; the value is consistency with the other two and a loop that reads as a loop. Cursor advance rules (D16), sink retry and `--once`/`maxPolls` semantics unchanged. Test: `test/forwarder.test.mjs`, `test/parity/events.test.mjs`.

## Deliberately left in plain TypeScript

- src/queue.ts: the store is synchronous SQLite over an FFI shim. Effect adds nothing to synchronous calls; it would add a compile surface to the file every other seam depends on.
- src/config.ts: TOML parse and validation, synchronous, no lifetimes.
- src/doctor.ts, src/main.ts, src/service.ts: one-shot CLI paths with no long-lived async state. `main.ts` deliberately imports the daemon dynamically; putting Effect in the CLI's static import graph would put it in the CLI-only startup path, which the dynamic import exists to avoid.
- The daemon's per-turn SQL work (see seam 1): synchronous, non-overlapping, parity-tested.

## Remaining risk

- The pnpm patch is the load-bearing piece. A `pnpm install` in a clean checkout applies it from `patches/`, and CI (Linux) builds against a runtime pack that does have ICU, where only the AsyncResource half of the patch matters. If effect 4.1.6 changes `dist/Schedule.js` or the `captureAsyncContext` shape, the patch needs a rebase.
- Effect runs its fibers on scriptc's static runtime scheduler (setImmediate-based). This is exercised by the tests through the real daemon loop and the ACP turn, but a longer soak (bench campaign) would be the next confidence step.
- The report-only Node-island note (object-model prototype mutation inside effect's Context.js et al.) does not affect this build, but a future Effect module that forces a real island would be a hard stop under the static gate.
