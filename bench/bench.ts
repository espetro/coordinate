// TypeScript port of legacy/python bench/bench.py (quick scenario set), driving any
// coordinate binary. Port of the scenarios: cli, idle, throughput, cap, repo, priority,
// chaos, toolpark, orchestrator-kill, state-loss. noise-floor and live-density are not
// ported (optional, not needed for the Effect comparison).
//
// Differences from the Python harness (kept deliberately):
//   - drives an arbitrary --bin binary path with isolated --tmp state dirs per scenario
//     and per repeat, instead of a venv tree;
//   - the stub ACP agent is fixtures/stub_acp_agent.mjs run by node, wrapped by
//     bench/acp-client.mjs (the Python stack had acp_client.py + stub_acp_agent.py);
//   - poll loops are async (await sleep) instead of time.sleep;
//   - process-group reads use macOS ps (pgid=/rss=/time=) instead of /proc.
// Everything else preserves metric names and semantics so results stay comparable
// with benchmarks/legacy-python/baseline-linux.json.
//
//   node bench/bench.ts --bin /path/to/coordinate --out results.json [--only cli,idle] ...
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const STUB_AGENT = path.join(ROOT, "fixtures", "stub_acp_agent.mjs");
const STAMP = "/usr/bin/perl -MTime::HiRes=time -e 'printf \"%.3f\\n\", time'";
const NODE = process.execPath;

// ---- fleet handle ----------------------------------------------------------
const LIVE: Fleet[] = [];

class Fleet {
  bin: string;
  dir: string;
  env: Record<string, string>;
  daemon: cp.ChildProcess | null = null;
  daemonPid: number | null = null;

  constructor(bin: string, workdir: string, cap: number, lease: number) {
    this.bin = bin;
    this.dir = workdir;
    const e: Record<string, string> = {};
    for (const k of Object.keys(process.env)) {
      const v = process.env[k];
      if (v !== undefined && !k.startsWith("COORDINATE_") && !k.startsWith("FLEET_")) {
        e[k] = v;
      }
    }
    e["COORDINATE_DB"] = path.join(workdir, "queue.db");
    e["COORDINATE_CAP"] = String(cap);
    e["COORDINATE_REPO_CAP"] = "1";
    e["COORDINATE_MACHINE"] = "bench";
    e["COORDINATE_LEASE_S"] = String(lease);
    e["COORDINATE_CONFIG"] = path.join(workdir, "none.toml");
    this.env = e;
  }

  // cli runs the binary with a hard timeout. The binary talks to the same SQLite
  // store as the daemon, so a lock contention can make a call fail; the caller
  // retries where it matters.
  cli(args: string[], timeoutMs = 30000, retries = 3): string {
    let last = "";
    for (let attempt = 0; attempt <= retries; attempt++) {
      const r = cp.spawnSync(this.bin, args, { env: this.env, cwd: this.dir, encoding: "utf8", timeout: timeoutMs });
      if (r.status === 0) {
        return (r.stdout === null ? "" : r.stdout).trim();
      }
      last = (r.stderr === null ? "" : r.stderr).slice(-400);
      if (attempt < retries) sleep(300);
    }
    throw new Error("cli " + args.join(" ") + " failed: " + last);
  }

  start(): void {
    const log = fs.openSync(path.join(this.dir, "daemon.log"), "a");
    this.daemon = cp.spawn(this.bin, ["daemon"], {
      env: this.env,
      cwd: this.dir,
      stdio: ["ignore", log, log],
      detached: true,
    });
    fs.closeSync(log);
    this.daemonPid = this.daemon.pid === undefined ? null : this.daemon.pid;
    this.daemon.unref();
    LIVE.push(this);
  }

