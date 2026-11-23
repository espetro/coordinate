# coordinate

Local-first orchestration for AI coding-agent sessions: a per-device daemon (`coordinated`) with a durable SQLite queue, soft concurrency caps, parked sessions woken by events, per-job time caps, and ACP or tmux dispatch. Built to run next to a control panel such as T3 Code. Design and status: [ARCHITECTURE.md](ARCHITECTURE.md). Research, spikes and decisions: `.agents/docs/`.

Pre-release prototype. Pure stdlib Python, one SQLite file.

## Install

```sh
uv tool install coordinate            # from a git URL: uv tool install git+https://github.com/<org>/coordinate
coordinate service install            # systemd user unit on Linux, launchd agent on macOS; prints the file it wrote
```

`uv build` produces `dist/coordinate-*.whl` and the sdist; `uv tool install --from dist/coordinate-*.whl coordinate` installs from a local wheel. Releases attach both to a GitHub Release on `v*` tags.

## Paths and migration

State lives in the XDG locations on Linux and macOS alike: config in `$XDG_CONFIG_HOME/coordinate/config.toml` (default `~/.config`), the queue and logs in `$XDG_STATE_HOME/coordinate/` (default `~/.local/state`), runtime files in `$XDG_RUNTIME_DIR/coordinate/` with fallback `$XDG_STATE_HOME/coordinate/run/`. `COORDINATE_DB` and `COORDINATE_CONFIG` override; every `COORDINATE_*` env var falls back to its old `FLEET_*` spelling. If legacy `~/.fleet/queue.db` or `~/.fleet/config.toml` exists and the new files do not, they are used with a one-line notice; `coordinate migrate` copies (never moves or deletes) them into the XDG locations.

## Usage

```sh
uv run coordinate enqueue --cwd ~/code/repo -- make test   # job runs payload.cmd in payload.cwd, exit 0 = done
uv run coordinate enqueue --shell -- 'sh -c "echo a  b" | wc -c'   # ONE string, stored and run verbatim via sh -c
uv run coordinate enqueue --acp opencode --cwd ~/code/repo --prompt "fix the bug"   # kind acp, see below
uv run coordinated                                      # dispatcher (same as `coordinate daemon`): claim loop, heartbeat, reaper
uv run coordinate status [id]
uv run coordinate wait-on <id> <event>                      # park a job, frees its slot
uv run coordinate release <event>                           # requeue jobs parked on the event
uv run coordinate cancel <id>                               # recorded as failed; a running job is killed at next heartbeat
uv run coordinate stats
uv run coordinate dead retry [id]                           # requeue dead and failed jobs, attempts reset
```

## Semantics

- `--shell` takes exactly one command string (stored verbatim, run by `/bin/sh -c`). Multiple tokens are refused instead of being flattened, which used to lose inner quoting.
- Claim is one `BEGIN IMMEDIATE` transaction: machine cap plus per-repo cap (repo = `payload.repo` or `payload.cwd`), FIFO by priority desc, run_at, id. A blocked job stays `queued`.
- Lease 30s, heartbeat every lease/3. The reaper requeues expired leases if `attempts < max_attempts`, else `dead`.
- Nonzero exit is `failed` (terminal, no retry). Only lost leases consume retry attempts.
- Config env: `COORDINATE_MACHINE` (laptop:3, vps:6 default caps), `COORDINATE_CAP`, `COORDINATE_REPO_CAP` (default 1), `COORDINATE_LEASE_S` (each with the old `FLEET_*` spelling as fallback).
- Idle polling backs off from 50ms to 2s and resets on activity.

## ACP jobs

`enqueue --acp <agent> --cwd <dir> --prompt <text>` creates a job of kind `acp` (payload `agent`, `cwd`, `prompt`, optional `registry`). The daemon runs `fleet-acp run <agent> --cwd --prompt --pid-file ...`; the command is `fleet-acp` or whatever `COORDINATE_ACP_CMD` says (`FLEET_ACP_CMD` still works). The `fleet-acp` executable name is unchanged; it is a separate project. (for example `node /path/to/fleet-acp/bin/fleet-acp.js`).

- The sessionId on stdout line 1 is written to `payload.session` as soon as it appears. A retry after a lost lease runs with `--session <id>` automatically, and must use the same `cwd`.
- Exit 0 is `done`, nonzero is `failed` (terminal), same as `cmd` jobs.

## Orphans

The daemon records each child process group (`jobs.pgid`) and, for acp jobs, the detached agent pid file (`jobs.pidfile`, under `pids/` next to the DB). The reaper SIGKILLs both groups before it requeues an expired lease, so after a daemon `kill -9` the retry never runs beside the old attempt. A new daemon's reaper does this on its first lease expiry.

Limits: a crash between claim and the pgid write leaves that one child untracked. Recorded pids are trusted, so pid reuse after a long outage could hit an unrelated group. Cancel and wait-on of a running job still rely on a live daemon killing its child at the next heartbeat.

## Tests

```sh
flock /tmp/tsc.lock uv run --with pytest pytest -v
```

`tests/test_pilot_acp.py` is the end-to-end pilot (real opencode and a sibling `fleet-acp` checkout, about a minute, skipped when missing; override the checkout with `COORDINATE_ACP_DIR` (`FLEET_ACP_DIR` still works)).

`tests/test_pilot_claude.py` repeats the pilot on the `claude` agent (isolated config dir under tmp, haiku by default via `COORDINATE_PILOT_CLAUDE_MODEL` (`FLEET_PILOT_CLAUDE_MODEL` still works), skipped without Claude credentials). `tests/test_caps.py` checks the vps cap of 6 with 14 jobs and the per-repo cap of 1.

`.agents/docs/spike-ref/` holds the validated Spike B shim and its findings, kept as reference.
