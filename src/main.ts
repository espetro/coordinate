// coordinate CLI: enqueue, status, wait-on, release, cancel, stats, dead, daemon.
// Port of src/coordinate/cli.py (cmd lane only). Uses hand-rolled argv parsing that
// mirrors argparse semantics (REMAINDER after `--`), because @cutils/cli owns the
// subcommand seam only and cannot express positional remainder commands in-subset.

import { env } from "./env.ts";
import * as q from "./queue.ts";
import { ConfigError, defaultMaxRuntimeS, parseDurationSecs, validateConfig as cfgValidate } from "./config.ts";

function usage(): string {
  return (
    "usage: coordinate <verb> [args]\n" +
    "verbs: enqueue, status [--self], wait-on <id> <event>, release <event>, cancel <id>, stats, events [--follow] [--since ID], forward [--exec CMD] [--once], dead retry [id], daemon\n" +
    "enqueue options:\n" +
    "  --cwd DIR           working directory for the job\n" +
    "  --repo KEY          per-repo cap key (default: cwd; an empty value skips the key)\n" +
    "  --priority N        higher numbers claim first (default 0)\n" +
    "  --max-attempts N    starts allowed after lease expiries (default 3)\n" +
    "  --max-runtime DUR   execution-time cap, e.g. 15m, 2h, 90s (0 = unbounded;\n" +
    "                      default comes from [defaults] max_runtime in config.toml)\n" +
    "  --wait-on EVENT     park the job immediately on this event id\n" +
    "  --slot KEY          extra tool-level slot key (repeatable), e.g. --slot tool:vitest\n" +
    "  --shell             cmd is ONE string, stored and run verbatim via sh -c\n"
  );
}

function fail(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

// Add the derived timecap fields an agent needs: remaining budget and deadline delta (cli.py:24-31).
function jobView(job: q.Job): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys: (keyof q.Job)[] = [
    "id", "kind", "payload", "status", "priority", "run_at", "lease_owner", "lease_expires_at",
    "waiting_on", "attempts", "max_attempts", "created_at", "max_runtime_s", "runtime_used_s",
    "deadline_at", "claim_at", "outcome", "pgid", "pidfile",
  ];
  for (const k of keys) {
    out[k] = job[k];
  }
  const cap = job.max_runtime_s;
  const used = job.runtime_used_s;
  out["runtime_remaining_s"] = cap === null || cap <= 0 ? null : round3(Math.max(0, cap - used));
  const dl = job.deadline_at;
  out["deadline_in_s"] = dl === null || dl <= 0 ? null : round3(dl - Date.now() / 1000);
  return out;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

// Resolve the execution-time cap: explicit flag wins, else [defaults] max_runtime.
// 0 means unbounded; the flag value 0 explicitly disables the machine default.
function maxRuntimeS(flagValue: string | null): number {
  if (flagValue === null) {
    return defaultMaxRuntimeS();
  }
  const secs = parseDurationSecs(flagValue);
  if (secs === null) {
    fail("enqueue --max-runtime: bad duration " + JSON.stringify(flagValue) + " (use e.g. 90s, 15m, 2h)");
  }
  return secs;
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

function isEnqueueOption(name: string): boolean {
  return (
    name === "--cwd" || name === "--repo" || name === "--priority" || name === "--max-attempts" ||
    name === "--max-runtime" || name === "--wait-on" || name === "--shell" || name === "--slot"
  );
}

function optionTakesValue(name: string): boolean {
  return name !== "--shell";
}

// argparse type=int parity: a non-integer exits with a clear message, not a stack trace.
function parseIntArg(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    fail("enqueue " + flag + ": invalid int value: " + JSON.stringify(raw));
  }
  return n;
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
    // fail loudly on an unreadable or invalid config instead of silently defaulting
    cfgValidate();
    const o = opts();
    let cmd: string[] = [];
    // argparse REMAINDER parity (cli.py:56): everything from the first non-option token on,
    // or from the first `--`, is the command. `--opt=value` is accepted like argparse.
    let flagPart: string[];
    let valuePart: string[];
    const dashed = rest.indexOf("--");
    if (dashed >= 0) {
      flagPart = rest.slice(0, dashed);
      valuePart = rest.slice(dashed + 1);
    } else {
      let first = rest.length;
      for (let i = 0; i < rest.length; i++) {
        if (!rest[i].startsWith("--")) {
          first = i;
          break;
        }
        if (rest[i] === "--shell") {
          // --shell is a store_true flag; REMAINDER stops at the first positional anyway
          continue;
        }
        const eq = rest[i].indexOf("=");
        const name = eq === -1 ? rest[i] : rest[i].slice(0, eq);
        if (!isEnqueueOption(name)) {
          first = i;
          break;
        }
        if (eq === -1 && optionTakesValue(name)) {
          i = i + 1;
        }
      }
      flagPart = rest.slice(0, first);
      valuePart = rest.slice(first);
    }
    if (valuePart.length > 0 && valuePart[0] === "--") {
      valuePart = valuePart.slice(1);
    }
    for (let i = 0; i < flagPart.length; i++) {
      const t = flagPart[i];
      const eq = t.indexOf("=");
      const name = eq === -1 ? t : t.slice(0, eq);
      const inline = eq === -1 ? null : t.slice(eq + 1);
      const need = () => {
        if (inline !== null) {
          return inline;
        }
        i = i + 1;
        if (i >= flagPart.length) {
          fail("enqueue: argument " + name + ": expected one value");
        }
        return flagPart[i];
      };
      if (name === "--cwd") {
        o.cwd = need();
      } else if (name === "--repo") {
        o.repo = need();
      } else if (name === "--priority") {
        o.priority = parseIntArg(need(), "--priority");
      } else if (name === "--max-attempts") {
        o.maxAttempts = parseIntArg(need(), "--max-attempts");
      } else if (name === "--max-runtime") {
        o.maxRuntime = need();
      } else if (name === "--wait-on") {
        o.waitOn = need();
      } else if (name === "--shell") {
        o.shell = true;
      } else if (name === "--slot") {
        o.slots.push(need());
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
    const cap = maxRuntimeS(o.maxRuntime);
    const jid = q.enqueue(db, payload, o.priority, o.maxAttempts, null, cap > 0 ? cap : null);
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
      process.stdout.write(JSON.stringify(jobView(job), null, 2) + "\n");
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

main().catch((e) => {
  if (e instanceof ConfigError) {
    fail("coordinate: " + e.message);
  }
  fail(String(e instanceof Error ? e.message : e));
});
