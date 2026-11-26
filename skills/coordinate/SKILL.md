---
name: coordinate
description: "Durable per-device job/session queue (SQLite + single binary). Use when enqueueing background or batch work that must survive restarts, bounding concurrency per machine/repo, parking jobs until an event, or tracking headless jobs with an event feed. Interactive work stays with your own threads; coordinate is for the queue."
---

# coordinate

Durable local job queue: a job is one SQLite row plus a process the daemon spawns. Single static binary, no service dependencies, per-device database.

## When to use it

- Batch or overflow work beyond a session's parallelism: enqueue everything, let caps drain it.
- Jobs that must survive a reboot or an agent crash: queue state is SQLite (WAL), leases are reaped, attempts retry.
- Concurrency caps: `--slot` names a scarce resource (machine, repo, tool class); the daemon claims at most the configured count per slot.
- Ordering: `--wait-on <event>` parks a job until `release <event>` frees it. Finishing a job releases only its `tool:` slot waiters, so a `--wait-on` job always needs an explicit `release`; it is never woken because another job finished.
- Visibility without babysitting: `coordinate events --follow` streams transitions; `coordinate forward --exec '<cmd>'` pipes them into any external tool.

## Install

```
curl -fsSL https://raw.githubusercontent.com/espetro/coordinate/main/install.sh | sh
mise use -g github:espetro/coordinate        # alternative
```

Binary lands in `~/.local/bin/coordinate`. Per-device DB defaults to `$XDG_STATE_HOME/coordinate/queue.db`; override with `COORDINATE_DB`. Never share one DB file across machines. Each device runs its own queue.

## Core verbs

```
coordinate enqueue [--cwd DIR] [--repo KEY] [--priority N] [--slot NAME]
                   [--wait-on EVENT] [--max-attempts N] [--max-runtime 90s]
                   [--run-at 15m] [--shell] -- <cmd...>
coordinate status [JOB_ID]      # one job as JSON, payload decoded
coordinate logs JOB_ID [--attempt N] [--json] [--follow]
                               # the captured stdout/stderr of the job's attempts
coordinate why JOB_ID [--json] # live state, blockers, next step, log pointers
coordinate health [--json]     # one fixed summary object (daemon, caps, counts)
coordinate jobs                # human table by default; --json for the machine records
                               # --watch repaints the table every second
                               # flags: --status a,b --kind a,b --search TEXT
                               #        --sort id|created|priority|status|runtime --asc|--desc --limit N
coordinate stats                # {"queued":N,...}
coordinate events [--follow] [--since ID] [--job ID] [--kind a,b] [--search TEXT]
coordinate forward --exec '<cmd>' [--kinds k1,k2] [--interval S] [--once]
coordinate wait-on JOB_ID EVENT / release EVENT
coordinate cancel JOB_ID
coordinate dead retry [JOB_ID]
coordinate cap show                # {"machine_cap":N,"repo_cap":N,"running":N}
coordinate cap set --machine-cap N [--repo-cap N] [--force]
coordinate daemon               # claim loop; run under tmux/service, one per machine
coordinate lease acquire KEY [--cost N] [--wait 60s] [--owner ID]  # grant JSON on stdout
coordinate lease release GRANT_ID / lease refresh GRANT_ID / lease cancel WAIT_ID
coordinate lease list / lease waits   # live state as NDJSON
```

