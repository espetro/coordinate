// Human table renderer over the shared read model. The same queryJobs()
// results feed the machine NDJSON (readmodel.ts) and this table; the table is
// presentation only and is explicitly not the machine contract (see
// docs/machine-schema.md).

import type { JobRecord } from "./readmodel.ts";

// Truncate a cell to a width, marking the cut with an ellipsis so a long
// command cannot blow out the row.
function trunc(s: string, width: number): string {
  if (s.length <= width) {
    return s;
  }
  if (width <= 1) {
    return s.slice(0, width);
  }
  return s.slice(0, width - 1) + "\u2026";
}

function pad(s: string, width: number): string {
  let out = s;
  while (out.length < width) {
    out = out + " ";
  }
  return out;
}

// A short human command summary from the decoded payload: the cmd array
// joined, or the shell string, or the ACP agent, or a placeholder.
function commandSummary(payload: Record<string, unknown>): string {
  const cmd = payload["cmd"];
  if (typeof cmd === "string") {
    return cmd;
  }
  if (Array.isArray(cmd)) {
    return (cmd as unknown[]).join(" ");
  }
  const agent = payload["agent"];
  if (typeof agent === "string" && agent !== "") {
    return "acp:" + agent;
  }
  const raw = payload["_raw"];
  if (typeof raw === "string") {
    return raw;
  }
  return "";
}

// Relative age in compact units: 42s, 5m, 3h, 2d. Times are epoch seconds.
function age(now: number, ts: number): string {
  const d = Math.max(0, Math.floor(now - ts));
  if (d < 60) {
    return String(d) + "s";
  }
  if (d < 3600) {
    return String(Math.floor(d / 60)) + "m";
  }
  if (d < 86400) {
    return String(Math.floor(d / 3600)) + "h";
  }
  return String(Math.floor(d / 86400)) + "d";
}

export interface TableOptions {
  cmdWidth?: number; // max command column width; default 40
  now?: number; // epoch seconds; defaults to Date.now()/1000
}

// Render JobRecords as an aligned ASCII table. The header row is included;
// the row order is exactly the order of the records (already sorted and
// filtered by the query).
export function renderJobsTable(records: JobRecord[], opts?: TableOptions): string {
  const cmdWidth = opts !== undefined && opts.cmdWidth !== undefined ? opts.cmdWidth : 40;
  const now = opts !== undefined && opts.now !== undefined ? opts.now : Date.now() / 1000;
  const header = ["ID", "STATUS", "AGE", "ATT", "PRI", "WAITING_ON", "COMMAND"];
  const rows: string[][] = [];
  for (const r of records) {
    rows.push([
      String(r.id),
      r.status,
      age(now, r.created_at),
      String(r.attempts) + "/" + String(r.max_attempts),
      String(r.priority),
      r.waiting_on === null ? "-" : r.waiting_on,
      trunc(commandSummary(r.payload), cmdWidth),
    ]);
  }
  const widths = [0, 0, 0, 0, 0, 0, 0];
  for (let c = 0; c < header.length; c++) {
    widths[c] = header[c].length;
  }
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      if (row[c].length > widths[c]) {
        widths[c] = row[c].length;
      }
    }
  }
  const line = (cells: string[]): string => {
    let out = "";
    for (let c = 0; c < cells.length; c++) {
      // the last column is left ragged: no padding after the command
      out = out + (c === cells.length - 1 ? cells[c] : pad(trunc(cells[c], widths[c]), widths[c])) + (c === cells.length - 1 ? "" : "  ");
    }
    return out;
  };
  let out = line(header) + "\n";
  for (const row of rows) {
    out = out + line(row) + "\n";
  }
  return out;
}
