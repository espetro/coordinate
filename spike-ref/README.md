# Spike B — SQLite durable queue + concurrency caps under `kill -9`

Throwaway experiment. Question: does a SQLite-backed job queue with lease-based
concurrency caps hold when the worker is SIGKILLed mid-run?

## Variants tested

Both tested.

- **Variant 1 (River)**: `riverqueue/river` v0.51.2 with `riversqlite` driver
  (modernc.org/sqlite, WAL). One process, `MaxWorkers: 3`,
  `JobTimeout: 10s`, `RescueStuckJobsAfter: 30s`.
- **Variant 2 (shim)**: hand-rolled Python 3.14 + stdlib `sqlite3`. `jobs` table
  (id, kind, payload, status, attempts, lease_owner, lease_expires_at, ...),
  claim loop in `BEGIN IMMEDIATE` transactions, cap 3, lease 30 s, reaper
  pass every 10 s requeues expired leases. WAL, `busy_timeout=10000`,
  `synchronous=NORMAL`.

## Commands to reproduce

```sh
# Variant 2 (shim)
cd /tmp/spike-b/shim && python3 driver.py

# Variant 1 (River)
cd /tmp/spike-b/river && go build -o spikeb . && python3 driver.py
# driver: migrate → enqueue 10 (sleep 2s jobs) → start worker → wait ≥4 done
# → kill -9 worker → restart → poll until 10 completed → report metrics.
# A 100ms-interval monitor goroutine/thread samples `running` count the whole time.
```

## Test results (job: sleep 2s, 10 jobs, cap 3, kill -9 after ≥4 done)

| Metric | Shim | River |
|---|---|---|
| Max concurrent observed (live workers) | 3 | 3 |
| Max `running` rows observed after kill -9 | 4 | 6 |
| Cap exceeded by live workers? | **no** | **no** |
| Cap "violation" if counting stale rows | yes (artifact) | yes (artifact) |
| Jobs lost | 0 | 0 |
| Orphan requeued and re-run | yes (reaper, attempts=2) | yes (rescuer, attempt=2) |
| Recovery (kill → all 10 done) | ~32 s (lease had to expire) | ~45 s (rescuer interval + 30s horizon) |
| Total drain (enqueue → 10 done) | ~36 s | ~50 s |
| Claim latency (enqueue→running) | min 0.03 s, median 2.0 s, max 34 s (requeued orphan) | min 0.03 s, median 4.2 s, max 47 s |

Notes:

- The "max_running > 3" samples in both variants are stale rows from the killed
  process, not real concurrency: after `kill -9`, the orphaned `running` rows sit
  there until lease/rescuer expiry, while the restarted worker claims up to 3
  fresh jobs. Live worker concurrency never exceeded 3 in either variant.
- River gotcha hit during the spike: `RescueStuckJobsAfter` must be > `JobTimeout`
  (default 1 min / 1 h rescue horizon means a SIGKILLed job waits ~1 h by default).
  With `JobTimeout: 10s, RescueStuckJobsAfter: 30s` recovery is ~45 s.
- The shim recovers faster (lease expiry 30 s vs River's 30 s horizon + 30 s
  rescuer poll) and is ~100 lines of auditable SQL.

## Verdict per spike exit criteria

- **Cap held under kill -9? Yes** (both variants) — live concurrency never
  exceeded 3; apparent violations were orphaned rows pending lease expiry.
- **No job lost? Yes** (both variants) — all 10 reached done/completed after
  restart, each orphan requeued exactly once (max attempts = 2).
- **Orphan recovery bounded? Yes** — shim ~30–35 s, River ~45 s with tuned
  config (~1 h with River defaults — must be tuned explicitly).

## Recommendation

**Shim for a small agent-dispatch queue.** Reasons:

1. Recovery is faster and predictable: lease expiry (30 s) vs River's
   rescue-horizon + poll interval (~45 s tuned, ~1 h at defaults). For an agent
   dispatcher where a hung agent is common, tighter bound matters.
2. River's safety constraints bite: `RescueStuckJobsAfter > JobTimeout` means
   slow agent jobs force long stuck-horizons, and the default (1 h) silently
   strands killed jobs for an hour. Getting it right requires understanding
   three interacting config knobs.
3. The shim is ~100 lines, one table, trivially auditable and debuggable
   (`SELECT * FROM jobs`), zero dependencies beyond stdlib sqlite3. Agent
   dispatch needs exactly one semantics: claim with lease, requeue on expiry.
   River's retries/cancellations/unique-jobs/middleware are unused weight here.
4. River's SQLite driver is explicitly "early testing, not production ready"
   (upstream docs), poll-only, no batch insert.

River becomes the right choice if you later need Postgres, multi-host fan-out,
cron/periodic jobs, or rich retry policies — the shim's semantics map 1:1 to
River's, so migration is cheap.
