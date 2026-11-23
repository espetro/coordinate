# DBOS spike: results

Branch `spike/dbos` (worktree `~/.worktrees/fleet-dbos/spike`), forked from `feat/spawn-shim`. DBOS 3.6.0, SQLite system DB, Python 3.14.
Select with `FLEET_BACKEND=dbos`; default stays SQLite. Bench: `python bench/bench.py --tree <checkout> --backend sqlite|dbos --out f.json`.
Measured 2026-11-21 on the laptop while other heavy jobs ran, so treat small deltas as noise.

## What was built (`src/fleet/dbos_backend.py`, 223 lines)

| Fleet concept | DBOS mapping |
|---|---|
| machine cap | queue `global_concurrency` |
| repo cap | queue `partition_concurrency`, partition key = repo path (solo key for repo-less jobs) |
| lease, heartbeat, reaper | DBOS executor recovery of PENDING workflows on launch, `max_recovery_attempts=3` |
| weighted tool lease | glue: sidecar sqlite `leases` table, atomic acquire, polled |
| session resume, orphan kill | glue: sidecar `procs` table (pgid, pidfile, session) |
| enqueue from CLI | `DBOSClient` |

Not ported: `wait-on`, `release`, per-job `max_attempts`, integer job ids (now `job-<hex>`), the pilot/ACP tests.

## Before vs after (SQLite vs DBOS)

| Metric | SQLite | DBOS | Verdict |
|---|---|---|---|
| Machine cap holds (cap 3, 9 jobs) | yes | yes | tie |
| Repo cap holds | yes | yes | tie |
| Weighted tool cap holds | yes | yes | tie |
| kill -9 recovery, time to all done | 16.7s (waits out lease) | 2.7s | DBOS wins |
| Duplicate executions after kill -9 | 3 of 9 | 3 of 9 | tie (both at-least-once) |
| `enqueue` CLI median | 234 ms | 2431 ms | DBOS loses badly |
| Import cost of CLI | 0.05s | 1.8s | cause of the above |
| Throughput, 60 trivial jobs | 4.4/s | 2.0/s | enqueue-bound, not dispatch-bound |
| Daemon idle RSS | 25 MB | 82 MB | DBOS loses |
| Daemon idle CPU | 0.0% | 2.2% (0.2s poll set by us) | DBOS loses |
| Disk (.venv) | 10 MB | 48 MB | DBOS loses |
| Own code | 576 lines (queue+daemon) | 799 total, 223 DBOS glue | queue code not removable yet |
| Global priority across repos | ok | broken | DBOS loses |
| Trivial job runs while another is parked at tool cap | yes | no | DBOS loses |

## Findings

1. Priority is only ordered within a partition in DBOS. Per-repo partitions therefore lose global priority. Needs a redesign (single partition plus our own repo gate) or a feature request.
2. Parking holds a queue slot. Releasing it on park needs `recv(suspend=True)`, which is Transact Enterprise (`suspend_mode`), so on the free tier a parked job occupies a machine slot and starves trivial jobs.
3. CLI cold start is 1.8s because importing dbos pulls in SQLAlchemy. Agents call `fleet enqueue` a lot, so this needs a thin enqueue path (direct insert, or a unix socket to the daemon), which is more glue.
4. The client cannot enqueue before the daemon has run once (system DB is created by the daemon's launch).
5. Crash recovery is the real win: no lease wait, recovery starts at launch. The SQLite backend could get the same by reaping on daemon start, without DBOS.
6. Queues must be registered after `DBOS.launch()`.

## Verdict

Not worth migrating as is. DBOS gives faster crash recovery, but costs 10x CLI latency, 3x memory, a priority regression, and a park regression, and the weighted-lease and session glue is still ours. Cheapest win to take from this spike: reap expired leases at daemon start in the SQLite backend. Revisit DBOS if a hosted or multi-executor setup appears.
