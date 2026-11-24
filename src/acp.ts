// ACP agent-session lane (port of the legacy/python ACP path, inlined).
//
// The Python daemon spawned an external `fleet-acp` wrapper that spoke Agent Client
// Protocol JSON-RPC 2.0 (ndjson over the agent's stdin/stdout) and printed a
// `{"sessionId": ...}` line for the dispatcher to persist. This port speaks the protocol
// directly: the daemon spawns the agent command from a registry file (same
// {"<name>": {"command": ..., "args": [...]}} format), runs initialize, session/new or
// session/load, then session/prompt and waits for the stopReason. Protocol subset per the
// lane contract: session/new, session/load, session/prompt, session/cancel, and the
// session/update + session/request_permission notifications needed to detect completion.
// The registry default mirrors the bench: bench/agents.stub.json next to the repo root.

import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { env, dbPath } from "./env.ts";
import * as q from "./queue.ts";
import { Database } from "@cutils/sqlite";
// Effect v4 for the request/response lifetime: Effect.callback replaces the
// hand-rolled 10ms poll loop, and acquireRelease scopes the agent process to
// the session turn. Deep function-style imports, like daemon.ts.
import { callback, fail, flatMap, gen, runPromise, scoped, succeed } from "effect/Effect";
import type { Effect } from "effect/Effect";

export const PROTOCOL_VERSION = 1;

export interface AgentSpec {
  command: string;
  args: string[];
}

export interface AcpOutcome {
  sessionId: string;
  stopReason: string;
  promptError: string | null;
  exitCode: number | null;
}

// Registry lookup: a JSON file mapping agent names to {command, args}. Resolve order
// mirrors the Python lane: explicit --registry beats the default next to the repo root.
export function loadRegistry(p: string | null): Record<string, AgentSpec> {
  const file = p === null || p === "" ? path.resolve("bench", "agents.stub.json") : path.resolve(p);
  const text = fs.readFileSync(file, "utf8");
  const raw = JSON.parse(text) as Record<string, { command: string; args?: string[] }>;
  const out: Record<string, AgentSpec> = {};
  for (const name of Object.keys(raw)) {
    const spec = raw[name];
    out[name] = { command: spec.command, args: spec.args === undefined ? [] : spec.args };
  }
  return out;
}

// JSON-RPC 2.0 framing types. scriptc subset: concrete, no unions with undefined members.
export interface RpcResponse {
  id: number;
  result: Record<string, unknown> | null;
  error: { code: number; message: string } | null;
}

export interface RpcNotification {
  method: string;
  params: Record<string, unknown>;
}

// One newline-delimited JSON-RPC message off the agent's stdout, tagged by shape.
export interface AgentMessage {
  response: RpcResponse | null;
  notification: RpcNotification | null;
}

export function parseAgentLine(line: string): AgentMessage | null {
  const s = line.trim();
  if (s === "") {
    return null;
  }
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null; // non-JSON noise on stdout is skipped, like the Python read loop
  }
  const hasId = msg["id"] !== undefined && msg["id"] !== null;
  const hasResultOrError = msg["result"] !== undefined || msg["error"] !== undefined;
  if (hasId && hasResultOrError) {
    const err = msg["error"] as { code: number; message: string } | null | undefined;
    return {
      response: {
        id: msg["id"] as number,
        result: (msg["result"] as Record<string, unknown> | undefined) === undefined ? null : (msg["result"] as Record<string, unknown>),
        error: err === undefined || err === null ? null : { code: err.code, message: err.message },
      },
      notification: null,
    };
  }
  if (msg["method"] !== undefined) {
    const params = msg["params"] as Record<string, unknown> | undefined;
    return { response: null, notification: { method: msg["method"] as string, params: params === undefined ? {} : params } };
  }
  return null;
}

// The stopReason of a session/prompt result: "end_turn" when absent, like the bench client.
export function stopReasonOf(result: Record<string, unknown> | null): string {
  if (result !== null && typeof result["stopReason"] === "string") {
    return result["stopReason"];
  }
  return "end_turn";
}

interface PendingSlot {
  resolved: boolean;
  response: RpcResponse | null;
  resume: ((e: Effect<RpcResponse, Error>) => void) | null;
}

