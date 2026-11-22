"""Terminal-fallback benchmark for the M2 dispatcher: tmux vs Herdr vs zmx.

Stdlib only. Each tool runs in its own isolated HOME (created under --tmp-parent,
default ~/tmp-termfb) so existing user sessions are never touched. Every session
name is prefixed tfspike-. The fake workload is a python stdin/stdout loop
(fakeworker.py, written next to this file), not a real agent.

For each tool and each session count (1, 5, 20) it records, as an orchestrator
would see them through the tool's CLI/socket surface:
- server idle RSS, idle CPU, plus uptime and free -m context (shared machine)
- RSS per added session (linear fit over the 1/5/20 points)
- median/p95 time to create a session
- median/p95 send-input + read-output roundtrip
- whether sessions survive the controlling client exiting (they are all created
  by short-lived CLI clients, so this is inherent, but we verify the workload
  process is alive after each client subprocess is gone)
- what survives kill -9 of the server: workload processes alive? reattachable
  after restart?

Usage: python bench/term_fallback.py [--tools tmux,herdr,zmx] [--out results.json]
"""
import json
import os
import pathlib
import re
import shlex
import signal
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
WORKER = HERE / "fakeworker.py"
PREFIX = "tfspike-"
COUNTS = [1, 5, 20]
HERDR = str(pathlib.Path("/home/own-agents/.local/opt/herdr/herdr"))
ZMX = str(pathlib.Path("/home/own-agents/.local/opt/zmx/zmx"))
ECHO_RE = re.compile(r"ECHO:(\S+)")


def sh(args, env=None, timeout=30, cwd=None, stdin=None):
    r = subprocess.run(args, env=env, cwd=cwd, capture_output=True, text=True,
                       timeout=timeout, input=stdin)
    return r.returncode, r.stdout, r.stderr


def note(s):
    print(f"[{time.strftime('%H:%M:%S')}] {s}", file=sys.stderr, flush=True)


class Isolation:
    """Isolated HOME plus XDG dirs under a parent dir, plus machine context."""

    def __init__(self, parent: Path, tag: str):
        self.home = parent / f"home-{tag}"
        self.home.mkdir(parents=True)
        (self.home / "tmpdir").mkdir()
        self.tmpdir = self.home / "tmpdir"
        self.env = {
            "HOME": str(self.home),
            "XDG_CONFIG_HOME": str(self.home / ".config"),
            "XDG_DATA_HOME": str(self.home / ".local/share"),
            "XDG_STATE_HOME": str(self.home / ".local/state"),
            "TMPDIR": str(self.tmpdir),
            "PATH": os.environ["PATH"],
            "TERM": "xterm-256color",
            "SHELL": "/bin/bash",
        }
        (self.home / ".config").mkdir()
        (self.home / ".local/share").mkdir(parents=True)
        (self.home / ".local/state").mkdir(parents=True)

    def ctx(self):
        """Shared-machine context next to a memory measurement."""
        _, up, _ = sh(["uptime"])
        _, fr, _ = sh(["free", "-m"])
        return {"uptime": up.strip(), "free_m_head": fr.splitlines()[0].strip(),
                "free_m_available": fr.splitlines()[1].split()[-2] + "MB"}


class Tool:
    name = "?"
    server_pids = []  # exact PIDs we started, for RSS and cleanup

    def cmd_env(self, iso): return dict(iso.env)

    def start_server(self, iso): ...
    def create_session(self, iso, name, extra_env=None): ...
    def roundtrip(self, iso, name, text): ...  # send text+Enter, return echoed line or None
    def output(self, iso, name, lines=10): ...
    def close_session(self, iso, name): ...
    def list_sessions(self, iso): ...
    def server_rss(self): ...  # sum RSS MB over server pids
    def stop_server(self, kill9=False): ...
    def session_pids(self, iso, name): ...  # workload pids by exact match


