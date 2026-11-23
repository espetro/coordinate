// Env and paths: mirrors src/coordinate/paths.py for the vars the bench and CLI use.
// COORDINATE_* is canonical, FLEET_* is the fallback.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function env(name: string, fallback: string | null = null): string | null {
  return process.env["COORDINATE_" + name] || process.env["FLEET_" + name] || fallback;
}

export function dbPath(): string {
  const override = env("DB");
  if (override) {
    return override;
  }
  if (process.platform === "win32") {
    const state = process.env["LOCALAPPDATA"] || path.join(os.homedir(), "AppData", "Local");
    return path.join(state, "coordinate", "queue.db");
  }
  const state = process.env["XDG_STATE_HOME"] || path.join(os.homedir(), ".local", "state");
  return path.join(state, "coordinate", "queue.db");
}

export function configPath(): string {
  const override = env("CONFIG");
  if (override) {
    return override;
  }
  if (process.platform === "win32") {
    const cfg = process.env["APPDATA"] || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(cfg, "coordinate", "config.toml");
  }
  const cfg = process.env["XDG_CONFIG_HOME"] || path.join(os.homedir(), ".config");
  return path.join(cfg, "coordinate", "config.toml");
}

export function ensureParentDir(p: string): void {
  const d = path.dirname(path.resolve(p));
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch (e) {
    if ((e as { code?: string }).code !== "EEXIST") {
      throw e;
    }
  }
}
