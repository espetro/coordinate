"""Dispatcher daemon: claim loop, subprocess execution, lease heartbeat, reaper.

Single-threaded. Children run in their own session so a cancelled or lost job can be killed as a group.
"""
import os
import signal
import subprocess
import time

from fleet import queue as q

BACKOFF_MAX = 2.0
BACKOFF_MIN = 0.05


def spawn(payload: dict) -> subprocess.Popen:
    cmd = payload["cmd"]
    return subprocess.Popen(cmd, shell=isinstance(cmd, str), cwd=payload.get("cwd"),
                            start_new_session=True)


def kill(proc: subprocess.Popen) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    proc.wait()


def run(stop=lambda: False) -> None:
    c = q.connect()
    owner = f"{os.uname().nodename}:{os.getpid()}"
    running: dict[int, subprocess.Popen] = {}
    delay, last_hb, last_reap = BACKOFF_MIN, 0.0, 0.0
    try:
        while not stop():
            busy = False
            now = time.time()
            for jid, proc in list(running.items()):
                rc = proc.poll()
                if rc is not None:
                    q.finish(c, jid, owner, "done" if rc == 0 else "failed")
                    del running[jid]
                    busy = True
            if now - last_hb >= q.LEASE_S / 3:
                for jid, proc in list(running.items()):
                    if not q.heartbeat(c, jid, owner):
                        kill(proc)
                        del running[jid]
                last_hb = now
            if now - last_reap >= q.LEASE_S / 3:
                q.reap(c)
                last_reap = now
            while len(running) < q.machine_cap():
                got = q.claim(c, owner)
                if got is None:
                    break
                jid, payload = got
                try:
                    running[jid] = spawn(payload)
                except OSError:
                    q.finish(c, jid, owner, "failed")
                busy = True
            delay = BACKOFF_MIN if busy else min(delay * 2, BACKOFF_MAX)
            time.sleep(delay)
    finally:
        for proc in running.values():
            kill(proc)
        c.close()