// A failed RPC response as an Effect error. A plain function, not an inline
// effect constructor call inside callback bodies, so the shape stays obvious.
function failRequest(message: string): Effect<RpcResponse, Error> {
  return fail(new Error(message));
}

// mapResponse: the protocol calls all answer with an RpcResponse whose
// `error` field carries the failure. This turns one into an Effect that
// fails with an Error, so the turn program reads as ordinary Effect code.
function mapResponse<A>(f: (r: RpcResponse) => A): (self: Effect<RpcResponse, Error>) => Effect<A, Error> {
  return (self) =>
    flatMap(self, (r) => {
      try {
        return succeed(f(r));
      } catch (e) {
        return fail(e instanceof Error ? e : new Error(String(e)));
      }
    });
}

// Minimal ACP client over a child process's stdin/stdout. The daemon calls request()
// (fire and await), notify() and reads agent notifications through the onNotification
// callback; session/update chunks are ignored beyond completion detection.
export class AcpClient {
  private proc: cp.ChildProcess;
  private nextId = 1;
  // A Map, not a Record: `delete map.get(key)` compiles under scriptc where
  // `delete obj[numberKey]` is SC1090, and the daemon needs this file static.
  private pending = new Map<number, PendingSlot>();
  private buffer = "";
  private closed = false;

  constructor(proc: cp.ChildProcess, onNotification: (n: RpcNotification) => void) {
    this.proc = proc;
    const stdout = proc.stdout;
    if (stdout !== null && stdout !== undefined) {
      stdout.setEncoding("utf8");
      stdout.on("data", (chunk: string) => {
        this.buffer = this.buffer + chunk;
        this.drain(onNotification);
      });
      stdout.on("end", () => {
        this.closed = true;
        this.failAll("agent stdout closed");
      });
      stdout.on("error", () => {
        this.closed = true;
        this.failAll("agent stdout error");
      });
    }
  }

