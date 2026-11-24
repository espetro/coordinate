#!/bin/sh
# A/B bench runner: baseline vs candidate, interleaved so host noise hits both.
# Usage: sh bench/run-ab.sh <baseline-bin> <candidate-bin> <out-prefix> [repeats-idle-throughput]
set -eu
BASE="$1"
CAND="$2"
OUT="$3"
REPEATS="${4:-3}"
ROOT="/tmp/coordbench"
HERE="$(cd "$(dirname "$0")" && pwd)"

# The scenario set: the quick set from .agents/docs/bench-ci.md.
SCEN="cli,idle,throughput,cap,repo,priority,chaos,toolpark,orchestrator-kill,state-loss"

mkdir -p "$ROOT"
i=1
while [ "$i" -le "$REPEATS" ]; do
  echo "=== round $i: baseline" >&2
  node "$HERE/bench.ts" --bin "$BASE" --out "${OUT}-baseline-r${i}.json" --only "$SCEN" --root "$ROOT" >/dev/null
  echo "=== round $i: candidate" >&2
  node "$HERE/bench.ts" --bin "$CAND" --out "${OUT}-candidate-r${i}.json" --only "$SCEN" --root "$ROOT" >/dev/null
  i=$((i + 1))
done

# The single-run scenarios (everything except idle and throughput) run once per binary.
echo "=== single-shot scenarios: baseline" >&2
node "$HERE/bench.ts" --bin "$BASE" --out "${OUT}-baseline-single.json" --only "cap,repo,priority,chaos,toolpark,orchestrator-kill,state-loss" --root "$ROOT" >/dev/null
echo "=== single-shot scenarios: candidate" >&2
node "$HERE/bench.ts" --bin "$CAND" --out "${OUT}-candidate-single.json" --only "cap,repo,priority,chaos,toolpark,orchestrator-kill,state-loss" --root "$ROOT" >/dev/null
echo "done: ${OUT}-*.json" >&2
