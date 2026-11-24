// coordinate doctor: one-shot health report for the CLI install.
// Checks binary version, DB path/open/schema, config.toml parsing, daemon
// liveness (fresh job leases, never pgrep) and queue stats. Any failed check
// marks the report unhealthy and the verb exits non-zero.

import * as fs from "node:fs";
import { Database } from "@cutils/sqlite";
import { ConfigError, validateConfig } from "./config.ts";
import { configPath, dbPath, env } from "./env.ts";
import * as q from "./queue.ts";
import { CLI_VERSION } from "./version.ts";

export interface CheckRow {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Report {
  rows: CheckRow[];
  healthy: boolean;
}

function row(name: string, ok: boolean, detail: string): CheckRow {
  return { name: name, ok: ok, detail: detail };
}

function dbSource(): string {
  if (env("DB") !== null) {
    return "COORDINATE_DB/FLEET_DB override";
  }
  if (process.platform === "win32") {
    return "LOCALAPPDATA";
  }
  return "XDG_STATE_HOME";
}

// Daemon liveness without pgrep: the dispatcher refreshes the daemon-table
// heartbeat row every loop tick, so a fresh heartbeat_ts (< 2x tick interval)
// proves a live daemon even when it is idle (zero running jobs). Stale or
// absent rows mean no daemon is running (a valid state, informational).
function checkDaemon(db: Database): CheckRow {
  const pid = q.liveDaemonPid(db);
  if (pid !== null) {
    return row("daemon", true, "heartbeat fresh (pid " + pid + "); dispatcher is alive");
  }
  const fresh = db
    .prepareRaw("SELECT COUNT(*) AS c FROM jobs WHERE status='running' AND lease_expires_at > ?")
    .all([Date.now() / 1000]) as { c: number }[];
  const n = fresh.length > 0 ? fresh[0].c : 0;
  if (n > 0) {
    return row("daemon", true, n + " fresh job lease(s) but a stale daemon heartbeat; a dispatcher may be alive");
  }
  return row("daemon", true, "no fresh daemon heartbeat; no daemon appears to be running (informational)");
}

export function doctor(): Report {
  const rows: CheckRow[] = [];
  rows.push(row("version", true, "coordinate " + CLI_VERSION + " (source tree; scripts/build-bin.sh stamps release binaries)"));

  let db: Database | null = null;
  const p = dbPath();
  if (!fs.existsSync(p)) {
    rows.push(row("db", true, p + " (" + dbSource() + "): not created yet; created on first use"));
  } else {
    try {
      db = Database.open(p);
      const uv = db.prepareRaw("PRAGMA user_version").get([]) as { user_version: number } | undefined;
      const tables = db.prepareRaw(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('jobs','events','concurrency_slots')",
      ).all([]) as { name: string }[];
      const have: string[] = [];
      for (const t of tables) {
        have.push(t.name);
      }
      let missing: string[] = [];
      for (const want of ["jobs", "events", "concurrency_slots"]) {
        if (have.indexOf(want) === -1) {
          missing.push(want);
        }
      }
      const userVersion = uv === undefined ? 0 : uv.user_version;
      if (missing.length > 0) {
        rows.push(row("db", false, p + " (" + dbSource() + "): opens but is missing table(s): " + missing.join(", ") + " (user_version " + userVersion + ")"));
      } else {
        rows.push(row("db", true, p + " (" + dbSource() + "): opens, schema tables present (user_version " + userVersion + ")"));
      }
    } catch (e) {
      rows.push(row("db", false, p + " (" + dbSource() + "): open failed: " + String(e instanceof Error ? e.message : e)));
    }
  }

  const cp = configPath();
  if (!fs.existsSync(cp)) {
    rows.push(row("config", true, cp + ": missing (defaults apply)"));
  } else {
    try {
      validateConfig();
      rows.push(row("config", true, cp + ": parses, validates"));
    } catch (e) {
      if (e instanceof ConfigError) {
        rows.push(row("config", false, cp + ":" + e.line + ": " + e.message));
      } else {
        rows.push(row("config", false, cp + ": " + String(e instanceof Error ? e.message : e)));
      }
    }
  }

  if (db !== null) {
    rows.push(checkDaemon(db));
    rows.push(row("stats", true, JSON.stringify(q.stats(db))));
    db.close();
  } else {
    rows.push(row("stats", true, "skipped: no database yet"));
  }

  rows.push(row("disk", true, "skipped: no statfs in the scriptc stdlib subset"));

  let healthy = true;
  for (const r of rows) {
    if (!r.ok) {
      healthy = false;
    }
  }
  return { rows: rows, healthy: healthy };
}

export function run(): void {
  const rep = doctor();
  for (const r of rep.rows) {
    process.stdout.write((r.ok ? "ok   " : "FAIL ") + r.name + ": " + r.detail + "\n");
  }
  process.stdout.write((rep.healthy ? "healthy" : "unhealthy") + "\n");
  if (!rep.healthy) {
    process.exit(1);
  }
}
