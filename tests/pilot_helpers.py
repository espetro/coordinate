"""Shared helpers for the end-to-end pilots (real agents, throwaway git repos)."""
import json
import os
import sqlite3
import subprocess
import threading
import time


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True).stdout


def row(jid):
    c = sqlite3.connect(os.environ["FLEET_DB"])
    r = c.execute("SELECT status, attempts, payload FROM jobs WHERE id=?", (jid,)).fetchone()
    c.close()
    return r[0], r[1], json.loads(r[2])


def wait_for(pred, timeout, step=0.5):
    end = time.time() + timeout
    while time.time() < end:
        v = pred()
        if v:
            return v
        time.sleep(step)
    return None


class Sampler(threading.Thread):
    """Poll ps for fleet-acp processes working in a directory; record every sample."""

    def __init__(self, marker):
        super().__init__(daemon=True)
        self.marker, self.samples, self.stop = marker, [], threading.Event()

    def run(self):
        while not self.stop.is_set():
            out = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True).stdout
            pids = {int(l.split(None, 1)[0]) for l in out.splitlines()
                    if "fleet-acp.js run" in l and self.marker in l}
            self.samples.append((time.time(), pids))
            time.sleep(0.2)
