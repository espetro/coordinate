// The triage TUI: one screen, keyboard only, hand-rolled ANSI. It reads the
// shared read model (readmodel.ts queryJobs/whyJob/jobLogs) and renders with
// the same table renderer as `coordinate jobs` (format-table.ts), so the TUI
// is a view of the contract and not a second query path. Mutations go through
// the same queue operations (queue.ts cancel/retryDead/release) as the CLI,
// so the events stay accurate.
//
// Hooks are external commands only, read from [tui] hooks in config.toml.
// A hook command receives the selected job's v1 JSON on stdin and may use the
// {id} {cwd} {repo} {status} substitutions. There is no plugin API: foreign
// code stays outside this process.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as readline from "node:readline";
import * as cfg from "./config.ts";
import * as q from "./queue.ts";
import { renderJobsTable } from "./format-table.ts";
import { jobLogs, queryJobs, whyJob, type JobQuery, type JobRecord, type SortKey } from "./readmodel.ts";
import type { Database } from "@cutils/sqlite";

const SORTS: SortKey[] = ["id", "created", "priority", "status", "runtime"];
const STATES = ["all", "queued", "running", "waiting", "failed", "dead", "done", "timed_out"];

export interface TuiHooks {
  [name: string]: string;
}

// [tui] hooks from config.toml: hook name -> command template. Only string
// entries become hooks; anything else fails validation as config usually does.
export function tuiHooks(): TuiHooks {
  const out: TuiHooks = {};
  const cf = cfg.readConfig();
  if (cf === null) {
    return out;
  }
  const sec = cf.root["tui"];
  if (sec === undefined || sec === null) {
    return out;
  }
  if (typeof sec !== "object") {
    throw new cfg.ConfigError(cf.file, cf.lines["tui"] ?? 0, "[tui] must be a table");
  }
  const rec = sec as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    const v = rec[key];
    if (typeof v !== "string" || v === "") {
      throw new cfg.ConfigError(cf.file, cf.lines["tui." + key] ?? 0, "tui." + key + " must be a non-empty command string");
    }
    out[key] = v;
  }
  return out;
}

// Safe substitutions: only whole-token placeholders are replaced, with the
// values shell-quoted, so a job field can never inject extra words. The
// selected job JSON always goes to the hook's stdin as well.
export function expandHook(cmd: string, job: JobRecord): string {
  const q1 = (v: string): string => "'" + v.split("'").join("'\\''") + "'";
  const cwd = typeof job.payload["cwd"] === "string" ? (job.payload["cwd"] as string) : "";
  const repo = typeof job.payload["repo"] === "string" ? (job.payload["repo"] as string) : "";
  let out = cmd;
  out = out.split("{id}").join(q1(String(job.id)));
  out = out.split("{cwd}").join(q1(cwd));
  out = out.split("{repo}").join(q1(repo));
  out = out.split("{status}").join(q1(job.status));
  return out;
}

export function runHook(cmd: string, job: JobRecord): { status: number | null; stderr: string } {
  const r = spawnSync("sh", ["-c", cmd], {
    input: JSON.stringify(job) + "\n",
    timeout: 30_000,
    encoding: "utf8",
  });
  return { status: r.status, stderr: String(r.stderr || "").slice(0, 400) };
}

export type Mode = "list" | "details" | "confirm" | "event" | "filter";

export interface TuiState {
  sel: number; // selected index into the visible rows
  filter: string;
  sortIdx: number;
  stateIdx: number; // index into STATES
  mode: Mode;
  confirmAction: "cancel" | "retry" | null;
  eventName: string;
  status: string; // one-line feedback at the bottom
}

export function initialState(): TuiState {
  return { sel: 0, filter: "", sortIdx: 0, stateIdx: 0, mode: "list", confirmAction: null, eventName: "", status: "" };
}

export function buildQuery(s: TuiState): JobQuery {
  const stateName = STATES[s.stateIdx] ?? "all";
  return {
    status: stateName === "all" ? null : [stateName],
    search: s.filter === "" ? null : s.filter,
    sort: SORTS[s.sortIdx] ?? "id",
    asc: false,
  };
}

export function visibleJobs(s: TuiState, db: Database): JobRecord[] {
  const rows = queryJobs(db, buildQuery(s));
  if (s.sel >= rows.length) {
    s.sel = Math.max(0, rows.length - 1);
  }
  return rows;
}

