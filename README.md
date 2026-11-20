# fleet

Per-machine durable job queue with lease-based concurrency caps. Pure stdlib Python, one SQLite file.

State lives in `~/.fleet/queue.db` (override with `FLEET_DB`), WAL mode, `busy_timeout=5s`. Never share the file across machines.

## Usage

```sh
uv run fleet enqueue --cwd ~/code/repo -- make test   # job runs payload.cmd in payload.cwd, exit 0 = done
uv run fleet daemon                                    # dispatcher: claim loop, heartbeat, reaper
uv run fleet status [id]
uv run fleet wait-on <id> <event>                      # park a job, frees its slot
uv run fleet release <event>                           # requeue jobs parked on the event
uv run fleet cancel <id>                               # recorded as failed; a running job is killed at next heartbeat
uv run fleet stats
uv run fleet dead retry [id]                           # requeue dead and failed jobs, attempts reset
```

## Semantics

- Claim is one `BEGIN IMMEDIATE` transaction: machine cap plus per-repo cap (repo = `payload.repo` or `payload.cwd`), FIFO by priority desc, run_at, id. A blocked job stays `queued`.
- Lease 30s, heartbeat every lease/3. The reaper requeues expired leases if `attempts < max_attempts`, else `dead`.
- Nonzero exit is `failed` (terminal, no retry). Only lost leases consume retry attempts.
- Config env: `FLEET_MACHINE` (laptop:3, vps:6 default caps), `FLEET_CAP`, `FLEET_REPO_CAP` (default 1), `FLEET_LEASE_S`.
- Idle polling backs off from 50ms to 2s and resets on activity.

## Tests

```sh
flock /tmp/tsc.lock uv run --with pytest pytest -v
```

`spike-ref/` holds the validated Spike B shim and its findings, kept as reference.
