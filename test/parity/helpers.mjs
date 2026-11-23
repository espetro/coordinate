// Shared harness for the Python parity suites in test/parity/.
//
// The Python implementation (legacy/python) is the specification. Each ported file keeps the
// Python test names so every assertion can be traced back to tests/test_<file>.py.
//
// Everything runs against the real code: the CLI through `node bin/coordinate.mjs`, the queue
// module `src/queue.ts` directly, and the daemon as a child process. Every run gets a private
// COORDINATE_DB, COORDINATE_CONFIG and COORDINATE_MACHINE, so nothing touches the user's queue.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import "koffi";
import "@cutils/sqlite/node-binding";
import { Database } from "@cutils/sqlite";

export const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const BIN = path.join(ROOT, "bin", "coordinate.mjs");

// The Python suites use sqlite3 directly to inspect rows; we do the same over the same file.
export function rows(r, sql) {
  const db = Database.open(r.db);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    return db.prepareRaw(sql).all([]);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export function one(r, sql) {
  return rows(r, sql)[0] ?? null;
}

// A private rig: temp dir, private db/config, inherited PATH but no COORDINATE_*/FLEET_* leaks.
export function rig(extraEnv = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord-parity-")));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("COORDINATE_") && !k.startsWith("FLEET_") && v !== undefined) env[k] = v;
  }
  Object.assign(env, {
    COORDINATE_DB: path.join(dir, "queue.db"),
    COORDINATE_CONFIG: path.join(dir, "config.toml"),
    COORDINATE_MACHINE: "parity",
    XDG_STATE_HOME: path.join(dir, "state"),
    XDG_CONFIG_HOME: path.join(dir, "conf"),
    ...extraEnv,
  });
  return { dir, env, db: env.COORDINATE_DB, daemons: [], extraPgids: [] };
}

export function cli(r, ...args) {
  const p = spawnSync(process.execPath, [BIN, ...args], {
    env: r.env,
    encoding: "utf8",
    timeout: 30000,
  });
  return { status: p.status, stdout: p.stdout || "", stderr: p.stderr || "" };
}

export function startDaemon(r, env = {}) {
  const logPath = path.join(r.dir, `daemon-${r.daemons.length}.log`);
  const fd = fs.openSync(logPath, "w");
  const child = spawn(process.execPath, [BIN, "daemon"], {
    env: { ...r.env, ...env },
    stdio: ["ignore", fd, fd],
  });
  fs.closeSync(fd);
  const d = { child, logPath, exited: false };
  child.once("exit", () => {
    d.exited = true;
  });
  r.daemons.push(d);
  return d;
}

export async function waitFor(pred, ms, step = 50) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await new Promise((res) => setTimeout(res, step));
  }
  return await pred();
}

export function groupAlive(pgid) {
  if (!pgid || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

// Stop only the daemons this rig started (by handle) and the job groups recorded in our own
// private DB. No pkill, no pattern matching: every signal goes to an exact pid we own.
export async function cleanup(r) {
  for (const d of r.daemons) {
    if (!d.exited) {
      d.child.kill("SIGKILL");
      await waitFor(() => d.exited, 3000);
    }
  }
  let recorded = [];
  try {
    recorded = rows(r, "SELECT pgid FROM jobs WHERE pgid IS NOT NULL").map((x) => Number(x.pgid));
  } catch {
    // the database was never created
  }
  for (const pg of [...recorded, ...(r.extraPgids || [])]) {
    if (pg > 1) {
      try {
        process.kill(-pg, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  fs.rmSync(r.dir, { recursive: true, force: true });
}

export function status(r, id) {
  return rows(r, `SELECT status FROM jobs WHERE id=${id}`)[0]?.status ?? null;
}

export function jobRow(r, id) {
  return one(r, `SELECT * FROM jobs WHERE id=${id}`);
}

// Fake binaries so the heavy-tool tests never hit the user's real vitest/tsc shims.
export function fakeBin(r, name, body) {
  const bin = path.join(r.dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const f = path.join(bin, name);
  fs.writeFileSync(f, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(f, 0o755);
  r.env.PATH = bin + path.delimiter + r.env.PATH;
  return bin;
}

export function git(cwd, ...args) {
  return spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  });
}

// The Python suites timestamp job spans with `$(python3 -c 'import time;print(time.time())')`.
// We use the shell's own epoch seconds instead, the same shape the peak-overlap math expects.
export const NOW = "$(date +%s.%N)";

// Peak number of simultaneously live spans in a span log, optionally filtered by tag.
export function peakOverlap(logPath, tags = null) {
  const lines = fs.readFileSync(logPath, "utf8").split("\n").filter((l) => l.trim() !== "");
  const events = [];
  for (const ln of lines) {
    const parts = ln.split(" ");
    const k = parts[0];
    const tag = parts.length > 2 ? parts[1] : "";
    const t = Number(parts[parts.length - 1]);
    if (tags !== null && !tags.has(tag)) continue;
    events.push([t, k === "s" ? 1 : -1]);
  }
  events.sort((a, b) => a[0] - b[0]);
  let live = 0;
  let peak = 0;
  for (const [, d] of events) {
    live += d;
    if (live > peak) peak = live;
  }
  return peak;
}

// Sample live running rows until `total` jobs are done; returns [peak, done].
// Keeps one connection open: the Python suite opens a fresh connection per query, but the
// numbers are the same and a long drain must not leak handles.
export function drain(r, total, timeout = 90000) {
  const end = Date.now() + timeout;
  let peak = 0;
  let done = 0;
  const db = Database.open(r.db);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    while (Date.now() < end && done < total) {
      const running = Number(
        db.prepareRaw("SELECT COUNT(*) AS n FROM jobs WHERE status='running' AND lease_expires_at>?").getOrNull([Date.now() / 1000]).n,
      );
      peak = Math.max(peak, running);
      done = Number(db.prepareRaw("SELECT COUNT(*) AS n FROM jobs WHERE status='done'").getOrNull([]).n);
      // sample without burning the CPU
      const until = Date.now() + 20;
      while (Date.now() < until) {
        // busy wait a fraction of the sample interval
      }
    }
  } finally {
    db.close();
  }
  return [peak, done];
}