class TmuxTool(Tool):
    name = "tmux"
    sock = "tfspike-sock"

    def _run(self, iso, *args, timeout=30, stdin=None):
        return sh(["tmux", "-L", self.sock, *args], env=self.cmd_env(iso),
                  timeout=timeout, stdin=stdin)

    def start_server(self, iso):
        rc, out, err = self._run(iso, "start-server")
        # the server exits when idle-less; force it live with a scratch session
        rc, out, err = self._run(
            iso, "new-session", "-d", "-s", PREFIX + "hold", "sleep 600")
        rc, out, _ = self._run(iso, "list-panes", "-a", "-F", "#{pane_pid}")
        pids = [p for p in out.split() if p.isdigit()]
        self.server_pids = self._descend(int(pids[0])) if pids else []
        return rc == 0

    def _descend(self, pid):
        """tmux server is the parent of the hold session's shell."""
        pids = []
        p = pid
        for _ in range(4):
            _, out, _ = sh(["ps", "-o", "ppid=", "-p", str(p)])
            pp = int(out.strip())
            _, cmd, _ = sh(["ps", "-o", "comm=", "-p", str(pp)])
            if "tmux" in cmd:
                pids = [pp]
                break
            p = pp
        return pids

    def create_session(self, iso, name, extra_env=None):
        cmd = f"{sys.executable} {shlex.quote(str(WORKER))}"
        rc, _, err = self._run(iso, "new-session", "-d", "-s", name, cmd)
        return rc == 0, err

    def roundtrip(self, iso, name, text):
        rc, _, err = self._run(iso, "send-keys", "-t", name, text, "Enter")
        if rc:
            return None, err
        t0 = time.time()
        while time.time() - t0 < 5:
            rc, out, _ = self._run(iso, "capture-pane", "-p", "-t", name)
            m = ECHO_RE.findall(out or "")
            if m and m[-1] == text:
                return time.time() - t0, None
            time.sleep(0.05)
        return None, "no echo within 5s"

    def output(self, iso, name, lines=10):
        rc, out, _ = self._run(iso, "capture-pane", "-p", "-t", name)
        return out

    def close_session(self, iso, name):
        self._run(iso, "kill-session", "-t", name)

    def list_sessions(self, iso):
        rc, out, _ = self._run(iso, "list-sessions", "-F", "#{session_name}")
        return [l for l in (out or "").splitlines() if l.startswith(PREFIX)]

    def server_rss(self):
        tot = 0
        for pid in self.server_pids:
            _, out, _ = sh(["ps", "-o", "rss=", "-p", str(pid)])
            for x in out.split():
                tot += int(x)
        return tot / 1024

    def server_cpu_s(self):
        tot = 0.0
        for pid in self.server_pids:
            _, out, _ = sh(["ps", "-o", "time=", "-p", str(pid)])
            for t in out.split():
                s = 0.0
                for x in t.replace("-", ":").split(":"):
                    s = s * 60 + float(x)
                tot += s
        return tot

    def stop_server(self, kill9=False):
        for pid in self.server_pids:
            try:
                os.kill(pid, signal.SIGKILL if kill9 else signal.SIGTERM)
            except ProcessLookupError:
                pass
        self.server_pids = []

    def session_pids(self, iso, name):
        rc, out, _ = self._run(iso, "list-panes", "-t", name, "-F", "#{pane_pid}")
        return [int(p) for p in out.split() if p.isdigit()]

    def cmd_env(self, iso):
        e = dict(iso.env)
        e["TMUX_TMPDIR"] = str(iso.tmpdir)
        return e


