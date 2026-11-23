# Park density and wake latency

Close-out of the park/wake spike. Measured 2026-11-23 on the shared VPS (6 cores, 11GB RAM, load 0.2 to 0.9 during the runs, host state recorded in every result file). Everything below is M unless marked C.

Results: `bench/results-wake-sqlite-vps.json` (1,000 parked), `bench/results-wake-sqlite-10k-vps.json` (10,000 parked), `bench/results-park-restate-vps.json` (Restate, 1,000 parked), `bench/results-bytes-sqlite-vps.json` and `bench/results-bytes-sqlite-vps-full.json` (the bytes). Method and the earlier spike results: `.agents/docs/orchestrator-framing.md` assessment 9.

## Method

Three questions, three experiments.

The wake experiment uses the `wake-latency` scenario in `bench/bench.py`. It parks N sessions and then wakes them one at a time, timing each wake. A parked session is a job row with status `waiting` and `waiting_on` set: no process, no lease, no slot. The wake is the release command putting the row back to `queued`, then the daemon claiming it, spawning the ACP client, and the client driving `initialize` and `session/load`.

The parked population is filled with `bench/park_filler.py`, never through the CLI: 10,000 CLI enqueues take 18 minutes (M), the bulk filler takes 0.5s in one transaction. The filler parks every row on its own event (`wake-ttl-<id>`) so that a wake releases exactly one session instead of all of them.

The wake stages are traced without instrumenting the wake path. Each wake job gets its own working directory, and `bench/acp_client.py` appends stage epochs (`client_start`, `initialize_done`, `session_load_done`, `session_ready`) to `<cwd>/.acp-trace.jsonl` when `ACP_TRACE=1`. The store's `claim_at` column gives the claim epoch. The daemon's poll interval is configurable (`COORDINATE_BACKOFF_MIN`, `COORDINATE_BACKOFF_MAX`, defaults 0.05s and 2.0s) so the measurement is the spawn path and not the idle poll timer; the bench sets 0.01s and 0.05s.

The bytes experiment uses `bench/bytes_analysis.py`, which measures the store with `dbstat` (the per-object page accounting) instead of the file size, and then measures the reclaim on copies of the database: `DELETE` alone, `DELETE` plus `VACUUM`, and `DELETE` plus `PRAGMA incremental_vacuum` on a copy rebuilt with `PRAGMA auto_vacuum=INCREMENTAL`.

The Restate experiment uses `bench/adapters/restate/park_wake.py`. Restate has no parked-session row, so its park is a suspended invocation: the job contends for the weighted tool lease (`ToolLease` virtual object), and the SDK's `ctx.sleep(200ms)` poll loop parks it.

## Results

| | SQLite (ours) | Restate 1.8.1 | Rivet 3.1.1 (local fs) |
|---|---|---|---|
| 1,000 parked sessions, RSS of the whole stack | 18.5MB idle, 18.7MB parked (M, `bench/results-park-sqlite-vps.json`) | 367.9MB idle, 851.2MB parked (M, `bench/results-park-restate-vps.json`) | not measured at 1,000 |
| 10,000 parked sessions, RSS of the whole stack | 18.5MB idle, 19.1MB parked (M, `bench/results-park-sqlite-10k-vps.json`) | not measured (M: the 1,000 run already passes the memory budget) | 1,489MB (M, Rivet spike) |
| Bytes per parked session on disk | 326 bytes (M, dbstat, 10,000 sessions, no WAL) | 91,398 bytes of data directory growth per parked invocation (M, `bench/results-park-restate-vps.json`) | 24KB (M, Rivet spike) |
| Wake latency, p50 | 112ms at 1,000 parked, 115ms at 10,000 parked (M) | 158.8ms (M, the lease release to the first parked job completing) | 5 to 6ms (M, Rivet spike) |
| Wake latency, p99 | 173ms at 1,000 parked, 167ms at 10,000 parked (M) | not measured (single sample) | 10.6ms at 10k, but 2,034ms at 1k (M, bimodal: 3 of 40 samples were 1.3 to 2.0s) |
| Enqueue of one parked session | 98ms through the CLI (M, Python startup), 0.1ms in the bulk filler | 202ms through the shim CLI (M, `park_enqueue_per_invocation_ms`) | 270ms (M) |

The wake numbers are not comparable across the three rows without reading what each one measures. Rivet's 5 to 6ms is the actor-only wake: a hibernated actor with no resident instance is woken by an action call, and nothing is spawned, no ACP session is initialized and no harness process exists. The SQLite 112ms is the full path: an agent process is spawned, the ACP protocol is initialized and the session is loaded, so the harness is running when the wake completes. Restate's 158.8ms is in between because the job that wakes is a shell command over the lease, not an ACP agent.

## Where the bytes go

