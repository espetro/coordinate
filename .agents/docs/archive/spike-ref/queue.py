"""SQLite durable queue: claim loop with BEGIN IMMEDIATE, cap=3, lease 30s, reaper every 10s."""
import os, sqlite3, sys, time, json, threading

DB = os.environ.get("QDB", "/tmp/spike-b/shim/queue.db")
CAP = 3
LEASE_S = 30
REAP_EVERY = 10

def conn():
    c = sqlite3.connect(DB, timeout=10, isolation_level=None)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA busy_timeout=10000")
    c.execute("PRAGMA synchronous=NORMAL")
    return c

def init():
    c = conn()
    c.executescript("""
    CREATE TABLE IF NOT EXISTS jobs(
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', -- queued|running|done|failed
      attempts INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_expires_at REAL,
      enqueued_at REAL NOT NULL,
      started_at REAL,
      finished_at REAL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    """)
    c.close()

def enqueue(n, kind="sleep", payload_s=2.0):
    c = conn()
    now = time.time()
    for i in range(n):
        c.execute("INSERT INTO jobs(kind,payload,enqueued_at) VALUES(?,?,?)",
                  (kind, json.dumps({"sleep": payload_s, "i": i}), now))
    ids = [r[0] for r in c.execute("SELECT id FROM jobs ORDER BY id DESC LIMIT ?", (n,))]
    c.close()
    return ids

def reap_once(owner_tag):
    c = conn()
    now = time.time()
    cur = c.execute(
        "UPDATE jobs SET status='queued', lease_owner=NULL, lease_expires_at=NULL "
        "WHERE status='running' AND lease_expires_at < ? RETURNING id", (now,))
    reaped = [r[0] for r in cur.fetchall()]
    c.close()
    if reaped:
        print(f"[reaper] requeued expired leases: {reaped}", flush=True)
    return reaped

def reaper_loop(stop):
    while not stop.is_set():
        reap_once("reaper")
        stop.wait(REAP_EVERY)

def claim_one(worker_id):
    c = conn()
    try:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute(
            "SELECT id, payload FROM jobs WHERE status='queued' ORDER BY id LIMIT 1"
        ).fetchone()
        if row is None:
            c.execute("COMMIT")
            return None
        jid, payload = row
        c.execute(
            "UPDATE jobs SET status='running', attempts=attempts+1, lease_owner=?, "
            "lease_expires_at=?, started_at=? WHERE id=?",
            (worker_id, time.time() + LEASE_S, time.time(), jid))
        c.execute("COMMIT")
        return jid, json.loads(payload)
    except sqlite3.OperationalError:
        try: c.execute("ROLLBACK")
        except Exception: pass
        return None
    finally:
        c.close()

def complete(jid):
    c = conn()
    c.execute("UPDATE jobs SET status='done', lease_owner=NULL, lease_expires_at=NULL, finished_at=? WHERE id=? AND lease_owner=?",
              (time.time(), jid, threading.current_thread().name))
    c.close()

def worker_loop(stop):
    name = threading.current_thread().name
    while not stop.is_set():
        got = claim_one(name)
        if got is None:
            stop.wait(0.05)
            continue
        jid, payload = got
        time.sleep(payload.get("sleep", 2))
        complete(jid)

def stats():
    c = conn()
    r = dict(c.execute("SELECT status, COUNT(*) FROM jobs GROUP BY status").fetchall())
    c.close()
    return r

def monitor(stop, target_running=10):
    max_running = 0
    max_attempts_seen = 0
    while not stop.is_set():
        r = stats()
        running = r.get("running", 0)
        max_running = max(max_running, running)
        c = conn()
        mx = c.execute("SELECT MAX(attempts) FROM jobs").fetchone()[0]
        c.close()
        max_attempts_seen = max(max_attempts_seen, mx or 0)
        if running > CAP:
            print(f"[monitor] CAP VIOLATION: {running} running", flush=True)
        stop.wait(0.2)
    return max_running, max_attempts_seen

if __name__ == "__main__":
    cmd = sys.argv[1]
    init()
    if cmd == "enqueue":
        ids = enqueue(int(sys.argv[2]), payload_s=float(sys.argv[3]) if len(sys.argv) > 3 else 2.0)
        print("enqueued", ids)
    elif cmd == "run":
        dur = float(sys.argv[2]) if len(sys.argv) > 2 else 60
        stop = threading.Event()
        rp = threading.Thread(target=reaper_loop, args=(stop,), daemon=True)
        rp.start()
        ws = [threading.Thread(target=worker_loop, args=(stop,), name=f"w{i}", daemon=True) for i in range(CAP)]
        for w in ws: w.start()
        print(f"running {CAP} workers for {dur}s", flush=True)
        time.sleep(dur)
        stop.set()
    elif cmd == "stats":
        print(stats())
    elif cmd == "watch":
        stop = threading.Event()
        try:
            mr, mx = monitor(stop)
        except KeyboardInterrupt:
            pass
        print(f"max_running={mr} max_attempts={mx}")
