// Daemon handoff: the only upgrade concern coordinate owns. Binary acquisition
// belongs to external package managers (mise/brew — their versioned-prefix
// installs never overwrite a mapped binary in place, so the macOS SIGKILL
// gotcha does not exist there) or to install.sh for curl-pipe users.
// The handoff itself is coordination-free by design: the durability contract
// (detached children, lease expiry, orphan reaping, ACP session resume)
// absorbs the gap, so a restart is just start-the-new + stop-the-old.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { Database } from "@cutils/sqlite";
import { liveDaemonPid } from "./queue.ts";

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Spawn a detached daemon running the binary at `bin` and return its pid.
export function spawnDaemon(bin: string): number | null {
  const logDir = path.join(process.env["XDG_STATE_HOME"] ?? path.join(os.homedir(), ".local", "state"), "coordinate");
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, "daemon.log"), "a");
  const child = spawn(bin, ["daemon"], {
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();
  return child.pid ?? null;
}

// Restart the daemon recorded in the daemon table, if any. The replacement is
// spawned BEFORE the old process is signalled: overlap is harmless (singleton
// takeover hands off the row; a cleanly stopping daemon now releases it
// explicitly) and the gap-free ordering means the queue is never without a
// dispatcher. SIGTERM is safe by design — children detach, jobs resume.
export function restartDaemon(db: Database, bin: string): { action: string; oldPid: number | null; newPid: number | null } {
  // Only a fresh heartbeat proves the recorded pid is still our daemon: a
  // stale row may name a pid the OS has since given to an unrelated process.
  const oldPid = liveDaemonPid(db);
  if (oldPid === null || !pidAlive(oldPid)) {
    return { action: "no-daemon", oldPid: oldPid, newPid: null };
  }
  const newPid = spawnDaemon(bin);
  try {
    process.kill(oldPid, "SIGTERM");
  } catch {
    // already gone; the replacement still takes over
  }
  return { action: "restarted", oldPid, newPid };
}

// Fingerprint of a binary file for change detection. Atomic-rename installs
// swap the inode; non-atomic copies change size or mtime.
export interface BinFingerprint {
  ino: number;
  size: number;
  mtimeMs: number;
}

export function binFingerprint(p: string): BinFingerprint | null {
  try {
    const st = fs.statSync(p);
    return { ino: Number(st.ino), size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

export function sameFingerprint(a: BinFingerprint | null, b: BinFingerprint | null): boolean {
  if (a === null || b === null) {
    return false;
  }
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}
