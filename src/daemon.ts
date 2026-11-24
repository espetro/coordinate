// Dispatcher daemon: claim loop, subprocess execution, lease heartbeat, reaper.
// cmd jobs run as shell children; acp jobs (port of the Python ACP lane) go through
// spawnAcpJob in acp.ts: JSON-RPC over the agent's stdio, session persisted for resume.
// Python's Popen raised OSError synchronously and the loop recorded `failed` (daemon.py:307-309);
// node reports the same failures asynchronously as an `error` event on the ChildProcess, so
// spawnJob passes the running list down and spawnRaw marks the entry on error instead of
// letting the unhandled event crash the daemon.

import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configPath, dbPath } from "./env.ts";
import { Database } from "@cutils/sqlite";
import * as q from "./queue.ts";
import type { AcpHandle } from "./acp.ts";
import { acpPayloadOf, startAcpJob } from "./acp.ts";
import { ConfigError, DEFAULT_TOOL_CLASSES, slotLimit, toolClasses, validateConfig } from "./config.ts";

const BACKOFF_MAX = 2.0;
const BACKOFF_MIN = 0.05;
const SH = process.platform === "win32" ? "cmd.exe" : "/bin/sh";

interface Running {
  jid: number;
  proc: cp.ChildProcess;
  spawnErrored?: boolean;
}

// An in-flight ACP agent-session job: the spawnAcpJob promise drives the protocol
// (session/new or session/load, then session/prompt) and settles on completion.
interface RunningAcp {
  jid: number;
  handle: AcpHandle;
  settled: boolean;
}

class Parked {
  key: string;
  constructor(key: string) {
    this.key = key;
  }
}

function matchToolClass(argv0: string): { cls: string; cost: number } | null {
  const norm = path.normalize(argv0);
  const parts = norm.split(path.sep).filter((p) => p !== "");
  const names: Record<string, boolean> = {};
  names[path.basename(argv0)] = true;
  for (const p of parts) {
    names[p] = true;
  }
  for (const cls of Object.keys(toolClasses())) {
    const spec = toolClasses()[cls];
    for (const m of spec.match) {
      if (names[m] === true) {
        return { cls, cost: spec.cost };
      }
    }
  }
  return null;
}

function which(name: string): string | null {
  if (name.includes(path.sep)) {
    try {
      fs.accessSync(name, fs.constants.X_OK);
      return name;
    } catch {
      return null;
    }
  }
  const p = process.env["PATH"] || "";
  for (const d of p.split(path.delimiter)) {
    const full = path.join(d, name);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      // keep looking
    }
  }
  return null;
}

function projectKey(cwd: string | null): string {
  const start = path.resolve(cwd === null || cwd === undefined || cwd === "" ? process.cwd() : cwd);
  let d = start;
  for (;;) {
    const dot = path.join(d, ".git");
    if (fs.existsSync(dot)) {
      try {
        if (fs.statSync(dot).isDirectory()) {
          return d;
        }
        // .git file: worktree; resolve gitdir + commondir
        const text = fs.readFileSync(dot, "utf8");
        let gitdir: string | null = null;
        for (const line of text.split("\n")) {
          if (line.startsWith("gitdir:")) {
            gitdir = path.resolve(d, line.slice(7).trim());
            break;
          }
        }
        if (gitdir !== null) {
          const common = fs.readFileSync(path.join(gitdir, "commondir"), "utf8").trim();
          return path.dirname(path.resolve(gitdir, common));
        }
      } catch {
        // fall through to git probe
      }
      try {
        const out = cp.execFileSync("git", ["-C", d, "rev-parse", "--git-common-dir"], { timeout: 2000, encoding: "utf8" }).trim();
        if (out !== "") {
          const p = path.resolve(d, out);
          if (path.basename(p) === ".git") {
            return path.dirname(p);
          }
          return fs.existsSync(path.join(p, ".git")) ? p : path.dirname(p);
        }
      } catch {
        // not resolvable
      }
    }
    const parent = path.dirname(d);
    if (parent === d) {
      return start;
    }
    d = parent;
  }
}

