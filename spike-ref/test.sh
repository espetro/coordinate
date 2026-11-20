#!/usr/bin/env bash
# Spike B variant 2 test: cap + kill -9 recovery.
set -euo pipefail
cd /tmp/spike-b/shim
rm -f queue.db queue.db-*

python3 queue.py init 2>/dev/null || true
# test 1+2: enqueue 10 jobs of 2s
python3 queue.py enqueue 10 2
python3 queue.py stats

# run worker for 4s in background (kills mid-run ~job 4-6), monitor concurrently
( python3 queue.py run 4 & echo $! > /tmp/spike-b/worker.pid ; wait ) &
MON_PID=$!
sleep 0.5
WORKER=$(cat /tmp/spike-b/worker.pid)
sleep 3
echo "--- kill -9 worker ---"
kill -9 "$WORKER" || true
sleep 1
python3 queue.py stats

echo "--- restart worker until drained ---"
for i in $(seq 1 40); do
  S=$(python3 queue.py stats)
  echo "poll $i: $S"
  # run a short-lived worker to drain; also exercises reaper
  python3 queue.py run 2
  if python3 -c "
import sqlite3,sys
c=sqlite3.connect('queue.db')
d=c.execute(\"SELECT COUNT(*) FROM jobs WHERE status='done'\").fetchone()[0]
sys.exit(0 if d==10 else 1)"
  then break; fi
done
python3 queue.py stats
kill $MON_PID 2>/dev/null || true
