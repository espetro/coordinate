#!/usr/bin/env python3
"""Stub ACP agent for fleet bench scenarios. Stdlib only, no model calls.

Speaks enough Agent Client Protocol JSON-RPC 2.0 over stdio for fleet's ACP path
(bench/stub_acp_agent.py is passed to fleet-acp via a registry file):
- initialize (advertises loadSession)
- session/new (persists the session id to a state file)
- session/load (resume by id from the state file)
- session/prompt (a turn of configurable duration while streaming agent_message_chunk updates)
- session/cancel (ends the turn early with stopReason "cancelled")

State: one JSON file (default <cwd>/.stub-acp-sessions.json) mapping session id to a turn
counter, so a resumed session can report turns_done across agent process restarts.

Environment:
  STUB_TURN_MS   duration of one simulated turn in ms (default 2000)
  STUB_CHUNKS    number of streamed session/update notifications per turn (default 5)
  STUB_BALLAST_MB  MB of RSS ballast: this many MiB of bytes are allocated and touched
                 at startup and kept alive (default 0; use 60 for codex/maki-like,
                 240 for claude-like)

Usage (matches the ACP convention used by real harnesses): the client spawns this
process with cwd set, speaks JSON-RPC over stdin/stdout, one JSON object per line.
"""
import json
import os
import sys
import threading
import time

STATE_NAME = ".stub-acp-sessions.json"
CANCELLED = "cancelled"


def state_path():
    return os.path.join(os.getcwd(), STATE_NAME)


def load_state():
    try:
        with open(state_path()) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"sessions": {}}


def save_state(st):
    tmp = state_path() + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f)
    os.replace(tmp, state_path())


class Ballast:
    """Allocate and touch N MiB so RSS reflects it, keep a reference alive."""

    def __init__(self, mb: int):
        self.pages = bytearray(mb * 1024 * 1024)
        for i in range(0, len(self.pages), 4096):
            self.pages[i] = 1


class Agent:
    def __init__(self):
        self.state = load_state()
        self.cancelled: set[str] = set()
        self.lock = threading.Lock()
        self.ballast = None
        mb = int(os.environ.get("STUB_BALLAST_MB", "0") or 0)
        if mb > 0:
            self.ballast = Ballast(mb)

    def send(self, msg: dict):
        sys.stdout.write(json.dumps(msg) + "\n")
        sys.stdout.flush()

    def reply(self, msg: dict, result):
        self.send({"jsonrpc": "2.0", "id": msg.get("id"), "result": result})

    def error(self, msg: dict, code: int, message: str):
        self.send({"jsonrpc": "2.0", "id": msg.get("id"), "error": {"code": code, "message": message}})

    def notify(self, method: str, params: dict):
        self.send({"jsonrpc": "2.0", "method": method, "params": params})

    def turn(self, sid: str):
        """One simulated turn: stream STUB_CHUNKS updates over STUB_TURN_MS, then end_turn."""
        n = int(os.environ.get("STUB_CHUNKS", "5") or 5)
        dur = int(os.environ.get("STUB_TURN_MS", "2000") or 2000) / 1000
        step = dur / max(n, 1)
        with self.lock:
            s = self.state["sessions"].setdefault(sid, {"turns_done": 0, "turns_started": 0, "loads": 0})
            s["turns_started"] = s.get("turns_started", 0) + 1
        save_state(self.state)
        for i in range(n):
            if sid in self.cancelled:
                with self.lock:
                    self.state["sessions"][sid]["turns_done"] += 1
                    self.state["sessions"][sid]["stop"] = CANCELLED
                save_state(self.state)
                return CANCELLED
            time.sleep(step)
            self.notify("session/update", {"sessionId": sid, "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": f"stub chunk {i}"},
            }})
        with self.lock:
            self.state["sessions"][sid]["turns_done"] += 1
            self.state["sessions"][sid]["stop"] = "end_turn"
        save_state(self.state)
        return "end_turn"

    def handle(self, msg: dict):
        method = msg.get("method", "")
        params = msg.get("params") or {}
        if method == "initialize":
            self.reply(msg, {"protocolVersion": params.get("protocolVersion", 1),
                             "agentCapabilities": {"loadSession": True},
                             "agentInfo": {"name": "stub-acp-agent", "version": "1.0"}})
        elif method == "session/new":
            sid = f"stub-{os.getpid()}-{time.time_ns()}"
            with self.lock:
                self.state["sessions"][sid] = {"turns_done": 0}
            save_state(self.state)
            self.reply(msg, {"sessionId": sid})
        elif method == "session/load":
            sid = params.get("sessionId")
            with self.lock:
                known = sid in self.state["sessions"]
                if known:
                    self.state["sessions"][sid]["loads"] = self.state["sessions"][sid].get("loads", 0) + 1
            if not known:
                self.error(msg, -32001, f"unknown session {sid}")
                return
            save_state(self.state)
            self.reply(msg, {})
        elif method == "session/prompt":
            sid = params.get("sessionId")
            stop = self.turn(sid)
            self.reply(msg, {"stopReason": stop})
        elif method == "session/cancel":
            sid = params.get("sessionId")
            self.cancelled.add(sid)
        else:
            if "id" in msg:
                self.error(msg, -32601, f"method not found: {method}")

    def serve(self):
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if "method" in msg and "id" not in msg:
                self.handle(msg)  # notification, no reply
                continue
            # serve each request in a thread so cancel can arrive mid-turn
            threading.Thread(target=self.handle, args=(msg,), daemon=True).start()


if __name__ == "__main__":
    Agent().serve()