class HerdrTool(Tool):
    name = "herdr"

    def cmd_env(self, iso):
        return dict(iso.env)

    def _run(self, iso, *args, timeout=60, stdin=None):
        return sh([HERDR, *args], env=self.cmd_env(iso), timeout=timeout, stdin=stdin)

    def start_server(self, iso):
        # server must be daemonized ourselves; it exits if its parent shell dies
        # when run in the foreground of a dead bench subprocess
        out = iso.home / "server.out"
        with open(out, "wb") as devnull:
            p = subprocess.Popen([HERDR, "server"], env=self.cmd_env(iso),
                                 stdin=subprocess.DEVNULL, stdout=devnull,
                                 stderr=devnull, start_new_session=True,
                                 cwd=str(iso.home))
        self._server_proc = p
        t0 = time.time()
        while time.time() - t0 < 15:
            rc, out, _ = self._run(iso, "status")
            if "status: running" in (out or ""):
                break
            time.sleep(0.3)
        # find exact server pid: the process listening on herdr.sock
        rc, out, _ = sh(["ss", "-xlp"], )
        self.server_pids = []
        for line in out.splitlines():
            if "herdr.sock" in line and "herdr" in line:
                m = re.search(r"pid=(\d+)", line)
                if m:
                    self.server_pids.append(int(m.group(1)))
        if not self.server_pids and p.poll() is None:
            self.server_pids = [p.pid]
        return bool(self.server_pids)

    def _label_pane(self, iso, name):
        """Map workspace label -> its first pane_id via workspace/pane lists."""
        rc, out, _ = self._run(iso, "workspace", "list")
        try:
            ws = json.loads(out)["result"]["workspaces"]
        except Exception:
            return None
        wid = next((w["workspace_id"] for w in ws if w.get("label") == name), None)
        if not wid:
            return None
        rc, out, _ = self._run(iso, "pane", "list")
        try:
            panes = json.loads(out)["result"]["panes"]
        except Exception:
            return None
        return next((p["pane_id"] for p in panes if p.get("workspace_id") == wid), None)

    def create_session(self, iso, name, extra_env=None):
        rc, out, err = self._run(iso, "workspace", "create", "--cwd", str(iso.home),
                                 "--label", name)
        if rc:
            return False, err
        pid = self._label_pane(iso, name)
        if not pid:
            return False, "no pane_id for " + name
        rc, out, err = self._run(iso, "pane", "run", pid,
                                 f"{sys.executable} {shlex.quote(str(WORKER))}")
        if rc:
            return False, err
        t0 = time.time()
        while time.time() - t0 < 5:
            rc, out, _ = self._run(iso, "pane", "read", pid, "--lines", "5")
            if "READY" in (out or ""):
                return True, None
            time.sleep(0.1)
        return False, "worker READY not seen"

    def roundtrip(self, iso, name, text):
        pid = self._label_pane(iso, name)
        if not pid:
            return None, "pane not found for " + name
        rc, _, err = self._run(iso, "pane", "send-text", pid, text)
        if rc:
            return None, err
        rc, _, err = self._run(iso, "pane", "send-keys", pid, "Enter")
        if rc:
            return None, err
        t0 = time.time()
        while time.time() - t0 < 5:
            rc, out, _ = self._run(iso, "pane", "read", pid, "--lines", "10")
            ms = ECHO_RE.findall(out or "")
            if ms and ms[-1] == text:
                return time.time() - t0, None
            time.sleep(0.05)
        return None, "no echo within 5s"

    def output(self, iso, name, lines=10):
        pid = self._label_pane(iso, name)
        if not pid:
            return ""
        rc, out, _ = self._run(iso, "pane", "read", pid, "--lines", str(lines))
        return out

    def close_session(self, iso, name):
        rc, out, _ = self._run(iso, "workspace", "list")
        try:
            ws = json.loads(out)["result"]["workspaces"]
        except Exception:
            return
        wid = next((w["workspace_id"] for w in ws if w.get("label") == name), None)
        if wid:
            self._run(iso, "workspace", "close", wid)

    def list_sessions(self, iso):
        rc, out, _ = self._run(iso, "workspace", "list")
        try:
            return [w["label"] for w in json.loads(out)["result"]["workspaces"]
                    if w.get("label", "").startswith(PREFIX)]
        except Exception:
            return []

    def server_rss(self):
        tot = 0
        for pid in self.server_pids:
            _, out, _ = sh(["ps", "-o", "rss=", "-p", str(pid)])
            for x in out.split():
                tot += int(x)
        return tot / 1024

    def server_cpu_s(self):
        tot = 0.0
        for pid in self.server_pids:
            _, out, _ = sh(["ps", "-o", "time=", "-p", str(pid)])
            for t in out.split():
                s = 0.0
                for x in t.replace("-", ":").split(":"):
                    s = s * 60 + float(x)
                tot += s
        return tot

    def stop_server(self, kill9=False):
        for pid in self.server_pids:
            try:
                os.kill(pid, signal.SIGKILL if kill9 else signal.SIGTERM)
            except ProcessLookupError:
                pass
        self.server_pids = []

    def session_pids(self, iso, name):
        # the pane's shell+worker are children of the server; match worker by cmdline
        out = []
        for spid in self.server_pids:
            _, kids, _ = sh(["ps", "--ppid", str(spid), "-o", "pid=,args="])
            kids = kids or ""
            grand = []
            for ln in kids.splitlines():
                parts = ln.split(None, 1)
                if len(parts) == 2:
                    _, g, _ = sh(["ps", "--ppid", parts[0], "-o", "pid=,args="])
                    grand += (g or "").splitlines()
            for ln in kids.splitlines() + grand:
                if "fakeworker.py" in ln:
                    out.append(int(ln.split()[0]))
        return out


