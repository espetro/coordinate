# Benchmarks

Measured results for coordinate. Each file in `results/` is the raw output of one run and records the host state (load, free memory, timestamp) next to the numbers.

Hosts: the VPS is a 6-core, 11 GB Linux x86_64 machine, and the laptop is macOS on arm64. Files marked Python came from the earlier Python version, which is on the `legacy/python` branch. The SQLite schema is the same in both versions, so storage numbers carry over.

## Results

| File | What it measures | Version | Host |
| --- | --- | --- | --- |
| `ts-0.4.16-linux-vps` | Enqueue latency, throughput, daemon memory, startup, binary size | TypeScript, scriptc 0.4.16 | VPS |
| `ts-linux-vps` | The same run on scriptc 0.4.12 | TypeScript | VPS |
| `py-samehost` | The same run on the Python version, as the comparison baseline | Python | VPS |
| `park-sqlite-vps`, `park-sqlite-10k-vps` | Daemon memory and disk with 1,000 and 10,000 parked jobs | Python | VPS |
| `wake-sqlite-0`, `wake-sqlite-vps`, `wake-sqlite-10k-vps` | Time from a release event to the job running again, with 0, 1,000 and 10,000 parked jobs | Python | VPS |
| `bytes-sqlite-vps`, `bytes-sqlite-vps-full` | Where the bytes of a parked job go (table pages, write-ahead log) | Python | VPS |
| `timecap-vps` | Time cap precision, including a daemon `kill -9` | Python | VPS |
| `noise-sqlite-vps-idle` | Run-to-run variation on an idle host, 10 repeats | Python | VPS |

Files are named `results-<name>.json`. `legacy-python/` holds the older Python baseline suites and the regression-gate settings (`baseline-linux.json`, `noise-linux.json`, `thresholds.toml`). Third-party measurements (Rivet, Restate, DBOS, terminal multiplexers) are in `.agents/docs/data/`.

## Reproducing

The harness that produced these files was written in Python and is on `legacy/python` (`bench/bench.py`). It drives any build through its command line with `--cli <path to binary>`, which is how the TypeScript numbers were produced. Porting it is open work, and until then there is no automated performance gate in CI. The method is in `.agents/docs/ts-port-spike.md` and `.agents/docs/park-wake.md`.
