// coordinate CLI: enqueue, status, wait-on, release, cancel, stats, dead, daemon.
// Port of src/coordinate/cli.py (cmd lane only). Uses hand-rolled argv parsing that
// mirrors argparse semantics (REMAINDER after `--`), because @cutils/cli owns the
// subcommand seam only and cannot express positional remainder commands in-subset.

import { env } from "./env.ts";
import * as q from "./queue.ts";

function usage(): string {
  return "usage: coordinate <verb> [args]\nverbs: enqueue, status [--self], wait-on <id> <event>, release <event>, cancel <id>, stats, events [--follow] [--since ID], forward [--exec CMD] [--once], dead retry [id], daemon\n";
}

function fail(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

function parseDuration(text: string): number {
  const t = String(text).trim().toLowerCase();
  const mult: Record<string, number> = { s: 1.0, m: 60.0, h: 3600.0 };
  const last = t.slice(-1);
  if (mult[last] !== undefined) {
    return Number(t.slice(0, -1)) * mult[last];
  }
  const v = Number(t);
  if (Number.isNaN(v)) {
    fail("enqueue --max-runtime: bad duration " + JSON.stringify(text) + " (use e.g. 90s, 15m, 2h)");
  }
  return v;
}

interface Opts {
  cwd: string | null;
  repo: string | null;
  priority: number;
  maxAttempts: number;
  maxRuntime: string | null;
  waitOn: string | null;
  shell: boolean;
  selfFlag: boolean;
  slots: string[];
}

function opts(): Opts {
  return { cwd: null, repo: null, priority: 0, maxAttempts: 3, maxRuntime: null, waitOn: null, shell: false, selfFlag: false, slots: [] };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(
      usage(),
    );
    process.exit(argv.length === 0 ? 1 : 0);
  }
  const verb = argv[0];
  const rest = argv.slice(1);

  if (verb === "daemon") {
    // dynamic import keeps daemon deps out of CLI-only startup
    import("./daemon.ts").then((d) => d.run()).catch((e) => fail(String(e)));
    return;
  }

  const db = q.connect();

  if (verb === "enqueue") {
    const o = opts();
    let cmd: string[] = [];
    const dashed = rest.indexOf("--");
    const flagPart = dashed >= 0 ? rest.slice(0, dashed) : rest;
    let valuePart = dashed >= 0 ? rest.slice(dashed + 1) : [];
    if (valuePart.length > 0 && valuePart[0] === "--") {
      valuePart = valuePart.slice(1);
    }
    for (let i = 0; i < flagPart.length; i++) {
      const t = flagPart[i];
      if (t === "--cwd") {
        o.cwd = flagPart[++i];
      } else if (t === "--repo") {
        o.repo = flagPart[++i];
      } else if (t === "--priority") {
        o.priority = Number(flagPart[++i]);
      } else if (t === "--max-attempts") {
        o.maxAttempts = Number(flagPart[++i]);
      } else if (t === "--max-runtime") {
        o.maxRuntime = flagPart[++i];
      } else if (t === "--wait-on") {
        o.waitOn = flagPart[++i];
      } else if (t === "--shell") {
        o.shell = true;
      } else if (t === "--slot") {
        o.slots.push(flagPart[++i]);
      } else {
        fail("enqueue: unknown option " + t);
      }
    }
    cmd = valuePart;
    if (cmd.length === 0) {
      fail("enqueue: no command given");
    }
    if (o.shell && cmd.length !== 1) {
      fail('enqueue --shell: pass the command as ONE quoted string, e.g. --shell -- \'sh -c "echo hi"\'');
    }
    const payload: q.Payload = { cmd: o.shell ? cmd[0] : cmd, cwd: o.cwd, repo: null, slots: null, session: null };
    if (o.repo !== null) {
      payload.repo = o.repo;
    }
    if (o.slots.length > 0) {
      payload.slots = o.slots;
    }
    const maxRuntimeS = o.maxRuntime === null ? null : parseDuration(o.maxRuntime);
    const jid = q.enqueue(db, payload, o.priority, o.maxAttempts, null, maxRuntimeS !== null && maxRuntimeS > 0 ? maxRuntimeS : null);
    if (o.waitOn !== null) {
      q.waitOn(db, jid, o.waitOn);
    }
    process.stdout.write(String(jid) + "\n");
  } else if (verb === "status") {
    let jidText: string | null = null;
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i];
      if (t === "--self") {
        const v = env("JOB_ID");
        if (!v) {
          fail("status --self: COORDINATE_JOB_ID (or FLEET_JOB_ID) is not set");
        }
        jidText = v;
      } else {
        jidText = t;
      }
    }
    if (jidText !== null) {
      const job = q.getJob(db, Number(jidText));
      if (job === null) {
        fail("no job " + jidText);
      }
      process.stdout.write(JSON.stringify(job, null, 2) + "\n");
    } else {
      const rows = db.prepareRaw("SELECT id, status, attempts, max_attempts, waiting_on, payload FROM jobs ORDER BY id").all([]) as Record<string, unknown>[];
      for (const r of rows) {
        const cells = [r["id"], r["status"], r["attempts"], r["max_attempts"], r["waiting_on"], r["payload"]];
        const line = cells.map((v) => (v === null || v === undefined ? "" : String(v))).join("\t");
        process.stdout.write(line + "\n");
      }
    }
  } else if (verb === "wait-on") {
    const ok = q.waitOn(db, Number(rest[0]), rest[1]);
    if (!ok) {
      fail("job " + rest[0] + " not parkable");
    }
  } else if (verb === "release") {
    const ids = q.release(db, rest[0]);
    if (ids.length > 0) {
      process.stdout.write(ids.join("\n") + "\n");
    }
  } else if (verb === "cancel") {
    const ok = q.cancel(db, Number(rest[0]));
    if (!ok) {
      fail("job " + rest[0] + " not cancellable");
    }
  } else if (verb === "events") {
    // JSONL event tail: list once, or poll MAX(id) with --follow (matches Python CLI).
    let follow = false;
    let since = 0;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--follow") {
        follow = true;
      } else if (rest[i] === "--since") {
        since = Number(rest[++i]);
      } else {
        fail("events: unknown argument " + rest[i]);
      }
    }
    let last = since;
    const printRows = (rows: { id: number; ts: number; job_id: number | null; kind: string; data: string }[]) => {
      for (const r of rows) {
        last = r.id;
        const line = { id: r.id, ts: r.ts, job_id: r.job_id, kind: r.kind, data: r.data ? JSON.parse(r.data) : {} };
        process.stdout.write(JSON.stringify(line) + "\n");
      }
    };
    printRows(
      db.prepareRaw("SELECT id,ts,job_id,kind,data FROM events WHERE id>? ORDER BY id").all([last]) as never,
    );
    while (follow) {
      printRows(
        db.prepareRaw("SELECT id,ts,job_id,kind,data FROM events WHERE id>? ORDER BY id").all([last]) as never,
      );
      await new Promise((res) => setTimeout(res, 500));
    }
  } else if (verb === "forward") {
    const { forward } = await import("./forwarder.ts");
    const o: import("./forwarder.ts").ForwardOpts = { exec: "", since: null };
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i];
      if (t === "--exec") o.exec = rest[++i];
      else if (t === "--machine") o.machine = rest[++i];
      else if (t === "--interval") o.interval = Number(rest[++i]);
      else if (t === "--cursor") o.cursor = rest[++i];
      else if (t === "--since") o.since = Number(rest[++i]);
      else if (t === "--kinds") o.kinds = rest[++i];
      else if (t === "--once") o.once = true;
      else if (t === "-v" || t === "--verbose") o.verbose = true;
      else fail("forward: unknown argument " + t);
    }
    if (!o.exec) fail("forward: --exec is required");
    await forward(o);
  } else if (verb === "stats") {
    process.stdout.write(JSON.stringify(q.stats(db)) + "\n");
  } else if (verb === "dead") {
    const action = rest[0];
    if (action !== "retry") {
      fail("dead: action must be retry");
    }
    const ids = q.retryDead(db, rest.length > 1 ? Number(rest[1]) : null);
    if (ids.length > 0) {
      process.stdout.write(ids.join("\n") + "\n");
    }
  } else {
    fail("unknown verb: " + verb);
  }
}

main();