function auditSpawn(db: Database, jid: number, argv0: string, cls: string, proj: string): void {
  db.prepareRaw("INSERT INTO spawn_audit(ts,job_id,argv0,tool_class,project) VALUES(?,?,?,?,?)").run([
    Date.now() / 1000,
    jid,
    argv0,
    cls,
    proj,
  ]);
}

function toolSlotKey(cls: string, proj: string): string {
  return "tool:" + cls + ":" + proj;
}

function acquireToolLease(db: Database, jid: number, key: string, cost: number): boolean {
  using _tx = db.transaction();
  db.exec("DELETE FROM concurrency_slots WHERE lease_expires_at < " + Date.now() / 1000);
  let used = 0;
  const rows = db.prepareRaw("SELECT COALESCE(SUM(cost),0) AS c FROM concurrency_slots WHERE key=?").all([key]) as { c: number }[];
  for (const r of rows) {
    used = r.c;
  }
  if (used + cost > slotLimit(key)) {
    return false;
  }
  db.prepareRaw("INSERT INTO concurrency_slots(key,lease_expires_at,job_id,cost) VALUES(?,?,?,?)").run([
    key,
    Date.now() / 1000 + q.LEASE_S,
    jid,
    cost,
  ]);
  return true;
}

interface DeadlineRow {
  deadline_at: number | null;
}

// Absolute epoch-second deadline of this attempt, set at claim; empty when the job has no cap.
function deadlineEnv(db: Database, jid: number): string {
  const rows = db.prepareRaw("SELECT deadline_at FROM jobs WHERE id=?").all([jid]) as DeadlineRow[];
  if (rows.length === 0 || rows[0].deadline_at === null) {
    return "";
  }
  return String(rows[0].deadline_at);
}

interface AttemptRow {
  attempts: number;
  max_attempts: number;
}

// Attempt numbers let a retried job detect replay and stay idempotent (D17:
// at-least-once execution means a killed attempt can replay side effects).
function attemptEnv(db: Database, jid: number): { attempt: string; maxAttempts: string } {
  const rows = db.prepareRaw("SELECT attempts, max_attempts FROM jobs WHERE id=?").all([jid]) as AttemptRow[];
  if (rows.length === 0) {
    return { attempt: "", maxAttempts: "" };
  }
  return { attempt: String(rows[0].attempts), maxAttempts: String(rows[0].max_attempts) };
}

function jobEnv(jid: number, deadlineAt: string, attempt: string, maxAttempts: string): Record<string, string> {
  const e: Record<string, string> = {};
  for (const k of Object.keys(process.env)) {
    const v = process.env[k];
    if (v !== undefined && !k.startsWith("COORDINATE_") && !k.startsWith("FLEET_")) {
      e[k] = v;
    }
  }
  e["COORDINATE_JOB_ID"] = String(jid);
  e["FLEET_JOB_ID"] = String(jid);
  e["COORDINATE_MACHINE"] = q.MACHINE;
  e["FLEET_MACHINE"] = q.MACHINE;
  e["COORDINATE_DB"] = dbPath();
  e["FLEET_DB"] = dbPath();
  e["COORDINATE_DEADLINE_AT"] = deadlineAt;
  e["FLEET_DEADLINE_AT"] = deadlineAt;
  e["COORDINATE_ATTEMPT"] = attempt;
  e["COORDINATE_MAX_ATTEMPTS"] = maxAttempts;
  return e;
}

