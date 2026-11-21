# Tool search rubric for fleet

Purpose: a reference spec and acceptance test. Hand section 1 to a web search agent so it looks for tools or stacks that satisfy it (the reverse prompt), then run section 4 on the shortlist.
Derived from the DBOS spike (`docs/dbos-spike.md`): every gate and score below exists because a candidate failed or won on it.

## 1. Prompt for the search agent

Paste everything between the lines.

---

You are a research agent. Find tools, libraries or small stacks that could replace the queue, lease and concurrency-cap layer of a per-machine job dispatcher. Do not recommend anything you have not checked against its own docs or source.

Context. The dispatcher, called fleet, runs on three machines (a laptop, a VPS, an old MacBook), each with its own local store and no shared database. It queues and runs external processes: shell commands and AI coding agents, lasting minutes to hours. An agent that crashes is resumed by its own session transcript, so we do NOT need step-replay workflow semantics. Agents enqueue work by calling a CLI many times per day. Machine caps are 2, 3 and 6 concurrent jobs. At most 1 job per git repo at a time. Some jobs also take weighted leases on heavy tools (for example a test runner costing 2 of 2 units per project).

Hard gates. Reject a candidate that fails any, citing evidence.
- G1 No external server process to operate: no Postgres, Redis, Kafka or cluster. A single embedded store, or one self-contained binary.
- G2 State lives in a local file or embedded store and survives kill -9 and reboot.
- G3 Whole resident stack idles at 200MB RSS or less (60MB or less is the target), and about 0% CPU.
- G4 Enqueue from a fresh shell process takes 300ms or less median (100ms or less is the target).
- G5 Atomic machine-wide cap N plus a per-key cap (key = repo path) of 1, with zero violations under load.
- G6 After kill -9 of the daemon, all in-flight jobs finish with no manual action, and the process group of the dead attempt is killed.
- G7 Runs on macOS (arm64 and x86_64) and Linux.
- G8 License allows internal use and modification. Flag SSPL, BSL and paid tiers explicitly.

Scored criteria (0 absent, 1 workaround of 150 lines or more, 2 workaround under 150 lines or partial, 3 native). Weight in brackets.
- S1 [3] Priority is honored globally across keys, not only within a partition.
- S2 [3] A job waiting on a cap or a tool lease does not hold a machine slot.
- S3 [2] Weighted per-key costs, or a documented extension point to add them.
- S4 [2] We own the subprocess lifecycle: a pre-exec hook, or the worker is our own code.
- S5 [2] Long jobs stay leased without step boundaries (heartbeat or liveness based).
- S6 [2] A running job can persist a small value (the agent session id) so a retry resumes it.
- S7 [2] Cancel a running job and kill its process group.
- S8 [2] How much of our 576 lines of queue and daemon code it removes.
- S9 [1] Status and stats from the CLI or SQL.
- S10 [2] Maintenance health: release in the last 6 months, more than one maintainer, issues answered.
- S11 [1] Contribution path (we may patch it).
- S12 [1] Language fit: Python best, then TypeScript, then Go or Rust as a single binary.

Anti-goals. Do not reward: deterministic replay, workflow versioning, serverless or HTTP push, HA clusters, multi-tenant billing, hosted cloud, dashboards.

Already evaluated, do not re-report except to correct a fact: DBOS Transact (rejected on measurements), Inngest, litequeue, gpahal/durable-execution, Absurd, OpenWorkflow, Restate, River.

Where to look. Job queues with keyed or partitioned concurrency, embedded or SQLite-backed queues, process supervisors with queues, durable task runners, agent orchestrators, queue libraries in Python, TypeScript, Go and Rust. Vocabulary: "concurrency key", "partition", "group concurrency", "per-key limit", "lease", "visibility timeout", "heartbeat", "reaper", "embedded", "SQLite", "single binary". Do not limit yourself to things called workflow engines.

Evidence rules. Rank sources: the project's own docs and source, then its issue tracker and changelog, then independent write-ups, then marketing. A number from a blog is tagged B and not trusted. Run `date` first and check release dates against it. Unknown stays unknown, never inferred from the name or the category. Every field needs a URL.

Output. First a ranked list of at most 8 candidates, then one JSON object per candidate using the schema below, then a section "rejected, and the first gate each failed".

