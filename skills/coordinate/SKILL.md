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
                   [--shell] -- <cmd...>
coordinate status [JOB_ID]      # rows: id, state, attempts, max, payload
coordinate stats                # {"queued":N,...}
coordinate events [--follow] [--since ID]
coordinate forward --exec '<cmd>' [--kinds k1,k2] [--interval S] [--once]
coordinate wait-on JOB_ID EVENT / release EVENT
coordinate cancel JOB_ID
coordinate dead retry [JOB_ID]
coordinate daemon               # claim loop; run under tmux/service, one per machine
```

- `enqueue --shell` takes ONE quoted string run through the platform shell (`/bin/sh`, `cmd.exe` on Windows); without it args are exec'd directly.
- Higher `--priority` claims first. `--repo` serializes jobs touching the same repo; an empty `--repo ""` skips the repo key, and the default key is the working directory.
- `forward` calls `--exec '<cmd>'` once per event: event JSON on stdin, `{message}` in the command substituted with a one-line summary. Cursor file under `$XDG_STATE_HOME/coordinate/forward-cursor` makes restarts resume without replaying.
- Daemon claims `cmd` jobs, heartbeats leases and reaps dead owners. Only an expired lease is retried, up to `--max-attempts`, then the job is `dead`. A job that exits non-zero goes to `failed` and stays there until `dead retry` revives it.

## Watching dispatched jobs

Queue jobs outlive your turn. After enqueueing work you must follow up on, arm a wake-up mechanism **before ending the turn** — never leave running jobs unwatched:

- **Same device**: `forward --exec` can page a sink you control (chat webhook, `t3 thread send` to a thread on the same T3 environment, a status file your monitor tails).
- **Remote device**: you cannot push events across environments (`t3 thread send` only reaches threads on its own T3 environment). The reliable pattern is **pull**: arm a scheduled task/interval watchdog that ssh-checks `coordinate stats`/`status` on the remote, acts on terminal transitions (merge the worktree branch, `dead retry`, re-dispatch), and disables itself when the queue is clear.
- Ending a turn with queued/running jobs and no armed watchdog is a process bug — the workstream's completion will go unnoticed.

## ACP agent sessions

The Python CLI (`legacy/python` branch, `src/coordinate/cli.py`) additionally enqueued `--acp AGENT --cwd DIR --prompt TEXT` jobs (daemon-hosted ACP session with resume support). The TS binary is cmd-only; the ACP lane TS port is pending, so agent-session enqueue is currently unavailable.

## Verified platforms

linux-x64 (gnu + musl static), darwin-arm64. darwin-x64 and windows-x64 build in CI; windows-x64 gets a best-effort smoke pass per release. All latency/RSS claims in the docs are SQLite-on-Linux measurements.