// A shlex.split-style splitter for the scriptc subset: POSIX-style single and double quotes,
// backslash escapes outside single quotes. Like shlex.split, an unterminated quote returns
// null (Python raises ValueError); the caller then treats the string as unmatched.
function shlexSplit(s: string): string[] | null {
  const toks: string[] = [];
  let cur = "";
  let started = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (started) {
        toks.push(cur);
        cur = "";
        started = false;
      }
      i = i + 1;
      continue;
    }
    if (ch === "'") {
      started = true;
      i = i + 1;
      while (i < s.length && s[i] !== "'") {
        cur = cur + s[i];
        i = i + 1;
      }
      if (i >= s.length) {
        return null;
      }
      i = i + 1;
      continue;
    }
    if (ch === '"') {
      started = true;
      i = i + 1;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < s.length) {
          const n = s[i + 1];
          if (n === '"' || n === "\\" || n === "$" || n === "`") {
            cur = cur + n;
            i = i + 2;
            continue;
          }
        }
        cur = cur + s[i];
        i = i + 1;
      }
      if (i >= s.length) {
        return null;
      }
      i = i + 1;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 >= s.length) {
        return null;
      }
      cur = cur + s[i + 1];
      started = true;
      i = i + 2;
      continue;
    }
    cur = cur + ch;
    started = true;
    i = i + 1;
  }
  if (started) {
    toks.push(cur);
  }
  return toks;
}

function argv0Of(kind: string, payload: q.Payload): string | null {
  if (kind !== "cmd") {
    return null;
  }
  const cmd = payload.cmd;
  let toks: string[] | null = null;
  if (typeof cmd === "string") {
    toks = shlexSplit(cmd);
  } else if (Array.isArray(cmd)) {
    toks = cmd;
  }
  if (toks === null || toks.length === 0) {
    return null;
  }
  if (toks[0] === "sh" || toks[0] === "bash" || toks[0] === "zsh") {
    for (let i = 0; i < toks.length; i++) {
      if (toks[i] === "-c" && i + 1 < toks.length) {
        const inner = shlexSplit(toks[i + 1]);
        if (inner === null || inner.length === 0) {
          return null;
        }
        return inner[0];
      }
    }
    return null;
  }
  return toks[0];
}

function spawnJob(db: Database, jid: number, owner: string, kind: string, payload: q.Payload, running: Running[], runningAcp: RunningAcp[]): cp.ChildProcess {
  if (kind === "acp") {
    // ACP lane: no tool-class matching, no shell; the agent gets pipes and JSON-RPC.
    const att = attemptEnv(db, jid);
    const handle = startAcpJob(db, jid, owner, acpPayloadOf(payload), jobEnv(jid, deadlineEnv(db, jid), att.attempt, att.maxAttempts));
    runningAcp.push({ jid, handle, settled: false });
    return handle.proc;
  }
  const argv0 = argv0Of(kind, payload);
  if (argv0 === null) {
    return spawnRaw(db, jid, owner, kind, payload, running);
  }
  const resolved = which(argv0);
  const m = matchToolClass(resolved === null ? argv0 : resolved);
  if (m === null) {
    return spawnRaw(db, jid, owner, kind, payload, running);
  }
  const proj = projectKey(payload.cwd);
  auditSpawn(db, jid, argv0, m.cls, proj);
  const key = toolSlotKey(m.cls, proj);
  if (m.cost > slotLimit(key)) {
    // never grantable: config error, not contention
    q.finish(db, jid, owner, "failed");
    throw new Parked(key);
  }
  if (!acquireToolLease(db, jid, key, m.cost)) {
    q.waitOn(db, jid, key); // D7 park-at-boundary
    throw new Parked(key);
  }
  return spawnRaw(db, jid, owner, kind, payload, running);
}

