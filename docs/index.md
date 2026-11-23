---
title: coordinate
description: A durable job queue for your machines and your coding agents.
---

# coordinate

coordinate is a durable job queue for your machines and your coding agents. Each device runs one small daemon that claims jobs from a SQLite file, so a crash or a reboot loses nothing and the work simply runs again.

```sh
coordinate daemon &
coordinate enqueue --shell -- 'pnpm test && pnpm build'
coordinate status
```

- Enqueue takes about 5 ms, and the daemon idles at 5.9 MB.
- 10,000 parked jobs take about 3 MB of disk and no process.
- It ships as one 4 MB binary with nothing to install beside it.

Start with [Getting started](getting-started.md). The numbers are on the [Benchmarks](benchmarks.md) page.
