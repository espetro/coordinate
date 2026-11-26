// coordinate CLI: enqueue, status, wait-on, release, cancel, stats, dead, daemon.
// Port of src/coordinate/cli.py (cmd lane only). Uses hand-rolled argv parsing that
// mirrors argparse semantics (REMAINDER after `--`), because @cutils/cli owns the
// subcommand seam only and cannot express positional remainder commands in-subset.

import * as fs from "node:fs";
import * as path from "node:path";
import { env } from "./env.ts";
import * as q from "./queue.ts";
import { jobRecord, queryJobs, queryEvents, whyJob, health, jobLogs, type JobQuery, type SortKey } from "./readmodel.ts";
import { renderJobsTable } from "./format-table.ts";
import { ConfigError, defaultMaxRuntimeS, parseDurationSecs, validateConfig as cfgValidate } from "./config.ts";

function usage(): string {
  return (
    "usage: coordinate <verb> [args]\n" +
    "verbs: enqueue, status [--self], jobs, wait-on <id> <event>, release <event>, cancel <id>, stats, cap [show|set --machine-cap N|--repo-cap N] [--force], events [--follow] [--since ID], forward [--exec CMD] [--once], dead retry [id], logs <id> [--attempt N] [--follow], why <id> [--json], health [--json], tui, daemon, doctor, service install [--force]|uninstall|status\n" +
    "jobs [--status a,b] [--kind a,b] [--search TEXT] [--sort id|created|priority|status|runtime] [--asc|--desc] [--limit N] [--json] [--watch] prints a human table; --json emits one v1 job JSON object per line (see docs/machine-schema.md)\n" +
    "logs <id> prints the newest captured stdout and stderr; --attempt N reads that attempt, --json emits paths and byte counts, --follow tails new output\n" +
    "why <id> explains the job's live state: blockers, next step, log pointers (--json for the machine record)\n" +
    "health prints a fixed queue summary; --json emits the one-object v1 machine record\n" +
    "tui runs the interactive triage screen (needs a TTY on stdout); hooks come from [tui] in config.toml\n" +
    "enqueue --acp <agent> --cwd <dir> --prompt <text> enqueues an acp job for the agent (registry via --registry)\n" +
    "enqueue options:\n" +
    "  --cwd DIR           working directory for the job\n" +
    "  --repo KEY          per-repo cap key (default: cwd; an empty value skips the key)\n" +
    "  --priority N        higher numbers claim first (default 0)\n" +
    "  --max-attempts N    starts allowed after lease expiries (default 3)\n" +
    "  --max-runtime DUR   execution-time cap, e.g. 15m, 2h, 90s (0 = unbounded;\n" +
    "                      default comes from [defaults] max_runtime in config.toml)\n" +
    "  --run-at WHEN       earliest start, as a delay (30s, 15m, 2h) or an ISO\n" +
    "                      timestamp (2026-11-23T18:00:00Z); the job stays queued\n" +
    "                      until then\n" +
    "  --wait-on EVENT     park the job immediately on this event id\n" +
    "  --slot KEY          extra tool-level slot key (repeatable), e.g. --slot tool:vitest\n" +
    "  --shell             cmd is ONE string, stored and run verbatim via sh -c\n"
  );
}