// The reducer: applies one keypress to the state, optionally mutating the
// queue through the same operations the CLI verbs use. `job` is the currently
// selected record, or null when the list is empty. Returns true when the
// screen must be repainted.
export interface KeyResult {
  repaint: boolean;
  selected: JobRecord | null;
  quit: boolean;
}

export function handleKey(
  s: TuiState,
  key: readline.Key,
  db: Database,
  hooks: TuiHooks,
): KeyResult {
  const rows = visibleJobs(s, db);
  const selRow: JobRecord | null = rows.length > 0 && s.sel >= 0 ? rows[s.sel] : null;
  const name = typeof key.name === "string" ? key.name : "";
  const seq = typeof key.sequence === "string" ? key.sequence : "";
  const ctrl = key.ctrl === true;
  const repaintStart = true;

  // modes with their own input handling
  if (s.mode === "confirm") {
    s.mode = "list";
    if (seq === "y" || seq === "Y") {
      if (selRow !== null && s.confirmAction === "cancel") {
        if (q.cancel(db, selRow.id)) {
          s.status = "cancelled " + String(selRow.id);
        } else {
          s.status = "cancel: not cancellable";
        }
      } else if (selRow !== null && s.confirmAction === "retry") {
        const ids = q.retryDead(db, selRow.id);
        s.status = ids.length > 0 ? "requeued " + String(selRow.id) : "retry: not failed or dead";
      }
    } else {
      s.status = "";
    }
    s.confirmAction = null;
    return { repaint: repaintStart, selected: null, quit: false };
  }
  if (s.mode === "event") {
    if (name === "return" || seq === "\r") {
      const ev = s.eventName;
      s.mode = "list";
      s.eventName = "";
      if (ev !== "") {
        const ids = q.release(db, ev);
        s.status = ids.length > 0 ? "released " + String(ids.length) + " job(s) on " + ev : "release: nothing waiting on " + ev;
      }
      return { repaint: repaintStart, selected: null, quit: false };
    }
    if (name === "escape") {
      s.mode = "list";
      s.eventName = "";
      s.status = "";
      return { repaint: repaintStart, selected: null, quit: false };
    }
    if (name === "backspace" || seq === "\x7f") {
      s.eventName = s.eventName.slice(0, Math.max(0, s.eventName.length - 1));
      return { repaint: repaintStart, selected: null, quit: false };
    }
    if (seq.length === 1 && seq >= " " && !ctrl) {
      s.eventName = s.eventName + seq;
      return { repaint: repaintStart, selected: null, quit: false };
    }
    return { repaint: false, selected: null, quit: false };
  }
  if (s.mode === "filter") {
    if (name === "return" || name === "escape" || seq === "\r") {
      s.mode = "list";
      s.sel = 0;
      return { repaint: repaintStart, selected: null, quit: false };
    }
    if (name === "backspace" || seq === "\x7f") {
      s.filter = s.filter.slice(0, Math.max(0, s.filter.length - 1));
      s.sel = 0;
      return { repaint: repaintStart, selected: null, quit: false };
    }
    if (seq.length === 1 && seq >= " " && !ctrl) {
      s.filter = s.filter + seq;
      s.sel = 0;
      return { repaint: repaintStart, selected: null, quit: false };
    }
    return { repaint: false, selected: null, quit: false };
  }

  // list mode keys
  if (ctrl && name === "n") {
    if (s.sel < rows.length - 1) {
      s.sel = s.sel + 1;
    }
    return { repaint: repaintStart, selected: selRow, quit: false };
  }
  if (ctrl && name === "p") {
    if (s.sel > 0) {
      s.sel = s.sel - 1;
    }
    return { repaint: repaintStart, selected: selRow, quit: false };
  }
  if (name === "down" || name === "up") {
    const delta = name === "down" ? 1 : -1;
    const next = s.sel + delta;
    if (next >= 0 && next < rows.length) {
      s.sel = next;
    }
    return { repaint: repaintStart, selected: selRow, quit: false };
  }
  if (seq === "/") {
    s.mode = "filter";
    return { repaint: repaintStart, selected: null, quit: false };
  }
  if (seq === "s") {
    s.sortIdx = (s.sortIdx + 1) % SORTS.length;
    s.status = "sort " + (SORTS[s.sortIdx] ?? "id");
    return { repaint: repaintStart, selected: null, quit: false };
  }
  if (seq === "f") {
    s.stateIdx = (s.stateIdx + 1) % STATES.length;
    s.sel = 0;
    s.status = "state " + (STATES[s.stateIdx] ?? "all");
    return { repaint: repaintStart, selected: null, quit: false };
  }
  if (name === "return" || seq === "\r") {
    s.mode = s.mode === "details" ? "list" : "details";
    return { repaint: repaintStart, selected: selRow, quit: false };
  }
  if (seq === "r") {
    s.status = "refreshed";
    return { repaint: repaintStart, selected: selRow, quit: false };
  }
  if (seq === "x") {
    if (selRow === null) {
      return { repaint: false, selected: null, quit: false };
    }
    s.mode = "confirm";
    s.confirmAction = "cancel";
    s.status = "cancel job " + String(selRow.id) + "? y/n";
    return { repaint: repaintStart, selected: selRow, quit: false };
  }
  if (seq === "R") {
    if (selRow === null) {
      return { repaint: false, selected: null, quit: false };
    }
    s.mode = "confirm";
    s.confirmAction = "retry";
    s.status = "retry job " + String(selRow.id) + "? y/n";
    return { repaint: repaintStart, selected: selRow, quit: false };
  }
  if (seq === "e") {
    s.mode = "event";
    s.eventName = "";
    s.status = "release event:";
    return { repaint: repaintStart, selected: null, quit: false };
  }
  if (seq.length === 1 && hooks[seq] !== undefined && selRow !== null) {
    // hook keys are lowercase letters not already bound; the command runs and
    // its stderr surfaces in the status line, like a tiny printf pane
    const expanded = expandHook(hooks[seq] as string, selRow);
    const res = runHook(expanded, selRow);
    s.status = "hook " + seq + " -> rc " + String(res.status) + (res.stderr === "" ? "" : ": " + res.stderr);
    return { repaint: repaintStart, selected: selRow, quit: false };
  }
  if (seq === "q" || (ctrl && name === "c")) {
    return { repaint: false, selected: null, quit: true };
  }
  return { repaint: repaintStart, selected: selRow, quit: false };
}