  private drain(onNotification: (n: RpcNotification) => void): void {
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl === -1) {
        return;
      }
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      const msg = parseAgentLine(line);
      if (msg === null) {
        continue;
      }
      if (msg.response !== null) {
        const slot = this.pending.get(msg.response.id);
        if (slot !== undefined && !slot.resolved) {
          slot.resolved = true;
          slot.response = msg.response;
          if (slot.resume !== null) {
            this.pending.delete(msg.response.id);
            const resume = slot.resume;
            slot.resume = null;
            resume(succeed(msg.response));
          }
        }
      } else if (msg.notification !== null) {
        onNotification(msg.notification);
      }
    }
  }

  private failAll(reason: string): void {
    for (const key of [...this.pending.keys()]) {
      const slot = this.pending.get(key);
      if (slot !== undefined && !slot.resolved) {
        slot.resolved = true;
        this.pending.delete(key);
        if (slot.resume !== null) {
          const resume = slot.resume;
          slot.resume = null;
          resume(succeed({ id: key, result: null, error: { code: -32000, message: reason } }));
        }
      }
    }
  }

  private send(msg: Record<string, unknown>): void {
    const stdin = this.proc.stdin;
    if (stdin === null || stdin === undefined || this.closed) {
      throw new Error("agent stdin closed");
    }
    stdin.write(JSON.stringify(msg) + "\n");
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method: method, params: params });
  }

  // request: send one JSON-RPC call and wait for its response. Effect.callback
  // replaces the hand-rolled 10ms poll loop: the response resumes the effect
  // directly, and the timeout is one timer instead of a poll that re-checks
  // the clock every 10ms.
  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<RpcResponse> {
    return runPromise(this.requestEffect(method, params, timeoutMs));
  }

  requestEffect(method: string, params: Record<string, unknown>, timeoutMs: number): Effect<RpcResponse, Error> {
    const rid = this.nextId;
    this.nextId = this.nextId + 1;
    const slot: PendingSlot = { resolved: false, response: null, resume: null };
    this.pending.set(rid, slot);
    try {
      this.send({ jsonrpc: "2.0", id: rid, method: method, params: params });
    } catch (e) {
      this.pending.delete(rid);
      return failRequest(e instanceof Error ? e.message : String(e));
    }
    return callback<RpcResponse, Error>((resume) => {
      slot.resume = resume;
      const timer: NodeJS.Timeout = setTimeout(() => {
        const current = this.pending.get(rid);
        if (current !== undefined && !current.resolved) {
          current.resolved = true;
          this.pending.delete(rid);
          if (current.resume !== null) {
            const r = current.resume;
            current.resume = null;
            r(failRequest(method + " timed out"));
          }
        }
      }, timeoutMs);
      // The timer must not keep the process alive on its own. The cast is
      // narrowed to a named interface (not an inline object type) so scriptc
      // can lower the method call.
      // The timer must not keep the process alive on its own.
      timer.unref();
    });
  }

  // initialize: verify the protocol handshake before any session work.
  async initialize(): Promise<void> {
    await this.initializeEffect();
  }

  // The Effect-shaped siblings of the four protocol calls. The async ones are
  // thin wrappers over these, so the daemon can drive the turn as one Effect
  // program while the tests can still await a promise.
  initializeEffect(): Effect<void, Error> {
    return this.requestEffect("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} }, 30000).pipe(mapResponse((r) => {
      if (r.error !== null) {
        throw new Error("initialize failed: " + r.error.message);
      }
    }));
  }

  newSessionEffect(cwd: string): Effect<string, Error> {
    return this.requestEffect("session/new", { cwd: cwd, mcpServers: [] }, 60000).pipe(mapResponse((r) => {
      if (r.error !== null || r.result === null) {
        throw new Error("session/new failed: " + (r.error === null ? "no result" : r.error.message));
      }
      return String(r.result["sessionId"]);
    }));
  }

  loadSessionEffect(sessionId: string, cwd: string): Effect<void, Error> {
    return this.requestEffect("session/load", { sessionId: sessionId, cwd: cwd, mcpServers: [] }, 60000).pipe(mapResponse((r) => {
      if (r.error !== null) {
        throw new Error("session/load failed: " + r.error.message);
      }
    }));
  }

  promptEffect(sessionId: string, text: string): Effect<string, Error> {
    return this.requestEffect("session/prompt", { sessionId: sessionId, prompt: [{ type: "text", text: text }] }, 3600000).pipe(mapResponse((r) => {
      if (r.error !== null) {
        throw new Error("session/prompt failed: " + r.error.message);
      }
      return stopReasonOf(r.result);
    }));
  }

  async newSession(cwd: string): Promise<string> {
    return runPromise(this.newSessionEffect(cwd));
  }

  async loadSession(sessionId: string, cwd: string): Promise<void> {
    await runPromise(this.loadSessionEffect(sessionId, cwd));
  }

  async prompt(sessionId: string, text: string): Promise<string> {
    return runPromise(this.promptEffect(sessionId, text));
  }

  cancel(sessionId: string): boolean {
    // Best-effort notification, like the Python _acp_cancel: failures are swallowed.
    try {
      this.notify("session/cancel", { sessionId: sessionId });
      return true;
    } catch {
      return false;
    }
  }
}

// Resolve the agent command. COORDINATE_ACP_CMD ("node /path/to/agent.js", shlex-free:
// split on spaces) overrides the registry, mirroring the env override the Python daemon
// used for its fleet-acp wrapper.
export function agentCommand(spec: AgentSpec): string[] {
  const override = env("ACP_CMD");
  if (override !== null && override !== "") {
    return override.split(" ").filter((t) => t !== "");
  }
  const out: string[] = [spec.command];
  for (const a of spec.args) {
    out.push(a);
  }
  return out;
}

export interface AcpPayload {
  agent: string;
  cwd: string;
  prompt: string;
  registry: string | null;
  session: string | null;
}

export function isAcpPayload(p: q.Payload): boolean {
  return typeof (p as unknown as Record<string, unknown>)["agent"] === "string";
}

export function acpPayloadOf(p: q.Payload): AcpPayload {
  const r = p as unknown as Record<string, unknown>;
  return {
    agent: String(r["agent"]),
    cwd: r["cwd"] === null || r["cwd"] === undefined ? process.cwd() : String(r["cwd"]),
    prompt: String(r["prompt"]),
    registry: (r["registry"] === undefined ? null : String(r["registry"])) || null,
    session: (r["session"] === undefined || r["session"] === null ? null : String(r["session"])) || null,
  };
}

export function agentPidFile(jid: number): string {
  return path.join(path.dirname(path.resolve(dbPath())), "pids", jid + ".agent");
}

export interface AcpHandle {
  proc: cp.ChildProcess;
  client: AcpClient;
  jid: number;
  settled: boolean;
  done: boolean;
  exitCode: number | null;
  failure: string | null;
  sessionId: string | null;
}

