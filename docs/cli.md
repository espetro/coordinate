---
title: Command reference
---

# Command reference

```text
coordinate <verb> [args]
```

| Verb | What it does |
| --- | --- |
| `daemon` | Runs the claim loop on this machine. Singleton per DB: a second start is refused with `daemon already running (pid N)` on stderr and exit 1, unless the previous daemon's heartbeat row is stale (crashed without cleanup) |
| `service install [--force]` | Installs a user-level service that runs `coordinate daemon` on login/boot. Linux: systemd user unit at `~/.config/systemd/user/coordinate.service`, enabled with `systemctl --user enable --now`. macOS: launchd plist at `~/Library/LaunchAgents/sh.coordinate.daemon.plist`, loaded with `launchctl bootstrap gui/$UID`. Windows is not supported yet; run `coordinate daemon` manually or from a scheduled task. The unit embeds the absolute path of the running binary plus the resolved `COORDINATE_DB` (if set), `COORDINATE_MACHINE`, `COORDINATE_CAP` and `PATH`, so the service survives PATH changes. Install is idempotent: re-running with an identical unit is a no-op, and an existing but differing unit requires `--force` to overwrite |
| `service uninstall` | Stops and removes the installed service unit |
| `service status` | Reports installed, enabled and running state by asking the system manager (`systemctl --user is-enabled`/`is-active`, or `launchctl print`), never pgrep |
| `doctor` | Prints a health report (version, DB, config, daemon liveness via the heartbeat row, queue stats); exits non-zero on failed checks |
| `enqueue [options] -- <command...>` | Adds a job and prints its id |
| `enqueue --acp <agent> --cwd <dir> --prompt <text>` | Adds an ACP agent-session job; the daemon spawns the agent and drives one turn |
| `status [id]` | Shows one job as pretty-printed JSON with the payload decoded. Without an id it still prints the historical tab-separated rows |
| `status --self` | Shows the job whose id is in `COORDINATE_JOB_ID` |
| `jobs [--status a,b] [--kind a,b] [--search TEXT] [--sort id\|created\|priority\|status\|runtime] [--asc\|--desc] [--limit N]` | Lists jobs as the canonical v1 machine records, one JSON object per line. This is the surface agents and scripts should read |
| `stats` | Prints the job count per state as JSON |
| `wait-on <id> <event>` | Parks a job until the event is released |
| `release <event>` | Queues every job parked on the event |
| `cancel <id>` | Cancels a job |
| `dead retry [id]` | Puts failed and dead jobs back in the queue |
| `cap show` | Prints the effective machine cap, repo cap, running-job count and machine name as JSON. The machine name is the one the daemon recorded in the queue DB on claim, so it is the daemon's identity even when this CLI process has no `COORDINATE_MACHINE` in its env (the common case over ssh) |
| `cap set --machine-cap N --repo-cap N [--force]` | Writes the runtime cap into the queue DB; the daemon re-reads it each claim, so raising the cap starts queued jobs with no daemon restart, and lowering it never interrupts running jobs (claims pause until the count drains). `--force` accepts a decrease below the current running count |
| `events [--follow] [--since ID] [--job ID] [--kind a,b] [--search TEXT]` | Prints the event log, or follows it. The filters are applied server-side |
| `logs <id> [--attempt N] [--json] [--follow]` | Prints the captured output of the job's attempts. Without `--attempt` it prints the newest attempt's stdout and stderr files with a header; `--attempt N` reads that attempt, `--json` emits one machine record per attempt (paths and byte counts, no output), `--follow` tails new output |
| `why <id> [--json]` | Explains the job's live state from the current rows: the state, the blockers (waiting event, saturated caps, spent budget), the next step and the log pointers. `--json` emits the machine record |
| `health [--json]` | Emits one fixed summary object: daemon liveness, caps, per-state job counts, oldest queued age and slot usage. `--json` is the machine form (one JSON object); without it the same data prints as short lines |
| `forward --exec <command> [--once] [--since ID] [--kinds a,b] [--cursor FILE]` | Runs a command for each event |

## Watching dispatched jobs