function fail(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

// The size of a log file, or 0 when it is gone.
function fileSizeOf(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

// A slice of a log file, from byte offset to the current end.
function readFrom(p: string, offset: number, size: number): string {
  try {
    const fd = fs.openSync(p, "r");
    try {
      const buf = Buffer.alloc(size - offset);
      const read = fs.readSync(fd, buf, 0, buf.length, offset);
      return buf.slice(0, read).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

// Print a captured log file to stdout, with a header naming the stream.
function printLogFile(p: string | null, stream: string): void {
  if (p === null) {
    return;
  }
  let text = "";
  try {
    text = fs.readFileSync(p, "utf8");
  } catch {
    text = "";
  }
  process.stdout.write("--- " + stream + " (" + p + ") ---\n");
  process.stdout.write(text);
  if (text !== "" && text.charAt(text.length - 1) !== "\n") {
    process.stdout.write("\n");
  }
}

function jobView(job: q.Job): Record<string, unknown> {
  // Single-job detail stays pretty-printed for human readers; the canonical
  // machine record is the v1 record from readmodel.ts (see docs/machine-schema.md).
  // Build the detail object rather than deleting `v`: the windows scriptc
  // runtime treats record fields as non-configurable, so `delete` throws there.
  const rec = jobRecord(job);
  return {
    id: rec.id,
    kind: rec.kind,
    status: rec.status,
    payload: rec.payload,
    priority: rec.priority,
    run_at: rec.run_at,
    lease_owner: rec.lease_owner,
    lease_expires_at: rec.lease_expires_at,
    waiting_on: rec.waiting_on,
    attempts: rec.attempts,
    max_attempts: rec.max_attempts,
    created_at: rec.created_at,
    max_runtime_s: rec.max_runtime_s,
    runtime_used_s: rec.runtime_used_s,
    runtime_remaining_s: rec.runtime_remaining_s,
    deadline_at: rec.deadline_at,
    deadline_in_s: rec.deadline_in_s,
    claim_at: rec.claim_at,
    outcome: rec.outcome,
    pgid: rec.pgid,
    pidfile: rec.pidfile,
  };
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

// --run-at: a delay such as 90s, 15m, 2h, or an absolute ISO timestamp
// (with or without the Z). Returns epoch seconds, or null when absent.
function runAtSecs(flagValue: string | null): number | null {
  if (flagValue === null) {
    return null;
  }
  const t = flagValue.trim();
  if (t === "") {
    fail("enqueue --run-at: empty value");
  }
  if (/^[0-9]+(\.[0-9]+)?[smh]?$/.test(t)) {
    // a bare number is seconds, like --max-runtime; a suffix picks the unit
    const secs = parseDurationSecs(t);
    if (secs === null) {
      fail("enqueue --run-at: bad duration " + JSON.stringify(t) + " (use e.g. 90s, 15m, 2h)");
    }
    return Date.now() / 1000 + secs;
  }
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) {
    fail("enqueue --run-at: bad timestamp " + JSON.stringify(t) + " (use a delay like 15m or an ISO timestamp like 2026-11-23T18:00:00Z)");
  }
  return ms / 1000;
}

interface Opts {
  cwd: string | null;
  repo: string | null;
  priority: number;
  maxAttempts: number;
  maxRuntime: string | null;
  runAt: string | null;
  waitOn: string | null;
  shell: boolean;
  selfFlag: boolean;
  slots: string[];
  acp: string | null;
  prompt: string | null;
  registry: string | null;
}

function opts(): Opts {
  return { cwd: null, repo: null, priority: 0, maxAttempts: 3, maxRuntime: null, runAt: null, waitOn: null, shell: false, selfFlag: false, slots: [], acp: null, prompt: null, registry: null };
}

function isEnqueueOption(name: string): boolean {
  return (
    name === "--cwd" || name === "--repo" || name === "--priority" || name === "--max-attempts" ||
    name === "--max-runtime" || name === "--run-at" || name === "--wait-on" || name === "--shell" || name === "--slot" ||
    name === "--acp" || name === "--prompt" || name === "--registry"
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
  if (argv[0] === "--version" || argv[0] === "-V" || argv[0] === "version") {
    const { CLI_VERSION } = await import("./version.ts");
    process.stdout.write("coordinate " + CLI_VERSION + "\n");
    return;
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
      } else if (name === "--run-at") {
        o.runAt = need();
      } else if (name === "--wait-on") {
        o.waitOn = need();
      } else if (name === "--shell") {
        o.shell = true;
      } else if (name === "--slot") {
        o.slots.push(need());
      } else if (name === "--acp") {
        o.acp = need();
      } else if (name === "--prompt") {
        o.prompt = need();
      } else if (name === "--registry") {
        o.registry = need();
      } else {
        fail("enqueue: unknown option " + t);
      }
    }
    cmd = valuePart;
    if (o.acp !== null) {
      // ACP lane: no command remainder; the agent comes from the registry.
      if (o.cwd === null || o.prompt === null) {
        fail("enqueue --acp: --cwd and --prompt are required");
      }
      if (cmd.length > 0) {
        fail("enqueue --acp: no command expected");
      }
      const payload: q.Payload = { cmd: [], cwd: path.resolve(o.cwd), repo: null, slots: null, session: null };
      const r = payload as unknown as Record<string, unknown>;
      r["agent"] = o.acp;
      r["prompt"] = o.prompt;
      if (o.registry !== null) {
        r["registry"] = o.registry;
      }
      const cap = maxRuntimeS(o.maxRuntime);
      const jid = q.enqueue(db, payload, o.priority, o.maxAttempts, runAtSecs(o.runAt), cap > 0 ? cap : null, "acp");
      if (o.waitOn !== null) {
        q.waitOn(db, jid, o.waitOn);
      }
      process.stdout.write(String(jid) + "\n");
      return;
    }
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
    const jid = q.enqueue(db, payload, o.priority, o.maxAttempts, runAtSecs(o.runAt), cap > 0 ? cap : null);
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
      // Compatibility: the historical no-id rows stay tab-separated. The
      // human table lives on `jobs`; agents should use `jobs --json`.
      const rows = q.qAll(db, "SELECT id, status, attempts, max_attempts, waiting_on, payload FROM jobs ORDER BY id", []) as Record<string, unknown>[];
      for (const r of rows) {
        const cells = [r["id"], r["status"], r["attempts"], r["max_attempts"], r["waiting_on"], r["payload"]];
        const line = cells.map((v) => (v === null || v === undefined ? "" : String(v))).join("\t");
        process.stdout.write(line + "\n");
      }
    }
  } else if (verb === "jobs") {
    const query: JobQuery = { sort: "id", asc: false };
    let asJson = false;
    let watch = false;
    const parseList = (v: string): string[] => v.split(",").map((s) => s.trim()).filter((s) => s !== "");
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i];
      const eq = t.indexOf("=");
      const name = eq === -1 ? t : t.slice(0, eq);
      const inline = eq === -1 ? null : t.slice(eq + 1);
      const need = (): string => {
        if (inline !== null) return inline;
        i = i + 1;
        if (i >= rest.length) fail("jobs: argument " + name + ": expected one value");
        return rest[i];
      };
      if (name === "--status") {
        query.status = parseList(need());
      } else if (name === "--kind") {
        query.kind = parseList(need());
      } else if (name === "--search") {
        query.search = need();
      } else if (name === "--sort") {
        const v = need() as SortKey;
        if (["id", "created", "priority", "status", "runtime"].indexOf(v) === -1) {
          fail("jobs --sort: must be one of id, created, priority, status, runtime");
        }
        query.sort = v;
      } else if (name === "--asc") {
        query.asc = true;
      } else if (name === "--desc") {
        query.asc = false;
      } else if (name === "--limit") {
        const n = Number(need());
        if (!Number.isInteger(n) || n < 0) {
          fail("jobs --limit: must be a non-negative integer");
        }
        query.limit = n;
      } else if (name === "--json") {
        asJson = true;
      } else if (name === "--watch") {
        watch = true;
      } else {
        fail("jobs: unknown argument " + t);
      }
    }
    if (asJson && watch) {
      fail("jobs: --json and --watch cannot be combined");
    }
    const emitRecords = (): void => {
      for (const rec of queryJobs(db, query)) {
        process.stdout.write(JSON.stringify(rec) + "\n");
      }
    };
    if (asJson) {
      // Machine surface: the canonical v1 NDJSON records, one per line.
      emitRecords();
    } else if (!watch) {
      // Human surface: the table is presentation only, never the contract.
      process.stdout.write(renderJobsTable(queryJobs(db, query)));
    } else {
      // Non-interactive watch: poll and repaint with plain ANSI cursor moves.
      // Scripting stays on --json; this is for a human watching a terminal.
      const repaint = (): void => {
        process.stdout.write("\x1b[H\x1b[2J");
        process.stdout.write(renderJobsTable(queryJobs(db, query)));
      };
      repaint();
      for (;;) {
        await new Promise((res) => setTimeout(res, 1000));
        repaint();
      }
    }
  } else if (verb === "logs") {
    // The captured output of a job's attempts. The files live in the state
    // directory; the metadata that links job, attempt and paths is durable.
    let jidText: string | null = null;
    let attemptFilter: number | null = null;
    let follow = false;
    let asJson = false;
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i];
      if (t === "--attempt") {
        attemptFilter = Number(rest[++i]);
        if (!Number.isInteger(attemptFilter)) {
          fail("logs --attempt: must be an integer");
        }
      } else if (t === "--follow") {
        follow = true;
      } else if (t === "--json") {
        asJson = true;
      } else if (t.startsWith("--")) {
        fail("logs: unknown argument " + t);
      } else {
        jidText = t;
      }
    }
    if (jidText === null) {
      fail("logs: a job id is required");
    }
    const jid = Number(jidText);
    if (!Number.isInteger(jid)) {
      fail("logs: job id must be an integer");
    }
    if (q.getJob(db, jid) === null) {
      fail("no job " + jidText);
    }
    if (asJson && follow) {
      fail("logs: --json and --follow cannot be combined");
    }
    const attempts = jobLogs(db, jid);
    if (attempts.length === 0) {
      fail("job " + jidText + " has no captured output");
    }
    const selected =
      attemptFilter === null
        ? [attempts[attempts.length - 1]]
        : attempts.filter((a) => a.attempt === attemptFilter);
    if (selected.length === 0) {
      fail("job " + jidText + " has no captured attempt " + String(attemptFilter));
    }
    if (asJson) {
      for (const a of selected) {
        process.stdout.write(
          JSON.stringify({
            v: 1,
            job_id: jid,
            attempt: a.attempt,
            stdout: a.stdout,
            stderr: a.stderr,
            stdout_bytes: a.stdout_bytes,
            stderr_bytes: a.stderr_bytes,
            created_at: a.created_at,
          }) + "\n",
        );
      }
    } else {
      for (const a of selected) {
        printLogFile(a.stdout, "stdout");
        printLogFile(a.stderr, "stderr");
      }
    }
    if (follow) {
      // Tail the selected attempt's files: the same shape as `events --follow`.
      const target = selected[selected.length - 1];
      const offsets: Record<string, number> = {};
      for (const p of [target.stdout, target.stderr]) {
        if (p !== null) {
          offsets[p] = fileSizeOf(p);
        }
      }
      for (;;) {
        await new Promise((res) => setTimeout(res, 500));
        for (const p of Object.keys(offsets)) {
          const size = fileSizeOf(p);
          if (size > offsets[p]) {
            const chunk = readFrom(p, offsets[p], size);
            offsets[p] = size;
            process.stdout.write(chunk);
          }
        }
      }
    }
  } else if (verb === "why") {
    // Explain the job's live state from the current rows, not from history.
    let jidText: string | null = null;
    let asJson = false;
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i];
      if (t === "--json") {
        asJson = true;
      } else if (t.startsWith("--")) {
        fail("why: unknown argument " + t);
      } else {
        jidText = t;
      }
    }
    if (jidText === null) {
      fail("why: a job id is required");
    }
    const rec = whyJob(db, Number(jidText));
    if (rec === null) {
      fail("no job " + jidText);
    }
    if (asJson) {
      process.stdout.write(JSON.stringify(rec) + "\n");
    } else {
      process.stdout.write("job " + String(rec.id) + ": " + rec.state + "\n");
      process.stdout.write("  " + rec.detail + "\n");
      if (rec.blockers.length > 0) {
        for (const b of rec.blockers) {
          process.stdout.write("  blocker: " + b.reason + " (" + b.detail + ")\n");
        }
      } else {
        process.stdout.write("  blocker: none\n");
      }
      if (rec.next !== null) {
        process.stdout.write("  next: " + rec.next + "\n");
      }
      for (const a of rec.logs) {
        process.stdout.write(
          "  attempt " +
            String(a.attempt) +
            ": stdout " +
            (a.stdout === null ? "none" : a.stdout + " (" + String(a.stdout_bytes) + " bytes)") +
            ", stderr " +
            (a.stderr === null ? "none" : a.stderr + " (" + String(a.stderr_bytes) + " bytes)") +
            "\n",
        );
      }
    }
  } else if (verb === "health") {
    // One fixed summary object for scripts and panels.
    let asJson = false;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--json") {
        asJson = true;
      } else {
        fail("health: unknown argument " + rest[i]);
      }
    }
    const rec = health(db);
    if (asJson) {
      process.stdout.write(JSON.stringify(rec) + "\n");
    } else {
      process.stdout.write(
        "machine " +
          rec.machine +
          "  daemon " +
          (rec.daemon.running ? "up (pid " + String(rec.daemon.pid) + ")" : "not running") +
          "\n",
      );
      process.stdout.write(
        "queued " +
          String(rec.queued) +
          "  running " +
          String(rec.running) +
          "  waiting " +
          String(rec.waiting) +
          "  done " +
          String(rec.done) +
          "  failed " +
          String(rec.failed) +
          "  dead " +
          String(rec.dead) +
          "  timed_out " +
          String(rec.timed_out) +
          "\n",
      );
      process.stdout.write(
        "caps: machine " + String(rec.machine_cap) + ", repo " + String(rec.repo_cap) + "\n",
      );
      for (const s of rec.slots) {
        process.stdout.write("slot " + s.key + ": " + String(s.cost) + "/" + String(s.limit) + "\n");
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
  } else if (verb === "lease") {
    // Weighted semaphore leases with FIFO waits (surfaces-design.md). Open to
    // any process on the machine, job or not: the default owner is the parent
    // process of this CLI call, so a shim or hook that stays alive while the
    // tool runs keeps the lease; a dead owner is reaped within one poll cycle
    // of the next acquirer and the TTL is the final backstop.
    const sub = rest[0];
    if (sub === "acquire") {
      let key: string | null = null;
      let cost = 1;
      let waitDur: string | null = null;
      let owner: string | null = null;
      for (let i = 1; i < rest.length; i++) {
        const t = rest[i];
        if (t === "--cost") {
          cost = parseIntArg(rest[++i], "--cost");
        } else if (t === "--wait") {
          waitDur = rest[++i];
        } else if (t === "--owner") {
          owner = rest[++i];
        } else if (t.startsWith("--cost=")) {
          cost = parseIntArg(t.slice(7), "--cost");
        } else if (t.startsWith("--wait=")) {
          waitDur = t.slice(7);
        } else if (t.startsWith("--owner=")) {
          owner = t.slice(8);
        } else if (!t.startsWith("--") && key === null) {
          key = t;
        } else {
          fail("lease acquire: unknown argument " + t);
        }
      }
      if (key === null) {
        fail("lease acquire: give a lease key, e.g. coordinate lease acquire tool:vitest --cost 2 --wait 60s");
      }
      if (cost <= 0) {
        fail("lease acquire --cost: must be a positive integer");
      }
      const { slotLimit } = await import("./config.ts");
      const limit = slotLimit(key);
      if (cost > limit) {
        process.stderr.write(
          JSON.stringify({ error: "ungrantable", key, cost, limit, detail: "cost exceeds the key limit; raise it in [slots] config" }) + "\n",
        );
        process.exit(4);
      }
      if (owner === null) {
        owner = "pid:" + process.ppid;
      }
      const kind = owner.startsWith("pid:") ? "process" : owner.startsWith("job:") ? "job" : "agent";
      q.registerEntity(db, owner, kind, null);
      const immediate = q.acquireLease(db, key, owner, cost);
      if (immediate !== null) {
        const lease = q.qOne(db, "SELECT * FROM leases WHERE grant_id=?", [immediate]) as q.Lease;
        process.stdout.write(JSON.stringify({ ...lease, wait_id: null }) + "\n");
        return;
      }
      let deadlineAt: number | null = null;
      if (waitDur !== null) {
        const secs = parseDurationSecs(waitDur);
        if (secs === null || secs <= 0) {
          fail("lease acquire --wait: bad duration " + JSON.stringify(waitDur) + " (use e.g. 30s, 15m)");
        }
        deadlineAt = Date.now() / 1000 + secs;
      }
      const waitId = q.enqueueWait(db, key, owner, cost, deadlineAt);
      // Poll loop: every iteration runs the shared maintenance (expire TTLs,
      // reap dead owners, drain the FIFO), so any active waiter is its own
      // granter and no daemon is required for fairness.
      for (;;) {
        await new Promise((res) => setTimeout(res, 150));
        {
          using _tx = db.transaction();
          q.maintainLeases(db, [key]);
        }
        const w = q.getWait(db, waitId);
        if (w === null) {
          process.exit(4);
        }
        if (w.state === "granted" && w.grant_id !== null) {
          const lease = q.qOne(db, "SELECT * FROM leases WHERE grant_id=?", [w.grant_id]) as q.Lease | null;
          if (lease !== null) {
            process.stdout.write(JSON.stringify({ ...lease, wait_id: waitId }) + "\n");
            process.exit(0);
          }
        }
        if (w.state === "expired") {
          process.stderr.write(JSON.stringify({ error: "timeout", key, wait_id: waitId }) + "\n");
          process.exit(3);
        }
        if (w.state === "cancelled") {
          process.stderr.write(JSON.stringify({ error: "cancelled", key, wait_id: waitId }) + "\n");
          process.exit(4);
        }
      }
    } else if (sub === "release") {
      if (rest.length !== 2) {
        fail("lease release: give one grant id");
      }
      if (!q.releaseLease(db, rest[1])) {
        fail("lease release: no such grant " + rest[1]);
      }
    } else if (sub === "cancel") {
      if (rest.length !== 2) {
        fail("lease cancel: give one wait id");
      }
      if (!q.cancelWait(db, Number(rest[1]))) {
        fail("lease cancel: no queued wait " + rest[1]);
      }
    } else if (sub === "refresh") {
      if (rest.length !== 2) {
        fail("lease refresh: give one grant id");
      }
      if (!q.refreshLease(db, rest[1])) {
        fail("lease refresh: no such grant " + rest[1]);
      }
    } else if (sub === "list" || sub === "waits") {
      const rows = sub === "list" ? q.listLeases(db) : q.listWaits(db);
      for (const r of rows) {
        process.stdout.write(JSON.stringify(r) + "\n");
      }
    } else {
      fail("lease: action must be acquire, release, cancel, refresh, list or waits");
    }
  } else if (verb === "events") {
    // JSONL event tail: list once, or poll MAX(id) with --follow (matches Python CLI).
    let follow = false;
    let since = 0;
    let jobFilter: number | null = null;
    let kinds: string | null = null;
    let search: string | null = null;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--follow") {
        follow = true;
      } else if (rest[i] === "--since") {
        since = Number(rest[++i]);
      } else if (rest[i] === "--job") {
        jobFilter = Number(rest[++i]);
      } else if (rest[i] === "--kind") {
        kinds = rest[++i];
      } else if (rest[i] === "--search") {
        search = rest[++i];
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
    const fetchRows = (): { id: number; ts: number; job_id: number | null; kind: string; data: string }[] => {
      const recs = queryEvents(db, { job: jobFilter, kind: kinds === null ? null : kinds.split(",").map((s) => s.trim()).filter((s) => s !== ""), sinceId: last, search: search });
      return recs.map((rec) => ({ id: rec.id, ts: rec.ts, job_id: rec.job_id, kind: rec.kind, data: JSON.stringify(rec.data) }));
    };
    printRows(fetchRows());
    while (follow) {
      printRows(fetchRows());
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
  } else if (verb === "doctor") {
    const { run } = await import("./doctor.ts");
    run();
  } else if (verb === "service") {
    const svc = await import("./service.ts");
    const action = rest[0];
    if (action === "install") {
      svc.cmdInstall(rest.slice(1));
    } else if (action === "uninstall") {
      if (rest.length > 1) {
        fail("service uninstall: takes no arguments");
      }
      svc.cmdUninstall();
    } else if (action === "status") {
      if (rest.length > 1) {
        fail("service status: takes no arguments");
      }
      svc.cmdStatus();
    } else {
      fail("service: action must be install, uninstall or status");
    }
  } else if (verb === "cap") {
    // Runtime cap control. The values live in the queue DB, so the daemon
    // picks them up on its next claim: raising the cap frees queued jobs
    // immediately, lowering it never interrupts the jobs already running.
    const action = rest[0] === undefined ? "show" : rest[0];
    if (action === "show") {
      if (rest.length > 1) {
        fail("cap show: takes no arguments");
      }
      const running = (
        q.qAll(db, "SELECT COUNT(*) AS c FROM jobs WHERE status='running'", []) as { c: number }[]
      )[0].c;
      process.stdout.write(
        JSON.stringify({
          machine_cap: q.machineCap(db),
          repo_cap: q.repoCap(db),
          running: running,
          // The daemon records its machine name in the queue DB on claim, so
          // this reports the daemon's identity even when this CLI process has
          // no COORDINATE_MACHINE in its env (e.g. over ssh). The CLI's own
          // name is only a fallback for a queue no daemon has claimed yet.
          machine: q.recordedMachine(db) ?? q.MACHINE,
        }) + "\n",
      );
    } else if (action === "set") {
      let machineCapValue: number | null = null;
      let repoCapValue: number | null = null;
      let force = false;
      for (let i = 1; i < rest.length; i++) {
        const t = rest[i];
        if (t === "--repo-cap") {
          repoCapValue = parseIntArg(rest[++i], "--repo-cap");
        } else if (t === "--machine-cap") {
          machineCapValue = parseIntArg(rest[++i], "--machine-cap");
        } else if (t === "--force") {
          force = true;
        } else {
          fail("cap set: unknown argument " + t);
        }
      }
      if (machineCapValue === null && repoCapValue === null) {
        fail("cap set: give --machine-cap N and/or --repo-cap N");
      }
      for (const [flag, v] of [
        ["--machine-cap", machineCapValue],
        ["--repo-cap", repoCapValue],
      ] as [string, number | null][]) {
        if (v !== null && v <= 0) {
          fail("cap set " + flag + ": must be a positive integer");
        }
      }
      const running = (
        q.qAll(db, "SELECT COUNT(*) AS c FROM jobs WHERE status='running'", []) as { c: number }[]
      )[0].c;
      if (machineCapValue !== null && machineCapValue < running && !force) {
        fail(
          "cap set --machine-cap " +
            machineCapValue +
            ": " +
            running +
            " job(s) are running; lowering below that waits for them to drain. Pass --force to accept the overshoot.",
        );
      }
      if (machineCapValue !== null) {
        q.setCap(db, q.SETTING_MACHINE_CAP, machineCapValue);
      }
      if (repoCapValue !== null) {
        q.setCap(db, q.SETTING_REPO_CAP, repoCapValue);
      }
      process.stdout.write(
        JSON.stringify({
          machine_cap: q.machineCap(db),
          repo_cap: q.repoCap(db),
          running: running,
          // The daemon records its machine name in the queue DB on claim, so
          // this reports the daemon's identity even when this CLI process has
          // no COORDINATE_MACHINE in its env (e.g. over ssh). The CLI's own
          // name is only a fallback for a queue no daemon has claimed yet.
          machine: q.recordedMachine(db) ?? q.MACHINE,
        }) + "\n",
      );
    } else {
      fail("cap: action must be show or set");
    }
  } else if (verb === "tui") {
    // The interactive triage surface. It must never emit escape sequences into
    // a pipe: without a TTY on stdout fail with a clear message instead.
    if (process.stdout.isTTY !== true) {
      fail("tui: stdout is not a terminal; use coordinate jobs (or jobs --json) instead");
    }
    const { tuiHooks, runTui } = await import("./tui.ts");
    let hooks;
    try {
      hooks = tuiHooks();
    } catch (e) {
      if (e instanceof ConfigError) {
        fail("coordinate: " + e.message);
      }
      throw e;
    }
    runTui(db, hooks);
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