The per-session numbers that were reported before (4,444 bytes at 1,000 sessions, 679 at 10,000, 303 with the bulk filler) are not the cost of a parked session. They are the cost of the WAL sidecar, which is a fixed 4,161,040 bytes regardless of how many sessions are parked.

| Fill | Store file | WAL + shm | Total | Bytes per session |
|---|---|---|---|---|
| 1,000 sessions, one connection open | 331,776 | 4,161,040 | 4,492,816 | 4,493 |
| 1,000 sessions, no second connection | 335,872 | 0 | 335,872 | 336 |
| 10,000 sessions, one connection open | 3,051,520 | 4,161,040 | 7,212,560 | 721 |
| 10,000 sessions, no second connection | 3,088,384 | 0 | 3,088,384 | 309 |

(M, `bench/results-bytes-sqlite-vps.json`, the `wal_experiment` section.)

The mechanism: in WAL mode SQLite resets and truncates the WAL when the last connection to the database closes. The daemon holds a connection open for as long as it runs, so the WAL is never reset, and it grows to a high-water mark of 4,128,272 bytes (plus the 32,768 byte `-shm` file). Every subsequent commit reuses that space, so the WAL cost is a fixed overhead that the per-session number amortizes: 4,161,040 bytes over 1,000 sessions looks like 4,161 bytes each, over 10,000 it looks like 416, and the rest of the difference between 721 and 309 is where the WAL's high-water mark sits relative to the row data.

The rows themselves, measured with `dbstat` on 10,000 parked sessions (M, `bench/results-bytes-sqlite-vps-full.json`):

| Object | Bytes per session (shell job payload) | Bytes per session (ACP payload) |
|---|---|---|
| `jobs` table (leaf pages) | 314.2 | 213.0 |
| `idx_jobs_claim` (leaf pages) | 31.9 | 31.9 |
| `jobs` table (interior pages) | 1.2 | 1.2 |
| everything else (`concurrency_slots`, its two indexes, `spawn_audit`, `sqlite_schema`) | 1.6 | 1.6 |
| total | 349.8 | 248.6 |
| of which the payload itself | 210.9 | 130.9 |

A parked session therefore costs 326 bytes for a shell job and 249 bytes for an ACP session, of which the payload (the JSON with the command or the agent, cwd, prompt, registry and the durable session id) is 211 and 131 bytes, and the index on `(status, priority DESC, run_at, id)` is 32 bytes. The page size is 4,096 bytes and the freelist is empty after the fill.

The remaining difference against the CI number of 303 bytes per session at 11,000 sessions is the same amortization: 10,000 sessions of 3,088,384 bytes is 309 bytes each, and at 11,000 it is 281 bytes each before the index pages are counted, so 303 is the file-size-per-session at that population, which is the same number as the dbstat figure here once the WAL is not counted.

## Does the TTL reclaim shrink the file

Measured on copies of the 10,000-session store (`bench/results-bytes-sqlite-vps-full.json`, the `reclaim` section):

| Variant | File before | File after | Freelist after |
|---|---|---|---|
| `DELETE` the parked rows | 3,502,080 | 3,502,080 | 848 pages (3,473,408 bytes) |
| `DELETE` plus `VACUUM` | 3,502,080 | 28,672 | 0 |
| `DELETE` plus `incremental_vacuum`, on a copy with `auto_vacuum=INCREMENTAL` | 3,227,648 | 32,768 | 0 |

(M.) So `PRAGMA auto_vacuum=INCREMENTAL` plus `PRAGMA incremental_vacuum` does make the reclaim shrink the file: the space goes back to the filesystem, without the full rewrite that `VACUUM` does. The cost is that `auto_vacuum=INCREMENTAL` has to be set before the database is created, or followed by a `VACUUM` on an existing store, and it makes every delete leave a pointer to the freed page instead of reusing it, so the writes are slightly more expensive.

The reclaim that the production code does today (delete the row, leave the file alone) does not shrink the file at all: the freed pages go to the freelist and are reused by later writes. That is why the earlier measurement saw the file grow by 0.7MB when 10,000 parked sessions were released: the rows were rewritten (the terminal rows are wider than the parked ones, because the outcome and the lease columns get filled) while the WAL was still open and could not be checkpointed.

## Wake latency breakdown

From `bench/results-wake-sqlite-vps.json` and `bench/results-wake-sqlite-10k-vps.json` (M, p50 over 200 wakes):

