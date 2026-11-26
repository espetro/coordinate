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
| `jobs [--status a,b] [--kind a,b] [--search TEXT] [--sort id\|created\|priority\|status\|runtime] [--asc\|--desc] [--limit N] [--json] [--watch]` | Lists jobs as a human table by default. With `--json` it prints the canonical v1 machine records, one JSON object per line; that is the surface agents and scripts should read |
| `stats` | Prints the job count per state as JSON |
| `wait-on <id> <event>` | Parks a job until the event is released |
| `release <event>` | Queues every job parked on the event |
| `cancel <id>` | Cancels a job |
| `dead retry <id>` / `dead retry --all` | Puts one failed or dead job back in the queue. `--all` requeues every one of them, including cancelled jobs, so it must be asked for explicitly |
| `cap show` | Prints the effective machine cap, repo cap, running-job count and machine name as JSON. The machine name is the one the daemon recorded in the queue DB on claim, so it is the daemon's identity even when this CLI process has no `COORDINATE_MACHINE` in its env (the common case over ssh) |
| `cap set --machine-cap N --repo-cap N [--force]` | Writes the runtime cap into the queue DB; the daemon re-reads it each claim, so raising the cap starts queued jobs with no daemon restart, and lowering it never interrupts running jobs (claims pause until the count drains). `--force` accepts a decrease below the current running count |
| `events [--follow] [--since ID] [--job ID] [--kind a,b] [--search TEXT]` | Prints the event log, or follows it. The filters are applied server-side |
| `logs <id> [--attempt N] [--json] [--follow]` | Prints the captured output of the job's attempts. Without `--attempt` it prints the newest attempt's stdout and stderr files with a header; `--attempt N` reads that attempt, `--json` emits one machine record per attempt (paths and byte counts, no output), `--follow` tails new output |
| `why <id> [--json]` | Explains the job's live state from the current rows: the state, the blockers (waiting event, saturated caps, spent budget), the next step and the log pointers. `--json` emits the machine record |
| `health [--json]` | Emits one fixed summary object: daemon liveness, caps, per-state job counts, oldest queued age and slot usage. `--json` is the machine form (one JSON object); without it the same data prints as short lines |
| `lease acquire <key> [--cost N] [--wait DUR] [--owner ID]` | Acquires units of a weighted semaphore key, waiting in a durable FIFO queue when the key is saturated. Prints the grant as JSON on stdout. Exit 3 on wait timeout, 4 when cancelled or ungrantable. No daemon needed |
| `lease release <grant-id>` | Releases a grant early; the next FIFO waiter is drained immediately |
| `lease refresh <grant-id>` | Extends a grant's TTL (holders heartbeat through this; unrefreshed leases expire after `COORDINATE_LEASE_S`) |
| `lease cancel <wait-id>` | Cancels a queued wait |
| `lease list` / `lease waits` | Prints live leases or queued waits as NDJSON |
| `run [--wait DUR] [--key KEY] [--cost N] -- <cmd...>` | Runs a command wrapped in a tool lease: classifies the binary against the same table the daemon uses, waits in the FIFO when the key is saturated, babysits the grant for the whole run and releases it at exit. Commands that match no heavy class pass through with no lease round-trip |
| `forward --exec <command> [--once] [--since ID] [--kinds a,b] [--cursor FILE]` | Runs a command for each event |
| `tui` | Runs the interactive triage screen. One screen, keyboard only, over the same read model as `jobs`; needs a terminal on stdout and fails with a clear message when there is none |

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

`coordinate jobs --json` prints one v1 record per line, so `jq` and `while read` consume it directly. The payload is decoded once (an object, not a string with JSON inside) and timestamps stay epoch seconds. The full field list and the query semantics are in [Machine output schema](machine-schema.md). Without `--json` the same query renders as a human table (id, state, age, attempts, priority, waiting-on, truncated command); the table is presentation only and not the machine contract.

```sh
coordinate jobs --json --status queued,running --sort priority --limit 20 | jq -c '[.id,.status,.payload.cmd]'
coordinate jobs --watch       # repaint the human table every second; Ctrl-C exits
```

## The triage screen

`coordinate tui` is a small interactive triage UI over the shared read model. It renders the same table as `coordinate jobs`, reads the same `jobs --json` records for the details and mutates through the same queue operations as the CLI verbs, so the emitted events are identical to the CLI's. It fails with `tui: stdout is not a terminal; use coordinate jobs (or jobs --json) instead` when stdout is not a TTY, so escape sequences never reach a pipe.

| Key | Action |
| --- | --- |
| arrows or Ctrl-N / Ctrl-P | Move the selection |
| `/` | Filter jobs by metadata substring (the same search as `jobs --search`) |
| `s` | Cycle the sort (id, created, priority, status, runtime) |
| `f` | Cycle the state filter (all, queued, running, waiting, failed, dead, done, timed_out) |
| enter | Toggle the details pane: decoded metadata, the computed `why`, recent events and the end of the newest stdout |
| `r` | Refresh |
| `x` | Cancel the selected job, after a y/n confirmation |
| `R` | Retry (requeue) the selected failed or dead job, after a y/n confirmation |
| `e` | Prompt for an event name and release it (the same as `coordinate release EVENT`) |
| `q` or Ctrl-C | Quit |

The screen repaints about once a second. Scripting stays on `jobs --json` and `events`; the TUI is not the scripting surface.

## TUI hooks

Hooks are external commands only, configured under `[tui]` in `config.toml`. Any key not otherwise bound becomes a hook key: pressing it runs the named command with the selected job's v1 JSON on stdin. Inside the command string, `{id}`, `{cwd}`, `{repo}` and `{status}` are substituted with the shell-quoted job fields, so a value containing spaces or quotes cannot change the command's word structure.

```toml
[tui]
w = "codex open {id} --cwd {cwd}"
```

The hook inherits the terminal, its stderr lands in the TUI's status line (first 400 characters, with the exit code), and each invocation gets a 30s timeout. There is no plugin loader and no in-process API: foreign code always runs in its own process, the same boundary `forward --exec` uses.

## Tool and resource leases

`lease` is the generalized concurrency primitive behind `--slot` (design: `.agents/docs/surfaces-design.md`). Keys are weighted semaphores: `[slots]` in `config.toml` sets the unit limit per key (`"tool:vitest:*" = 4` covers every project), a grant costs `--cost` units, and at most the limit is ever granted at once. Jobs and ordinary processes share one accounting space, so an interactive session can meter heavy tool runs against the same keys the queue uses.

```
coordinate lease acquire tool:vitest:myproject --cost 2 --wait 60s
```

The acquirer polls the database itself, so grants work with no daemon running; a running daemon additionally drains waiters in the background. When capacity is saturated the wait is durable and FIFO: every waiter is eventually granted, in order, unless it times out (`--wait`), is cancelled (`lease cancel`) or its owner dies. The owner defaults to the parent process of the CLI call — keep the calling shim or shell alive for the duration of the tool run, or pass `--owner` explicitly. Dead owners are reaped: their leases are released and their waits cancelled, so a killed tool run can never wedge capacity. The final backstop is the lease TTL.

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
