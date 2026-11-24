// Stub ACP agent for the TypeScript tests: a JS port of legacy/python bench/stub_acp_agent.py
// speaking just enough JSON-RPC 2.0 ndjson over stdio (initialize, session/new, session/load,
// session/prompt, session/cancel). Session state lands in .stub-acp-sessions.json in cwd so a
// resumed session reports turns_done across agent process restarts.

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const STATE_NAME = ".stub-acp-sessions.json";

function statePath() {
  return path.join(process.cwd(), STATE_NAME);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), "utf8"));
  } catch {
    return { sessions: {} };
  }
}

function saveState(st) {
  const tmp = statePath() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(st));
  fs.renameSync(tmp, statePath());
}

const cancelled = new Set();

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function turn(sid) {
  const st = loadState();
  const s = st.sessions[sid];
  s.turns_started = s.turns_started + 1;
  saveState(st);
  const n = Number(process.env["STUB_CHUNKS"] || "5");
  const dur = Number(process.env["STUB_TURN_MS"] || "500");
  const step = dur / Math.max(n, 1);
  const forever = process.env["STUB_FOREVER"] === "1";
  if (forever) {
    for (;;) {
      await sleep(200);
      if (cancelled.has(sid)) {
        return "cancelled";
      }
    }
  }
  for (let i = 0; i < n; i++) {
    if (cancelled.has(sid)) {
      break;
    }
    await sleep(step);
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "stub chunk " + i } } } });
  }
  const stop = cancelled.has(sid) ? "cancelled" : "end_turn";
  const st2 = loadState();
  st2.sessions[sid].turns_done = st2.sessions[sid].turns_done + 1;
  st2.sessions[sid].stop = stop;
  saveState(st2);
  return stop;
}

async function handle(msg) {
  const method = msg["method"] === undefined ? "" : String(msg["method"]);
  const params = msg["params"] === undefined ? {} : msg["params"];
  const id = msg["id"];
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id: id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "stub-acp-agent", version: "1.0" } } });
  } else if (method === "session/new") {
    const sid = "stub-" + process.pid + "-" + Date.now();
    const st = loadState();
    st.sessions[sid] = { turns_done: 0, turns_started: 0, loads: 0, stop: "" };
    saveState(st);
    send({ jsonrpc: "2.0", id: id, result: { sessionId: sid } });
  } else if (method === "session/load") {
    const sid = String(params["sessionId"]);
    const st = loadState();
    if (!(sid in st.sessions)) {
      send({ jsonrpc: "2.0", id: id, error: { code: -32001, message: "unknown session " + sid } });
      return;
    }
    st.sessions[sid].loads = st.sessions[sid].loads + 1;
    saveState(st);
    send({ jsonrpc: "2.0", id: id, result: {} });
  } else if (method === "session/prompt") {
    const sid = String(params["sessionId"]);
    const stop = await turn(sid);
    send({ jsonrpc: "2.0", id: id, result: { stopReason: stop } });
  } else if (method === "session/cancel") {
    cancelled.add(String(params["sessionId"]));
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id: id, error: { code: -32601, message: "method not found: " + method } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const s = line.trim();
  if (s === "") {
    return;
  }
  let msg;
  try {
    msg = JSON.parse(s);
  } catch {
    return;
  }
  void handle(msg);
});
rl.on("close", () => {
  process.exit(0);
});