class ZmxTool(Tool):
    name = "zmx"

    def cmd_env(self, iso):
        return dict(iso.env)  # TMPDIR drives socket dir

    def _run(self, iso, *args, timeout=30, stdin=None):
        return sh([ZMX, *args], env=self.cmd_env(iso), timeout=timeout, stdin=stdin,
                  cwd=str(iso.home))

    def start_server(self, iso):
        # zmx has no server: each `run -d` daemonizes a per-session process.
        # Record the "server" as the set of session daemons we started.
        self.daemon_pids = {}
        return True

    def create_session(self, iso, name, extra_env=None):
        rc, out, err = self._run(iso, "run", name, "-d", sys.executable, str(WORKER))
        if rc or "created" not in (out or ""):
            return False, err or out
        t0 = time.time()
        while time.time() - t0 < 5:
            rc, out, _ = self._run(iso, "history", "--screen", name)
            if "READY" in (out or ""):
                # daemon pid from list
                rc, out, _ = self._run(iso, "list")
                for line in (out or "").splitlines():
                    if line.startswith(f"name={name}"):
                        m = re.search(r"pid=(\d+)", line)
                        if m:
                            self.daemon_pids[name] = int(m.group(1))
                return True, None
            time.sleep(0.1)
        return False, "worker READY not seen"

    def roundtrip(self, iso, name, text):
        rc, _, err = self._run(iso, "send", name, text + "\r")
        if rc:
            return None, err
        t0 = time.time()
        while time.time() - t0 < 5:
            rc, out, _ = self._run(iso, "history", "--screen", name)
            ms = ECHO_RE.findall(out or "")
            if ms and ms[-1] == text:
                return time.time() - t0, None
            time.sleep(0.05)
        return None, "no echo within 5s"

    def output(self, iso, name, lines=10):
        rc, out, _ = self._run(iso, "history", "--scrollback", "256", name)
        return out

    def close_session(self, iso, name):
        self._run(iso, "kill", name)
        self.daemon_pids.pop(name, None)

    def list_sessions(self, iso):
        rc, out, _ = self._run(iso, "list")
        return [l[len("name="):].split()[0] for l in (out or "").splitlines()
                if l.startswith("name=") and PREFIX in l]

    def server_rss(self):
        tot = 0
        for pid in self.daemon_pids.values():
            _, out, _ = sh(["ps", "-o", "rss=", "-p", str(pid)])
            for x in out.split():
                tot += int(x)
        return tot / 1024

    def server_cpu_s(self):
        tot = 0.0
        for pid in self.daemon_pids.values():
            _, out, _ = sh(["ps", "-o", "time=", "-p", str(pid)])
            for t in out.split():
                s = 0.0
                for x in t.replace("-", ":").split(":"):
                    s = s * 60 + float(x)
                tot += s
        return tot

    def stop_server(self, kill9=False):
        for pid in self.daemon_pids.values():
            try:
                os.kill(pid, signal.SIGKILL if kill9 else signal.SIGTERM)
            except ProcessLookupError:
                pass

    def session_pids(self, iso, name):
        return [self.daemon_pids.get(name)] if name in self.daemon_pids else []


