# Restate spike: results

Candidate for the M4 scheduler and the M5 await module. Restate 1.8.1 (restate-server 1.8.1, CLI 1.8.1, restate-sdk Python 1.5.4), native binary under ~/.local/opt/restate, no docker. Measured 2026-11-22 on the shared VPS (6 cores, 11GB, load 0.2 to 0.9 during runs), worktree ~/.worktrees/fleet-spikes/restate, branch spike/restate. Adapter shim in bench/adapters/restate/ (shim.py 177 lines + worker.py 106 lines, 283 lines of glue). Results in bench/results-restate.json and bench/results-sqlite-vps.json (same machine, same session).

## What was built (bench/adapters/restate/, 283 lines)

| Fleet concept | Restate mapping |
|---|---|
| machine cap (FLEET_CAP) | flow-control rule `*` (concurrency = cap); invocations sent through scoped ingress `/restate/scope/machine/send/JobRunner/run` |
| repo cap (FLEET_REPO_CAP) | flow-control rule `machine/<repo-key>` with limit key `x-restate-limit-key: <repo-key>`; rules upserted idempotently per enqueue via `PUT /limits/rules` |
| enqueue durability | ingress `send` is journalled by the server before the 202 response, so it survives kill -9 (M: chaos all 9 jobs finished after killing the whole stack) |
| job execution | `JobRunner` service handler: spawns `/bin/sh -c CMD` as its own session, nonzero exit raises a TerminalError (400, non-retried) |
| weighted tool lease | `ToolLease` VirtualObject, one instance per (tool class, project) hash; acquire is a stateful exclusive handler, park is `ctx.sleep(200ms)` poll loop; the sleep suspends the invocation, which frees its machine slot |
| priority | not mapped: flow control has no priority knob today (planned per docs, R) |
| stats | `restate sql` over sys_invocation grouped by status |

Restate scope semantics caveat (M): the scope budget is shared across all limit keys in the scope, so the machine cap and the repo caps compose as documented, but a single scope means all fleet work goes through one partition (R, docs call this out for low-cardinality scopes).

## Results (same machine, same day; sqlite from `python -m fleet`)

| Metric | SQLite (current) | Restate 1.8.1 | Verdict |
|---|---|---|---|
| G1 no external server | yes | yes (single binary + our worker process) | tie |
| G2 idle RSS, whole stack | 18.5 MB | 532.4 MB (restate-server alone ~532MB settled; worker ~28MB) | Restate loses badly |
| G2 idle CPU | 0.0% | 0.0% | tie |
| S10 enqueue CLI median | 160 ms | 169 ms | tie (shim CLI cold start ~130ms Python) |
| Enqueue via curl to ingress | n/a | 22 ms median | raw ingress is fast; our CLI overhead is Python startup |
| Enqueue via restate-sdk Python client | n/a | not measurable (generic_send returns HTTP 400 on 1.5.4, K: looks like a client bug) | — |
| Throughput 60 trivial jobs | 8.6 jobs/s | 5.8 jobs/s | Restate loses |
| Peak RSS under throughput | 18.9 MB | 687.8 MB | Restate loses |
| Machine cap holds (cap 3) | yes | yes | tie |
| Repo cap holds | yes | yes | tie |
| Weighted tool cap holds | yes | yes | tie |
| Trivial job runs while another is parked | yes | yes (M, toolpark bench) | tie: the sleep-poll suspends and frees the slot |
| kill -9 recovery to all done | 14.5 s | 3.5 s | Restate wins (server replays journals at boot) |
| Duplicate executions after kill -9 | 3 of 9 | 3 of 9 | tie (both at-least-once) |
| Global priority across repos | ok | no (B/R: "invocation priorities" listed as planned in flow control docs) | Restate loses S9 |

## Gates

| Gate | Verdict |
|---|---|
| G1 no external server | pass (M): restate-server + our Python worker, both local |
| G2 footprint | fail (M): 532MB idle, budget is 200-300MB for the whole stack and 60MB per module. Server RSS did not shrink after warmup (537MB at 45s, 532MB at 2min, 0% CPU) |
| G3 survives kill -9 + TTL | pass (M): 3.5s to all done. Retention defaults exist (journal 1d), (R) |
| G4 availability over consistency | pass (M): chaos scenario, nothing dropped |
| G5 macOS and Linux | pass (R): single Rust binary, musl build in use |
| G6 license | pass with a flag: LICENSE on main is Business Source License 1.1 with an Additional Use Grant that explicitly permits production and internal deployments that are not a public Restate platform service (M, read from raw.githubusercontent.com/restatedev/restate/main/LICENSE). Not OSS by OSI definition; revisit if we ever redistribute |
| G7 maintained | pass (R): 1.8.1 released 2026-10, active repo |

## Scores (rubric section 1 weights)