// startAcpJob: the daemon-side lane entry (port of daemon.py spawn_acp + the client loop
// that used to live in the fleet-acp wrapper). Spawns the agent synchronously (detached,
// own process group, stdin/stdout pipes), persists the pid in <db-dir>/pids/<jid>.agent,
// then runs initialize -> session/new|session/load -> session/prompt on the returned
// promise. The sessionId is persisted into the job payload the moment it exists
// (q.setSession) so a restarted dispatcher resumes the SAME session via session/load.
// Completion is the prompt response (stopReason); `settled` flips when the turn ends.
export function startAcpJob(db: Database, jid: number, owner: string, payload: AcpPayload, jobEnv: Record<string, string>): AcpHandle {
  const registry = loadRegistry(payload.registry);
  const spec = registry[payload.agent];
  if (spec === undefined) {
    throw new Error("unknown acp agent: " + payload.agent);
  }
  const cmd = agentCommand(spec);
  const pidfile = agentPidFile(jid);
  fs.mkdirSync(path.dirname(pidfile), { recursive: true });
  try {
    fs.unlinkSync(pidfile);
  } catch {
    // not there
  }
  const proc = cp.spawn(cmd[0], cmd.slice(1), {
    cwd: payload.cwd,
    detached: true,
    env: jobEnv,
    stdio: ["pipe", "pipe", "inherit"],
  });
  if (proc.pid === undefined || proc.pid === null) {
    throw new Error("acp agent spawn failed: " + cmd[0]);
  }
  try {
    fs.writeFileSync(pidfile, String(proc.pid) + "\n");
  } catch {
    // the pidfile is best-effort for the reaper
  }
  q.setProc(db, jid, owner, proc.pid);
  const handle: AcpHandle = {
    proc,
    client: new AcpClient(proc, (_n) => {}),
    jid,
    settled: false,
    done: false,
    exitCode: null,
    failure: null,
    sessionId: payload.session,
  };
  proc.on("exit", (code: number | null) => {
    handle.exitCode = code;
  });
  const drive = async (): Promise<void> => {
    // The agent process is the resource; acquireRelease scopes its lifetime to
    // the turn, so the release (terminate the group, close stdin, drop the
    // pidfile) runs on every exit path, whether the turn ended or failed.
    const program = scoped(
      gen(function* () {
        const stop = yield* gen(function* () {
          yield* handle.client.initializeEffect();
          if (payload.session !== null && payload.session !== "") {
            yield* handle.client.loadSessionEffect(payload.session, payload.cwd);
            handle.sessionId = payload.session;
          } else {
            const created = yield* handle.client.newSessionEffect(payload.cwd);
            handle.sessionId = created;
            q.setSession(db, jid, owner, created);
          }
          return yield* handle.client.promptEffect(handle.sessionId === null ? "" : handle.sessionId, payload.prompt);
        });
        handle.done = true;
        handle.failure = stop === "end_turn" ? null : "stopReason: " + stop;
      }),
    );
    try {
      await runPromise(program);
    } catch (e) {
      handle.failure = e instanceof Error ? e.message : String(e);
    } finally {
      handle.settled = true;
      releaseAgent(proc, pidfile);
    }
  };
  void drive();
  return handle;
}

// releaseAgent: terminate the agent's process group and drop its pidfile.
// The wrapper's teardown, kept as a plain function so the acquireRelease
// release and the failure path share one implementation.
function releaseAgent(proc: cp.ChildProcess, pidfile: string): void {
  const pid = proc.pid;
  if (pid !== undefined && pid !== null) {
    try {
      if (process.platform !== "win32") {
        process.kill(-pid, "SIGTERM");
      } else {
        process.kill(pid, "SIGTERM");
      }
    } catch {
      // already gone
    }
  }
  const stdin = proc.stdin;
  if (stdin !== null && stdin !== undefined) {
    stdin.end();
  }
  proc.unref();
  try {
    fs.unlinkSync(pidfile);
  } catch {
    // already gone
  }
}

// Completion check for the daemon poll: an ACP job is finished when the spawnAcpJob
// promise settled (failure set on error, done set on a normal turn end).
export function acpFinished(h: AcpHandle): boolean {
  return h.done || h.failure !== null;
}
