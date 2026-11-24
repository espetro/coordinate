// Minimal ACP client for the real-agent bench. Node stdlib only; run with
// `node acp-client.ts` (type stripping needs node >= 22.18).
//
// Mirrors the stdout contract the Python bench client used (first line the
// sessionId, second the stopReason) so artifacts and drivers stay compatible:
//
//   node acp-client.ts run <agent> --cwd DIR --prompt TEXT
//       [--session ID] [--registry FILE] [--pid-file FILE]
//
// Registry format:
//   {"maki-glm45air": {"command": "maki", "args": ["acp", "-m", "..."]}}
//
// The agent is spawned detached in its own process group; on exit the whole
// group is SIGTERMed then SIGKILLed, matching the reaper contract.

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PROTOCOL_VERSION = 1;

function trace(event: string, tMs: number): void {
  if (process.env.ACP_TRACE !== "1") return;
  try {
    fs.appendFileSync(
      ".acp-trace.jsonl",
      JSON.stringify({
        job: process.env.COORDINATE_JOB_ID,
        event,
        t_ms: Math.round(tMs * 10) / 10,
        epoch: Date.now() / 1000,
      }) + "\n",
    );
  } catch {
    // tracing is best-effort
  }
}

interface JsonRpc {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

class Client {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buf = "";
  private stopped = false;

  private proc: ChildProcess;

  constructor(proc: ChildProcess) {
    this.proc = proc;
    proc.stdout!.on("data", (d: Buffer) => this.onData(d.toString("utf8")));
    // Forward session/cancel notifications written to our stdin by the driver.
    // unref() so an open stdin held by the job shell cannot keep us alive past
    // the prompt's completion.
    (process.stdin as unknown as { unref?: () => void }).unref?.();
    let inBuf = "";
    process.stdin.on("data", (d: Buffer) => {
      inBuf += d.toString("utf8");
      let i: number;
      while ((i = inBuf.indexOf("\n")) >= 0) {
        const line = inBuf.slice(0, i).trim();
        inBuf = inBuf.slice(i + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as JsonRpc;
          if (msg.method === "session/cancel" && this.sessionId) {
            this.notify("session/cancel", { sessionId: this.sessionId });
          }
        } catch {
          // ignore non-JSON input
        }
      }
    });
  }

  sessionId: string | null = null;

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: JsonRpc;
      try {
        msg = JSON.parse(line) as JsonRpc;
      } catch {
        continue;
      }
      if (msg.id !== undefined && msg.method === undefined) {
        const slot = this.pending.get(msg.id);
        if (slot) {
          this.pending.delete(msg.id);
          if (msg.error !== undefined && msg.error !== null) slot.reject(new Error(JSON.stringify(msg.error)));
          else slot.resolve(msg.result);
        }
      } else if (msg.id !== undefined && msg.method !== undefined) {
        this.handleAgentRequest(msg);
      } else if (msg.method !== undefined) {
        this.handleAgentNotification(msg);
      }
    }
  }

  private send(msg: JsonRpc): void {
    this.proc.stdin!.write(JSON.stringify(msg) + "\n");
  }

  private handleAgentRequest(msg: JsonRpc): void {
    let result: unknown = {};
    if (msg.method === "session/request_permission") {
      const options = ((msg.params ?? {}).options ?? []) as { optionId?: string; id?: string }[];
      if (options.length > 0) {
        result = { outcome: { outcome: "selected", optionId: options[0].optionId ?? options[0].id } };
      } else {
        result = { outcome: { outcome: "cancelled" } };
      }
    }
    this.send({ jsonrpc: "2.0", id: msg.id, result });
  }

  private handleAgentNotification(msg: JsonRpc): void {
    if (msg.method === "session/update") {
      const sid = (msg.params ?? {}).sessionId;
      if (typeof sid === "string" && this.sessionId === null) this.sessionId = sid;
    }
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 120_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const t = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, timeoutMs);
      t.unref();
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[++i] ?? "";
  }
  return out;
}

async function main(): Promise<number> {
  const [verb, agent, ...rest] = process.argv.slice(2);
  const a = parseArgs(rest);
  if (verb !== "run" || !agent || !a.cwd || a.prompt === undefined) {
    process.stderr.write(
      "usage: acp-client.ts run <agent> --cwd DIR --prompt TEXT [--session ID] [--registry FILE] [--pid-file FILE]\n",
    );
    return 2;
  }
  const registryPath = a.registry ?? path.join(path.dirname(new URL(import.meta.url).pathname), "agents.real.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8")) as Record<
    string,
    { command: string; args?: string[] }
  >;
  const spec = registry[agent];
  if (!spec) {
    process.stderr.write(`unknown agent ${agent}\n`);
    return 2;
  }

  const proc = spawn(spec.command, spec.args ?? [], {
    cwd: a.cwd,
    stdio: ["pipe", "pipe", "inherit"],
    detached: true, // own process group, like the Python client
  });
  proc.on("error", (e) => process.stderr.write(`acp-client: spawn failed: ${e.message}\n`));
  if (a["pid-file"]) {
    fs.mkdirSync(path.dirname(path.resolve(a["pid-file"])), { recursive: true });
    fs.writeFileSync(a["pid-file"], String(proc.pid));
  }

  const client = new Client(proc);
  let sid: string | null = a.session ?? null;
  let code = 1;
  try {
    const t0 = performance.now();
    trace("client_start", 0);
    await client.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
    trace("initialize_done", performance.now() - t0);
    if (sid) {
      await client.request("session/load", { sessionId: sid, cwd: a.cwd, mcpServers: [] });
      trace("session_load_done", performance.now() - t0);
    } else {
      const r = (await client.request("session/new", { cwd: a.cwd, mcpServers: [] })) as { sessionId?: string };
      sid = r.sessionId ?? null;
      trace("session_new_done", performance.now() - t0);
    }
    trace("session_ready", performance.now() - t0);
    fs.writeSync(1, JSON.stringify({ sessionId: sid }) + "\n");
    const res = (await client.request(
      "session/prompt",
      { sessionId: sid, prompt: [{ type: "text", text: a.prompt }] },
      3_600_000,
    )) as { stopReason?: string };
    const stop = res.stopReason ?? "end_turn";
    fs.writeSync(1, JSON.stringify({ stopReason: stop }) + "\n");
    code = stop === "end_turn" ? 0 : 1;
  } catch (e) {
    process.stderr.write(`acp-client: ${e instanceof Error ? e.message : String(e)}\n`);
    code = 1;
  }

  if (client.sessionId) {
    try {
      client.notify("session/cancel", { sessionId: client.sessionId });
    } catch {
      // process may already be gone
    }
  }
  const pid = proc.pid;
  if (pid) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // already gone
    }
    const gone = await new Promise<boolean>((r) => {
      const deadline = Date.now() + 3000;
      const check = setInterval(() => {
        try {
          process.kill(-pid, 0);
          if (Date.now() > deadline) {
            clearInterval(check);
            r(false);
          }
        } catch {
          clearInterval(check);
          r(true);
        }
      }, 100);
    });
    if (!gone) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  return code;
}

// Reap the agent without holding the loop: SIGKILL goes to the whole group but
// we do not wait on descendants, so lingering grandchildren cannot hang the job.
const exitCode = await main();
process.exit(exitCode);
