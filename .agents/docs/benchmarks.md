# Benchmarks: coordinate surfaces in comparative context

Method: each number marked (M) measured on this machine with host state recorded in `bench/results-*.json`, or (C) claimed from external sources without local verification. Harness: `node bench/surfaces-bench.mjs` (sections selectable by argument). Raw baseline: `node bench/rawsqlite-baseline.mjs`.

## Reference ceiling first (M, 2026-11-26, this machine)

Raw SQLite through the project's own connection helper, WAL mode, warm:

| Operation | Latency | Throughput |
|---|---|---|
| single-row insert, own transaction | 0.025 ms | ~40,800/s |
| batched insert (one tx) | 0.003 ms | ~309,000/s |
| lease-like cycle (insert+read+update+delete in one tx) | 0.047 ms | ~21,300/s |

This ceiling reframes every other number: the queue core is never the bottleneck at single-machine scale. Even 100 concurrent lease waiters polling once per second cost 0.5% of the lease-cycle budget.

## coordinate surface numbers (M, same host, under load)

| Surface | Operation | Median | Note |
|---|---|---|---|
| lease | acquire+release round trip, compiled binary CLI | 20.1 ms (p95 28.2) | ~99.8% process spawn + init, not SQLite |
| lease | same via node shim | 706 ms | node boot dominates; why the compiled binary matters |
| enqueue | serial CLI, 60 jobs | ~272 ms/op | startup-bound, same story |
| mailbox | 100 sends then full inbox read | read 218 ms for 100 msgs | shim-measured |

Structural conclusion: coordinate's per-operation cost is almost entirely process-boundary crossing, not queue machinery. In-process consumers (the daemon) pay microseconds; CLI consumers pay tens of milliseconds. Both are far inside the budget for an orchestration tool whose jobs run seconds-to-hours.

## Comparison with comparable systems (C, structural)

Direct numeric comparisons are misleading because the deployment shapes differ. What each system pays per operation:

| System | Backing store | Per-op cost shape | What their numbers mean |
|---|---|---|---|
| coordinate | embedded SQLite, local | µs in-proc, ~20 ms via CLI spawn | single-machine; no network hop ever |
| river / hatchet / dbos | Postgres (often networked) | one network RTT + query, typically 1-10 ms LAN, more cross-AZ | throughput claims (jobs/s) assume pooled connections in a long-lived process |
| temporal | server cluster + Cassandra/Postgres | multiple service hops per workflow task | hundreds-thousands of workflow starts/s per cluster, at the cost of running the cluster |
| restate | embedded raft log, but server deployment | network hop to the restate server | durable execution as a service, not a library |

The honest comparative statement: for a single-machine agent orchestration queue, coordinate's embedded-SQLite design sits 2-3 orders of magnitude below the latency floor of any network-backed alternative (0.047 ms lease cycle vs a 1-10 ms network RTT before any query logic), and the places where coordinate is slow (CLI spawn overhead) are exactly the places the alternatives don't even offer (none of them have a meaningful CLI-per-operation mode; they assume long-lived client processes).

Where coordinate genuinely gives something up: throughput beyond one machine (by design — the machine IS the trust domain), and batch ingest (no COPY-style path; enqueues are row-at-a-time, though at 40k/s raw this only matters past thousands of jobs per second, far above agent-fleet scale).

## Regression gate recommendation

Track these continuously, fail CI if they regress >2x against the previous release on the same host class:

1. lease acquire+release median via compiled binary (now 20.1 ms)
2. lease-like raw cycle per second (now ~21,300)
3. FIFO exactness under 20 waiters (correctness, boolean)
4. enqueue-to-claim latency at machine cap (needs the daemon lane; not yet automated)

Host state must be recorded next to every run (the harness does this) — numbers without loadavg/memory are not comparable.
