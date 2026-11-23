#!/usr/bin/env python3
"""Spike B driver: cap check, kill -9 recovery, latency + drain metrics."""
import json, os, signal, sqlite3, subprocess, sys, time

DIR = "/tmp/spike-b/shim"
DB = f"{DIR}/queue.db"
PY = sys.executable

for f in (DB, DB + "-wal", DB + "-shm"):
    if os.path.exists(f): os.remove(f)

def stats():
    c = sqlite3.connect(DB, timeout=10)
    r = dict(c.execute("SELECT status, COUNT(*) FROM jobs GROUP BY status").fetchall())
    mx = c.execute("SELECT MAX(attempts) FROM jobs").fetchone()[0]
    c.close()
    return r, mx or 0

def poll_loop(stop_flag, max_state):
    """Sample running count every 100ms until stop_flag[0]."""
    violations = 0
    while not stop_flag[0]:
        r, _ = stats()
        run = r.get("running", 0)
        max_state["max_running"] = max(max_state["max_running"], run)
        if run > 3: violations += 1
        time.sleep(0.1)
    return violations

subprocess.run([PY, "queue.py", "enqueue", "10", "2"], cwd=DIR, check=True)
enqueue_t = time.time()
print("enqueued 10 jobs")

# worker as subprocess so we can kill -9
worker = subprocess.Popen([PY, "queue.py", "run", "600"], cwd=DIR,
                          stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)

stop = [False]
max_state = {"max_running": 0}
import threading
mon = threading.Thread(target=poll_loop, args=(stop, max_state)); mon.start()

# wait until ~5 jobs done or 12s, then kill -9
t0 = time.time()
killed_at = None
while time.time() - t0 < 12:
    r, _ = stats()
    if r.get("done", 0) >= 4:
        break
    time.sleep(0.1)
killed_at = time.time()
os.kill(worker.pid, signal.SIGKILL)
worker.wait()
orphans_at_kill, _ = stats()
print(f"kill -9 at t+{killed_at-enqueue_t:.1f}s; state at kill: {orphans_at_kill}")

# restart worker
restart_t = time.time()
worker2 = subprocess.Popen([PY, "queue.py", "run", "600"], cwd=DIR,
                           stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)

# wait for all done, up to 120s
all_done_at = None
while time.time() - restart_t < 120:
    r, mx = stats()
    if r.get("done", 0) == 10:
        all_done_at = time.time()
        break
    time.sleep(0.2)
stop[0] = True; mon.join()

r, mx = stats()
lost = 10 - sum(r.get(s, 0) for s in ("done", "queued", "running", "failed"))
print(f"final: {r}  max_attempts={mx}  lost={lost}")
print(f"max_running_observed={max_state['max_running']} (cap=3) violations={0 if max_state['max_running']<=3 else 'YES'}")
if all_done_at:
    print(f"orphan recovery (kill->all done): {all_done_at-killed_at:.1f}s")
    print(f"total drain: {all_done_at-enqueue_t:.1f}s")

# claim latency: started_at - enqueued_at, including the requeued orphan
c = sqlite3.connect(DB)
lat = [(a, b, (b or 0)-a) for a, b, in c.execute("SELECT enqueued_at, started_at FROM jobs").fetchall()]
c.close()
ls = sorted(x[2] for x in lat)
print(f"claim latency: min={ls[0]:.2f}s median={ls[5]:.2f}s max={ls[-1]:.2f}s (n=10)")
json.dump({"max_running": max_state["max_running"], "final": r, "max_attempts": mx,
           "recovery_s": all_done_at-killed_at if all_done_at else None,
           "drain_s": all_done_at-enqueue_t if all_done_at else None,
           "latencies": [round(x[2],2) for x in lat]}, open(f"{DIR}/results.json","w"))