```json
{
  "name": "", "url": "", "version": "", "last_release": "YYYY-MM-DD", "license": "", "language": "",
  "store": "", "extra_processes": [],
  "gates": {"G1": {"pass": null, "evidence": ""}, "G2": {}, "G3": {}, "G4": {}, "G5": {}, "G6": {}, "G7": {}, "G8": {}},
  "scores": {"S1": {"score": null, "evidence": ""}, "S2": {}, "S3": {}, "S4": {}, "S5": {}, "S6": {}, "S7": {}, "S8": {}, "S9": {}, "S10": {}, "S11": {}, "S12": {}},
  "unknowns": [], "weighted_total": null, "suggested_adapter_effort_lines": null
}
```

For the top 3, also write the adapter shim described in section 3 and say what you could not verify without running it.

---

## 2. Calibration: how our own backends score

Use these to sanity check an agent's scorecard. M means measured with `bench/bench.py`.

| Item | SQLite (current) | DBOS spike |
|---|---|---|
| G3 idle RSS | 25MB (M) | 82MB (M) |
| G4 enqueue median | 234 to 293ms under load (M) | 2431ms (M) |
| G5 caps hold | yes (M) | yes (M) |
| G6 recovery time | 16.7s, waits for the lease (M) | 2.7s (M) |
| S1 global priority | 3 (M) | 0 (M) |
| S2 park frees slot | 3 (M) | 0 (M) |
| S3 weighted costs | 3, own code | 1, glue table |

The G4 numbers were taken with other heavy jobs running on the machine, so treat them as upper bounds.

## 3. Adapter contract

A candidate is tested by wrapping it in an executable shim, so the same benchmark runs against any of them.
Invocation: `python bench/bench.py --cli "<shim command>" --backend custom --out result.json`.

The shim implements:
- `daemon`: runs in the foreground until killed. Every process it starts must stay in the shim's process group (no setsid, no double fork), so the benchmark can sum RSS over the whole stack. Jobs must start their own session so they are excluded from that sum.
- `enqueue --cwd DIR [--priority N] --shell -- "CMD"`: stores the job durably, prints an id, exits 0. The job later runs `/bin/sh -c CMD` with DIR as working directory, as its own process group. DIR is also the per-repo cap key. Higher `--priority` runs first.
- `stats`: optional, prints JSON.

Environment the shim reads: `FLEET_DB` (state path, inside a temp dir), `FLEET_CAP` (machine cap), `FLEET_REPO_CAP` (always 1), `FLEET_LEASE_S`, `FLEET_MACHINE`, `FLEET_CONFIG` (TOML file, may contain `[slots]` limits for the tool-lease scenario).

Semantics the shim must preserve: a nonzero exit marks the job failed and is not retried, except after a daemon crash, where in-flight jobs run again (at-least-once).

## 4. Acceptance test, mapped to gates

| Scenario (`--only`) | Checks | Gate or score |
|---|---|---|
| `cli` | median and p95 enqueue time from a cold process | G4 |
| `idle` | RSS and CPU of the whole stack after 20s idle | G3 |
| `throughput` | 60 trivial jobs at cap 6, makespan and peak RSS | G3, S8 context |
| `cap` | cap 3, 9 jobs, max observed concurrency from job-written timestamps | G5 |
| `repo` | 4 jobs on one repo plus 2 others, shared repo concurrency must be 1 | G5 |
| `priority` | cap 1, blocker running, jobs queued with priorities 0, 5, 1, 9 on different repos, expected order 9, 5, 1, 0 | S1 |
| `chaos` | kill -9 the daemon group at 1.5s, restart, all 9 jobs must finish, reports recovery time and duplicate runs | G6 |
| `toolpark` | two cost-2 tool jobs on one project with limit 2, plus a trivial job at cap 2: tool concurrency must be 1, and the trivial job should run while one is parked | G5, S2, S3 |

A candidate passes the acceptance test when `cap_holds`, `repo_cap_holds`, `chaos_all_done` and `tool_cap_holds` are true and `enqueue_cli_median_ms` is 300 or less. `priority_ok` and `tool_trivial_ran_while_parked` decide S1 and S2.

## 5. Decision rule

Adopt only if the candidate passes every gate, scores at least 45 weighted points out of 69, and removes at least half of the 576 lines.
Otherwise keep the SQLite backend and take the cheap win: reap expired leases at daemon start.
