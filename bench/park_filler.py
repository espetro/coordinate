#!/usr/bin/env python3
"""Bulk-enqueue parked sessions for the park-density and wake-latency scenarios. Stdlib only, uses
coordinate's own queue API.

  python bench/park_filler.py --db PATH --count N --event EVENT [--cwd DIR]
                              [--kind cmd|acp] [--batch] [--event-per-row PREFIX] [--seed-sessions]

One process per job would take about 95ms each (M, the enqueue_cli_median_ms gate), so 10,000
parked sessions would take 18 minutes through the CLI. This helper calls the same
`coordinate.queue.enqueue` and `coordinate.queue.wait_on` functions the CLI calls, so the store sees
exactly the rows the CLI would have written.

Modes:
- default (per row): enqueue + wait_on per row, each in its own transaction, which is what the CLI
  does.
- `--batch`: one transaction for all the rows, which is what a bulk load looks like. Much faster
  (10,000 rows in seconds instead of 18 minutes) and it produces a much smaller WAL, which matters
  when the question is how many bytes a parked session costs on disk.

`--kind acp` writes an ACP payload with a durable session id and, with `--seed-sessions`, seeds the
stub agent's session state file (.stub-acp-sessions.json) in the cwd, so a later wake resumes that
session through ACP `session/load` instead of starting a new one.

`--event-per-row PREFIX` parks row i on the event `PREFIX-i`, so one row can be woken without
releasing the whole batch (the `release` verb releases every row waiting on an event).
"""
import argparse
import json
import os
import sys

STATE_NAME = ".stub-acp-sessions.json"


def _payload(i: int, kind: str, cwd: str) -> dict:
    if kind == "acp":
        return {"agent": "stub", "cwd": cwd, "prompt": f"park {i}",
                "registry": "/tmp/agents.stub.json",
                "session": f"stub-park-{i:08d}"}
    return {"cmd": ["true"], "cwd": cwd, "kind": "parked", "index": i, "note": "x" * 128}


def _seed_sessions(cwd: str, sids: list[str]) -> None:
    """Make the stub agent know these session ids, so session/load succeeds for them."""
    path = os.path.join(cwd, STATE_NAME)
    state = {"sessions": {}}
    if os.path.exists(path):
        try:
            with open(path) as f:
                state = json.load(f)
        except (OSError, ValueError):
            pass
    for sid in sids:
        state.setdefault("sessions", {}).setdefault(sid, {"turns_done": 0, "turns_started": 0, "loads": 0})
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, path)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--count", type=int, required=True)
    ap.add_argument("--event", default="park-evt")
    ap.add_argument("--event-per-row", default=None,
                    help="park row i on the event PREFIX-i instead of one shared event")
    ap.add_argument("--cwd", default=None)
    ap.add_argument("--kind", default="cmd", choices=["cmd", "acp"])
    ap.add_argument("--batch", action="store_true",
                    help="one transaction for all rows (bulk load); default is one transaction per row")
    ap.add_argument("--seed-sessions", action="store_true",
                    help="acp only: write the session ids into the stub agent state file in the cwd")
    a = ap.parse_args(argv)

    os.environ["COORDINATE_DB"] = a.db
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
    from coordinate import queue as q

    cwd = a.cwd or "/tmp"
    sids = [f"stub-park-{i:08d}" for i in range(a.count)] if a.kind == "acp" else []
    if a.seed_sessions and sids:
        _seed_sessions(cwd, sids)

    c = q.connect()
    first = None
    try:
        if a.batch:
            c.execute("BEGIN IMMEDIATE")
            try:
                for i in range(a.count):
                    jid = q.enqueue(c, _payload(i, a.kind, cwd), kind=a.kind)
                    if first is None:
                        first = jid
                # the rows are freshly queued, so the columns wait_on clears (lease_owner,
                # lease_expires_at, claim_at, deadline_at) are already NULL.
                if a.event_per_row:
                    for i in range(a.count):
                        c.execute("UPDATE jobs SET status='waiting', waiting_on=? WHERE id=?",
                                  (f"{a.event_per_row}-{i}", first + i))
                else:
                    c.execute("UPDATE jobs SET status='waiting', waiting_on=? WHERE id>=? AND id<=?",
                              (a.event, first, first + a.count - 1))
                c.execute("COMMIT")
            except BaseException:
                c.execute("ROLLBACK")
                raise
        else:
            for i in range(a.count):
                jid = q.enqueue(c, _payload(i, a.kind, cwd), kind=a.kind)
                # wait_on opens its own transaction, so it cannot run inside one of ours
                q.wait_on(c, jid, f"{a.event_per_row}-{i}" if a.event_per_row else a.event)
                if first is None:
                    first = jid
    finally:
        c.close()
    print(json.dumps({"first_id": first, "count": a.count,
                      "ids": [first, first + a.count - 1] if first is not None else []}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
