"""Dispatcher daemon: claim loop, subprocess execution, lease heartbeat, reaper.

Single-threaded. Children run in their own session so a cancelled or lost job can be killed as a group.
"""
import json
import os
import shlex
import signal
import subprocess
import threading
import time

from fleet import queue as q

BACKOFF_MAX = 2.0
BACKOFF_MIN = 0.05


def _pump_session(proc: subprocess.Popen, jid: int, owner: str) -> None:
    """Read fleet-acp stdout; persist the sessionId from line 1 immediately, then drain."""
    c = q.connect()
    try:
        for n, line in enumerate(proc.stdout):
            if n == 0:
                try:
                    sid = json.loads(line).get("sessionId")
                except (ValueError, AttributeError):
                    sid = None
                if sid:
                    q.set_session(c, jid, owner, sid)
    finally:
        c.close()


def spawn_acp(c, jid: int, owner: str, payload: dict) -> tuple[subprocess.Popen, str]:
    """fleet-acp run <agent> --cwd --prompt [--session]; the agent pid file lets the reaper kill its group."""
    pidfile = os.path.join(os.path.dirname(os.path.abspath(q.db_path())), "pids", f"{jid}.agent")
    os.makedirs(os.path.dirname(pidfile), exist_ok=True)
    if os.path.exists(pidfile):
        os.unlink(pidfile)
    cmd = shlex.split(os.environ.get("FLEET_ACP_CMD", "fleet-acp")) + [
        "run", payload["agent"], "--cwd", payload["cwd"], "--prompt", payload["prompt"], "--pid-file", pidfile]
    if payload.get("registry"):
        cmd += ["--registry", payload["registry"]]
    if payload.get("session"):
        cmd += ["--session", payload["session"]]
    proc = subprocess.Popen(cmd, cwd=payload["cwd"], start_new_session=True, stdout=subprocess.PIPE, text=True)
    q.set_proc(c, jid, owner, proc.pid, pidfile)
    threading.Thread(target=_pump_session, args=(proc, jid, owner), daemon=True).start()
    return proc, pidfile


def spawn(c, jid: int, owner: str, kind: str, payload: dict) -> subprocess.Popen:
    if kind == "acp":
        return spawn_acp(c, jid, owner, payload)[0]
    cmd = payload["cmd"]
    proc = subprocess.Popen(cmd, shell=isinstance(cmd, str), cwd=payload.get("cwd"), start_new_session=True)
    q.set_proc(c, jid, owner, proc.pid, None)
    return proc


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
                jid, kind, payload = got
                try:
                    running[jid] = spawn(c, jid, owner, kind, payload)
                except (OSError, KeyError):
                    q.finish(c, jid, owner, "failed")
                busy = True
            delay = BACKOFF_MIN if busy else min(delay * 2, BACKOFF_MAX)
            time.sleep(delay)
    finally:
        for proc in running.values():
            kill(proc)
        c.close()
