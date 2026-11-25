// Merge the A/B round files into one results JSON with per-metric aggregates.
// Usage: node bench/merge-ab.mjs --baseline <prefix> --candidate <prefix> --out results.json
import * as fs from "node:fs";

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[++i];
}
const prefixB = args["baseline"];
const prefixC = args["candidate"];
const out = args["out"];
if (prefixB === undefined || prefixC === undefined || out === undefined) {
  process.stderr.write("usage: node bench/merge-ab.mjs --baseline P --candidate P --out FILE\n");
  process.exit(2);
}

function load(prefix, side) {
  const files = fs.readdirSync("/tmp").filter((f) => f.startsWith(prefix) && f.endsWith(".json"));
  const rounds = [];
  for (const f of files.sort()) {
    rounds.push({ file: f, data: JSON.parse(fs.readFileSync("/tmp/" + f, "utf8")) });
  }
  void side;
  return rounds;
}

const bRounds = load(prefixB, "baseline");
const cRounds = load(prefixC, "candidate");

// Metrics that are numbers, aggregated across rounds (median of the rounds).
const NUMERIC = [
  "enqueue_cli_median_ms", "enqueue_cli_p95_ms", "idle_rss_mb", "idle_cpu_pct",
  "enqueue_total_s", "throughput_makespan_s", "throughput_jobs_per_s", "peak_rss_mb",
  "cap_makespan_s", "cap_ideal_s", "chaos_recovery_to_all_done_s", "chaos_total_executions",
  "chaos_duplicated_jobs", "orchkill_recovery_s", "orchkill_duplicate_turns",
  "orchkill_resumed_via_session_load", "orchkill_restarted", "stateloss_recovery_s",
  "stateloss_jobs_lost", "stateloss_never_finished", "stateloss_jobs_run_twice",
  "stateloss_duplicate_turns", "stateloss_leases_leaked", "stateloss_leases_leaked_right_after_kill",
  "stateloss_parked_still_parked", "stateloss_parked_released", "stateloss_orphan_agents_surviving",
  "enqueue_to_claim_p50_ms", "enqueue_to_claim_p95_ms", "enqueue_to_claim_max_ms",
];
// Metrics that must be identical in every round (booleans and counts).
const EXACT = [
  "throughput_jobs", "throughput_all_done", "cap", "cap_jobs", "cap_all_done", "cap_max_concurrency", "cap_holds",
  "repo_all_done", "repo_shared_max_concurrency", "repo_cap_holds",
  "priority_ok", "chaos_all_done", "tool_all_done", "tool_vitest_max_concurrency", "tool_cap_holds",
  "tool_trivial_ran_while_parked", "orchkill_jobs", "orchkill_all_done", "orchkill_done",
  "orchkill_agents_alive_before_kill", "orchkill_agents_alive_after_kill", "orchkill_orphan_agents_surviving",
  "stateloss_live_jobs", "stateloss_parked_jobs", "stateloss_tool_jobs", "stateloss_acp_jobs",
];

function vals(rounds, key) {
  return rounds.map((r) => r.data[key]).filter((v) => typeof v === "number");
}

function med(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const merged = {
  backend: "sqlite",
  generated_by: "bench/merge-ab.mjs",
  baseline_bin: bRounds[0] === undefined ? null : bRounds[0].data.bin,
  baseline_version: bRounds[0] === undefined ? null : bRounds[0].data.bin_version,
  baseline_acp_lane: bRounds[0] === undefined ? null : bRounds[0].data.acp_lane,
  candidate_bin: cRounds[0] === undefined ? null : cRounds[0].data.bin,
  candidate_version: cRounds[0] === undefined ? null : cRounds[0].data.bin_version,
  candidate_acp_lane: cRounds[0] === undefined ? null : cRounds[0].data.acp_lane,
  host: cRounds[0] === undefined ? null : cRounds[0].data.host,
  rounds: { baseline: bRounds.map((r) => r.file), candidate: cRounds.map((r) => r.file) },
  host_load_1m_per_round: {
    baseline: bRounds.map((r) => r.data.host.load_1m),
    candidate: cRounds.map((r) => r.data.host.load_1m),
  },
  metrics: {},
};
for (const k of NUMERIC) {
  const b = vals(bRounds, k);
  const c = vals(cRounds, k);
  merged.metrics[k] = {
    baseline_rounds: b,
    candidate_rounds: c,
    baseline_median: med(b),
    candidate_median: med(c),
  };
}
for (const k of EXACT) {
  const b = [...new Set(bRounds.map((r) => String(r.data[k])))];
  const c = [...new Set(cRounds.map((r) => String(r.data[k])))];
  merged.metrics[k] = { baseline_values: b, candidate_values: c, equal: b.length === 1 && c.length === 1 && b[0] === c[0] };
}
// Priority order is a list, compare as a set of distinct values.
merged.metrics["priority_order"] = {
  baseline_values: [...new Set(bRounds.map((r) => (r.data["priority_order"] === undefined ? "" : r.data["priority_order"].join(","))))],
  candidate_values: [...new Set(cRounds.map((r) => (r.data["priority_order"] === undefined ? "" : r.data["priority_order"].join(","))))],
};
// Skipped / failed scenarios, per round.
merged.skipped_or_failed = {};
for (const r of [...bRounds.map((r) => ["baseline", r]), ...cRounds.map((r) => ["candidate", r])]) {
  for (const k of Object.keys(r[1].data)) {
    if (k.endsWith("_skipped") || k.endsWith("_error")) {
      const key = k.replace(/_(skipped|error)$/, "");
      merged.skipped_or_failed[key] = merged.skipped_or_failed[key] ?? {};
      merged.skipped_or_failed[key][r[0] + ":" + r[1].file] = r[1].data[k];
    }
  }
}
fs.writeFileSync(out, JSON.stringify(merged, null, 2) + "\n");
process.stdout.write(JSON.stringify(merged, null, 2) + "\n");
