// coordinate service install|uninstall|status: manage a user-level service
// that runs `coordinate daemon` on login/boot. Linux uses a systemd user
// unit, macOS a launchd LaunchAgent plist. Windows is not supported yet.
// Unit-file generation lives in pure functions so tests can verify content
// without touching the real system manager.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { dbPath, env } from "./env.ts";

export interface ServiceEnv {
  db: string | null;
  machine: string | null;
  cap: string | null;
  pathValue: string;
}

// Snapshot the resolved environment the daemon needs. COORDINATE_DB only
// lands in the unit when the user set it (or FLEET_DB), matching dbPath().
export function snapshotEnv(pathValue: string): ServiceEnv {
  return {
    db: env("DB"),
    machine: env("MACHINE"),
    cap: env("CAP"),
    pathValue: pathValue,
  };
}

function quoteSystemd(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

export function systemdUnitPath(): string {
  const cfg = process.env["XDG_CONFIG_HOME"] || path.join(os.homedir(), ".config");
  return path.join(cfg, "systemd", "user", "coordinate.service");
}

export function launchdPlistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", "sh.coordinate.daemon.plist");
}

export function unitPath(): string {
  if (process.platform === "darwin") {
    return launchdPlistPath();
  }
  return systemdUnitPath();
}

export function binaryPath(): string {
  // process.execPath points at the running binary for scriptc-built
  // executables; argv[0] keeps the daemon alive across PATH changes.
  return process.execPath;
}

// Generate the systemd user unit. The ExecStart uses the absolute binary
// path, never a bare `coordinate`, so the service survives PATH changes.
export function renderSystemdUnit(bin: string, e: ServiceEnv): string {
  const lines: string[] = [];
  lines.push("[Unit]");
  lines.push("Description=coordinate daemon (job queue dispatcher)");
  lines.push("After=network.target");
  lines.push("");
  lines.push("[Service]");
  lines.push("Type=simple");
  lines.push("ExecStart=" + quoteSystemd(bin) + " daemon");
  if (e.db !== null) {
    lines.push("Environment=COORDINATE_DB=" + quoteSystemd(e.db));
  }
  if (e.machine !== null) {
    lines.push("Environment=COORDINATE_MACHINE=" + quoteSystemd(e.machine));
  }
  if (e.cap !== null) {
    lines.push("Environment=COORDINATE_CAP=" + quoteSystemd(e.cap));
  }
  lines.push("Environment=PATH=" + quoteSystemd(e.pathValue));
  lines.push("Restart=on-failure");
  lines.push("RestartSec=5");
  lines.push("");
  lines.push("[Install]");
  lines.push("WantedBy=default.target");
  lines.push("");
  return lines.join("\n");
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Generate the launchd LaunchAgent plist. ProgramArguments embeds the
// absolute binary path and the daemon verb; EnvironmentDict carries the
// resolved env, PATH included.
export function renderLaunchdPlist(bin: string, e: ServiceEnv): string {
  const envDict: string[] = [];
  if (e.db !== null) {
    envDict.push("    <key>COORDINATE_DB</key><string>" + xmlEscape(e.db) + "</string>");
  }
  if (e.machine !== null) {
    envDict.push("    <key>COORDINATE_MACHINE</key><string>" + xmlEscape(e.machine) + "</string>");
  }
  if (e.cap !== null) {
    envDict.push("    <key>COORDINATE_CAP</key><string>" + xmlEscape(e.cap) + "</string>");
  }
  envDict.push("    <key>PATH</key><string>" + xmlEscape(e.pathValue) + "</string>");
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n" +
    "<plist version=\"1.0\">\n" +
    "<dict>\n" +
    "  <key>Label</key><string>sh.coordinate.daemon</string>\n" +
    "  <key>ProgramArguments</key>\n" +
    "  <array>\n" +
    "    <string>" + xmlEscape(bin) + "</string>\n" +
    "    <string>daemon</string>\n" +
    "  </array>\n" +
    "  <key>EnvironmentVariables</key>\n" +
    "  <dict>\n" +
    envDict.join("\n") + "\n" +
    "  </dict>\n" +
    "  <key>RunAtLoad</key><true/>\n" +
    "  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n" +
    "  <key>StandardOutPath</key><string>" + xmlEscape(path.join(os.homedir(), ".local", "state", "coordinate", "daemon.log")) + "</string>\n" +
    "  <key>StandardErrorPath</key><string>" + xmlEscape(path.join(os.homedir(), ".local", "state", "coordinate", "daemon.log")) + "</string>\n" +
    "</dict>\n" +
    "</plist>\n"
  );
}

