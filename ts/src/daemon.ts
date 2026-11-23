// Dispatcher daemon: claim loop, subprocess execution, lease heartbeat, reaper.
// Port of src/coordinate/daemon.py run() for cmd jobs only (no ACP lane, no tool-class
// spawn interception: the bench --cli scenarios used here do not exercise [slots] config).

import * as cp from "node:child_process";
import * as os from "node:os";
import { dbPath } from "./env.ts";
import { Database } from "@cutils/sqlite";
import * as q from "./queue.ts";

const BACKOFF_MAX = 2.0;
const BACKOFF_MIN = 0.05;
const SH = "/bin/sh";

interface Running {
  jid: number;
  proc: cp.ChildProcess;
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

function spawnJob(db: Database, jid: number, owner: string, kind: string, payload: q.Payload): cp.ChildProcess {
  const cmd = payload.cmd;
  const opts = { cwd: payload.cwd === null ? undefined : payload.cwd, detached: true, env: jobEnv(jid), stdio: "ignore" as const };
  const proc =
    typeof cmd === "string" ? cp.spawn(SH, ["-c", cmd], opts) : cp.spawn(cmd[0], cmd.slice(1), opts);
  q.setProc(db, jid, owner, proc.pid === undefined || proc.pid === null ? 0 : proc.pid);
  return proc;
}

function killGroup(proc: cp.ChildProcess): void {
  const pid = proc.pid;
  if (pid === undefined || pid === null || pid <= 1) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

export function run(): void {
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
      for (const _wid of q.release(db, event)) {
        // released jobs are picked up by the claim loop
      }
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
          process.kill(-row.pgid, "SIGTERM");
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
      } catch {
        q.finish(db, got.jid, owner, "failed");
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