| Criterion | Score | Evidence |
|---|---|---|
| S1 park and wake (3) | 3 (M): a job waiting on a tool lease suspends (`ctx.sleep` shows as a Sleep journal entry, invocation not counted as running), and the trivial job ran while one tool job was parked (tool_trivial_ran_while_parked true). Awakeables and durable promises exist as first-class primitives, our poll loop was only used after an awakeable wakeup ordering issue in SDK 1.5.4 (K) | bench toolpark |
| S2 soft caps (3) | 3 (M): machine cap via scope rule, repo cap via limit key, surplus queues in the vqueue (INBOX counts visible in `restate vqueues list`). Weighted costs are in our 30-line ToolLease object, not native | bench cap, repo, toolpark |
| S3 resume after orchestrator dies (3) | 2 (M): journals replay and in-flight jobs re-run after kill -9 (3.5s), but there is no notion of resuming an external session with the same harness; that stays our glue | chaos bench |
| S9 global priority (2) | 0 (M): priority field accepted but ignored; flow control docs list invocation priorities as a planned capability (R). Bench order came out p0,p5,p1,p9 | bench priority |
| S10 enqueue under 300ms (2) | 2 (M): 169ms median via our CLI, 22ms raw to ingress | bench cli |

Weighted total for these five: 10 of 13 relevant points (77%). Weighted total over the full rubric ceiling would be lower because S5 cross-device, S8 quota rate limiting and S14 adaptive caps are absent or unmeasured.

## Findings

1. The footprint kills it for M4 on a laptop: 532MB idle RSS for the server alone is 2x the whole-stack budget, and 688MB peak under a 60-job burst. RocksDB memtable defaults are the likely cause (K); shrinking rocksdb-total-memory-size and the query-engine memory may cut this, but that is tuning against the design, not a fix.
2. Flow control maps cleanly to our cap model: scope = machine, limit key = repo, both enforced by the server's scheduler with fair queueing (R), and the vqueues view gives await tracking (what is queued, running, suspended per key) for free, which is a real S7 win.
3. Parking works: a suspended invocation does not hold a machine slot (M). This is the thing DBOS failed on the free tier. But our parking is a 200ms poll loop, not an awakeable: the awakeable version had a wake-ordering issue in SDK 1.5.4 (the release resolved the awakeable before the waiter recorded it under load, or the future never registered; not diagnosed to root cause, K). A durable promise or `object_call` attach would be the idiomatic fix and needs a retry with SDK 1.6+.
4. No priority support in flow control today (R). S9 fails natively; we would need one scope per priority class with caps split per class, which fragments the machine budget.
5. The Python SDK client (1.5.4, `restate-sdk[client]`) fails scoped sends with HTTP 400 (M). Curl to ingress is 22ms median, so the server path is fine; the CLI cost is Python interpreter startup (~130ms), the same cost our own CLI has.
6. Kill -9 recovery is the real win: 3.5s vs 14.5s for SQLite, without a lease-wait, because the server replays journals at boot and re-runs in-flight sends. The SQLite backend could get most of this by reaping on daemon start (already noted in the DBOS spike).
7. Operational rough edges (M): the server refuses to boot if any of ports 8080/9070/5122 is taken (fine), the config key for the data directory is `base-dir` in 1.8 (not `data-dir` as older docs say), and non-retriable job failures need TerminalError with a 4xx code; a 500 TerminalError is retried forever.
8. License: BSL 1.1, not MIT/Apache as the survey's "runtime BSL" note guessed and as some marketing pages imply. The Additional Use Grant covers our internal use, but it is a real constraint to record.

## Verdict

Adopt for neither M4 nor M5 as the resident scheduler; keep the SQLite scheduler as M4. The 532MB idle RSS fails G2 outright on every device we run, and priority (S9) is unsupported natively, while our SQLite backend already passes every bench gate at 18MB. The park result (S1 suspended-without-slot) is the one capability we lack, and it is worth copying rather than adopting: SQLite can get the same semantics with a parked-jobs table plus a waker, at DBOS-spike-level effort.

Keep Restate on the watch list for two cases: (a) if flow control ships invocation priorities and the server footprint drops under ~150MB, it becomes the best single fit for M4 plus M5 and should be re-spiked; (b) for the M5 coordination module alone, if we ever need cross-device durable awaits, a small shared Restate instance on the hub (the framing's coordinator role) would host awakeables and durable promises without each device running a server.

Glue: 283 lines (shim 177, worker 106). Replacing the SQLite scheduler (576 lines queue+daemon) would not remove much: caps, priority, session records and the CLI stay ours, so the glue is not smaller than the code it replaces, which fails the module adoption rule on its own.

## Open questions

- Does restate-server idle RSS drop materially with rocksdb-total-memory-size and admin.query-engine.memory-size tuned down? Not tested (M budget went to the bench).
- SDK 1.5.4 Python: does the awakeable wake ordering issue disappear in SDK 1.6+/1.8? And is the `generic_send` HTTP 400 a known client bug?
- Is the 22ms curl enqueue stable under load, and does an idempotency key give us job dedup for free?
- Park density (`park-density` scenario): bytes per suspended invocation and the 10k-session vqueue behaviour are unmeasured.
