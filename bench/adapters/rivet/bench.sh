#!/usr/bin/env bash
# Rivet spike benchmark driver. Run from bench/adapters/rivet.
set -u
export PATH=$HOME/.local/bin:$HOME/.local/share/mise/shims:/opt/mise/shims:$PATH
STORE=$HOME/tmp-spk-rivet/store
OUT=${1:-bench-results.json}
PORT=${RIVET_ENGINE_PORT:-6430}

log() { echo "[$(date -Is)] $*" >> /tmp/spk-rivet.progress; }

stack_rss() {
  # sum RSS KB of the runner bun process + engine + any rivet children we started (by explicit pids)
  local total=0 p rss
  for p in "${PIDS[@]}"; do
    rss=$(ps -o rss= -p "$p" 2>/dev/null | tr -d ' ')
    [ -n "$rss" ] && total=$((total + rss))
  done
  echo $total
}

meta() { echo "\"$(echo "$1" | sed 's/"/\\"/g')\": $(uptime | sed 's/.*load average/load average/; s/,//g' | awk '{print "\"load:"$3"\"}') , \"free_mb\": $(free -m | awk '/^Mem:/{print $7}')"; }

rm -rf "$STORE"
cd "$(dirname "$0")"
RIVET_RUN_ENGINE=1 RIVET_RUN_SERVICES=0 RIVETKIT_STORAGE_PATH=$STORE RIVET_RUN_ENGINE_PORT=$PORT bun src/server.ts > $HOME/tmp-spk-rivet/server.log 2>&1 &
RUNNER_PID=$!
# engine child appears shortly after
for i in $(seq 1 60); do
  ENGINE_PID=$(pgrep -P $RUNNER_PID -f rivet-engine | head -1)
  [ -n "$ENGINE_PID" ] && break
  sleep 1
done
PIDS=($RUNNER_PID ${ENGINE_PID:-})
echo "runner=$RUNNER_PID engine=${ENGINE_PID:-none}"
for i in $(seq 1 90); do
  curl -s -m 2 "http://127.0.0.1:$PORT/health" | grep -q '"ok"' && break
  sleep 1
done
echo "stack up"