function spawnRaw(db: Database, jid: number, owner: string, kind: string, payload: q.Payload, running: Running[]): cp.ChildProcess {
  const cmd = payload.cmd;
  const stdio: ("ignore" | "inherit")[] = ["ignore", "inherit", "inherit"];
  const att = attemptEnv(db, jid);
  const opts = { cwd: payload.cwd === null ? undefined : payload.cwd, detached: true, env: jobEnv(jid, deadlineEnv(db, jid), att.attempt, att.maxAttempts), stdio };
  const win = process.platform === "win32";
  const proc =
    typeof cmd === "string"
      ? win
        ? cp.spawn(SH, ["/c", cmd], opts)
        : cp.spawn(SH, ["-c", cmd], opts)
      : cp.spawn(cmd[0], cmd.slice(1), opts);
  // The handler must be attached before the pid check: on Linux, cp.spawn reports ENOENT
  // with pid already undefined, and the 'error' event still arrives on the next tick. An
  // unhandled 'error' event crashes the whole daemon.
  proc.on("error", (err: Error) => {
    const r = running.find((x) => x.jid === jid);
    if (r !== undefined) {
      r.spawnErrored = true;
    }
    const event = q.finish(db, jid, owner, "failed", "spawn failed: " + err.message);
    if (event !== null) {
      q.release(db, event);
    }
  });
  if (proc.pid === undefined || proc.pid === null) {
    // Spawn failed synchronously (bad cwd, permission): Python's Popen would have raised here.
    q.finish(db, jid, owner, "failed", "spawn failed");
    return proc;
  }
  q.setProc(db, jid, owner, proc.pid);
  return proc;
}

