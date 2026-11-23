# coordinate

Local-first orchestration for AI coding-agent sessions: a per-device daemon (`coordinated`) with a durable SQLite queue, soft concurrency caps, parked sessions woken by events, per-job time caps, and ACP or tmux dispatch. Built to run next to a control panel such as T3 Code. Design and status: [ARCHITECTURE.md](ARCHITECTURE.md). Research, spikes and decisions: `.agents/docs/`.

Pre-release. The code is still the `fleet` package and CLI until prototype slice P1 renames it; the usage below reflects the current names.

Per-machine durable job queue with lease-based concurrency caps. Pure stdlib Python, one SQLite file.

State lives in `~/.fleet/queue.db` (override with `FLEET_DB`), WAL mode, `busy_timeout=5s`. Never share the file across machines.

## Usage

```sh
uv run fleet enqueue --cwd ~/code/repo -- make test   # job runs payload.cmd in payload.cwd, exit 0 = done
uv run fleet enqueue --shell -- 'sh -c "echo a  b" | wc -c'   # ONE string, stored and run verbatim via sh -c
uv run fleet enqueue --acp opencode --cwd ~/code/repo --prompt "fix the bug"   # kind acp, see below
uv run fleet daemon                                    # dispatcher: claim loop, heartbeat, reaper
uv run fleet status [id]
uv run fleet wait-on <id> <event>                      # park a job, frees its slot
uv run fleet release <event>                           # requeue jobs parked on the event
uv run fleet cancel <id>                               # recorded as failed; a running job is killed at next heartbeat
uv run fleet stats
uv run fleet dead retry [id]                           # requeue dead and failed jobs, attempts reset
```

## Semantics

- `--shell` takes exactly one command string (stored verbatim, run by `/bin/sh -c`). Multiple tokens are refused instead of being flattened, which used to lose inner quoting.
- Claim is one `BEGIN IMMEDIATE` transaction: machine cap plus per-repo cap (repo = `payload.repo` or `payload.cwd`), FIFO by priority desc, run_at, id. A blocked job stays `queued`.
- Lease 30s, heartbeat every lease/3. The reaper requeues expired leases if `attempts < max_attempts`, else `dead`.
- Nonzero exit is `failed` (terminal, no retry). Only lost leases consume retry attempts.
- Config env: `FLEET_MACHINE` (laptop:3, vps:6 default caps), `FLEET_CAP`, `FLEET_REPO_CAP` (default 1), `FLEET_LEASE_S`.
- Idle polling backs off from 50ms to 2s and resets on activity.

## ACP jobs

`enqueue --acp <agent> --cwd <dir> --prompt <text>` creates a job of kind `acp` (payload `agent`, `cwd`, `prompt`, optional `registry`). The daemon runs `fleet-acp run <agent> --cwd --prompt --pid-file ...`; the command is `fleet-acp` or whatever `FLEET_ACP_CMD` says (for example `node /path/to/fleet-acp/bin/fleet-acp.js`).

- The sessionId on stdout line 1 is written to `payload.session` as soon as it appears. A retry after a lost lease runs with `--session <id>` automatically, and must use the same `cwd`.
- Exit 0 is `done`, nonzero is `failed` (terminal), same as `cmd` jobs.

## Orphans

The daemon records each child process group (`jobs.pgid`) and, for acp jobs, the detached agent pid file (`jobs.pidfile`, under `pids/` next to the DB). The reaper SIGKILLs both groups before it requeues an expired lease, so after a daemon `kill -9` the retry never runs beside the old attempt. A new daemon's reaper does this on its first lease expiry.

Limits: a crash between claim and the pgid write leaves that one child untracked. Recorded pids are trusted, so pid reuse after a long outage could hit an unrelated group. Cancel and wait-on of a running job still rely on a live daemon killing its child at the next heartbeat.

## Tests

```sh
flock /tmp/tsc.lock uv run --with pytest pytest -v
```

`tests/test_pilot_acp.py` is the end-to-end pilot (real opencode and a sibling `fleet-acp` checkout, about a minute, skipped when missing; override the checkout with `FLEET_ACP_DIR`).

`tests/test_pilot_claude.py` repeats the pilot on the `claude` agent (isolated config dir under tmp, haiku by default via `FLEET_PILOT_CLAUDE_MODEL`, skipped without Claude credentials). `tests/test_caps.py` checks the vps cap of 6 with 14 jobs and the per-repo cap of 1.

`.agents/docs/spike-ref/` holds the validated Spike B shim and its findings, kept as reference.
