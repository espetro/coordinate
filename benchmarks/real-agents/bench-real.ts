// Driver for the real-agent bench. Node stdlib only; `node bench-real.ts <verb>`.
//
// Everything runs against an isolated queue: the run dir holds its own
// COORDINATE_DB and config.toml, its own daemon process (spawned and killed by
// pid, never pkill), and one directory per session under sessions/.
//
// Verbs:
//   setup    --run-dir D            write config.toml, init dirs
//   daemon   --run-dir D [--cap K]  spawn the bench daemon (detached, env-isolated)
//   seed     --run-dir D --agent A --n N   enqueue N session/new jobs, wait, harvest sessionIds
//   resume   --run-dir D --agent A --n N [--event E]   parked resume jobs + release
//   killtest --run-dir D --agent A --n N   resume wave, SIGKILL the daemon mid-flight, restart
//   work     --run-dir D --agent A --n N   realistic coding task per session, one daemon kill
//   report   --run-dir D            aggregate artifacts + events -> results.json
//   run      --run-dir D --agent A --n N [--scenario density|kill|work]  setup+daemon+scenario+report

import { spawn, spawnSync, execFileSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const COORDINATE = process.env.BENCH_COORDINATE || "coordinate";

interface Opts {
  runDir: string;
  agent: string;
  n: number;
  cap: number;
  event: string;
  scenario: string;
}

function parseOpts(argv: string[]): Opts {
  const o: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) o[argv[i].slice(2)] = argv[++i] ?? "";
  }
  return {
    runDir: path.resolve(o["run-dir"] ?? "runs/" + new Date().toISOString().replace(/[:.]/g, "-")),
    agent: o.agent ?? "maki-glm45air",
    n: Number(o.n ?? 10),
    cap: Number(o.cap ?? 3),
    event: o.event ?? "bench-wave",
    scenario: o.scenario ?? "density",
  };
}

function registry(): Record<string, { command: string; args?: string[]; class?: string; cap?: number }> {
  return JSON.parse(fs.readFileSync(path.join(HERE, "agents.real.json"), "utf8"));
}

function env(runDir: string, cap: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    COORDINATE_DB: path.join(runDir, "queue.db"),
    COORDINATE_CONFIG: path.join(runDir, "config.toml"),
    COORDINATE_CAP: String(cap),
    COORDINATE_REPO_CAP: "1000", // one repo key for the whole bench; CAP and slots do the bounding
  };
}

function coordinate(runDir: string, cap: number, args: string[]): string {
  let last: Error | null = null;
  for (let attempt = 0; attempt < 15; attempt++) {
    const r = spawnSync(COORDINATE, args, { env: env(runDir, cap), encoding: "utf8" });
    if (r.status === 0) return r.stdout.trim();
    const err = (r.stderr || "") + (r.stdout || "");
    // SQLite lock contention right after a daemon (re)start is transient.
    if (!err.includes("database is locked") && !err.includes("SQLITE_BUSY")) {
      throw new Error(`coordinate ${args.join(" ")} failed: ${err}`);
    }
    last = new Error(err);
    spawnSync("sleep", ["0.4"]);
  }
  throw last ?? new Error(`coordinate ${args.join(" ")} failed`);
}

function jobStatus(runDir: string, cap: number, id: number): { status: string; attempts: number } {
  const out = coordinate(runDir, cap, ["status", String(id)]);
  const j = JSON.parse(out) as { status: string; attempts: number };
  return { status: j.status, attempts: j.attempts };
}

