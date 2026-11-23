---
name: coordinate
description: "Durable per-device job/session queue (SQLite + single binary). Use when enqueueing background or batch work that must survive restarts, bounding concurrency per machine/repo, parking jobs until an event, or tracking headless jobs with an event feed. Interactive work stays with your own threads; coordinate is for the queue."
---

# coordinate

Durable local job queue: a job is one SQLite row plus a process the daemon spawns. Single static binary (scriptc build of `ts/`), no service dependencies, per-device database.

## When to use it

- Batch or overflow work beyond a session's parallelism: enqueue everything, let caps drain it.
- Jobs that must survive a reboot or an agent crash: queue state is SQLite (WAL), leases are reaped, attempts retry.
- Concurrency caps: `--slot` names a scarce resource (machine, repo, tool class); the daemon claims at most the configured count per slot.
- Ordering/dependencies: `--wait-on <event>` parks a job until `release <event>` frees it.
- Visibility without babysitting: `coordinate events --follow` streams transitions; `coordinate forward --exec '<cmd>'` pipes them into any external tool.

## Install

```
curl -fsSL https://raw.githubusercontent.com/espetro/coordinate/main/install.sh | sh
mise use -g github:espetro/coordinate        # alternative
```

Binary lands in `~/.local/bin/coordinate`. Per-device DB defaults to `$XDG_STATE_HOME/coordinate/queue.db`; override with `COORDINATE_DB`. Never share one DB file across machines — each device runs its own queue.

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
- Lower `--priority` claims first. `--repo` serializes jobs touching the same repo.
- `forward` calls `--exec '<cmd>'` once per event: event JSON on stdin, `{message}` in the command substituted with a one-line summary. Cursor file under `$XDG_STATE_HOME/coordinate/forward-cursor` makes restarts resume without replaying.
- Daemon claims `cmd` jobs, heartbeats leases, reaps dead owners, retries to `--max-attempts`, then `dead`.

## ACP agent sessions

`uv run coordinate` (the Python CLI, `src/coordinate/cli.py`) additionally enqueues `--acp AGENT --cwd DIR --prompt TEXT` jobs: the daemon hosts an ACP session for that agent with resume support. The compiled binary is cmd-only; use the Python CLI for agent sessions until the ACP lane lands in TS.

## Plugins

`~/.config/coordinate/plugins/` (XDG config) holds out-of-process plugin dirs; `coordinate plugins` lists/runs them (Python CLI). Plugins are for policy, notifications and integrations — see `.agents/docs/extensibility.md` before writing one.

## Verified platforms

linux-x64 (gnu + musl static), darwin-arm64. darwin-x64 and windows-x64 build in CI; windows-x64 gets a best-effort smoke pass per release. All latency/RSS claims in the docs are SQLite-on-Linux measurements.
