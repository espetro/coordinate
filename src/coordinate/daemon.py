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

from . import queue as q

BACKOFF_MAX = 2.0
BACKOFF_MIN = 0.05


def _backoff_min() -> float:
    """Base poll interval of the claim loop, in seconds (COORDINATE_BACKOFF_MIN overrides).

    The default keeps the idle daemon near 0 CPU; a bench that measures wake latency drives the
    interval down so the measurement is the spawn path, not the poll timer."""
    try:
        return max(float(q.paths.env("BACKOFF_MIN", "") or BACKOFF_MIN), 0.001)
    except ValueError:
        return BACKOFF_MIN


def _backoff_max() -> float:
    """Largest poll interval of the claim loop, in seconds (COORDINATE_BACKOFF_MAX overrides).

    This is the daemon's idle poll ceiling, so it bounds how long a released job waits before the
    daemon notices it: the wake latency is at least the poll interval the daemon was sitting on."""
    try:
        return max(float(q.paths.env("BACKOFF_MAX", "") or BACKOFF_MAX), _backoff_min())
    except ValueError:
        return BACKOFF_MAX

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
                            cwd=payload.get("cwd"), start_new_session=True, env=_job_env(c, jid))
    q.set_proc(c, jid, owner, proc.pid, None)
    return proc


def _job_env(c, jid: int) -> dict:
    """Env contract for the child: COORDINATE_JOB_ID, COORDINATE_DEADLINE_AT, COORDINATE_MACHINE,
    COORDINATE_DB (the FLEET_* spellings are kept for existing agents until P2).

    COORDINATE_DEADLINE_AT is the absolute epoch-second deadline of this attempt (empty when
    the job carries no cap), so the agent can read its own identity and budget."""
    env = os.environ.copy()
    env["COORDINATE_JOB_ID"] = env["FLEET_JOB_ID"] = str(jid)
    row = c.execute("SELECT deadline_at FROM jobs WHERE id=?", (jid,)).fetchone()
    deadline = str(int(row[0])) if row and row[0] else ""
    env["COORDINATE_DEADLINE_AT"] = env["FLEET_DEADLINE_AT"] = deadline
    env["COORDINATE_MACHINE"] = env["FLEET_MACHINE"] = q.MACHINE
    env["COORDINATE_DB"] = env["FLEET_DB"] = q.db_path()
    return env


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
    cmd = shlex.split(q.paths.env("ACP_CMD", "fleet-acp")) + [
        "run", payload["agent"], "--cwd", payload["cwd"], "--prompt", payload["prompt"], "--pid-file", pidfile]
    if payload.get("registry"):
        cmd += ["--registry", payload["registry"]]
    if payload.get("model"):
        cmd += ["--model", payload["model"]]
    if payload.get("session"):
        cmd += ["--session", payload["session"]]
    proc = subprocess.Popen(cmd, cwd=payload["cwd"], start_new_session=True, stdout=subprocess.PIPE,
                            stdin=subprocess.PIPE, text=True, env=_job_env(c, jid))
    q.set_proc(c, jid, owner, proc.pid, pidfile)
    threading.Thread(target=_pump_session, args=(proc, jid, owner), daemon=True).start()
    return proc, pidfile


def kill(proc: subprocess.Popen) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    proc.wait()


def _acp_cancel(proc: subprocess.Popen, payload: dict) -> bool:
    """Send an ACP session/cancel to the running agent (best effort).

    The ACP command (fleet-acp) reads JSON-RPC requests on stdin, so a session/cancel
    notification is how the dispatcher asks a running turn to stop."""
    sid = payload.get("session")
    if not sid or proc.stdin is None:
        return False
    try:
        proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "session/cancel",
                                      "params": {"sessionId": sid}}) + "\n")
        proc.stdin.flush()
        return True
    except (OSError, ValueError):
        return False


def _terminate_tree(pgid: int | None, pidfile: str | None, proc: subprocess.Popen | None,
                    grace_s: float = 0.0) -> None:
    """SIGTERM the process group, then SIGKILL after 10s. The grace period (before the TERM)
    belongs to the ACP cancel step, so a cmd job is terminated without waiting."""
    term_wait = float(q.paths.env("TIMECAP_TERM_S", "10"))
    pids = [pgid]
    if pidfile:
        try:
            with open(pidfile) as f:
                pids.append(int(f.read().strip()))
        except (OSError, ValueError):
            pass
    pids = [p for p in pids if p and p > 1]
    if grace_s > 0:
        time.sleep(grace_s)
    for p in pids:
        try:
            os.killpg(p, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
    if proc is not None:
        try:
            proc.wait(timeout=term_wait)
        except subprocess.TimeoutExpired:
            pass
    time.sleep(0.1)
    for p in pids:
        try:
            os.killpg(p, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    if pidfile:
        try:
            os.unlink(pidfile)
        except OSError:
            pass


def _expire(c, jid: int, kind: str, payload: dict, pgid: int | None, pidfile: str | None,
            proc: subprocess.Popen | None, owner: str) -> None:
    """Timecap expiry: cancel the ACP turn, free the slot, then TERM/KILL the process group.

    The terminal transition happens now so the slot is freed and the job is never retried;
    the kill sequence runs in the background so the daemon keeps serving other jobs.

    ACP jobs get the grace period (FLEET_TIMECAP_GRACE_S) to stop the turn on their own;
    cmd jobs skip the cancel step and are terminated immediately."""
    grace = float(q.paths.env("TIMECAP_GRACE_S", "30"))
    if kind == "acp" and proc is not None:
        _acp_cancel(proc, payload)
    else:
        grace = 0.0
    cap = c.execute("SELECT max_runtime_s FROM jobs WHERE id=?", (jid,)).fetchone()[0]
    q.finalize_timed_out(c, jid, outcome=f"max runtime exceeded (cap {cap}s)")
    threading.Thread(target=_terminate_tree, args=(pgid, pidfile, proc, grace), daemon=True).start()


def run(stop=lambda: False) -> None:
    c = q.connect()
    owner = f"{os.uname().nodename}:{os.getpid()}"
    running: dict[int, subprocess.Popen] = {}
    delay, last_hb, last_reap = _backoff_min(), 0.0, 0.0
    try:
        while not stop():
            busy = False
            now = time.time()
            # expiry first: a job past its deadline must be timed_out, never recorded as a
            # plain failed exit by the poll below (the TERM we send is an exit != 0).
            for jid, kind, raw, pgid, pidfile in q.expired_running(c):
                proc = running.pop(jid, None)
                _expire(c, jid, kind, json.loads(raw), pgid, pidfile, proc, owner)
                busy = True
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
            delay = _backoff_min() if busy else min(delay * 2, _backoff_max())
            time.sleep(delay)
    finally:
        for proc in running.values():
            kill(proc)
        c.close()
