// Dispatcher daemon: claim loop, subprocess execution, lease heartbeat, reaper.
// Port of src/coordinate/daemon.py run() for cmd jobs only (no ACP lane, no tool-class
// spawn interception: the bench --cli scenarios used here do not exercise [slots] config).

import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configPath, dbPath } from "./env.ts";
import { Database } from "@cutils/sqlite";
import * as q from "./queue.ts";
import { ConfigError, DEFAULT_TOOL_CLASSES, slotLimit, toolClasses, validateConfig } from "./config.ts";

const BACKOFF_MAX = 2.0;
const BACKOFF_MIN = 0.05;
const SH = process.platform === "win32" ? "cmd.exe" : "/bin/sh";

interface Running {
  jid: number;
  proc: cp.ChildProcess;
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

function jobEnv(jid: number): Record<string, string> {
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
  return e;
}

function argv0Of(kind: string, payload: q.Payload): string | null {
  if (kind !== "cmd") {
    return null;
  }
  const cmd = payload.cmd;
  let toks: string[] | null = null;
  if (typeof cmd === "string") {
    toks = cmd.split(" ").filter((t) => t !== "");
  } else if (Array.isArray(cmd)) {
    toks = cmd;
  }
  if (toks === null || toks.length === 0) {
    return null;
  }
  if (toks[0] === "sh" || toks[0] === "bash" || toks[0] === "zsh") {
    for (let i = 0; i < toks.length; i++) {
      if (toks[i] === "-c" && i + 1 < toks.length) {
        const inner = toks[i + 1].split(" ").filter((t) => t !== "");
        return inner.length > 0 ? inner[0] : null;
      }
    }
    return null;
  }
  return toks[0];
}

function spawnJob(db: Database, jid: number, owner: string, kind: string, payload: q.Payload): cp.ChildProcess {
  const argv0 = argv0Of(kind, payload);
  if (argv0 === null) {
    return spawnRaw(db, jid, owner, kind, payload);
  }
  const resolved = which(argv0);
  const m = matchToolClass(resolved === null ? argv0 : resolved);
  if (m === null) {
    return spawnRaw(db, jid, owner, kind, payload);
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
  return spawnRaw(db, jid, owner, kind, payload);
}

function spawnRaw(db: Database, jid: number, owner: string, kind: string, payload: q.Payload): cp.ChildProcess {
  const cmd = payload.cmd;
  const opts = { cwd: payload.cwd === null ? undefined : payload.cwd, detached: true, env: jobEnv(jid), stdio: "ignore" as const };
  const win = process.platform === "win32";
  const proc =
    typeof cmd === "string"
      ? win
        ? cp.spawn(SH, ["/c", cmd], opts)
        : cp.spawn(SH, ["-c", cmd], opts)
      : cp.spawn(cmd[0], cmd.slice(1), opts);
  q.setProc(db, jid, owner, proc.pid === undefined || proc.pid === null ? 0 : proc.pid);
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

export function run(): void {
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
  const running: Running[] = [];
  let delay = BACKOFF_MIN;
  let lastHb = 0.0;
  let lastReap = 0.0;
  let stopping = false;
  process.on("SIGTERM", () => {
    stopping = true;
  });
  process.on("SIGINT", () => {
    stopping = true;
  });

  const exitProc = (r: Running, code: number | null): void => {
    const event = q.finish(db, r.jid, owner, code === 0 ? "done" : "failed");
    if (event !== null) {
      q.release(db, event); // D7 wake: released jobs are picked up by the claim loop
    }
  };

  const loop = (): void => {
    if (stopping) {
      for (const r of running) {
        killGroup(r.proc);
      }
      db.close();
      return;
    }
    let busy = false;
    const now = Date.now() / 1000;

    for (const row of q.expiredRunning(db)) {
      const payload = JSON.parse(row.payload) as q.Payload;
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

    for (let i = running.length - 1; i >= 0; i--) {
      const r = running[i];
      // spawn errors: node emits "error"; a missing binary exits with code 127 via sh
      if (r.proc.exitCode !== null || r.proc.signalCode !== null) {
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
      lastHb = now;
    }

    if (now - lastReap >= q.LEASE_S / 3) {
      q.reap(db);
      lastReap = now;
    }

    while (running.length < q.machineCap()) {
      const got = q.claim(db, owner);
      if (got === null) {
        break;
      }
      busy = true;
      try {
        running.push({ jid: got.jid, proc: spawnJob(db, got.jid, owner, got.kind, got.payload) });
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