A job outlives the turn that enqueued it, so pair every dispatch with a wake-up: `forward --exec` reaches sinks on the same machine (a failed `--exec` stalls the cursor at that event — verify the sink works once), and for remote machines pull `stats`/`status` over ssh from a local watchdog rather than pushing (event sinks are not routable across environments). See `skills/coordinate/SKILL.md` for the full pattern.

## Job output capture

The daemon captures every cmd attempt's stdout and stderr into files under the coordinate state directory, next to the queue DB: `logs/<job>-<attempt>.stdout.log` and `logs/<job>-<attempt>.stderr.log`. The durable `job_logs` table links job, attempt and the paths. ACP jobs keep stdout for the protocol stream; only their stderr is captured.

```sh
coordinate logs 7                  # the newest attempt's output
coordinate logs 7 --attempt 2      # a specific attempt
coordinate logs 7 --json | jq -c '[.attempt,.stdout_bytes,.stderr_bytes]'
coordinate why 7                   # state, blockers, next step, log pointers
```

Capture is best effort: when the state directory is not writable the job still runs and its output stays with the daemon's own streams, as before. Full-text log search is `rg` over these files; `--search` on jobs and events stays metadata search.

## Machine output

`coordinate jobs` prints one v1 record per line, so `jq` and `while read` consume it directly. The payload is decoded once (an object, not a string with JSON inside) and timestamps stay epoch seconds. The full field list and the query semantics are in [Machine output schema](machine-schema.md).

```sh
coordinate jobs --status queued,running --sort priority --limit 20 | jq -c '[.id,.status,.payload.cmd]'
```

## enqueue options

| Option | Meaning |
| --- | --- |
| `--shell` | The command is one quoted string run through the shell |
| `--cwd <dir>` | Working directory for the job |
| `--repo <key>` | Group jobs that must not run together. Defaults to the working directory; an empty `--repo ""` skips the repo key |
| `--priority <n>` | Higher numbers run first. Default 0 |
| `--max-attempts <n>` | How many times a job may be started. Default 3 |
| `--max-runtime <duration>` | A deadline such as `90s`, `15m` or `2h` |
| `--run-at <when>` | Earliest start: a delay such as `30s`, `15m`, `2h`, or an absolute ISO timestamp such as `2026-11-23T18:00:00Z`. The job stays `queued` until then |
| `--wait-on <event>` | Park the job immediately until `release <event>`. Finishing a job releases only its `tool:` slot waiters, so a `--wait-on` job needs an explicit release |
| `--acp <agent>` | Enqueue an ACP job for this agent instead of a command (needs `--cwd` and `--prompt`) |
| `--prompt <text>` | Prompt text for `--acp` jobs |
| `--registry <file>` | ACP agent registry JSON, `{"<name>": {"command": ..., "args": [...]}}`. Default: `bench/agents.stub.json` relative to the daemon's cwd |

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `COORDINATE_DB` | `$XDG_STATE_HOME/coordinate/queue.db` | Database file |
| `COORDINATE_CAP` | 3 (6 when `COORDINATE_MACHINE` is `vps`) | Jobs running at once on this machine |
| `COORDINATE_REPO_CAP` | 1 | Jobs running at once per repo key |
| `COORDINATE_MACHINE` | `laptop` | Name of this machine |
| `COORDINATE_LEASE_S` | 30 | Seconds before a silent job counts as dead |
| `COORDINATE_ACP_CMD` | (unset) | Overrides the registry: the full agent command line (space separated) spawned for every `--acp` job |

## ACP agent sessions

`enqueue --acp` stores the agent, cwd, prompt and registry in an `acp` job. The daemon resolves the agent in the registry, spawns it detached with stdin/stdout pipes, and speaks Agent Client Protocol JSON-RPC 2.0 (ndjson): `initialize`, then `session/new` on the first attempt, `session/load` on every later one, then one `session/prompt` turn. The `sessionId` is persisted into the job payload the moment it exists, so a daemon that dies mid-turn and restarts resumes the SAME session instead of starting fresh. The job finishes `done` when the turn ends with `stopReason: end_turn`, `failed` otherwise. Timecap expiry sends `session/cancel` before the kill. Real-agent runs are exercised by the gated test (`COORDINATE_ACP_REAL=1`, `COORDINATE_ACP_REAL_AGENT='{"command":...,"args":[...]}'`); the default suite uses the stub agent in `test/fixtures/stub_acp_agent.mjs`.