- `enqueue --shell` takes ONE quoted string run through the platform shell (`/bin/sh`, `cmd.exe` on Windows); without it args are exec'd directly.
- Higher `--priority` claims first, then the older job. Without aging a high-priority backlog can starve low priorities; `config.toml` `[scheduler] aging = "linear"` (off by default) boosts waiting jobs up to `aging_ceiling`. `--run-at 15m` or `--run-at 2026-11-23T18:00:00Z` holds a job until that time (it does not raise its priority). `--repo` serializes jobs touching the same repo; an empty `--repo ""` skips the repo key, and the default key is the working directory.
- `forward` calls `--exec '<cmd>'` once per event: event JSON on stdin, `{message}` in the command substituted with a one-line summary. Cursor file under `$XDG_STATE_HOME/coordinate/forward-cursor` makes restarts resume without replaying.
- `coordinate jobs --json` is the machine surface: one v1 JSON record per line, with the payload decoded once and epoch-second timestamps, so `jq` and `while read` consume it directly. The default output is a human table, which is not the machine contract. `docs/machine-schema.md` is the published contract.
- Every cmd attempt's stdout and stderr are captured into files under the state directory (`logs/<job>-<attempt>.*.log`); the durable `job_logs` table links job, attempt and paths. `coordinate logs JOB_ID` reads them, `--json` gives paths and byte counts without the output. Events carry the paths, never the output.
- `coordinate why JOB_ID` explains a job from the live rows: what holds it (waiting event, saturated cap, spent budget), the next step and the log pointers. `coordinate health --json` gives scripts and panels one fixed summary object.
- `coordinate tui` is the human triage screen (arrows move, `/` filters, `s` sort, `f` state, enter details, `x` cancel, `R` retry, `e` release, `q` quit). It needs a terminal and refuses a pipe. Agents should not scrape it: the machine surfaces above are the contract.
- Daemon claims `cmd` jobs, heartbeats leases and reaps dead owners. Only an expired lease is retried, up to `--max-attempts`, then the job is `dead`. A job that exits non-zero goes to `failed` and stays there until `dead retry` revives it.
- The concurrency caps are runtime-adjustable: `coordinate cap set --machine-cap N` writes the value into the queue DB and the daemon re-reads it on every claim, so raising the cap starts queued jobs with no daemon restart, and lowering it never interrupts running jobs (claims pause until the count drains). `--force` accepts a decrease below the current running count.

## Watching dispatched jobs

Queue jobs outlive your turn. After enqueueing work you must follow up on, arm a wake-up mechanism **before ending the turn** — never leave running jobs unwatched:

- **Same device**: `forward --exec` can page a sink you control (chat webhook, `t3 thread send` to a thread on the same T3 environment, a status file your monitor tails).
- **Remote device**: you cannot push events across environments (`t3 thread send` only reaches threads on its own T3 environment). The reliable pattern is **pull**: arm a scheduled task/interval watchdog that ssh-checks `coordinate stats`/`status` on the remote, acts on terminal transitions (merge the worktree branch, `dead retry`, re-dispatch), and disables itself when the queue is clear.
- Ending a turn with queued/running jobs and no armed watchdog is a process bug — the workstream's completion will go unnoticed.

## Tool leases

`coordinate lease acquire` meters any scarce resource, job or no job: heavy tool runs (vitest, tsc, cargo), deploys, devices. The key is a weighted semaphore sized by `[slots]` in config.toml; saturated keys queue waiters in a durable FIFO so every run is eventually granted. Use it for any heavy command you run yourself, enqueued or not:

```
grant=$(coordinate lease acquire tool:tsc:$(git rev-parse --git-common-dir 2>/dev/null || pwd) --cost 2 --wait 120s | jq -r .grant_id) || exit $?
# ... run the heavy command ...
coordinate lease release "$grant"
```

Exit 3 means the wait timed out, exit 4 cancelled or ungrantable. Stay alive while the tool runs: the default owner is your parent process, and dead owners are reaped (leases released, waits cancelled). The TTL (`COORDINATE_LEASE_S`, 30s) is the backstop; long runs heartbeat with `lease refresh`.

## ACP agent sessions

`enqueue --acp <agent> --cwd <dir> --prompt <text>` enqueues an ACP agent-session job: the daemon spawns the agent, speaks Agent Client Protocol over its stdio, and drives one turn. The `sessionId` is persisted into the job payload as soon as it exists, so a daemon that dies mid-turn and restarts resumes the SAME session via `session/load` instead of starting over. The agent comes from the registry (`--registry FILE`, JSON `{"<name>": {"command": ..., "args": [...]}}`; default `bench/agents.stub.json` relative to the daemon's cwd), or from `COORDINATE_ACP_CMD` which overrides the registry with one full command line for every `--acp` job.

## Verified platforms

linux-x64 (gnu + musl static), darwin-arm64. darwin-x64 and windows-x64 build in CI; windows-x64 gets a best-effort smoke pass per release. All latency/RSS claims in the docs are SQLite-on-Linux measurements.
