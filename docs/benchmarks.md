---
title: Benchmarks
---

# Benchmarks

All numbers come from result files in the [`benchmarks/`](https://github.com/espetro/coordinate/tree/main/benchmarks) folder, measured on a 6-core, 11 GB Linux VPS. Each file records the load and free memory of the host.

## coordinate

| Measure | Result |
| --- | --- |
| Enqueue from the command line, median | 4.9 ms |
| Throughput, 60 trivial jobs at cap 6 | 69 jobs per second |
| Daemon memory at idle | 5.9 MB |
| Command start-up | 7 ms |
| Binary size | 3.9 MB (gnu), 4.9 MB (musl) |
| 10,000 parked jobs | about 3 MB of disk, no process |

## Other tools on the same host

| Measure | coordinate | Rivet | Restate |
| --- | --- | --- | --- |
| Idle memory | 5.9 MB | 128 MB | 532 MB |
| 10,000 parked jobs | 3 MB on disk | 1,489 MB of memory | not run (851 MB at 1,000) |

Rivet and Restate are general frameworks for stateful services, so this compares footprint and not features.
