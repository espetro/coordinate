> Note (2026-11-23): main is now TypeScript + scriptc only. Python paths and `uv`/`pytest` commands below refer to the retired Python implementation, preserved on the `legacy/python` branch.
# Restate awakeable suspension spike

Close-out of the awakeable park/wake variant. Measured 2026-11-23 on the shared VPS (6 cores, 11GB RAM, load 1.4 to 2.4 during the runs, host state recorded in both result files). Everything below is M unless marked C.

Question: does replacing the polling park (`ctx.sleep(200ms)` loop) with a durable awakeable give Restate true park semantics on this stack, and what does the awakeable resolution itself cost?

Results: `bench/results-restate-suspension-vps.json` (awakeable variant, 1,000 parked) and `bench/results-park-restate-vps-awakeable-session.json` (same-session polling baseline via `park_wake.py`). Adapter: `bench/adapters/restate/park_wake_awakeable.py`; services: `bench/adapters/restate/worker.py`. Method otherwise as `.agents/docs/park-wake.md`.

## Method

The polling variant parks by spinning on the weighted `ToolLease` virtual object with `ctx.sleep(200ms)` between attempts. The awakeable variant (`JobRunnerSuspended.run_suspended`) instead registers a fresh awakeable id on every failed acquire: `acquire_or_park` appends the id to the `waiters` state of the `ToolLease` object and returns false, the invocation awaits its awakeable future, and `ToolLease.release` resolves every registered id and clears the list. The design intent (C, Restate semantics) is that awaiting the awakeable with no other progress suspends the invocation, which then leaves the resident set and shows up as `sys_invocation.status = 'suspended'`.

Both runs park 1,000 `pytest short` jobs against a lease held by one holder job for 90s, with `pytest:* = 2` slots. The bench samples `sys_invocation` status counts every second during the park.

## Headline result: the invocations never suspended

`parked_suspended` is 0 and `max_suspended_seen` is 0 across all 165 samples (M): every parked invocation stays in the `running` status for the whole 184s park, in both the awakeable and the polling runs. The awakeable machinery worked exactly as designed at the state level: 1,000 initial `acquire_or_park` calls registered 987 waiters (13 of the 1000 won acquires immediately, on top of the holder) and 15 `release` calls over the run resolved the waiters each time (M, `tool_lease_state` and `tool_lease_calls` in the result file).

The count of `acquire_or_park` calls, 15,298 for 1,000 invocations, is the thundering herd (M): each release wakes all ~987 waiters at once, only 2 of them (the slot capacity) win the re-acquire, and the rest register again, so every release costs roughly 985 failed re-acquires. The last sample shows `waiters = []` and `held = 30`, so no wake was dropped (M).

Why no suspension: the service is declared `Service("JobRunnerSuspended", inactivity_timeout=timedelta(hours=2))` (M, `worker.py:131`). Restate suspends an invocation only after the inactivity timeout passes with no progress (C, Restate semantics), so with a 2h timeout the awakeable await keeps the invocation resident in the worker process indefinitely. The 2h value was chosen so long-running jobs are never suspended mid-execution; it also disables suspension while parked. True suspension via awakeables would need a short inactivity timeout, which conflicts with jobs that legitimately run for minutes. An `attach`-style wait or a runtime-level suspension hint might avoid this, but was not measured here.

## Numbers, polling vs awakeable

| | Polling (`park_wake.py`) | Awakeable (`park_wake_awakeable.py`) |
|---|---|---|
| Parked population at sample end | 923 polling, 77 completed (M) | 987 running, 14 completed (M) |
| `suspended` status seen | 0 (M) | 0 (M) |
| RSS idle, server + worker | 695.0MB (M) | 730.3MB (M) |
| RSS parked | 1,186.1MB (M) | 1,019.8MB (M) |
| RSS delta per parked | 502.9KB (M) | 296.5KB (M) |
| Data dir growth per parked | 90,895 bytes (M) | 294,451 bytes (M) |
| of which log store | 63,473,712 bytes total (M) | 180,337,079 bytes total (M) |
| Enqueue per invocation | 215.5ms (M) | 3.5ms (M) |
| Park wall time (enqueue + settle) | 396.3s (M) | 184.3s (M) |
| Wake, release to first parked completion | 198.9ms (M) | 126.0ms (M) |

Two caveats on the comparison. The two runs are not aligned on the parked population (923 vs 987 still parked at the last sample), so the per-parked numbers carry roughly a 6% skew, direction against the awakeable variant, which strengthens rather than weakens its RSS win (M). And the completions drift during the park differs (77 vs 14), because the polling run's 200ms polls let more waiters win slots as the holder's lease frees; the awakeable run only wakes on releases, of which there are 15 (M).

What the awakeable run does show, even without suspension:

- Enqueue is 61x faster: 3.5ms per invocation through the scoped send (M) versus 215.5ms through the polling bench's shim path (M). Most of that gap is path, not park mechanics: the awakeable bench posts the envelope straight to the scoped ingress while `park_wake.py` goes through the shim CLI (M, adapter code). The comparable enqueue number for the polling baseline in `.agents/docs/park-wake.md` is 217ms through the shim (M).
- RSS per parked drops 41%, from 502.9KB to 296.5KB (M). The invocation awaiting an awakeable does not allocate journal entries per poll iteration, and the 15,298 acquire calls are cheaper than the polling run's ~90,000 sleep-journal writes (C, arithmetic: 923 waiters polling every 200ms for ~390s is ~1.8M sleeps, each a journal write, which is the plausible driver of the polling run's runtime cost).
- Journal bytes per parked triple, from 90,895 to 294,451 bytes (M): each release/wake cycle rewrites the `waiters` list twice (append, clear) and journals an `acquire_or_park` attempt per waiter per cycle, roughly 985 extra attempts per release over 15 releases (M, from the call counts). The awakeable park trades CPU-free waiting for write amplification on the release path.
- Wake latency is 126ms (M) versus 199ms (M): the resolve is push, so the 200ms poll granularity disappears; what remains is the re-acquire round trip plus the job. Still far above the SQLite full-path 112ms p50 (M, `.agents/docs/park-wake.md`) because this job path also spawns a shell process.

## Do awakeables deliver true park semantics on this stack

No, as configured. The registration, durable waiter list, and resolution all work on SDK 1.x / Restate 1.8 (M, the call and state counts), but the invocation awaiting the awakeable stays resident because the service's 2h inactivity timeout prevents suspension (C, semantics; M, the observed status counts). Getting real suspension would require either a short inactivity timeout (breaking long jobs) or a runtime feature that suspends on awakeable wait regardless of the timeout, which this SDK version does not offer (C).

## Verdict for the footprint table

The verdict does not change: keep the SQLite scheduler, copy the design rather than adopt the runtime (M). Even granting the awakeable variant its best numbers, the stack idles at 730.3MB and parks 1,000 invocations at 1,019.8MB (M), against 18.7MB parked for the SQLite scheduler at the same population (M, `bench/results-park-sqlite-vps.json`), and the disk growth is 294KB per parked invocation against SQLite's 326 bytes (M). The idle RSS alone (730MB, M) is 39x the entire SQLite stack parked. The awakeable variant is a genuine improvement over polling (41% less RSS per parked, push wake) and is the right shape for a hosted Restate deployment, but the 393 to 730MB idle floor is the server's RocksDB and is unaffected by the park mechanism (M, across all three Restate runs).