function allTerminal(runDir: string, cap: number, ids: number[]): boolean {
  return ids.every((id) => ["done", "failed", "dead", "timed_out"].includes(jobStatus(runDir, cap, id).status));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitAll(runDir: string, cap: number, ids: number[], timeoutS = 3600): Promise<void> {
  const t0 = Date.now();
  while (!allTerminal(runDir, cap, ids)) {
    if (Date.now() - t0 > timeoutS * 1000) throw new Error("timed out waiting for jobs");
    await sleep(2000);
  }
}

function hostState(): Record<string, unknown> {
  const load = os.loadavg();
  return {
    host: os.hostname(),
    platform: `${os.platform()} ${os.arch()}`,
    loadavg_1m: Math.round(load[0] * 100) / 100,
    loadavg_5m: Math.round(load[1] * 100) / 100,
    mem_free_mb: Math.round(os.freemem() / 1048576),
    mem_total_mb: Math.round(os.totalmem() / 1048576),
    ts: new Date().toISOString(),
  };
}

function sampleDaemonRss(runDir: string): NodeJS.Timeout {
  const f = path.join(runDir, "daemon-rss.jsonl");
  return setInterval(() => {
    const pidFile = path.join(runDir, "daemon.pid");
    if (!fs.existsSync(pidFile)) return;
    const pid = fs.readFileSync(pidFile, "utf8").trim();
    try {
      const out = execFileSync("ps", ["-o", "rss=", "-p", pid], { encoding: "utf8" }).trim();
      fs.appendFileSync(f, JSON.stringify({ ts: Date.now() / 1000, rss_kb: Number(out) }) + "\n");
    } catch {
      // daemon not running right now
    }
  }, 5000);
}

// ---------- verbs ----------

function setup(o: Opts): void {
  const reg = registry();
  const slots = Object.entries(reg)
    .map(([name, spec]) => `  "agent:${name}" = ${spec.cap ?? o.cap}`)
    .join("\n");
  fs.mkdirSync(o.runDir, { recursive: true });
  fs.mkdirSync(path.join(o.runDir, "sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(o.runDir, "config.toml"),
    `[defaults]\nmax_runtime = "15m"\n\n[slots]\n${slots}\n`,
  );
  fs.writeFileSync(path.join(o.runDir, "host-start.json"), JSON.stringify(hostState(), null, 2) + "\n");
  console.log(`run dir: ${o.runDir}`);
}

function daemonStart(o: Opts): ChildProcess {
  const log = fs.openSync(path.join(o.runDir, "daemon.log"), "a");
  const child = spawn(COORDINATE, ["daemon"], {
    env: env(o.runDir, o.cap),
    stdio: ["ignore", log, log],
    detached: true,
  });
  child.unref();
  fs.writeFileSync(path.join(o.runDir, "daemon.pid"), String(child.pid));
  console.log(`daemon pid ${child.pid} (cap ${o.cap})`);
  return child;
}

function daemonKill(runDir: string): void {
  // Kill only the daemon pid this bench spawned, verified via ps first
  // (repo rule: only signal PIDs you started and verified).
  const pidFile = path.join(runDir, "daemon.pid");
  const pid = fs.readFileSync(pidFile, "utf8").trim();
  const cmdline = execFileSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf8" });
  if (!cmdline.includes("coordinate") || !cmdline.includes("daemon")) {
    throw new Error(`pid ${pid} is not the bench daemon: ${cmdline}`);
  }
  process.kill(Number(pid), "SIGKILL");
}

function seedPrompt(i: number): string {
  return `Create a file named ok.txt whose content is exactly one line: "ok ${i}". Do nothing else.`;
}

function resumePrompt(i: number): string {
  return `Append one line containing exactly "resumed ${i}" to the file ok.txt. Do nothing else.`;
}

function workPrompt(i: number): string {
  return (
    `In this directory create a python module calc${i}.py with functions add, sub, mul and div ` +
    `(div raises ValueError on division by zero), plus test_calc${i}.py with pytest tests covering ` +
    `all four functions including the division-by-zero error. Then run "python3 -m pytest test_calc${i}.py -q" ` +
    `and fix any failures until it passes. Stop when the tests pass.`
  );
}

function enqueueAcp(o: Opts, cwd: string, promptFile: string, session: string | null, waitOn: string | null): number {
  const cmd = session
    ? `${HERE}/run-acp.sh ${o.agent} ${cwd} ${promptFile} ${session}`
    : `${HERE}/run-acp.sh ${o.agent} ${cwd} ${promptFile}`;
  const args = ["enqueue", "--shell", "--cwd", cwd, "--repo", "bench-real", "--slot", `agent:${o.agent}`];
  if (waitOn) args.push("--wait-on", waitOn);
  args.push(cmd);
  const out = coordinate(o.runDir, o.cap, args);
  const m = out.match(/(\d+)/);
  if (!m) throw new Error(`could not parse job id from: ${out}`);
  return Number(m[1]);
}

function sessionDir(o: Opts, i: number): string {
  const d = path.join(o.runDir, "sessions", `s${String(i).padStart(4, "0")}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function writePrompt(dir: string, name: string, text: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, text + "\n");
  return p;
}

function readSessionId(dir: string): string | null {
  const f = path.join(dir, "client.jsonl");
  if (!fs.existsSync(f)) return null;
  const first = fs.readFileSync(f, "utf8").split("\n")[0];
  try {
    const j = JSON.parse(first) as { sessionId?: string };
    return j.sessionId ?? null;
  } catch {
    return null;
  }
}

function sessionsFile(o: Opts): string {
  return path.join(o.runDir, "sessions.json");
}

async function seed(o: Opts): Promise<void> {
  const ids: number[] = [];
  for (let i = 1; i <= o.n; i++) {
    const d = sessionDir(o, i);
    const pf = writePrompt(d, "prompt-seed.txt", seedPrompt(i));
    ids.push(enqueueAcp(o, d, pf, null, null));
  }
  console.log(`enqueued ${ids.length} seed jobs`);
  await waitAll(o.runDir, o.cap, ids);
  const sessions: Record<string, { sessionId: string | null; jobId: number; status: string }> = {};
  for (let i = 1; i <= o.n; i++) {
    const d = sessionDir(o, i);
    sessions[`s${i}`] = {
      sessionId: readSessionId(d),
      jobId: ids[i - 1],
      status: jobStatus(o.runDir, o.cap, ids[i - 1]).status,
    };
  }
  fs.writeFileSync(sessionsFile(o), JSON.stringify(sessions, null, 2) + "\n");
  const ok = Object.values(sessions).filter((s) => s.sessionId !== null && s.status === "done").length;
  console.log(`seed done: ${ok}/${o.n} sessions established`);
}

async function resume(o: Opts, killDaemon = false): Promise<void> {
  const sessions = JSON.parse(fs.readFileSync(sessionsFile(o), "utf8")) as Record<
    string,
    { sessionId: string | null }
  >;
  const ids: number[] = [];
  let i = 0;
  for (const [key, s] of Object.entries(sessions)) {
    i++;
    if (!s.sessionId) continue;
    const d = sessionDir(o, i);
    const pf = writePrompt(d, "prompt-resume.txt", resumePrompt(i));
    // Parked on an event: N durable harness sessions, zero live processes until release.
    ids.push(enqueueAcp(o, d, pf, s.sessionId, o.event));
  }
  console.log(`enqueued ${ids.length} parked resume jobs on event ${o.event}`);

  const rssTimer = sampleDaemonRss(o.runDir);
  const releaseAt = Date.now() / 1000;
  coordinate(o.runDir, o.cap, ["release", o.event]);
  console.log(`released ${o.event}`);

  if (killDaemon) {
    // Wait until roughly a third of the wave has been claimed, then SIGKILL the
    // daemon mid-turn and restart it. Agents must survive; jobs must finish.
    const claimed = () => ids.filter((id) => ["running", "done"].includes(jobStatus(o.runDir, o.cap, id).status)).length;
    while (claimed() < Math.max(1, Math.floor(ids.length / 3))) await sleep(500);
    daemonKill(o.runDir);
    console.log("daemon SIGKILLed mid-wave, restarting");
    await sleep(2000);
    daemonStart(o);
  }

  await waitAll(o.runDir, o.cap, ids);
  clearInterval(rssTimer);

  const results = ids.map((id, k) => {
    const st = jobStatus(o.runDir, o.cap, id);
    return { jobId: id, status: st.status, attempts: st.attempts };
  });
  fs.writeFileSync(
    path.join(o.runDir, killDaemon ? "kill-results.json" : "resume-results.json"),
    JSON.stringify({ releaseAt, jobs: results }, null, 2) + "\n",
  );
  const done = results.filter((r) => r.status === "done").length;
  console.log(`resume done: ${done}/${ids.length} (kill=${killDaemon})`);
}

function countResumedMarkers(o: Opts): { duplicates: number; missing: number } {
  let duplicates = 0;
  let missing = 0;
  const dirs = fs.readdirSync(path.join(o.runDir, "sessions"));
  for (const d of dirs) {
    const f = path.join(o.runDir, "sessions", d, "ok.txt");
    if (!fs.existsSync(f)) continue;
    const markers = fs
      .readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("resumed "));
    if (markers.length === 0) missing++;
    if (markers.length > 1) duplicates++;
  }
  return { duplicates, missing };
}

async function work(o: Opts): Promise<void> {
  const ids: number[] = [];
  for (let i = 1; i <= o.n; i++) {
    const d = sessionDir(o, 10_000 + i); // separate numbering from density sessions
    spawnSync("git", ["init", "-q"], { cwd: d });
    const pf = writePrompt(d, "prompt-work.txt", workPrompt(i));
    ids.push(enqueueAcp(o, d, pf, null, null));
  }
  console.log(`enqueued ${ids.length} work jobs`);
  const rssTimer = sampleDaemonRss(o.runDir);

  // One daemon kill mid-run, once at least one job is running.
  while (!ids.some((id) => jobStatus(o.runDir, o.cap, id).status === "running")) await sleep(1000);
  await sleep(10_000);
  daemonKill(o.runDir);
  console.log("daemon SIGKILLed during work, restarting");
  await sleep(2000);
  daemonStart(o);

  await waitAll(o.runDir, o.cap, ids, 7200);
  clearInterval(rssTimer);
  const results = ids.map((id, k) => {
    const d = sessionDir(o, 10_000 + k + 1);
    const st = jobStatus(o.runDir, o.cap, id);
    const artifact = fs.existsSync(path.join(d, `calc${k + 1}.py`));
    let testsPass = false;
    try {
      const r = spawnSync("python3", ["-m", "pytest", `test_calc${k + 1}.py`, "-q"], {
        cwd: d,
        encoding: "utf8",
        timeout: 60_000,
      });
      testsPass = r.status === 0;
    } catch {
      testsPass = false;
    }
    return { jobId: id, status: st.status, attempts: st.attempts, artifact, testsPass };
  });
  fs.writeFileSync(path.join(o.runDir, "work-results.json"), JSON.stringify({ jobs: results }, null, 2) + "\n");
  console.log(`work done: ${results.filter((r) => r.testsPass).length}/${ids.length} sessions produced green tests`);
}

function report(o: Opts): void {
  const events = fs
    .readFileSync(path.join(o.runDir, "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { id: number; ts: number; job_id: number; kind: string });
  const out: Record<string, unknown> = {
    host: hostState(),
    host_start: JSON.parse(fs.readFileSync(path.join(o.runDir, "host-start.json"), "utf8")),
    scenario: o.scenario,
    agent: o.agent,
    n: o.n,
    cap: o.cap,
    markers: fs.existsSync(path.join(o.runDir, "sessions")) ? countResumedMarkers(o) : null,
    files: {} as Record<string, unknown>,
  };
  for (const f of ["resume-results.json", "kill-results.json", "work-results.json"]) {
    const p = path.join(o.runDir, f);
    if (fs.existsSync(p)) (out.files as Record<string, unknown>)[f] = JSON.parse(fs.readFileSync(p, "utf8"));
  }
  // claim/done latency per job from the event feed
  const claimed = new Map<number, number>();
  const finished = new Map<number, number>();
  for (const e of events) {
    if (e.kind === "claimed" && !claimed.has(e.job_id)) claimed.set(e.job_id, e.ts);
    if (["done", "failed", "dead", "timed_out"].includes(e.kind)) finished.set(e.job_id, e.ts);
  }
  const lat = [...finished.entries()].map(([jid, t]) => ({ job: jid, s: t - (claimed.get(jid) ?? t) }));
  lat.sort((a, b) => a.s - b.s);
  out.claim_to_finish_s = {
    n: lat.length,
    p50: lat[Math.floor(lat.length * 0.5)]?.s ?? null,
    p95: lat[Math.floor(lat.length * 0.95)]?.s ?? null,
    max: lat[lat.length - 1]?.s ?? null,
  };
  fs.writeFileSync(path.join(o.runDir, "results.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));
}

// ---------- main ----------

const [verb, ...rest] = process.argv.slice(2);
const o = parseOpts(rest);

switch (verb) {
  case "setup":
    setup(o);
    break;
  case "daemon":
    daemonStart(o);
    break;
  case "seed":
    await seed(o);
    break;
  case "resume":
    await resume(o, false);
    break;
  case "killtest":
    await resume(o, true);
    break;
  case "work":
    await work(o);
    break;
  case "report": {
    const env2 = env(o.runDir, o.cap);
    const ev = spawnSync(COORDINATE, ["events"], { env: env2, encoding: "utf8" });
    fs.writeFileSync(path.join(o.runDir, "events.jsonl"), ev.stdout);
    report(o);
    break;
  }
  case "run": {
    setup(o);
    daemonStart(o);
    await sleep(1500);
    if (o.scenario === "density") {
      await seed(o);
      await resume(o, false);
    } else if (o.scenario === "kill") {
      await seed(o);
      await resume(o, true);
    } else if (o.scenario === "work") {
      await work(o);
    } else {
      throw new Error(`unknown scenario ${o.scenario}`);
    }
    const ev = spawnSync(COORDINATE, ["events"], { env: env(o.runDir, o.cap), encoding: "utf8" });
    fs.writeFileSync(path.join(o.runDir, "events.jsonl"), ev.stdout);
    report(o);
    break;
  }
  default:
    console.error("verbs: setup | daemon | seed | resume | killtest | work | report | run");
    process.exit(2);
}
