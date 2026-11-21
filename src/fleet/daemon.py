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

# sh -c "..." wraps the user's argv0 so shell jobs can still be matched by their binary name.
SH = "/bin/sh"  # never the user's shell: zshrc PATH reordering would break tool-class matching


def _argv0(kind: str, payload: dict) -> str | None:
    """The binary the job's process group will exec, for tool-class matching."""
    if kind != "cmd":
        return None
    cmd = payload.get("cmd")
    if isinstance(cmd, str):
        toks = shlex.split(cmd)
    elif isinstance(cmd, list):
        toks = cmd
    else:
        return None
    if not toks:
        return None
    if toks[0] in ("sh", "bash", "zsh"):  # sh -c "vitest run": match the inner argv0
        for i, t in enumerate(toks):
            if t == "-c" and i + 1 < len(toks):
                inner = shlex.split(toks[i + 1])
                return inner[0] if inner else None
        return None
    return toks[0]


def _park(c, jid: int, owner: str, key: str) -> None:
    """D7 park-at-boundary: mark waiting on the tool slot event; the worker exits (no spawn)."""
    q.wait_on(c, jid, key)


def _which(name: str) -> str | None:
    """Resolve a binary against PATH in Python (D2): the spawn shell must not re-resolve
    via a user rc file that reorders PATH (zsh PATH exports beat our prepend)."""
    if os.sep in name:
        return name if os.path.isfile(name) else None
    for d in os.environ.get("PATH", "").split(os.pathsep):
        p = os.path.join(d, name)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def spawn(c, jid: int, owner: str, kind: str, payload: dict, jid_owner: tuple | None = None) -> subprocess.Popen:
    """Spawn a job, intercepting before exec: heavy-class match -> weighted tool lease (D2/D3).

    Lease unavailable -> the job parks (D7) instead of spawning; raise _Parked to signal the loop.
    Every spawn of a matched binary (heavy or unmatched) is audited (D9).
    """
    argv0 = _argv0(kind, payload)
    if argv0 is None:
        return _spawn_raw(c, jid, owner, kind, payload)
    resolved = _which(argv0)  # D2: match the binary we will actually exec, resolved in Python
    m = q.match_tool_class(resolved or argv0)
    proj = q.project_key(payload.get("cwd"))
    if m is None:
        return _spawn_raw(c, jid, owner, kind, payload)
    cls, cost = m
    q.audit_spawn(c, jid, argv0, cls, proj)
    key = q.tool_slot_key(cls, proj)
    if cost > q.slot_limit(key):
        # never grantable: config error, not contention. Fail fast instead of stranding.
        q.finish(c, jid, owner, "failed")
        raise _Parked(key)
    if not q.acquire_tool_lease(c, jid, key, cost):
        _park(c, jid, owner, key)
        raise _Parked(key)
    try:
        return _spawn_raw(c, jid, owner, kind, payload)
    except BaseException:
        q.release_tool_lease(c, jid)  # spawn failed: don't strand the lease
        raise


class _Parked(Exception):
    def __init__(self, key):
        self.key = key


def _spawn_raw(c, jid: int, owner: str, kind: str, payload: dict) -> subprocess.Popen:
    if kind == "acp":
        return spawn_acp(c, jid, owner, payload)[0]
    cmd = payload["cmd"]
    proc = subprocess.Popen(cmd, shell=isinstance(cmd, str), executable=SH if isinstance(cmd, str) else None,
                            cwd=payload.get("cwd"), start_new_session=True)
    q.set_proc(c, jid, owner, proc.pid, None)
    return proc


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
    if payload.get("model"):
        cmd += ["--model", payload["model"]]
    if payload.get("session"):
        cmd += ["--session", payload["session"]]
    proc = subprocess.Popen(cmd, cwd=payload["cwd"], start_new_session=True, stdout=subprocess.PIPE, text=True)
    q.set_proc(c, jid, owner, proc.pid, pidfile)
    threading.Thread(target=_pump_session, args=(proc, jid, owner), daemon=True).start()
    return proc, pidfile


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
                    event = q.finish(c, jid, owner, "done" if rc == 0 else "failed")
                    del running[jid]
                    busy = True
                    if event:
                        # D7 wake: a freed tool slot releases jobs parked on that key
                        for wid in q.release(c, event):
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
                except _Parked:
                    busy = True  # D7: parked at the heavy-spawn boundary, no worker spawned
                except (OSError, KeyError):
                    q.finish(c, jid, owner, "failed")
                    busy = True
            delay = BACKOFF_MIN if busy else min(delay * 2, BACKOFF_MAX)
            time.sleep(delay)
    finally:
        for proc in running.values():
            kill(proc)
        c.close()