// Render the full screen into one buffer string: header, table, optional
// details pane, one status/footer line. Pure: it takes rows and state, so the
// tests can render without a terminal.
export function renderScreen(s: TuiState, rows: JobRecord[], db: Database, cols: number, hooks: TuiHooks): string {
  const now = Date.now() / 1000;
  const selRow: JobRecord | null = rows.length > 0 && s.sel >= 0 ? rows[s.sel] : null;
  let out = "";
  // header: filter/sort/state and the selection
  const stateName = STATES[s.stateIdx] ?? "all";
  out = out + "coordinate  filter=" + (s.filter === "" ? "-" : s.filter) + "  sort=" + (SORTS[s.sortIdx] ?? "id") + "  state=" + stateName;
  out = out + "  " + String(rows.length) + " job(s)\n";
  // the same table renderer `coordinate jobs` uses, selected row marked
  const table = renderJobsTable(rows, { cmdWidth: Math.max(10, cols - 60 > 10 ? cols - 60 : 20), now });
  const tableLines = table.split("\n");
  for (let i = 0; i < tableLines.length; i++) {
    const line = tableLines[i] ?? "";
    if (line === "" && i === tableLines.length - 1) {
      continue;
    }
    if (i === s.sel + 1) {
      out = out + "> " + line + "\n";
    } else {
      out = out + "  " + line + "\n";
    }
  }
  if (s.mode === "details" && selRow !== null) {
    out = out + renderDetails(selRow, db, cols) + "\n";
  }
  // footer
  const hookNames = Object.keys(hooks).sort();
  out = out + "[ctrl-n/ctrl-p or arrows] move  / filter  s sort  f state  enter details  r refresh  x cancel  R retry  e release  q quit";
  out = out + (hookNames.length > 0 ? "  hooks: " + hookNames.join(",") : "") + "\n";
  if (s.status !== "") {
    out = out + s.status + "\n";
  }
  if (s.mode === "filter") {
    out = out + "/" + s.filter + "\n";
  }
  if (s.mode === "event") {
    out = out + "release event: " + s.eventName + "\n";
  }
  if (s.mode === "confirm" && s.confirmAction !== null) {
    out = out + s.status + "\n";
  }
  return out;
}