| Stage | 1,000 parked | 10,000 parked |
|---|---|---|
| The release command (Python startup, the caller's cost) | 98ms | 106ms |
| Release to the daemon's claim | 10ms | 4ms |
| Claim to the ACP client process starting | 79ms | 81ms |
| ACP `initialize` round trip | 36ms | 35ms |
| `session/load` answering | 0.9ms | 0.9ms |
| Total, event to a running agent | 112ms (p99 173ms) | 115ms (p99 167ms) |

The parked population does not matter: 1,000 and 10,000 parked sessions give the same 112ms and 115ms. The store is an indexed lookup, and the daemon's claim query touches one row.

The breakdown says where the time is. The 79ms from the claim to the agent process starting is `subprocess.Popen` of the ACP client plus its Python interpreter startup: two Python processes are started per wake (the ACP client and the agent it spawns). The 36ms of the ACP `initialize` round trip is the client talking to the agent over JSON-RPC, which is mostly the agent's own startup. `session/load` itself is 0.9ms, because the session is already known to the agent.

The first chunk of agent output follows within `STUB_TURN_MS / STUB_CHUNKS` after that, which is 30ms in this configuration, so the event to the first token of a resumed agent is about 145ms.

## What would move each number

The wake is 98ms of Python startup (the release command) plus 79ms of Python startup (the ACP client) plus 36ms of Python startup (the agent), plus 1ms of actual work. Almost all of it is interpreter startup, so the moves are:

A resident ACP host would take the 79ms and 36ms out: the agent process stays alive between turns and the wake is a `session/load` on an existing process, which the measured 0.9ms says is the cost of the work itself. That is the re-adoption design in `.agents/docs/readoption-design.md`, and it is the single biggest win available.

The release command's 98ms is Python startup for a command that only writes one SQL statement. A `coordinate release` that is a thin client over a unix socket to the daemon (the daemon is already running and holds the connection) would make the release a few milliseconds, and it would take the wake below 50ms.

The daemon's claim latency (10ms at 1,000 parked, 4ms at 10,000) is the poll interval. The daemon sleeps up to `COORDINATE_BACKOFF_MAX` (2s by default) when it is idle, so a wake on an idle daemon waits for the next poll: up to 2s. The bench drove the interval down to 0.05s, so the measured 4 to 10ms is the floor, not the production number. A production wake on an idle daemon is dominated by that poll interval, and the fix is a notification: a socket the daemon selects on, or a `PRAGMA` on the store that wakes the poller.

The parked-session bytes (326 per shell job, 249 per ACP session) are dominated by the payload (211 and 131 bytes). A row with a short payload would cost about 100 bytes, so the floor is set by the row header and the fixed columns: 19 columns, of which 8 are NULL for a parked session. Moving the volatile columns into a separate table that is deleted with the job would shrink the row, at the cost of a second table.

The WAL overhead (4,161,040 bytes fixed) goes away by checkpointing: `PRAGMA wal_checkpoint(TRUNCATE)` on a timer, or by not holding a second connection open during the bulk fill. With a periodic checkpoint the store of 10,000 parked sessions is 3.1MB, and the reclaim becomes visible with `incremental_vacuum`.

Restate's numbers (367.9MB idle, 851.2MB parked, 91,398 bytes of data directory growth per parked invocation) are the ones that decide it. The 367.9MB idle is the server's RocksDB (an earlier draft of this section carried 393MB idle, 410MB parked and 30,787 bytes per parked; those figures match no result file or commit in this repo and were superseded, so they are struck here: the JSON in `bench/results-park-restate-vps.json` is authoritative). The per-parked cost is about 280 times ours, not 50. The same draft also carried a 52ms Restate wake and a 217ms enqueue; the JSON records wake_ms 158.8 and park_enqueue_per_invocation_ms 202.0, which are used here. Root cause: the salvage commit of this write-up (891aaa9) is the only source of those numbers; no results file at any commit or in the on-disk data dir supports them, so they are treated as transcribed from a run whose results were not saved. Even if the parking is elegant, the footprint fails the memory budget on every device we run, which is why the earlier verdict stands: keep the SQLite scheduler, copy the design (a parked job frees its slot) rather than adopt the runtime.

## Open questions

The Restate wake was measured once, with a lease release to the first parked job completing. It needs the same 200-sample treatment over 1,000 parked invocations to be comparable with the SQLite row.

The Restate parked state is a poll loop, not an event wait: the SDK's `ctx.sleep(200ms)` keeps the invocation in the `running` state between polls, so `suspended` stayed at 0 in the measurement. The earlier spike found the same, plus an awakeable wake-ordering issue in SDK 1.5.4. The idiomatic fix is a durable promise or an `object_call` attach, and it needs a retry with SDK 1.6+.

The wake measurement uses a stub agent, so the 36ms `initialize` and the 79ms spawn are the stub's Python startup, not a real harness's. A real harness (codex, claude) has a much larger startup, so the measured 112ms is a lower bound for the spawn stage.

The production wake latency on an idle daemon (poll interval up to 2s) was not measured here: the bench drives the poll interval down. That number is worth measuring before the wake path is designed.