def bench_tool(tool, parent: Path):
    res = {"tool": tool.name, "counts": {}}
    iso = Isolation(parent, tool.name)
    tool.start_server(iso)
    time.sleep(1.0)

    for n in COUNTS:
        created = [f"{PREFIX}{tool.name}-{i}" for i in range(n)]
        t_creates = []
        # at each count we create only the delta over the previous count
        prev = COUNTS[COUNTS.index(n) - 1] if COUNTS.index(n) > 0 else 0
        delta = [f"{PREFIX}{tool.name}-{i}" for i in range(prev, n)]
        errs = []
        for name in delta:
            t0 = time.time()
            ok, err = tool.create_session(iso, name)
            t_creates.append(time.time() - t0)
            if not ok:
                errs.append(f"{name}: {err}")
        # idle settle then measure
        time.sleep(2.0)
        rss = tool.server_rss()
        c0, t0 = tool.server_cpu_s(), time.time()
        time.sleep(5.0)
        cpu_pct = (tool.server_cpu_s() - c0) / (time.time() - t0) * 100
        # roundtrips on first session
        rts = []
        rterr = None
        for i in range(5):
            dt, err = tool.roundtrip(iso, f"{PREFIX}{tool.name}-0", f"rt{n}_{i}")
            if dt is None:
                rterr = err
                break
            rts.append(dt)
        # client-exit survival: sessions were created by short-lived CLI
        # subprocesses (now gone); verify worker still responds
        alive = {}
        for name in created[: min(n, 5)]:
            dt, err = tool.roundtrip(iso, name, "alive_probe")
            alive[name] = dt is not None
        res["counts"][str(n)] = {
            "create_s_median": round(statistics.median(t_creates), 4) if t_creates else None,
            "create_s_p95": round(sorted(t_creates)[-1], 4) if len(t_creates) > 1 else None,
            "create_errors": errs[:3],
            "server_rss_mb": round(rss, 1),
            "rss_context": iso.ctx(),
            "idle_cpu_pct": round(cpu_pct, 3),
            "roundtrip_s_median": round(statistics.median(rts), 4) if rts else None,
            "roundtrip_s_p95": round(sorted(rts)[-1], 4) if len(rts) > 1 else None,
            "roundtrip_error": rterr,
            "sessions_alive_after_client_exit": alive,
        }
        note(f"{tool.name} n={n}: rss={rss:.1f}MB cpu={cpu_pct:.2f}% create_med="
             f"{statistics.median(t_creates) if t_creates else -1:.3f}s")

    # kill -9 the server, then check workloads and reattachability
    workload_names = [f"{PREFIX}{tool.name}-0"]
    pids_before = tool.session_pids(iso, workload_names[0])
    tool.stop_server(kill9=True)
    time.sleep(1.0)
    pids_after = []
    for p in pids_before:
        _, out, _ = sh(["ps", "-o", "pid=,args=", "-p", str(p)])
        if out.strip():
            pids_after.append(int(out.split()[0]))
    # restart server, see what is addressable
    tool2 = tool.__class__()
    tool2.start_server(iso)
    time.sleep(1.0)
    lst = []
    t0 = time.time()
    while time.time() - t0 < 5:
        lst = tool2.list_sessions(iso)
        if lst:
            break
        time.sleep(0.3)
    dt, err = tool2.roundtrip(iso, workload_names[0], "after_kill9") if lst else (None, "no sessions listed")
    res["kill9"] = {
        "workload_pids_before": pids_before,
        "workload_pids_alive_after": pids_after,
        "sessions_listed_after_restart": lst,
        "roundtrip_after_restart": dt if dt is None else round(dt, 4),
        "roundtrip_after_restart_error": None if dt is not None else err,
    }
    note(f"{tool.name} kill9: alive_after={pids_after} listed_after_restart={lst}")
    # cleanup: close remaining sessions by exact name, stop restarted server
    for name in set(lst):
        tool2.close_session(iso, name)
    tool2.stop_server(kill9=True)
    time.sleep(0.5)
    return res


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--tools", default="tmux,herdr,zmx")
    ap.add_argument("--out", default=str(HERE / "results-term-fallback.json"))
    ap.add_argument("--tmp-parent", default=str(pathlib.Path("/home/own-agents/tmp-termfb")))
    a = ap.parse_args()
    parent = Path(a.tmp_parent)
    parent.mkdir(parents=True, exist_ok=True)
    tools = {"tmux": TmuxTool, "herdr": HerdrTool, "zmx": ZmxTool}
    res = {"date": time.strftime("%Y-%m-%dT%H:%M:%S"), "host": os.uname().nodename,
           "kernel": os.uname().release, "tools": {}}
    for name in a.tools.split(","):
        cls = tools[name]
        note(f"=== {name} start ===")
        t0 = time.time()
        try:
            with tempfile.TemporaryDirectory(prefix=f"bench-{name}-", dir=str(parent)) as td:
                # Isolation expects parent; create under it
                res["tools"][name] = bench_tool(cls(), Path(td))
        except Exception as e:
            import traceback
            res["tools"][name] = {"error": repr(e), "trace": traceback.format_exc()[-1500:]}
        note(f"=== {name} done in {time.time() - t0:.1f}s ===")
    # per-added-session RSS slope
    for name, r in res["tools"].items():
        if "counts" not in r:
            continue
        pts = [(int(k), v["server_rss_mb"]) for k, v in r["counts"].items()
               if v.get("server_rss_mb") is not None]
        if len(pts) >= 2:
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            mx, my = statistics.mean(xs), statistics.mean(ys)
            slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sum((x - mx) ** 2 for x in xs)
            r["rss_mb_per_session"] = round(slope, 2)
            r["rss_idle_server_mb"] = round(my - slope * mx, 1)
    Path(a.out).write_text(json.dumps(res, indent=2))
    print(json.dumps(res, indent=2))


if __name__ == "__main__":
    main()