// The details pane: decoded metadata, the computed why, recent events and the
// end of the newest attempt's stdout. Same sources as `why` and `logs`.
export function renderDetails(job: JobRecord, db: Database, cols: number): string {
  const width = Math.max(20, cols - 2);
  let out = "\n-- job " + String(job.id) + " (" + job.kind + ", " + job.status + ") --\n";
  const cwd = typeof job.payload["cwd"] === "string" ? (job.payload["cwd"] as string) : "-";
  const repo = typeof job.payload["repo"] === "string" ? (job.payload["repo"] as string) : "-";
  const cmd = typeof job.payload["cmd"] === "string"
    ? (job.payload["cmd"] as string)
    : Array.isArray(job.payload["cmd"])
      ? (job.payload["cmd"] as unknown[]).join(" ")
      : "-";
  out = out + "cwd " + cwd + "  repo " + repo + "\n";
  out = out + "cmd " + cmd.slice(0, width) + "\n";
  out = out + "attempts " + String(job.attempts) + "/" + String(job.max_attempts) + "  priority " + String(job.priority);
  out = out + "  runtime " + String(Math.round(job.runtime_used_s)) + "s";
  if (job.deadline_in_s !== null) {
    out = out + "  deadline in " + String(Math.round(job.deadline_in_s)) + "s";
  }
  out = out + "\n";
  const why = whyJob(db, job.id);
  if (why !== null) {
    out = out + "why: " + why.detail + "\n";
    for (const b of why.blockers) {
      out = out + "blocker: " + b.reason + " (" + b.detail + ")\n";
    }
    if (why.next !== null) {
      out = out + "next: " + why.next + "\n";
    }
  }
  const evs = q.qAll(db, "SELECT id,ts,kind,data FROM events WHERE job_id=? ORDER BY id DESC LIMIT 8", [job.id]) as {
    id: number; ts: number; kind: string; data: string;
  }[];
  if (evs.length > 0) {
    out = out + "recent events:\n";
    for (const e of evs) {
      out = out + "  " + e.kind + " " + e.data.slice(0, Math.max(0, width - e.kind.length - 4)) + "\n";
    }
  }
  const logs = jobLogs(db, job.id);
  if (logs.length > 0) {
    const newest = logs[logs.length - 1] ?? null;
    if (newest !== null && newest.stdout !== null) {
      try {
        const text = fs.readFileSync(newest.stdout, "utf8");
        const tail = text.split("\n").slice(-8).join("\n");
        out = out + "stdout tail (" + String(newest.stdout_bytes) + " bytes):\n" + tail.slice(0, width * 8) + "\n";
      } catch {
        out = out + "stdout: unreadable\n";
      }
    }
  }
  return out;
}

// The live loop: raw mode keypresses, full repaints with cursor home and
// clear. Returns when the user presses q or Ctrl-C. Caller has already
// verified stdout is a TTY.
export function runTui(db: Database, hooks: TuiHooks): void {
  const stdin = process.stdin;
  const stdout = process.stdout;
  readline.emitKeypressEvents(stdin);
  if (stdin.isTTY === true) {
    stdin.setRawMode(true);
  }
  stdin.resume();
  const st = initialState();
  let quit = false;
  let pending: KeyResult | null = null;
  const repaint = (): void => {
    const rows = visibleJobs(st, db);
    const cols = typeof stdout.columns === "number" ? stdout.columns : 80;
    stdout.write("\x1b[H\x1b[2J" + renderScreen(st, rows, db, cols, hooks));
  };
  const onKey = (_ch: string, key: readline.Key): void => {
    if (key === undefined) {
      return;
    }
    pending = handleKey(st, key, db, hooks);
    if (pending.quit === true) {
      quit = true;
    }
  };
  stdin.on("keypress", onKey);
  const sleepMs = (ms: number): { promise: Promise<void>; cancel: () => void } => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const promise = new Promise<void>((res) => {
      t = setTimeout(res, ms);
    });
    return { promise, cancel: () => { if (t !== null) clearTimeout(t); } };
  };
  repaint();
  let tick = sleepMs(1000);
  const loop = (): Promise<void> =>
    tick.promise.then(() => {
      if (quit) {
        return;
      }
      if (pending !== null) {
        const p = pending;
        pending = null;
        if (p.repaint) {
          repaint();
        }
      } else {
        // periodic refresh keeps ages and running states honest
        repaint();
      }
      const next = sleepMs(1000);
      tick = next;
      return loop();
    });
  const done = loop();
  // On exit restore cooked mode so the shell is usable.
  const cleanup = (): void => {
    stdin.removeListener("keypress", onKey);
    if (stdin.isTTY === true) {
      stdin.setRawMode(false);
    }
    stdin.pause();
  };
  void done.then(cleanup);
}
