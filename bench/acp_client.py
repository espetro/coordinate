#!/usr/bin/env python3
"""Minimal ACP client for the bench. Stdlib only.

Mirrors the CLI surface fleet's daemon expects (same flags and stdout contract as
fleet-acp): it speaks Agent Client Protocol JSON-RPC 2.0 (ndjson) to an agent process
spawned from a registry file, so the bench can drive fleet's ACP job path without any
node dependency.

  python bench/acp_client.py run <agent> --cwd DIR --prompt TEXT
      [--session ID] [--registry FILE] [--pid-file FILE] [--model ID]

Registry format (same as fleet-acp's agents.json):
  {"stub": {"command": "/usr/bin/python3", "args": ["/path/bench/stub_acp_agent.py"]}}

Stdout contract: first line {"sessionId": ...} as soon as the session exists, then
{"stopReason": ...} when the turn ends. Exit 0 when the turn ended normally.
"""
import argparse
import json
import os
import signal
import subprocess
import sys
import threading
import time

PROTOCOL_VERSION = 1


class Client:
    def __init__(self, proc: subprocess.Popen):
        self.proc = proc
        self.next_id = 1
        self.pending: dict[int, dict] = {}
        self.lock = threading.Lock()
        self.cv = threading.Condition(self.lock)
        self.turn_stop_reason = None
        self.session_id = None
        self.thread = threading.Thread(target=self._read_loop, daemon=True)
        self.thread.start()

    # ---- transport -------------------------------------------------------
    def _send(self, msg: dict):
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

    def notify(self, method: str, params: dict):
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def request(self, method: str, params: dict, timeout: float = 120) -> dict:
        with self.cv:
            rid = self.next_id
            self.next_id += 1
            self.pending[rid] = {}
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        deadline = time.time() + timeout
        with self.cv:
            while rid not in self.pending or "result" not in self.pending[rid]:
                if rid in self.pending and "error" in self.pending[rid]:
                    raise RuntimeError(f"{method} failed: {self.pending[rid]['error']}")
                if not self.cv.wait(timeout=max(0.1, deadline - time.time())):
                    raise TimeoutError(f"{method} timed out")
        with self.cv:
            slot = self.pending.pop(rid)
        if "error" in slot:
            raise RuntimeError(f"{method} failed: {slot['error']}")
        return slot.get("result", {})

    def _read_loop(self):
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if "id" in msg and ("result" in msg or "error" in msg):
                with self.cv:
                    self.pending.setdefault(msg["id"], {}).update(
                        {"result": msg.get("result")} if "result" in msg else {"error": msg.get("error")})
                    self.cv.notify_all()
            elif "method" in msg and "id" in msg:
                self._handle_agent_request(msg)
            elif "method" in msg:
                self._handle_agent_notification(msg)

    def _handle_agent_request(self, msg):
        method = msg.get("method")
        result = {}
        if method == "session/request_permission":
            options = (msg.get("params") or {}).get("options") or []
            if options:
                first = options[0]
                result = {"outcome": {"outcome": "selected", "optionId": first.get("optionId", first.get("id"))}}
            else:
                result = {"outcome": {"outcome": "cancelled"}}
        self._send({"jsonrpc": "2.0", "id": msg["id"], "result": result})

    def _handle_agent_notification(self, msg):
        if msg.get("method") == "session/update":
            params = msg.get("params") or {}
            if params.get("sessionId") and self.session_id is None:
                self.session_id = params["sessionId"]

    # ---- acp session -----------------------------------------------------
    def initialize(self):
        r = self.request("initialize", {"protocolVersion": PROTOCOL_VERSION, "clientCapabilities": {}})
        return r

    def new_session(self, cwd):
        return self.request("session/new", {"cwd": cwd, "mcpServers": []})

    def load_session(self, sid, cwd):
        return self.request("session/load", {"sessionId": sid, "cwd": cwd, "mcpServers": []})

    def prompt(self, sid, text):
        return self.request("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": text}]},
                            timeout=3600)

    def cancel(self, sid):
        try:
            self.notify("session/cancel", {"sessionId": sid})
        except OSError:
            pass


def load_registry(path):
    with open(path) as f:
        return json.load(f)


def _stdin_cancel_forwarder(client: "Client", sid_getter) -> None:
    """Forward an incoming session/cancel notification (from the dispatcher) to the agent.

    The daemon writes ACP JSON-RPC to this process's stdin; without this thread the
    notification would sit unread while `prompt` blocks on the agent's reply."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if msg.get("method") == "session/cancel":
            client.cancel(sid_getter())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("verb")
    ap.add_argument("agent")
    ap.add_argument("--cwd", required=True)
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--session", default=None)
    ap.add_argument("--registry", default=None)
    ap.add_argument("--pid-file", default=None)
    ap.add_argument("--model", default=None)
    a = ap.parse_args()
    if a.verb != "run":
        sys.stderr.write("usage: acp_client.py run <agent> --cwd DIR --prompt TEXT [--session ID]\n")
        return 2

    registry = load_registry(a.registry or os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                        "agents.stub.json"))
    if a.agent not in registry:
        sys.stderr.write(f"unknown agent {a.agent}\n")
        return 2
    spec = registry[a.agent]
    cmd = [spec["command"], *(spec.get("args") or [])]
    # The agent runs detached (own session and process group) so the daemon's reaper can
    # kill the whole tree through the pid file, exactly like fleet-acp does.
    proc = subprocess.Popen(cmd, cwd=a.cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            text=True, start_new_session=True)
    if a.pid_file:
        os.makedirs(os.path.dirname(os.path.abspath(a.pid_file)), exist_ok=True)
        with open(a.pid_file, "w") as f:
            f.write(str(proc.pid))

    client = Client(proc)
    sid = a.session
    threading.Thread(target=_stdin_cancel_forwarder, args=(client, lambda: sid),
                     daemon=True).start()
    try:
        client.initialize()
        if sid:
            client.load_session(sid, a.cwd)
        else:
            r = client.new_session(a.cwd)
            sid = r.get("sessionId")
        sys.stdout.write(json.dumps({"sessionId": sid}) + "\n")
        sys.stdout.flush()
        res = client.prompt(sid, a.prompt)
        stop = res.get("stopReason", "end_turn")
        sys.stdout.write(json.dumps({"stopReason": stop}) + "\n")
        sys.stdout.flush()
        return 0 if stop == "end_turn" else 1
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"acp_client: {e}\n")
        return 1
    finally:
        if sid:
            client.cancel(sid)
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass


if __name__ == "__main__":
    sys.exit(main())
