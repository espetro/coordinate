---
title: Getting started
---

# Getting started

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/espetro/coordinate/main/install.sh | sh
```

The binary lands in `~/.local/bin/coordinate`. With mise you can use `mise use -g github:espetro/coordinate` instead.

## Run your first job

Start the daemon on the machine that should run the work. There is one daemon per machine.

```sh
coordinate daemon &
```

Enqueue a command. The command prints the job id.

```sh
coordinate enqueue --shell -- 'pnpm test && pnpm build'
```

Watch it run.

```sh
coordinate status        # every job (historical TSV)
coordinate status 1      # one job as JSON, payload decoded
coordinate jobs          # canonical v1 machine records, one JSON object per line
coordinate stats         # counts per state
coordinate events --follow
```

## Where things live

Each machine keeps its own database at `$XDG_STATE_HOME/coordinate/queue.db`, which is `~/.local/state/coordinate/queue.db` by default. Set `COORDINATE_DB` to use another file. Never share one database file between machines.
