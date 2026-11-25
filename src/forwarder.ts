// coordinate forward: tails the events table and invokes an external sink
// command per event (generic --exec; T3/ntfy/webhook stay pluggable outside).
// Port of src/coordinate_t3_forwarder.py with the sink de-hardcoded.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as q from "./queue.ts";
// Effect v4 for the follow loop: gen + sleep as the polling driver, replacing
// the hand-rolled `await new Promise(setTimeout)` chain. Deep function-style
// imports, like daemon.ts and acp.ts.
import { gen, runPromise, sleep } from "effect/Effect";
import { millis as durationMillis } from "effect/Duration";

export const DEFAULT_KINDS = "done,failed,timed_out,cancelled,dead,requeued";

export function defaultCursorPath(): string {
  const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(state, "coordinate", "forward-cursor");
}

export function loadCursor(p: string): number {
  try {
    const t = fs.readFileSync(p, "utf8").trim();
    const n = Number(t);
    return Number.isFinite(n) && t !== "" ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

export function saveCursor(p: string, id: number): void {
  try {
    fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true });
  } catch (e) {
    if ((e as { code?: string }).code !== "EEXIST") {
      throw e;
    }
  }
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, String(id));
  fs.renameSync(tmp, p);
}

export interface EventRow {
  id: number;
  ts: number;
  job_id: number | null;
  kind: string;
  data: Record<string, unknown>;
}

export function render(ev: EventRow): string {
  const data = ev.data || {};
  const bits = [`coordinate[${ev.kind}] job ${ev.job_id}`];
  if (data.outcome) bits.push(String(data.outcome));
  if (data.reason) bits.push(String(data.reason));
  if (data.waiting_on) bits.push(`waiting_on=${data.waiting_on}`);
  if (ev.kind === "claimed" || ev.kind === "requeued") {
    bits.push(data.attempt ? `attempt ${data.attempt}` : "retrying");
  }
  return bits.join(" \u2014 ");
}

interface Sink {
  cmd: string;
  run(message: string, ev: EventRow): boolean;
}

function makeSink(cmd: string): Sink {
  return {
    cmd,
    run(message: string, ev: EventRow): boolean {
      const full = cmd.includes("{message}") ? cmd.split("{message}").join(message) : cmd;
      const r = spawnSync("sh", ["-c", full], {
        input: JSON.stringify(ev),
        timeout: 120_000,
        encoding: "utf8",
      });
      if (r.status !== 0) {
        process.stderr.write(`exec sink failed rc=${r.status}: ${String(r.stderr || "").slice(0, 200)}\n`);
        return false;
      }
      return true;
    },
  };
}

export interface ForwardOpts {
  exec: string;
  sinkFn?: ((message: string, ev: EventRow) => boolean) | null;
  machine?: string;
  interval?: number;
  cursor?: string;
  since?: number | null;
  kinds?: string;
  once?: boolean;
  maxPolls?: number | null;
  verbose?: boolean;
}

export async function forward(o: ForwardOpts): Promise<void> {
  // The queue's own machine name, so the forwarder and the daemon can never
  // disagree: the daemon labels every event with queue.ts MACHINE (the
  // COORDINATE_/FLEET_ env pair, "laptop" by default), and the forwarder
  // labels its messages with the same value. A bare MACHINE env is not
  // consulted: the daemon does not read it either.
  const machine = o.machine || q.MACHINE;
  const kinds = new Set((o.kinds ?? DEFAULT_KINDS).split(",").map((k) => k.trim()).filter(Boolean));
  const cursorPath = o.cursor || defaultCursorPath();
  let cur = o.since !== null && o.since !== undefined ? o.since : loadCursor(cursorPath);
  const sink: Sink = o.sinkFn !== null && o.sinkFn !== undefined ? { cmd: o.exec ?? "", run: o.sinkFn } : makeSink(o.exec);
  const interval = (o.interval ?? 2) * 1000;
  const db = q.connect();

  process.stderr.write(
    `forwarding machine=${machine} kinds=${kinds.size ? [...kinds].sort().join(",") : "ALL"} cursor=${cur}\n`,
  );

  const poll = (): void => {
    const rows = q.qAll(db, "SELECT id,ts,job_id,kind,data FROM events WHERE id>? ORDER BY id", [cur]) as {
      id: number;
      ts: number;
      job_id: number | null;
      kind: string;
      data: string;
    }[];
    for (const r of rows) {
      if (kinds.size && !kinds.has(r.kind)) {
        // Filtered events need no send, so the cursor may advance past them (D16).
        cur = r.id;
        saveCursor(cursorPath, cur);
        continue;
      }
      const ev: EventRow = {
        id: r.id,
        ts: r.ts,
        job_id: r.job_id,
        kind: r.kind,
        data: r.data ? JSON.parse(r.data) : {},
      };
      const message = `[${machine}] ${render(ev)}`;
      if (sink.run(message, ev)) {
        // Advance only after a successful send, so a failed event is retried on the next poll.
        cur = r.id;
        saveCursor(cursorPath, cur);
        if (o.verbose) process.stderr.write(`sent: ${message}\n`);
      } else {
        // sink failure: stop advancing; retry on the next poll
        break;
      }
    }
  };

  // The follow loop as one Effect program: poll, sleep the interval, repeat
  // until --once or maxPolls. Effect.sleep replaces the awaited setTimeout
  // promise; the loop shape reads like the poll loop it is.
  const follow = gen(function* () {
    let polls = 1;
    poll();
    while (!o.once && (o.maxPolls === null || o.maxPolls === undefined || polls < o.maxPolls)) {
      yield* sleep(durationMillis(interval));
      polls = polls + 1;
      poll();
    }
  });
  await runPromise(follow);
}
