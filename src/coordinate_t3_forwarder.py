#!/usr/bin/env python3
"""Per-device events forwarder: coordinate events -> a T3 thread (bridge a).

Ops tooling, not shipped with the package. Tails `coordinate events --follow`
(or --since cursor resumption) and forwards terminal transitions into an
orchestrator T3 thread via `t3 thread send <thread> <msg>`.

The T3 channel was verified on this host (2026-11-23): `t3 thread send` exists
(t3 0.1.10), the background service is installed, and `t3 thread list --json`
talks to a live server. Thread ids look like `mcp:<uuid>`; find one with
`t3 thread list --json --project <path>` or start one with
`t3 thread start <project> "coordinate events forwarder"`.

Usage:
  coordinate-t3-forwarder --thread THREAD [--machine NAME] [--interval S]
                          [--cursor FILE] [--since ID] [--kinds k1,k2] [-v]

  --thread   T3 thread id to forward into (required).
  --cursor   file where the last forwarded event id is stored so a restart
             does not replay old transitions (default:
             $XDG_STATE_HOME/coordinate/t3-forwarder-cursor).
  --kinds    comma-separated allowlist of event kinds (default: terminal
             transitions: done,failed,timed_out,cancelled,dead,requeued).

Reads the events table directly through the coordinate package (read-only WAL
connection, never blocks the daemon writer). If T3 send fails (server down),
the process logs and retries; the cursor does not advance, so nothing is lost.
"""
import argparse
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from coordinate import events  # noqa: E402
from coordinate import queue as q  # noqa: E402

DEFAULT_KINDS = "done,failed,timed_out,cancelled,dead,requeued"


def default_cursor_path() -> str:
    state = os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state")
    return os.path.join(state, "coordinate", "t3-forwarder-cursor")


def load_cursor(path: str) -> int:
    try:
        with open(path) as f:
            return int(f.read().strip() or 0)
    except (OSError, ValueError):
        return 0


def save_cursor(path: str, eid: int) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(str(eid))
    os.replace(tmp, path)


def render(ev: dict) -> str | None:
    """One transition -> one T3 message line."""
    jid = ev["job_id"]
    kind = ev["kind"]
    data = ev.get("data") or {}
    bits = [f"coordinate[{kind}] job {jid}"]
    if data.get("outcome"):
        bits.append(str(data["outcome"]))
    if data.get("reason"):
        bits.append(str(data["reason"]))
    if data.get("waiting_on"):
        bits.append(f"waiting_on={data['waiting_on']}")
    if kind in ("claimed", "requeued"):
        bits.append(f"attempt {data.get('attempt', '?')}" if data.get("attempt") else "retrying")
    return " \u2014 ".join(bits)


def t3_send(thread: str, message: str) -> bool:
    r = subprocess.run(["t3", "thread", "send", thread, message],
                       capture_output=True, text=True, timeout=120)
    ok = r.returncode == 0
    if not ok:
        sys.stderr.write(f"t3 thread send failed rc={r.returncode}: {r.stderr.strip()[:200]}\n")
    return ok


def main() -> int:
    ap = argparse.ArgumentParser(description="forward coordinate job events into a T3 thread")
    ap.add_argument("--thread", required=True, help="T3 thread id")
    ap.add_argument("--machine", default=None, help="prefix for messages (defaults to $MACHINE or hostname)")
    ap.add_argument("--interval", type=float, default=2.0, help="poll seconds (default 2)")
    ap.add_argument("--cursor", default=default_cursor_path(), help="cursor file")
    ap.add_argument("--since", type=int, default=None, help="initial cursor (overrides the file once)")
    ap.add_argument("--kinds", default=DEFAULT_KINDS, help="comma-separated kinds to forward ('' = all)")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args()

    machine = a.machine or os.environ.get("MACHINE") or os.uname().nodename.split(".")[0]
    kinds = {k.strip() for k in a.kinds.split(",") if k.strip()}
    cur = load_cursor(a.cursor) if a.since is None else a.since

    c = q.connect()  # WAL read path; same schema as the daemon
    sys.stderr.write(f"forwarding machine={machine} kinds={sorted(kinds) or 'ALL'} "
                     f"thread={a.thread} cursor={cur}\n")
    while True:
        for row in events.follow(c, cur):
            ev = events.row_event(row)
            cur = ev["id"]
            if kinds and ev["kind"] not in kinds:
                continue
            msg = render(ev)
            if msg is None:
                continue
            if t3_send(a.thread, f"[{machine}] {msg}"):
                save_cursor(a.cursor, cur)
                if a.verbose:
                    sys.stderr.write(f"sent: {msg}\n")
            else:
                # stop advancing; retry on the next poll
                break
        time.sleep(a.interval)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
