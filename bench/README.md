# Bench harness

TypeScript port of the legacy Python harness (`legacy/python:bench/bench.py`, 1369 lines) that drives a `coordinate` binary and emits JSON in the shape of `benchmarks/results/*.json`. It exists because the Python stack was retired and there was no regression gate on performance until this port.

## Usage

```sh
node bench/bench.ts --bin /path/to/coordinate --out results.json [--only cli,idle,throughput] [--root /tmp/coordbench] [--keep]
```

`--bin` is any binary path (a release build, a locally built one, a different version). Each scenario runs in its own state directory under `--root`, with its own SQLite store, its own config and its own daemon, so runs never share state. `--keep` leaves the state directories behind for inspection; without it they are removed after the scenario.

The A/B runner interleaves baseline and candidate round by round, so a noisy host hits both equally:

```sh
sh bench/run-ab.sh /tmp/coord-baseline /tmp/coord-candidate /tmp/ab 3
```

It writes `/tmp/ab-baseline-r1.json` … `/tmp/ab-candidate-single.json`. The merger folds those into one results file with per-round values next to the medians:

```sh
node bench/merge-ab.mjs --baseline ab-baseline --candidate ab-candidate --out benchmarks/results/results-effect-v0.1.3-macos-arm64.json
```

## Scenarios

The quick set from `.agents/docs/bench-ci.md`: `cli`, `idle`, `throughput`, `cap`, `repo`, `priority`, `chaos`, `toolpark`, `orchestrator-kill`, `state-loss`.

Metric names match the Python harness exactly, so results stay comparable with `benchmarks/legacy-python/baseline-linux.json`. Two additions: `enqueue_to_claim_p50_ms`, `enqueue_to_claim_p95_ms` and `enqueue_to_claim_max_ms` (the daemon-side latency, read from the durable store as `claim_at - created_at`).

`orchestrator-kill` and `state-loss` need the ACP agent-session lane. The harness probes for it (`enqueue --acp` must produce `kind=acp`) and records `<scenario>_skipped` on a binary without it, rather than reporting a number that means nothing.

Not ported: `noise-floor` (a repeat-N wrapper, regenerable from the round files), `live-density` (needs the ballast-capable stub agent), and the long set (`park-density`, `park-density-cli`, `wake-latency`, `timecap`), which needs the bulk filler that writes the store directly.

## Differences from the Python harness

- Drives an arbitrary binary path instead of a venv tree, and isolates the state per scenario.
- The Python daemon drove the agent through `bench/acp_client.py`; the TypeScript daemon speaks ACP to the agent itself (`src/acp.ts`), so the registry points straight at `fixtures/stub_acp_agent.mjs`.
- `/proc` reads replaced by `ps` (macOS). The pid is verified through `ps -o command=` before any signal, and only pids the harness started are ever signalled.
- The span markers use the same `perl` timestamp source as the Python harness.

## Measured results

- `benchmarks/results/results-effect-v0.1.3-macos-arm64.json`: v0.1.2 vs v0.1.3, same host, interleaved.
- `benchmarks/results/results-effect-isolated-v0.1.3-macos-arm64.json`: pre-Effect `a803b7c` vs Effect `v0.1.3`, which is the pair where the only difference is the Effect commit.
