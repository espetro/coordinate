#!/usr/bin/env python3
"""Bulk-enqueue parked sessions for the park-density scenario. Stdlib only, uses fleet's own queue API.

  python bench/park_filler.py --db PATH --count N --event EVENT [--cwd DIR]

One process per job would take about 95ms each (M, the enqueue_cli_median_ms gate), so 10,000
parked sessions would take 16 minutes through the CLI. This helper calls the same
`fleet.queue.enqueue` and `fleet.queue.wait_on` functions the CLI calls, in one transaction,
so the store sees exactly the rows the CLI would have written.
"""
import argparse
import os
import sys


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--count", type=int, required=True)
    ap.add_argument("--event", default="park-evt")
    ap.add_argument("--cwd", default=None)
    a = ap.parse_args(argv)

    os.environ["FLEET_DB"] = a.db
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
    from fleet import queue as q

    c = q.connect()
    first = None
    try:
        for i in range(a.count):
            jid = q.enqueue(c, {"cmd": ["true"], "cwd": a.cwd or "/tmp", "kind": "parked",
                                "index": i, "note": "x" * 128})
            # wait_on opens its own transaction, so it cannot run inside one of ours
            q.wait_on(c, jid, a.event)
            if first is None:
                first = jid
    finally:
        c.close()
    print(first)
    return 0


if __name__ == "__main__":
    sys.exit(main())
