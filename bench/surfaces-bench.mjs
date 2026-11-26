// Surface benchmarks: queue, lease, mailbox. Each section uses a fresh temp
// COORDINATE_DB. Output: JSON lines to stdout; summary written to
// bench/results-<ts>.json. Host state recorded next to the numbers (M).
import { spawnSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(ROOT, "bin", "coordinate.mjs");

function rig() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "coord-bench-")));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("COORDINATE_") && !k.startsWith("FLEET_") && v !== undefined) env[k] = v;
  }
  Object.assign(env, {
    COORDINATE_DB: path.join(dir, "queue.db"),
    COORDINATE_CONFIG: path.join(dir, "config.toml"),
    COORDINATE_MACHINE: "bench",
    XDG_STATE_HOME: path.join(dir, "state"),
  });
  fs.writeFileSync(env.COORDINATE_CONFIG, "");
  return { dir, env };
}

function cli(env, args, timeout = 30000) {
  const t0 = performance.now();
  const p = spawnSync(process.execPath, [BIN, ...args], { env, encoding: "utf8", timeout });
  return { ms: performance.now() - t0, status: p.status, stdout: p.stdout || "", stderr: p.stderr || "" };
}

function pct(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function stats(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return { n: arr.length, median: Math.round(pct(s, 50) * 100) / 100, p99: Math.round(pct(s, 99) * 100) / 100, mean: Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100 };
}

function hostState() {
  const load = os.loadavg();
  return {
    host: os.hostname(),
    platform: os.platform() + "/" + os.arch(),
    cpus: os.cpus().length,
    loadavg1m: Math.round(load[0] * 100) / 100,
    memTotalMb: Math.round(os.totalmem() / 1048576),
    memFreeMb: Math.round(os.freemem() / 1048576),
    date: new Date().toISOString(),
  };
}

const results = { host: hostState(), sections: {} };
const out = (name, data) => {
  results.sections[name] = data;
  process.stdout.write(JSON.stringify({ section: name, ...data }) + "\n");
};

const sections = process.argv.length > 2 ? process.argv.slice(2) : ["enqueue", "lease-latency", "lease-fairness", "lease-contention", "mailbox"];

// (a) enqueue throughput: 60 jobs enqueued back-to-back through the CLI
if (sections.includes("enqueue")) {
  const r = rig();
  const times = [];
  const t0 = performance.now();
  for (let i = 0; i < 60; i++) {
    const t = performance.now();
    cli(r.env, ["enqueue", "--", "true"]);
    times.push(performance.now() - t);
  }
  const total = (performance.now() - t0) / 1000;
  out("enqueue", { ...stats(times), totalS: Math.round(total * 100) / 100, perSec: Math.round(60 / total) });
}

// (b) lease acquire latency, immediate grant, 500 iterations (in-proc: CLI cost
// is dominated by node startup; measure CLI round-trip as the user sees it)
if (sections.includes("lease-latency")) {
  const r = rig();
  fs.writeFileSync(r.env.COORDINATE_CONFIG, '[slots]\n"bench:*" = 1000\n');
  const times = [];
  for (let i = 0; i < 200; i++) {
    const res = cli(r.env, ["lease", "acquire", "bench:x", "--cost", "1", "--wait", "5s"]);
    if (res.status === 0) {
      times.push(res.ms);
      const g = JSON.parse(res.stdout);
      cli(r.env, ["lease", "release", g.grant_id]);
    }
  }
  out("lease-latency", { ...stats(times), note: "full CLI round trip incl. node startup" });
}

// (c) FIFO fairness: 20 waiters on one key with limit 1
if (sections.includes("lease-fairness")) {
  const r = rig();
  fs.writeFileSync(r.env.COORDINATE_CONFIG, '[slots]\n"bench:fifo" = 1\n');
  const holder = cli(r.env, ["lease", "acquire", "bench:fifo", "--cost", "1"]);
  const holderGrant = JSON.parse(holder.stdout).grant_id;
  const N = 20;
  const waiters = [];
  for (let i = 0; i < N; i++) {
    const child = spawn(process.execPath, [BIN, "lease", "acquire", "bench:fifo", "--cost", "1", "--wait", "60s", "--owner", "pid:1"], { env: r.env });
    waiters.push({ i, child, stdout: "", done: new Promise((res) => child.on("exit", res)) });
    child.stdout.on("data", (d) => (waiters[i].stdout += d));
    await new Promise((res) => setTimeout(res, 80)); // enqueue order == spawn order
  }
  const t0 = performance.now();
  const order = [];
  for (let k = 0; k < N; k++) {
    cli(r.env, ["lease", "release", holderGrant]);
    // collect whichever grant appears next
    const before = waiters.map((w) => w.stdout.length);
    for (let spins = 0; spins < 100; spins++) {
      await new Promise((res) => setTimeout(res, 50));
      const granted = waiters.findIndex((w, idx) => w.stdout.includes("grant_id") && !order.includes(idx));
      if (granted !== -1) {
        order.push(granted);
        const g = JSON.parse(waiters[granted].stdout.trim().split("\n")[0]);
        cli(r.env, ["lease", "release", g.grant_id]);
        break;
      }
    }
  }
  const drainS = (performance.now() - t0) / 1000;
  const fifoOk = order.every((v, idx) => v === idx);
  out("lease-fairness", { waiters: N, fifoOrderExact: fifoOk, grantOrder: order, drainS: Math.round(drainS * 100) / 100, grantsPerSec: Math.round(N / drainS) });
  for (const w of waiters) w.child.kill();
}

// (d) lease throughput under contention: N parallel CLI acquirers
if (sections.includes("lease-contention")) {
  const r = rig();
  fs.writeFileSync(r.env.COORDINATE_CONFIG, '[slots]\n"bench:par" = 4\n');
  const res = {};
  for (const N of [4, 16, 64]) {
    const t0 = performance.now();
    const procs = [];
    for (let i = 0; i < N; i++) {
      // each acquirer grabs and releases in a tiny shell loop of one acquire+release
      const child = spawn(process.execPath, [BIN, "lease", "acquire", "bench:par", "--cost", "1", "--wait", "120s"], { env: r.env });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      procs.push({ child, stdout: () => stdout, done: new Promise((res) => child.on("exit", res)) });
    }
    let grants = 0;
    // release grants as they land so others can proceed; each process exits after one grant
    const check = setInterval(() => {
      for (const p of procs) {
        const m = p.stdout().match(/"grant_id":\s*"([^"]+)"/);
        if (m) {
          spawnSync(process.execPath, [BIN, "lease", "release", m[1]], { env: r.env });
          p.stdout = () => p.stdout().replace(m[0], "");
        }
      }
    }, 100);
    await Promise.all(procs.map((p) => p.done));
    clearInterval(check);
    const dt = (performance.now() - t0) / 1000;
    grants = procs.filter((p) => p.stdout().includes("grant") || true).length;
    res["n" + N] = { totalS: Math.round(dt * 100) / 100, acquisitionsPerSec: Math.round(N / dt) };
  }
  out("lease-contention", { limit: 4, ...res, note: "limit 4, cost 1, each process one acquire" });
}

// (e) mailbox throughput
if (sections.includes("mailbox")) {
  const r = rig();
  cli(r.env, ["agent", "register", "bench"]);
  const sendTimes = [];
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) {
    const t = performance.now();
    cli(r.env, ["send", "agent:bench", "msg-" + i]);
    sendTimes.push(performance.now() - t);
  }
  const sendTotal = (performance.now() - t0) / 1000;
  const t1 = performance.now();
  cli(r.env, ["inbox", "agent:bench"]);
  const inboxMs = performance.now() - t1;
  out("mailbox", { send: stats(sendTimes), sendPerSec: Math.round(100 / sendTotal), inboxRead100Ms: Math.round(inboxMs * 100) / 100 });
}

const file = path.join(ROOT, "bench", "results-" + Date.now() + ".json");
fs.writeFileSync(file, JSON.stringify(results, null, 2));
process.stderr.write("written: " + file + "\n");