function killGroup(proc: cp.ChildProcess): void {
  const pid = proc.pid;
  if (pid === undefined || pid === null || pid <= 1) {
    return;
  }
  if (process.platform === "win32") {
    // Windows has no process groups: the detached child is its own leader, so
    // the direct pid is the best available kill target. Sibling leaks in a
    // shell pipeline are accepted for v0.1.0 (the shim runs one command).
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

export async function run(): Promise<void> {
  try {
    validateConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write("coordinate: invalid config: " + e.message + "\n");
    } else {
      process.stderr.write("coordinate: " + String(e instanceof Error ? e.message : e) + "\n");
    }
    process.exit(1);
  }
  const db = q.connect();
  const owner = os.hostname() + ":" + process.pid;
  // Singleton: only one dispatcher per DB. The claim is atomic against the
  // daemon table row (SQLite-only, no flock/pgrep); a stale heartbeat from a
  // crashed daemon is claimable, a fresh one refuses this start. A SIGKILLed
  // daemon can leave a "fresh" heartbeat behind for up to one lease interval,
  // so on conflict this start briefly probes the row: a heartbeat that stops
  // advancing belongs to a dead daemon and is taken over instead.
  const conflict: { v: number | null } = { v: null };
  if (!q.claimDaemon(db, process.pid, conflict)) {
    const ts0 = q.daemonHeartbeatTs(db);
    let takenOver = false;
    for (let i = 0; i < 8; i++) {
      await new Promise<void>((res) => {
        const t = setTimeout(res, 1000);
        process.once("SIGINT", () => {
          clearTimeout(t);
          res();
        });
      });
      if (q.claimDaemon(db, process.pid, conflict)) {
        takenOver = true;
        break;
      }
      if (q.daemonHeartbeatTs(db) !== ts0) {
        break; // row refreshed: the other daemon is alive
      }
    }
    if (!takenOver) {
      process.stderr.write("daemon already running (pid " + conflict.v + ")\n");
      db.close();
      process.exit(1);
    }
  }
  const running: Running[] = [];
  const runningAcp: RunningAcp[] = [];
  let delay = BACKOFF_MIN;
  let lastHb = 0.0;
  let lastReap = 0.0;
  let stopping = false;
  // Stop contract (ARCHITECTURE.md, durability): agents keep working when the orchestrator
  // stops. SIGTERM/SIGINT stop the claim loop and exit cleanly; running children are detached
  // (handles unref'd) and left alive. The next daemon start reaps their expired leases (X3).
  const stop = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    for (const r of running) {
      r.proc.unref();
      // Detached children keep their own process group; no kill: the job outlives the daemon.
    }
    try {
      db.close();
    } catch {
      // already closed by a concurrent loop turn
    }
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  const exitProc = (r: Running, code: number | null): void => {
    const event = q.finish(db, r.jid, owner, code === 0 ? "done" : "failed");
    if (event !== null) {
      q.release(db, event); // D7 wake: released jobs are picked up by the claim loop
    }
  };

  const loop = (): void => {
    if (stopping) {
      return;
    }
    let busy = false;
    const now = Date.now() / 1000;

    for (const row of q.expiredRunning(db)) {
      const payload = JSON.parse(row.payload) as q.Payload;
      if (row.kind === "acp") {
        // Timecap on an ACP job: ask the turn to stop first (best effort), like
        // daemon.py _acp_cancel, then the shared TERM path runs below.
        for (let i = 0; i < runningAcp.length; i++) {
          if (runningAcp[i].jid === row.id) {
            const sid = runningAcp[i].handle.sessionId;
            if (sid !== null) {
              runningAcp[i].handle.client.cancel(sid);
            }
          }
        }
      }
      q.finalizeTimedOut(db, row.id, "max runtime exceeded");
      // cmd lane: no recorded process to kill in this spike beyond best-effort pgid
      if (row.pgid !== null && row.pgid > 1) {
        try {
          // Windows has no process groups; kill the recorded pid directly.
          const target = process.platform === "win32" ? row.pgid : -row.pgid;
          process.kill(target, "SIGTERM");
        } catch {
          // gone
        }
      }
      void payload;
      busy = true;
    }

    // ACP completion poll: the protocol promise settles when the turn ends.
    for (let i = runningAcp.length - 1; i >= 0; i--) {
      const ra = runningAcp[i];
      if (ra.handle.settled) {
        const event = q.finish(db, ra.jid, owner, ra.handle.done && ra.handle.failure === null ? "done" : "failed", ra.handle.failure);
        if (event !== null) {
          q.release(db, event);
        }
        runningAcp.splice(i, 1);
        busy = true;
      }
    }

    for (let i = running.length - 1; i >= 0; i--) {
      const r = running[i];
      // spawn errors: node emits "error"; a missing binary exits with code 127 via sh
      if (r.proc.exitCode !== null || r.proc.signalCode !== null || r.spawnErrored === true) {
        exitProc(r, r.proc.exitCode);
        running.splice(i, 1);
        busy = true;
      }
    }

    if (now - lastHb >= q.LEASE_S / 3) {
      for (let i = running.length - 1; i >= 0; i--) {
        const r = running[i];
        if (!q.heartbeat(db, r.jid, owner)) {
          killGroup(r.proc);
          running.splice(i, 1);
        }
      }
      for (let i = runningAcp.length - 1; i >= 0; i--) {
        const ra = runningAcp[i];
        if (!q.heartbeat(db, ra.jid, owner)) {
          killGroup(ra.handle.proc);
          runningAcp.splice(i, 1);
        }
      }
      lastHb = now;
    }

    if (now - lastReap >= q.LEASE_S / 3) {
      q.reap(db);
      lastReap = now;
    }

    // Singleton heartbeat: refresh the daemon row every tick so doctor can
    // tell an idle dispatcher from a dead one (fresh ts = alive).
    q.daemonHeartbeat(db, process.pid);

    while (running.length + runningAcp.length < q.machineCap()) {
      const got = q.claim(db, owner);
      if (got === null) {
        break;
      }
      busy = true;
      try {
        const proc = spawnJob(db, got.jid, owner, got.kind, got.payload, running, runningAcp);
        if (got.kind !== "acp") {
          // ACP jobs are tracked in runningAcp; their proc exit is not the completion signal.
          running.push({ jid: got.jid, proc });
        }
      } catch (e) {
        if (e instanceof Parked) {
          busy = true; // parked at the heavy-spawn boundary, no worker spawned
        } else {
          q.finish(db, got.jid, owner, "failed");
        }
      }
    }

    delay = busy ? BACKOFF_MIN : Math.min(delay * 2, BACKOFF_MAX);
    // Atomics.wait does not run signal/timer callbacks while blocked (signals are
    // delivered only between macrotasks), so the idle sleep must go through the event loop.
    const target = delay;
    setTimeout(() => {}, target * 1000);
    const sleepStart = Date.now();
    const pump = (): void => {
      if (stopping || Date.now() - sleepStart >= target * 1000) {
        if (!stopping) {
          setImmediate(loop);
        }
        return;
      }
      setImmediate(pump);
    };
    pump();
  };
  loop();
}