function systemctl(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("systemctl", ["--user"].concat(args), { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout === undefined ? "" : r.stdout, stderr: r.stderr === undefined ? "" : r.stderr };
}

function launchctl(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("launchctl", args, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout === undefined ? "" : r.stdout, stderr: r.stderr === undefined ? "" : r.stderr };
}

function ensureParentDir(p: string): void {
  const d = path.dirname(path.resolve(p));
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch (e) {
    if ((e as { code?: string }).code !== "EEXIST") {
      throw e;
    }
  }
}

function serviceUnsupported(): void {
  process.stdout.write("service: Windows is not supported yet; run `coordinate daemon` manually or from a scheduled task.\n");
}

export function cmdInstall(rest: string[]): void {
  let force = false;
  for (const t of rest) {
    if (t === "--force") {
      force = true;
    } else {
      process.stderr.write("service install: unknown argument " + t + "\n");
      process.exit(1);
    }
  }
  if (process.platform === "win32") {
    serviceUnsupported();
    return;
  }
  const target = unitPath();
  const bin = binaryPath();
  const e = snapshotEnv(process.env["PATH"] || "");
  const content = process.platform === "darwin" ? renderLaunchdPlist(bin, e) : renderSystemdUnit(bin, e);
  const exists = fs.existsSync(target);
  if (exists && !force) {
    const same = fs.readFileSync(target, "utf8") === content;
    if (same) {
      process.stdout.write("service: already installed at " + target + " (identical unit); nothing to do\n");
    } else {
      process.stderr.write(
        "service: " + target + " already exists and differs; re-run with --force to overwrite\n",
      );
      process.exit(1);
    }
    return;
  }
  ensureParentDir(target);
  fs.writeFileSync(target, content, "utf8");
  if (process.platform === "darwin") {
    const uid = String(os.userInfo().uid);
    // bootout is best-effort: a previous generation may not be loaded
    launchctl(["bootout", "gui/" + uid + "/" + LAUNCHD_LABEL]);
    const r = launchctl(["bootstrap", "gui/" + uid, target]);
    if (r.status !== 0) {
      process.stderr.write("service: launchctl bootstrap failed: " + r.stderr + "\n");
      process.exit(1);
    }
  } else {
    const r = systemctl(["daemon-reload"]);
    if (r.status !== 0) {
      process.stderr.write("service: systemctl daemon-reload failed: " + r.stderr + "\n");
      process.exit(1);
    }
    const en = systemctl(["enable", "--now", "coordinate.service"]);
    if (en.status !== 0) {
      process.stderr.write("service: systemctl enable --now failed: " + en.stderr + "\n");
      process.exit(1);
    }
  }
  process.stdout.write("service: installed " + (exists ? "(overwritten) " : "") + "at " + target + "\n");
  if (e.db === null) {
    process.stdout.write("service: note: COORDINATE_DB not set; unit uses the default DB path " + dbPath() + "\n");
  }
}

export const LAUNCHD_LABEL = "sh.coordinate.daemon";
export const SYSTEMD_UNIT_NAME = "coordinate.service";

export function cmdUninstall(): void {
  if (process.platform === "win32") {
    serviceUnsupported();
    return;
  }
  const target = unitPath();
  if (process.platform === "darwin") {
    const uid = String(os.userInfo().uid);
    launchctl(["bootout", "gui/" + uid + "/" + LAUNCHD_LABEL]);
  } else {
    systemctl(["disable", "--now", SYSTEMD_UNIT_NAME]);
    systemctl(["daemon-reload"]);
    systemctl(["reset-failed", SYSTEMD_UNIT_NAME]);
  }
  if (fs.existsSync(target)) {
    fs.unlinkSync(target);
    process.stdout.write("service: removed " + target + "\n");
  } else {
    process.stdout.write("service: no unit at " + target + "; nothing to remove\n");
  }
}

export interface ServiceStatus {
  installed: boolean;
  enabled: boolean | null;
  running: boolean | null;
  detail: string;
}

export function readStatus(): ServiceStatus {
  const target = unitPath();
  const installed = fs.existsSync(target);
  if (process.platform === "darwin") {
    const uid = String(os.userInfo().uid);
    const r = launchctl(["print", "gui/" + uid + "/" + LAUNCHD_LABEL]);
    const loaded = r.status === 0;
    let running: boolean | null = null;
    let enabled = installed && loaded;
    if (loaded) {
      const m = r.stdout.match(/state = (\w+)/);
      if (m !== null) {
        running = m[1] === "running";
      }
    }
    return {
      installed: installed,
      enabled: enabled,
      running: running,
      detail: loaded ? r.stdout.split("\n")[0] : "not loaded in launchd",
    };
  }
  const en = systemctl(["is-enabled", SYSTEMD_UNIT_NAME]);
  const ac = systemctl(["is-active", SYSTEMD_UNIT_NAME]);
  const enabled = en.status === 0 ? true : en.stdout.trim() === "disabled" ? false : null;
  const running = ac.status === 0 ? true : ac.stdout.trim() === "inactive" || ac.stdout.trim() === "failed" ? false : null;
  return {
    installed: installed,
    enabled: enabled,
    running: running,
    detail: "is-enabled: " + en.stdout.trim() + "; is-active: " + ac.stdout.trim(),
  };
}

export function cmdStatus(): void {
  if (process.platform === "win32") {
    serviceUnsupported();
    return;
  }
  const s = readStatus();
  process.stdout.write("installed: " + (s.installed ? "yes (" + unitPath() + ")" : "no") + "\n");
  process.stdout.write("enabled:   " + (s.enabled === null ? "unknown" : s.enabled ? "yes" : "no") + "\n");
  process.stdout.write("running:   " + (s.running === null ? "unknown" : s.running ? "yes" : "no") + "\n");
}