  stop(sig: NodeJS.Signals = "SIGTERM"): void {
    if (this.daemonPid !== null && alive(this.daemonPid)) {
      try {
        process.kill(-this.daemonPid, sig);
      } catch {
        try {
          process.kill(this.daemonPid, sig);
        } catch {
          // already gone
        }
      }
      const deadline = Date.now() + 10000;
      while (alive(this.daemonPid) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
    this.daemonPid = null;
    const i = LIVE.indexOf(this);
    if (i >= 0) LIVE.splice(i, 1);
  }

  kill9(): void {
    this.stop("SIGKILL");
  }

  // ps rows for every process in the daemon's process group (the resident stack;
  // job children start their own session so they are excluded).
  private group(col: string): string[] {
    if (this.daemonPid === null) return [];
    const out = cp.spawnSync("/bin/ps", ["-axo", "pgid=," + col + "="], { encoding: "utf8" });
    const res: string[] = [];
    for (const line of (out.stdout === null ? "" : out.stdout).split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (m !== null && m[1] === String(this.daemonPid)) res.push(m[2].trim());
    }
    return res;
  }

  rssMb(): number {
    let kb = 0;
    for (const v of this.group("rss")) {
      const n = Number(v);
      if (Number.isFinite(n)) kb += n;
    }
    return kb / 1024;
  }

  cpuS(): number {
    let total = 0;
    for (const t of this.group("time")) {
      let s = 0;
      for (const x of t.replace("-", ":").split(":")) {
        s = s * 60 + Number(x);
      }
      total += s;
    }
    return total;
  }

  enqueue(shell: string, repo: string | null = null, priority = 0, extra: string[] = []): number {
    const r = repo === null ? path.join(this.dir, "repos", "r" + Date.now() + "-" + Math.random().toString(36).slice(2)) : repo;
    fs.mkdirSync(r, { recursive: true });
    const args = ["enqueue", "--cwd", r, "--shell"];
    if (priority !== 0) args.push("--priority", String(priority));
    return Number(this.cli([...args, ...extra, "--", shell]));
  }
}

process.on("exit", () => {
  // oxlint-disable-next-line no-useless-spread -- copy guards mutation during iteration
  for (const f of [...LIVE]) {
    try {
      f.stop("SIGKILL");
    } catch {
      // best effort
    }
  }
});

// ---- span helpers ----------------------------------------------------------
type Spans = Record<string, { s: number[]; e: number[] }>;

function spanCmd(log: string, tag: string, sleepS: number): string {
  return "echo s " + tag + " $(" + STAMP + ") >> " + log + "; sleep " + sleepS + "; echo e " + tag + " $(" + STAMP + ") >> " + log;
}

function readSpans(log: string): Spans {
  const ev: Spans = {};
  let text = "";
  try {
    text = fs.readFileSync(log, "utf8");
  } catch {
    return ev;
  }
  for (const line of text.split("\n")) {
    const p = line.trim().split(/\s+/);
    if (p.length === 3 && (p[0] === "s" || p[0] === "e")) {
      const tag = p[1];
      if (ev[tag] === undefined) ev[tag] = { s: [], e: [] };
      if (p[0] === "s") ev[tag].s.push(Number(p[2]));
      else ev[tag].e.push(Number(p[2]));
    }
  }
  return ev;
}

function maxConcurrency(ev: Spans): number {
  const pts: [number, number][] = [];
  for (const tag of Object.keys(ev)) {
    const e = ev[tag];
    const ss = [...e.s].sort();
    const es = [...e.e].sort();
    for (let i = 0; i < Math.min(ss.length, es.length); i++) {
      pts.push([ss[i], 1], [es[i], -1]);
    }
  }
  pts.sort((a, b) => a[0] - b[0]);
  let cur = 0;
  let peak = 0;
  for (const [, d] of pts) {
    cur += d;
    if (cur > peak) peak = cur;
  }
  return peak;
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

async function waitDone(log: string, tags: number, timeoutS: number): Promise<boolean> {
  const end = Date.now() + timeoutS * 1000;
  while (Date.now() < end) {
    const ev = readSpans(log);
    let ended = 0;
    for (const t of Object.keys(ev)) if (ev[t].e.length > 0) ended++;
    if (ended >= tags) return true;
    sleep(100);
  }
  return false;
}

// ---- sqlite store readers --------------------------------------------------
function jobRows(dbFile: string): Record<number, Record<string, unknown>> {
  const out: Record<number, Record<string, unknown>> = {};
  if (!fs.existsSync(dbFile)) return out;
  const db = new DatabaseSync(dbFile);
  try {
    const rows = db.prepare("SELECT * FROM jobs ORDER BY id").all() as Record<string, unknown>[];
    for (const r of rows) {
      const d = { ...r };
      delete d["lease_expires_at"];
      out[Number(d["id"])] = d;
    }
  } finally {
    db.close();
  }
  return out;
}

function slotRows(dbFile: string): Record<number, { key: string; cost: number; lease_expires_at: number }[]> {
  const out: Record<number, { key: string; cost: number; lease_expires_at: number }[]> = {};
  if (!fs.existsSync(dbFile)) return out;
  const db = new DatabaseSync(dbFile);
  try {
    const rows = db.prepare("SELECT key, lease_expires_at, job_id, cost FROM concurrency_slots ORDER BY key").all() as Record<string, unknown>[];
    for (const r of rows) {
      const jid = Number(r["job_id"]);
      if (out[jid] === undefined) out[jid] = [];
      out[jid].push({ key: String(r["key"]), cost: Number(r["cost"]), lease_expires_at: Number(r["lease_expires_at"]) });
    }
  } finally {
    db.close();
  }
  return out;
}

function stubSessions(p: string): Record<string, Record<string, number>> {
  try {
    return (JSON.parse(fs.readFileSync(p, "utf8")) as { sessions: Record<string, Record<string, number>> }).sessions ?? {};
  } catch {
    return {};
  }
}

// ---- process helpers -------------------------------------------------------
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function agentPids(dbFile: string): Record<number, number> {
  const pids: Record<number, number> = {};
  const pdir = path.join(path.dirname(path.resolve(dbFile)), "pids");
  let names: string[] = [];
  try {
    names = fs.readdirSync(pdir);
  } catch {
    return pids;
  }
  for (const n of names) {
    if (!n.endsWith(".agent")) continue;
    try {
      pids[Number(n.slice(0, -6))] = Number(fs.readFileSync(path.join(pdir, n), "utf8").trim());
    } catch {
      // unreadable
    }
  }
  return pids;
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

function rssKb(pid: number): number {
  const out = cp.spawnSync("/bin/ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
  const n = Number((out.stdout === null ? "" : out.stdout).trim());
  return Number.isFinite(n) ? n : 0;
}

// The TypeScript daemon speaks ACP to the agent itself (src/acp.ts): the registry
// points straight at the stub agent, no wrapper process. The legacy Python daemon
// drove the agent through bench/acp_client.py instead (COORDINATE_ACP_CMD), which
// is why the Python harness had a wrapper; the metric names are the same.
function acpRegistry(tmp: string): string {
  const reg = path.join(tmp, "agents.stub.json");
  fs.writeFileSync(reg, JSON.stringify({ stub: { command: NODE, args: [STUB_AGENT] } }));
  return reg;
}

function acpFleet(bin: string, tmp: string, cap: number, lease: number): Fleet {
  const f = new Fleet(bin, tmp, cap, lease);
  return f;
}

// ---- host state ------------------------------------------------------------
function hostState(): Record<string, unknown> {
  const cpus = os.cpus();
  const load = os.loadavg();
  let memTotal = 0;
  let memFree = 0;
  try {
    const hw = cp.spawnSync("/usr/sbin/sysctl", ["hw.memsize"], { encoding: "utf8" });
    const m = (hw.stdout === null ? "" : hw.stdout).match(/(\d+)/);
    if (m !== null) memTotal = Math.round(Number(m[1]) / 1024 / 1024);
    const vm = cp.spawnSync("/usr/bin/vm_stat", [], { encoding: "utf8" });
    const freeM = (vm.stdout === null ? "" : vm.stdout).match(/Pages free:\s+(\d+)/);
    if (freeM !== null) memFree = Math.round(Number(freeM[1]) * 4096 / 1024 / 1024);
  } catch {
    // not available
  }
  return {
    cpu_model: cpus[0] === undefined ? null : cpus[0].model.trim(),
    cores: cpus.length,
    mem_total_mb: memTotal,
    mem_available_mb: memFree,
    load_1m: Math.round(load[0] * 100) / 100,
    load_5m: Math.round(load[1] * 100) / 100,
    load_15m: Math.round(load[2] * 100) / 100,
    os: os.type() + " " + os.release(),
    platform: os.platform() + "-" + os.arch(),
    timestamp: new Date().toISOString(),
  };
}

function binVersion(bin: string): string {
  try {
    const r = cp.spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5000 });
    if (r.status === 0 && r.stdout !== null && r.stdout.trim() !== "") return r.stdout.trim();
  } catch {
    // fall through
  }
  try {
    const r = cp.spawnSync(bin, ["doctor"], { encoding: "utf8", timeout: 5000 });
    if (r.stdout !== null) {
      const m = r.stdout.match(/version\s+(\S+)/);
      if (m !== null) return m[1];
    }
  } catch {
    // fall through
  }
  return "unknown";
}

// Capability probe: does this binary have the ACP agent-session lane? The
// legacy pre-ACP binaries (v0.1.2) parse `enqueue --acp ...` as a command, so the
// enqueue succeeds but the job lands as kind=cmd. The ACP scenarios need the real
// lane, so they are skipped (and recorded as skipped) when the lane is missing.
function hasAcpLane(bin: string): boolean {
  const dir = fs.mkdtempSync(path.join("/tmp", "coordprobe-"));
  try {
    const env = { ...process.env, COORDINATE_DB: path.join(dir, "q.db"), COORDINATE_CONFIG: path.join(dir, "none.toml") };
    const reg = path.join(dir, "reg.json");
    fs.writeFileSync(reg, JSON.stringify({ stub: { command: "/bin/true", args: [] } }));
    const r = cp.spawnSync(bin, ["enqueue", "--acp", "stub", "--cwd", dir, "--prompt", "x", "--registry", reg], {
      env,
      encoding: "utf8",
      timeout: 15000,
    });
    if (r.status !== 0) return false;
    const jid = Number((r.stdout === null ? "" : r.stdout).trim());
    if (!Number.isFinite(jid)) return false;
    const s = cp.spawnSync(bin, ["status", String(jid)], { env, encoding: "utf8", timeout: 15000 });
    if (s.status !== 0) return false;
    const st = JSON.parse(s.stdout === null ? "{}" : s.stdout) as Record<string, unknown>;
    return st["kind"] === "acp";
  } catch {
    return false;
  }
}

// ---- scenarios -------------------------------------------------------------
async function scenarioCliLatency(bin: string, tmp: string): Promise<Record<string, unknown>> {
  const f = new Fleet(bin, tmp, 3, 5);
  f.start();
  sleep(3000);
  const ts: number[] = [];
  for (let i = 0; i < 12; i++) {
    const t = performance.now();
    f.enqueue("true");
    ts.push((performance.now() - t) / 1000);
  }
  f.stop();
  const tail = ts.slice(2).sort((a, b) => a - b);
  const med = tail[Math.floor(tail.length / 2)];
  const p95 = tail[Math.max(0, tail.length - 2)];
  return { enqueue_cli_median_ms: Math.round(med * 1000 * 10) / 10, enqueue_cli_p95_ms: Math.round(p95 * 1000 * 10) / 10 };
}

async function scenarioIdle(bin: string, tmp: string, secs = 20): Promise<Record<string, unknown>> {
  const f = new Fleet(bin, tmp, 3, 5);
  f.start();
  sleep(4000);
  const c0 = f.cpuS();
  const t0 = Date.now();
  sleep(secs * 1000);
  const c1 = f.cpuS();
  const t1 = Date.now();
  const rss = f.rssMb();
  f.stop();
  return { idle_rss_mb: Math.round(rss * 10) / 10, idle_cpu_pct: Math.round(((c1 - c0) / ((t1 - t0) / 1000)) * 10000) / 100 };
}

async function scenarioThroughput(bin: string, tmp: string, n = 60, cap = 6): Promise<Record<string, unknown>> {
  const f = new Fleet(bin, tmp, cap, 5);
  const log = path.join(tmp, "spans");
  f.start();
  sleep(3000);
  const t0 = Date.now() / 1000;
  for (let i = 0; i < n; i++) f.enqueue(spanCmd(log, "j" + i, 0));
  const tEnq = Date.now() / 1000 - t0;
  let peak = 0;
  let ok = false;
  const end = Date.now() + 180000;
  while (Date.now() < end) {
    peak = Math.max(peak, f.rssMb());
    const ev = readSpans(log);
    let ended = 0;
    for (const t of Object.keys(ev)) if (ev[t].e.length > 0) ended++;
    if (ended >= n) {
      ok = true;
      break;
    }
    sleep(250);
  }
  const makespan = Date.now() / 1000 - t0;
  f.stop();
  return {
    throughput_jobs: n,
    throughput_all_done: ok,
    enqueue_total_s: Math.round(tEnq * 100) / 100,
    throughput_makespan_s: Math.round(makespan * 100) / 100,
    throughput_jobs_per_s: Math.round((n / makespan) * 100) / 100,
    peak_rss_mb: Math.round(peak * 10) / 10,
    ...(await claimLatency(bin, tmp, cap, 40)),
  };
}

// Enqueue-to-claim latency, read from the durable store: the claim epoch minus
// the enqueue epoch, per job. The daemon clears claim_at when a job finishes, so
// the sample is taken while the jobs are still in flight (a fresh daemon, a fresh
// store, a few long jobs, so the claim epoch survives long enough to be read).
async function claimLatency(bin: string, tmp: string, cap: number, jobs: number): Promise<Record<string, unknown>> {
  const dir = fs.mkdtempSync(path.join(tmp, "claimlat-"));
  const f = new Fleet(bin, dir, cap, 30);
  const log = path.join(dir, "spans");
  f.start();
  sleep(3000);
  for (let i = 0; i < jobs; i++) f.enqueue(spanCmd(log, "c" + i, 8));
  // Poll the store until every job carries a claim epoch (the daemon claims them
  // as the cap allows), then read the deltas.
  const lat: number[] = [];
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const rows = jobRows(String(f.env["COORDINATE_DB"]));
    lat.length = 0;
    for (const jid of Object.keys(rows)) {
      const r = rows[Number(jid)];
      if (r["claim_at"] === null || r["claim_at"] === undefined || r["created_at"] === null) continue;
      lat.push((Number(r["claim_at"]) - Number(r["created_at"])) * 1000);
    }
    if (lat.length >= Math.min(cap, jobs)) break;
    sleep(50);
  }
  f.stop();
  lat.sort((a, b) => a - b);
  const pct = (q: number): number | null => (lat.length === 0 ? null : Math.round(lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] * 10) / 10);
  return {
    enqueue_to_claim_p50_ms: pct(0.5),
    enqueue_to_claim_p95_ms: pct(0.95),
    enqueue_to_claim_max_ms: lat.length === 0 ? null : Math.round(lat[lat.length - 1] * 10) / 10,
    enqueue_to_claim_samples: lat.length,
  };
}

async function scenarioCap(bin: string, tmp: string, cap = 3, sleepS = 1.0): Promise<Record<string, unknown>> {
  const f = new Fleet(bin, tmp, cap, 5);
  const log = path.join(tmp, "spans");
  const n = cap * 3;
  f.start();
  sleep(3000);
  const t0 = Date.now();
  for (let i = 0; i < n; i++) f.enqueue(spanCmd(log, "j" + i, sleepS));
  const ok = await waitDone(log, n, 90);
  const makespan = (Date.now() - t0) / 1000;
  const peak = maxConcurrency(readSpans(log));
  f.stop();
  return {
    cap: cap,
    cap_jobs: n,
    cap_all_done: ok,
    cap_max_concurrency: peak,
    cap_holds: peak <= cap,
    cap_makespan_s: Math.round(makespan * 100) / 100,
    cap_ideal_s: Math.round(((n / cap) * sleepS) * 100) / 100,
  };
}

async function scenarioRepoContention(bin: string, tmp: string): Promise<Record<string, unknown>> {
  const f = new Fleet(bin, tmp, 4, 5);
  const shared = path.join(tmp, "shared");
  const logS = path.join(tmp, "spans_shared");
  const logO = path.join(tmp, "spans_others");
  f.start();
  sleep(3000);
  for (let i = 0; i < 4; i++) f.enqueue(spanCmd(logS, "s" + i, 1.0), shared);
  for (let i = 0; i < 2; i++) f.enqueue(spanCmd(logO, "o" + i, 1.0), path.join(tmp, "o" + i));
  const ok = (await waitDone(logS, 4, 60)) && (await waitDone(logO, 2, 60));
  const conc = maxConcurrency(readSpans(logS));
  f.stop();
  return { repo_all_done: ok, repo_shared_max_concurrency: conc, repo_cap_holds: conc <= 1 };
}

async function scenarioPriority(bin: string, tmp: string): Promise<Record<string, unknown>> {
  const f = new Fleet(bin, tmp, 1, 5);
  const log = path.join(tmp, "spans");
  f.start();
  sleep(3000);
  f.enqueue(spanCmd(log, "blocker", 25.0));
  sleep(1000);
  for (const [tag, p] of [["p0", 0], ["p5", 5], ["p1", 1], ["p9", 9]] as [string, number][]) {
    f.enqueue(spanCmd(log, tag, 0.3), null, p);
  }
  await waitDone(log, 5, 90);
  const ev = readSpans(log);
  const order = Object.keys(ev)
    .filter((t) => t !== "blocker" && ev[t].s.length > 0)
    .map((t) => [t, Math.min(...ev[t].s)] as [string, number])
    .sort((a, b) => a[1] - b[1])
    .map((x) => x[0]);
  f.stop();
  return { priority_order: order, priority_ok: order.join(",") === "p9,p5,p1,p0" };
}

async function scenarioChaos(bin: string, tmp: string, cap = 3, n = 9): Promise<Record<string, unknown>> {
  const f = new Fleet(bin, tmp, cap, 5);
  const log = path.join(tmp, "spans");
  f.start();
  sleep(3000);
  for (let i = 0; i < n; i++) f.enqueue(spanCmd(log, "j" + i, 2.0));
  sleep(1500);
  const tKill = Date.now();
  f.kill9();
  f.start();
  const ok = await waitDone(log, n, 120);
  const tDone = (Date.now() - tKill) / 1000;
  sleep(2500);
  const ev = readSpans(log);
  let starts = 0;
  let dup = 0;
  for (const t of Object.keys(ev)) {
    starts += ev[t].s.length;
    if (ev[t].s.length > 1) dup++;
  }
  f.stop();
  return {
    chaos_all_done: ok,
    chaos_recovery_to_all_done_s: Math.round(tDone * 100) / 100,
    chaos_total_executions: starts,
    chaos_duplicated_jobs: dup,
  };
}

async function scenarioToolPark(bin: string, tmp: string): Promise<Record<string, unknown>> {
  const f = new Fleet(bin, tmp, 2, 5);
  fs.writeFileSync(path.join(tmp, "none.toml"), "[slots]\n'tool:vitest:*' = 2\n");
  const proj = path.join(tmp, "proj");
  fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
  const bindir = path.join(tmp, "bin");
  fs.mkdirSync(bindir, { recursive: true });
  const log = path.join(tmp, "spans");
  const v = path.join(bindir, "vitest");
  fs.writeFileSync(v, "#!/bin/sh\necho s $1 $(" + STAMP + ") >> " + log + "\nsleep 2\necho e $1 $(" + STAMP + ") >> " + log + "\n");
  fs.chmodSync(v, 0o755);
  f.env["PATH"] = bindir + ":" + (f.env["PATH"] === undefined ? "" : f.env["PATH"]);
  f.start();
  sleep(3000);
  f.enqueue("vitest v1", proj);
  f.enqueue("vitest v2", proj);
  sleep(500);
  f.enqueue(spanCmd(log, "trivial", 0.2));
  const ok = await waitDone(log, 3, 40);
  const ev = readSpans(log);
  f.stop();
  const vEv: Spans = {};
  for (const k of Object.keys(ev)) if (k.startsWith("v") && k !== "vitest") vEv[k] = ev[k];
  const vConc = maxConcurrency(vEv);
  const trivStart = ev["trivial"] === undefined || ev["trivial"].s.length === 0 ? null : Math.min(...ev["trivial"].s);
  const v1End = ev["v1"] === undefined || ev["v1"].e.length === 0 ? null : Math.min(...ev["v1"].e);
  return {
    tool_all_done: ok,
    tool_vitest_max_concurrency: vConc,
    tool_cap_holds: vConc <= 1,
    tool_trivial_ran_while_parked: trivStart !== null && v1End !== null && trivStart < v1End,
  };
}

async function scenarioOrchestratorKill(bin: string, tmp: string, k = 3, turnMs = 20000, lease = 4): Promise<Record<string, unknown>> {
  const reg = acpRegistry(tmp);
  const f = acpFleet(bin, tmp, Math.max(k, 1), lease);
  f.env["STUB_TURN_MS"] = String(turnMs);
  f.env["STUB_CHUNKS"] = "20";
  const fenv = f.env;
  f.start();
  sleep(3000);
  const jids: number[] = [];
  for (let i = 0; i < k; i++) {
    const repo = path.join(tmp, "job" + i);
    fs.mkdirSync(repo, { recursive: true });
    const out = f.cli(["enqueue", "--acp", "stub", "--cwd", repo, "--prompt", "turn " + i, "--registry", reg]);
    jids.push(Number(out));
  }
  const dbFile = String(fenv["COORDINATE_DB"]);
  const deadline = Date.now() + 60000;
  const sessions: Record<number, string> = {};
  while (Date.now() < deadline && Object.keys(sessions).length < k) {
    for (const jid of jids) {
      if (sessions[jid] !== undefined) continue;
      const st = JSON.parse(f.cli(["status", String(jid)])) as Record<string, unknown>;
      const payload = typeof st["payload"] === "string" ? JSON.parse(String(st["payload"])) : st["payload"] ?? {};
      if (payload["session"] !== undefined && payload["session"] !== null) sessions[jid] = String(payload["session"]);
    }
    sleep(200);
  }
  const pids = agentPids(dbFile);
  const aliveBefore = Object.values(pids).filter((p) => alive(p)).length;
  const tKill = Date.now();
  f.kill9();
  sleep(300);
  const aliveAfterKill = Object.values(pids).filter((p) => alive(p)).length;
  f.start();
  let done = 0;
  const deadline2 = Date.now() + 180000;
  while (Date.now() < deadline2) {
    done = 0;
    for (const jid of jids) {
      const st = JSON.parse(f.cli(["status", String(jid)])) as Record<string, unknown>;
      if (st["status"] === "done" || st["status"] === "failed") done++;
    }
    if (done === k) break;
    sleep(500);
  }
  const recovery = (Date.now() - tKill) / 1000;
  const survivors = Object.values(pids).filter((p) => alive(p));
  for (const p of survivors) killGroup(p);
  sleep(500);
  for (const p of survivors) {
    if (alive(p)) {
      try {
        process.kill(p, "SIGKILL");
      } catch {
        // gone
      }
    }
  }
  for (const p of Object.values(agentPids(dbFile))) {
    if (!survivors.includes(p) && alive(p)) killGroup(p);
  }
  let dup = 0;
  let resumed = 0;
  let restarted = 0;
  const perJob: Record<string, unknown>[] = [];
  for (let i = 0; i < jids.length; i++) {
    const jid = jids[i];
    const st = JSON.parse(f.cli(["status", String(jid)])) as Record<string, unknown>;
    const sf = path.join(tmp, "job" + i, ".stub-acp-sessions.json");
    let sid: string | null = null;
    let rec: Record<string, number> = {};
    if (fs.existsSync(sf)) {
      const recs = stubSessions(sf);
      const keys = Object.keys(recs);
      if (keys.length > 0) {
        sid = keys[0];
        rec = recs[sid];
      }
    }
    const payload = typeof st["payload"] === "string" ? JSON.parse(String(st["payload"])) : st["payload"] ?? {};
    const stored = payload["session"] === undefined ? null : String(payload["session"]);
    dup += Math.max(0, (rec["turns_started"] === undefined ? 0 : rec["turns_started"]) - 1);
    if (Number(st["attempts"]) > 1 && stored !== null && stored === sid && (rec["loads"] === undefined ? 0 : rec["loads"]) > 0) resumed++;
    else if (Number(st["attempts"]) > 1) restarted++;
    perJob.push({ job: jid, status: st["status"], attempts: st["attempts"], session_id: sid, payload_session: stored, turns_started: rec["turns_started"] ?? 0, turns_done: rec["turns_done"] ?? 0, loads: rec["loads"] ?? 0 });
  }
  f.stop();
  return {
    orchkill_jobs: k,
    orchkill_all_done: done === k,
    orchkill_done: done,
    orchkill_recovery_s: Math.round(recovery * 100) / 100,
    orchkill_agents_alive_before_kill: aliveBefore,
    orchkill_agents_alive_after_kill: aliveAfterKill,
    orchkill_orphan_agents_surviving: survivors.length,
    orchkill_duplicate_turns: dup,
    orchkill_resumed_via_session_load: resumed,
    orchkill_restarted: restarted,
    orchkill_per_job: perJob,
  };
}

async function scenarioStateLoss(bin: string, tmp: string, live = 2, parked = 2, turnMs = 20000, lease = 4): Promise<Record<string, unknown>> {
  const reg = acpRegistry(tmp);
  const f = acpFleet(bin, tmp, live + 2, lease);
  f.env["STUB_TURN_MS"] = String(turnMs);
  f.env["STUB_CHUNKS"] = "40";
  const dbFile = String(f.env["COORDINATE_DB"]);
  const log = path.join(tmp, "spans");
  const bindir = path.join(tmp, "bin");
  fs.mkdirSync(bindir, { recursive: true });
  const vitest = path.join(bindir, "vitest");
  fs.writeFileSync(vitest, "#!/bin/sh\necho s tool $(" + STAMP + ") >> " + log + "\nsleep " + lease * 2 + "\necho e tool $(" + STAMP + ") >> " + log + "\n");
  fs.chmodSync(vitest, 0o755);
  f.env["PATH"] = bindir + ":" + (f.env["PATH"] === undefined ? "" : f.env["PATH"]);
  fs.writeFileSync(String(f.env["COORDINATE_CONFIG"]), "[slots]\n'tool:vitest:*' = 2\n");
  f.start();
  sleep(3000);
  const liveIds: number[] = [];
  const parkedIds: number[] = [];
  const toolIds: number[] = [];
  const acpIds: number[] = [];
  for (let i = 0; i < live; i++) {
    const repo = path.join(tmp, "live" + i);
    fs.mkdirSync(repo, { recursive: true });
    liveIds.push(f.enqueue("echo s live" + i + " $(" + STAMP + ") >> " + log + "; sleep " + lease * 3 + "; echo e live" + i + " $(" + STAMP + ") >> " + log, repo));
  }
  for (let i = 0; i < parked; i++) {
    const repo = path.join(tmp, "parked" + i);
    fs.mkdirSync(repo, { recursive: true });
    parkedIds.push(Number(f.cli(["enqueue", "--cwd", repo, "--shell", "--wait-on", "evt-human", "--", "echo s parked" + i + " $(" + STAMP + ") >> " + log])));
  }
  const toolRepo = path.join(tmp, "toolproj");
  fs.mkdirSync(path.join(toolRepo, ".git"), { recursive: true });
  toolIds.push(f.enqueue("vitest run", toolRepo));
  const acpRepo = path.join(tmp, "acpjob");
  fs.mkdirSync(acpRepo, { recursive: true });
  acpIds.push(Number(f.cli(["enqueue", "--acp", "stub", "--cwd", acpRepo, "--prompt", "mid turn", "--registry", reg])));
  const deadline = Date.now() + 60000;
  let acpSid: string | null = null;
  while (Date.now() < deadline) {
    const rows = jobRows(dbFile);
    let running = 0;
    for (const j of Object.keys(rows)) if (rows[Number(j)]["status"] === "running") running++;
    const slots = slotRows(dbFile);
    let toolHeld = false;
    for (const jid of Object.keys(slots)) {
      for (const s of slots[Number(jid)]) if (s.key.startsWith("tool:")) toolHeld = true;
    }
    acpSid = null;
    for (const jid of acpIds) {
      const st = JSON.parse(f.cli(["status", String(jid)])) as Record<string, unknown>;
      const payload = typeof st["payload"] === "string" ? JSON.parse(String(st["payload"])) : st["payload"] ?? {};
      if (payload["session"] !== undefined) acpSid = String(payload["session"]);
    }
    if (running >= live + 1 && toolHeld && acpSid !== null) break;
    sleep(300);
  }
  const beforeRows = jobRows(dbFile);
  const beforeSlots = slotRows(dbFile);
  const beforeSessions = stubSessions(path.join(acpRepo, ".stub-acp-sessions.json"));
  const agentPidsBefore = agentPids(dbFile);
  const daemonPid = f.daemonPid;
  if (daemonPid === null) throw new Error("no daemon pid");
  const psOut = cp.spawnSync("/bin/ps", ["-o", "command=", "-p", String(daemonPid)], { encoding: "utf8" });
  const cmdLine = (psOut.stdout === null ? "" : psOut.stdout).trim();
  if (cmdLine.indexOf("daemon") === -1) throw new Error("refusing to kill pid " + daemonPid + ": not the coordinate daemon: " + cmdLine);
  const tKill = Date.now();
  f.kill9();
  sleep(300);
  const postKillRows = jobRows(dbFile);
  const postKillSlots = slotRows(dbFile);
  f.start();
  const terminal = ["done", "failed", "dead"];
  const deadline2 = Date.now() + 120000;
  let ok = true;
  while (Date.now() < deadline2) {
    const rows = jobRows(dbFile);
    ok = true;
    for (const jid of [...liveIds, ...toolIds, ...acpIds]) {
      const r = rows[jid];
      if (r === undefined || !terminal.includes(String(r["status"]))) {
        ok = false;
        break;
      }
    }
    if (ok) break;
    sleep(300);
  }
  void ok;
  const recovery = (Date.now() - tKill) / 1000;
  const afterRows = jobRows(dbFile);
  const afterSlots = slotRows(dbFile);
  const afterSessions = stubSessions(path.join(acpRepo, ".stub-acp-sessions.json"));
  const survivors = [...new Set([...Object.values(agentPidsBefore), ...Object.values(agentPids(dbFile))])].filter((p) => alive(p));
  for (const p of survivors) killGroup(p);
  sleep(400);
  for (const p of survivors) {
    if (alive(p)) {
      try {
        process.kill(p, "SIGKILL");
      } catch {
        // gone
      }
    }
  }
  const allIds = [...liveIds, ...parkedIds, ...toolIds, ...acpIds];
  const lost = allIds.filter((j) => afterRows[j] === undefined);
  const neverFinished = [...liveIds, ...toolIds, ...acpIds].filter((j) => {
    const r = afterRows[j];
    return r === undefined || !terminal.includes(String(r["status"]));
  });
  const ranTwice = allIds.filter((j) => {
    const r = afterRows[j];
    return r !== undefined && Number(r["attempts"] ?? 0) > 1;
  });
  let dupTurns = 0;
  for (const sid of Object.keys(afterSessions)) dupTurns += Math.max(0, (afterSessions[sid]["turns_started"] ?? 0) - 1);
  let dupTurnsBefore = 0;
  for (const sid of Object.keys(beforeSessions)) dupTurnsBefore += Math.max(0, (beforeSessions[sid]["turns_started"] ?? 0) - 1);
  const now = Date.now() / 1000;
  let leaked = 0;
  const leakedDetail: Record<string, unknown>[] = [];
  for (const jidS of Object.keys(afterSlots)) {
    const jid = Number(jidS);
    const st = afterRows[jid] === undefined ? null : String(afterRows[jid]["status"]);
    const sl = afterSlots[jid];
    if (st !== "running" || sl.every((s) => s.lease_expires_at <= now)) {
      for (const s of sl) {
        leaked++;
        leakedDetail.push({ job_id: jid, key: s.key, cost: s.cost, expired: s.lease_expires_at <= now });
      }
    }
  }
  let postKillLeaked = 0;
  for (const jidS of Object.keys(postKillSlots)) {
    const jid = Number(jidS);
    const st = postKillRows[jid] === undefined ? null : String(postKillRows[jid]["status"]);
    if (st !== "running") postKillLeaked += postKillSlots[jid].length;
  }
  const fieldDiff: Record<string, unknown>[] = [];
  for (const jid of allIds) {
    const b = beforeRows[jid] ?? {};
    const a = afterRows[jid] ?? {};
    for (const key of [...new Set([...Object.keys(b), ...Object.keys(a)])].sort()) {
      if (JSON.stringify(b[key]) !== JSON.stringify(a[key])) fieldDiff.push({ job: jid, field: key, before: b[key] ?? null, after: a[key] ?? null });
    }
  }
  const sessionDiff: Record<string, unknown>[] = [];
  for (const sid of [...new Set([...Object.keys(beforeSessions), ...Object.keys(afterSessions)])].sort()) {
    const b = beforeSessions[sid] ?? {};
    const a = afterSessions[sid] ?? {};
    for (const key of [...new Set([...Object.keys(b), ...Object.keys(a)])].sort()) {
      if (JSON.stringify(b[key]) !== JSON.stringify(a[key])) sessionDiff.push({ session: sid, field: key, before: b[key] ?? null, after: a[key] ?? null });
    }
  }
  const sessionIdKept = acpIds.map((jid) => {
    const b = beforeRows[jid] ?? {};
    const a = afterRows[jid] ?? {};
    const bs = b["payload"] === undefined || b["payload"] === null ? null : (JSON.parse(String(b["payload"])) as Record<string, unknown>)["session"];
    const as_ = a["payload"] === undefined || a["payload"] === null ? null : (JSON.parse(String(a["payload"])) as Record<string, unknown>)["session"];
    return { job: jid, before: bs ?? null, after: as_ ?? null, kept: bs !== null && bs !== undefined && bs === as_ };
  });
  f.stop();
  return {
    stateloss_live_jobs: liveIds.length,
    stateloss_parked_jobs: parkedIds.length,
    stateloss_tool_jobs: toolIds.length,
    stateloss_acp_jobs: acpIds.length,
    stateloss_jobs_lost: lost.length,
    stateloss_jobs_lost_ids: lost,
    stateloss_never_finished: neverFinished.length,
    stateloss_never_finished_ids: neverFinished,
    stateloss_jobs_run_twice: ranTwice.length,
    stateloss_jobs_run_twice_ids: ranTwice,
    stateloss_duplicate_turns: dupTurns,
    stateloss_duplicate_turns_before_kill: dupTurnsBefore,
    stateloss_leases_leaked: leaked,
    stateloss_leases_leaked_detail: leakedDetail,
    stateloss_leases_leaked_right_after_kill: postKillLeaked,
    stateloss_parked_still_parked: parkedIds.filter((j) => afterRows[j] !== undefined && afterRows[j]["status"] === "waiting").length,
    stateloss_parked_released: parkedIds.filter((j) => afterRows[j] !== undefined && afterRows[j]["status"] === "queued").length,
    stateloss_session_id_kept: sessionIdKept,
    stateloss_field_diff: fieldDiff,
    stateloss_session_diff: sessionDiff,
    stateloss_orphan_agents_surviving: survivors.length,
    stateloss_recovery_s: Math.round(recovery * 100) / 100,
    stateloss_host: hostState(),
  };
}

// ---- driver ----------------------------------------------------------------
const SCENARIOS: Record<string, (bin: string, tmp: string) => Promise<Record<string, unknown>>> = {
  cli: scenarioCliLatency,
  idle: (b, t) => scenarioIdle(b, t),
  throughput: (b, t) => scenarioThroughput(b, t),
  cap: (b, t) => scenarioCap(b, t),
  repo: scenarioRepoContention,
  priority: scenarioPriority,
  chaos: scenarioChaos,
  toolpark: scenarioToolPark,
  "orchestrator-kill": (b, t) => scenarioOrchestratorKill(b, t),
  "state-loss": (b, t) => scenarioStateLoss(b, t),
};

// The ACP scenarios need the agent-session lane, which pre-Effect binaries lack.
const ACP_SCENARIOS = ["orchestrator-kill", "state-loss"];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let bin = "";
  let out = "";
  let only = Object.keys(SCENARIOS).join(",");
  let root = "/tmp/coordbench";
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--bin") bin = argv[++i];
    else if (argv[i] === "--out") out = argv[++i];
    else if (argv[i] === "--only") only = argv[++i];
    else if (argv[i] === "--root") root = argv[++i];
    else if (argv[i] === "--keep") keep = true;
    else {
      process.stderr.write("usage: node bench/bench.ts --bin BIN --out results.json [--only a,b] [--root DIR]\n");
      process.exit(2);
    }
  }
  if (bin === "" || out === "") {
    process.stderr.write("--bin and --out are required\n");
    process.exit(2);
  }
  // The scenario temp dirs are created under --root; make sure it exists first,
  // otherwise mkdtemp fails with ENOENT when the caller points at a fresh path.
  fs.mkdirSync(root, { recursive: true });
  const acpCapable = hasAcpLane(bin);
  const res: Record<string, unknown> = {
    backend: "sqlite",
    bin,
    bin_version: binVersion(bin),
    acp_lane: acpCapable,
    host: hostState(),
  };
  for (const name of only.split(",")) {
    const key = name.trim();
    const fn = SCENARIOS[key];
    if (fn === undefined) {
      process.stderr.write("unknown scenario " + name + "; known: " + Object.keys(SCENARIOS).join(",") + "\n");
      process.exit(2);
    }
    if (ACP_SCENARIOS.includes(key) && !acpCapable) {
      res[key + "_skipped"] = "binary has no ACP agent-session lane (kind=acp missing)";
      process.stderr.write("[bench] " + key + " skipped (no ACP lane)\n");
      continue;
    }
    const tmp = fs.mkdtempSync(path.join(root, "coordinatebench-" + key + "-"));
    const t0 = Date.now();
    try {
      Object.assign(res, await fn(bin, tmp));
    } catch (e) {
      res[key + "_error"] = String(e instanceof Error ? e.message : e).slice(0, 300);
    }
    process.stderr.write("[bench] " + key + " done in " + ((Date.now() - t0) / 1000).toFixed(1) + "s\n");
    if (keep) {
      process.stderr.write("[bench] kept " + tmp + "\n");
    } else {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  fs.writeFileSync(out, JSON.stringify(res, null, 2) + "\n");
  process.stdout.write(JSON.stringify(res, null, 2) + "\n");
}

await main();
