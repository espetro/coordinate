#!/usr/bin/env python3
"""Hold a connection open on a store, so the WAL is not checkpointed away.

Used by bench/bytes_analysis.py --wal-experiment: with a second connection open, SQLite
cannot reset and truncate the WAL, so the WAL grows with every commit; without it, every
writer checkpoints and truncates the WAL when it closes.
"""
import os
import sys
import time

os.environ["COORDINATE_DB"] = sys.argv[1]
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
from coordinate import queue as q  # noqa: E402

c = q.connect()
time.sleep(float(sys.argv[2]) if len(sys.argv) > 2 else 60)
c.close()
