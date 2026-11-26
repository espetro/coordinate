// coordinate upgrade: atomic binary swap + safe daemon restart.
// Design notes (see .agents/docs/research/upgrade-rollout-2026-11-26.md):
// - never overwrite the running binary in place: macOS SIGKILLs new execs of a
//   binary whose pages are being rewritten while mapped (hit in practice during
//   the v0.2.0 install). Stage in the same directory and rename atomically.
// - restart is correct without adoption by design: the daemon's stop contract
//   detaches children, leases expire, the reaper kills orphans before requeue,
//   and ACP jobs resume their session. The window cost is one requeue at most.
// - CLI/daemon version skew is safe because both share only the SQLite schema,
//   which is additive-only within a compat window.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import * as q from "./queue.ts";
import type { Database } from "@cutils/sqlite";

function binDir(): string {
  const exe = process.execPath;
  // scriptc binaries: execPath is the installed binary itself.
  return path.dirname(exe);
}

function targetTriple(): string {
  const plat = process.platform;
  const arch = process.arch;
  if (plat === "darwin" && arch === "arm64") return "darwin-arm64";
  if (plat === "darwin") return "darwin-x64";
  if (plat === "linux" && arch === "x64") return "linux-x64-musl";
  throw new Error("unsupported platform for upgrade: " + plat + " " + arch);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function smoke(bin: string): boolean {
  const p = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 15000 });
  return p.status === 0 && typeof p.stdout === "string" && p.stdout.startsWith("coordinate ");
}

// Swap the binary at `dest` for the one at `src`, atomically, keeping a backup
// of the previous version for rollback.
export function swapBinary(src: string, dest: string): { backup: string | null } {
  let backup: string | null = null;
  if (fs.existsSync(dest)) {
    const v = spawnSync(dest, ["--version"], { encoding: "utf8", timeout: 15000 });
    const ver = v.status === 0 ? String(v.stdout).trim().replace(/^coordinate /, "").replace(/[^A-Za-z0-9._-]/g, "") : "unknown";
    backup = dest + "-" + ver + ".bak";
    fs.copyFileSync(dest, backup);
    fs.chmodSync(backup, 0o755);
  }
  // Same-directory stage then rename: rename is atomic on POSIX, and the old
  // inode stays valid for processes that still have it mapped.
  const staged = dest + ".staged." + String(process.pid);
  fs.copyFileSync(src, staged);
  fs.chmodSync(staged, 0o755);
  fs.renameSync(staged, dest);
  return { backup };
}

// Restart the daemon recorded in the daemon table, if any. SIGTERM is safe by
// design (children detach, the queue is durable). Returns a status object.
export function restartDaemon(db: Database, bin: string): { action: string; oldPid: number | null; newPid: number | null } {
  const row = q.qOne(db, "SELECT pid FROM daemon WHERE id=1", []) as { pid: number } | null;
  if (row === null || !pidAlive(row.pid)) {
    return { action: "no-daemon", oldPid: row === null ? null : row.pid, newPid: null };
  }
  const oldPid = row.pid;
  try {
    process.kill(oldPid, "SIGTERM");
  } catch {
    // already gone; proceed to start the replacement
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && pidAlive(oldPid)) {
    spawnSync("sleep", ["0.2"]);
  }
  const logDir = path.join(os.homedir(), ".local", "state", "coordinate");
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, "daemon.log"), "a");
  const child = spawn(bin, ["daemon"], {
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();
  return { action: "restarted", oldPid, newPid: child.pid ?? null };
}

export function findBackup(dest: string): string | null {
  const dir = path.dirname(dest);
  const base = path.basename(dest);
  const cands = fs.readdirSync(dir)
    .filter((f) => f.startsWith(base + "-") && f.endsWith(".bak"))
    .sort();
  return cands.length > 0 ? path.join(dir, cands[cands.length - 1]) : null;
}

export interface UpgradeResult {
  step: string;
  detail: string;
}

// Full upgrade flow. Either file (a local binary) or version (download from
// the release bucket) must be given.
export async function upgrade(opts: {
  db: Database;
  dest: string | null;
  file: string | null;
  version: string | null;
  restart: boolean;
  rollback: boolean;
  log: (step: string, detail: string) => void;
}): Promise<void> {
  // The install target is the well-known prefix path, never the invoked
  // binary itself: upgrading from a staged or dist binary must still land at
  // ~/.local/bin/coordinate. COORDINATE_PREFIX overrides for custom installs.
  const installDest = opts.dest !== null
    ? opts.dest
    : path.join(process.env["COORDINATE_PREFIX"] ?? path.join(os.homedir(), ".local", "bin"), "coordinate");

  if (opts.rollback) {
    const bak = findBackup(installDest);
    if (bak === null) throw new Error("no backup binary found next to " + installDest);
    const staged = installDest + ".staged." + String(process.pid);
    fs.copyFileSync(bak, staged);
    fs.chmodSync(staged, 0o755);
    fs.renameSync(staged, installDest);
    opts.log("rollback", "restored " + bak);
    if (!smoke(installDest)) throw new Error("rolled-back binary failed its smoke check");
    if (opts.restart) {
      const r = restartDaemon(opts.db, installDest);
      opts.log("daemon", JSON.stringify(r));
    }
    return;
  }

  let src: string;
  let cleanup: string | null = null;
  if (opts.file !== null) {
    src = opts.file;
  } else if (opts.version !== null) {
    const name = "coordinate-" + opts.version.replace(/^v/, "") + "-" + targetTriple();
    const url = "https://github.com/espetro/coordinate/releases/download/" + (opts.version.startsWith("v") ? opts.version : "v" + opts.version) + "/" + name;
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "coordinate-up-")), name);
    const dl = spawnSync("curl", ["-fSL", "--retry", "3", "-o", tmp, url], { timeout: 120000 });
    if (dl.status !== 0) throw new Error("download failed: " + url);
    // checksum verification when the release publishes a .sha256 next to it
    const dlSum = spawnSync("curl", ["-fsSL", "-o", tmp + ".sha256", url + ".sha256"], { timeout: 30000 });
    if (dlSum.status === 0) {
      const want = fs.readFileSync(tmp + ".sha256", "utf8").trim().split(/\s+/)[0];
      const got = spawnSync("shasum", ["-a", "256", tmp], { encoding: "utf8" }).stdout.split(/\s+/)[0];
      if (want !== got) throw new Error("checksum mismatch: want " + want + " got " + got);
      opts.log("verify", "sha256 ok");
    } else {
      opts.log("verify", "no checksum published, skipping (unsigned channel)");
    }
    src = tmp;
    cleanup = path.dirname(tmp);
  } else {
    throw new Error("give --version vX.Y.Z or --file PATH");
  }

  fs.chmodSync(src, 0o755);
  if (!smoke(src)) throw new Error("staged binary failed its smoke check (--version)");
  opts.log("smoke", "staged binary executes");
  const { backup } = swapBinary(src, installDest);
  opts.log("swap", "installed atomically at " + installDest + (backup === null ? "" : " (backup " + backup + ")"));
  if (cleanup !== null) fs.rmSync(cleanup, { recursive: true, force: true });
  if (opts.restart) {
    const r = restartDaemon(opts.db, installDest);
    opts.log("daemon", JSON.stringify(r));
  } else {
    opts.log("daemon", "not restarted (--no-restart)");
  }
}
