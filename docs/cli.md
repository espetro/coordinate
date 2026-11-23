---
title: Command reference
---

# Command reference

```text
coordinate <verb> [args]
```

| Verb | What it does |
| --- | --- |
| `daemon` | Runs the claim loop on this machine |
| `enqueue [options] -- <command...>` | Adds a job and prints its id |
| `status [id]` | Lists jobs, or shows one |
| `status --self` | Shows the job whose id is in `COORDINATE_JOB_ID` |
| `stats` | Prints the job count per state as JSON |
| `wait-on <id> <event>` | Parks a job until the event is released |
| `release <event>` | Queues every job parked on the event |
| `cancel <id>` | Cancels a job |
| `dead retry [id]` | Puts failed and dead jobs back in the queue |
| `events [--follow] [--since ID]` | Prints the event log, or follows it |
| `forward --exec <command> [--once] [--since ID] [--kinds a,b] [--cursor FILE]` | Runs a command for each event |

## enqueue options

| Option | Meaning |
| --- | --- |
| `--shell` | The command is one quoted string run through the shell |
| `--cwd <dir>` | Working directory for the job |
| `--repo <key>` | Group jobs that must not run together. Defaults to the working directory |
| `--priority <n>` | Higher numbers run first. Default 0 |
| `--max-attempts <n>` | How many times a job may be started. Default 3 |
| `--max-runtime <duration>` | A deadline such as `90s`, `15m` or `2h` |
| `--wait-on <event>` | Park the job immediately until `release <event>` |

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `COORDINATE_DB` | `$XDG_STATE_HOME/coordinate/queue.db` | Database file |
| `COORDINATE_CAP` | 3 (6 when `COORDINATE_MACHINE` is `vps`) | Jobs running at once on this machine |
| `COORDINATE_REPO_CAP` | 1 | Jobs running at once per repo key |
| `COORDINATE_MACHINE` | `laptop` | Name of this machine |
| `COORDINATE_LEASE_S` | 30 | Seconds before a silent job counts as dead |
