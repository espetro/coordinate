# Tool search rubric for the agent orchestration layer

Purpose: a reference spec and acceptance test. Hand section 1 to a web search agent so it looks for tools or stacks that satisfy it (the reverse prompt), then run sections 3 and 4 on the shortlist.
The requirements and the reasoning behind them are in `docs/orchestrator-framing.md`. The scheduler gates come from measured failures in the DBOS spike (`docs/dbos-spike.md`).

## 1. Prompt for the search agent

Paste everything between the lines.

---

You are a research agent. Find open source tools, or small stacks of them, that can serve as modules of a personal orchestration layer for AI coding-agent sessions. Run `date` first. Do not recommend anything you have not checked against its own docs or source.

Context. One person runs coding agents (Claude Code, Codex, OpenCode and others) on three devices: a laptop, a VPS and an old MacBook, connected over Tailscale in a hub and spoke shape (the laptop links to the other two). Agents are driven mostly from a control panel (T3 Code, or an agent IDE such as Orca), but the orchestration layer must also run on its own. Agents are external processes started through ACP (Agent Client Protocol), with tmux as a fallback, and resume through their own session transcripts (ACP `session/load`). Live agent processes cost from about 60MB (Rust harnesses such as Codex or maki, idle) to about 600MB (Claude Code with children, mid-turn), so most sessions must be parked (no process, a small durable record) and woken on events, Node.js event-loop style: hundreds to thousands of open sessions, a few live per device.

The layer is split into modules with a single responsibility each. A candidate may cover one module or several:
- M1 Connector: reach other devices, publish device state, delegate work.
- M2 Dispatcher: start, prompt, cancel and resume a session on any harness behind one interface.
- M3 Session store: durable session records with TTL and garbage collection.
- M4 Scheduler: queue, soft concurrency caps per device and per key, priority, placement across devices, park and wake.
- M5 Coordination: locks and leases on files and tools, provider rate limits, awaits (waiting on a human, another agent, a lock, CI).
- M6 Context: shared notes and handoffs across harnesses and devices.

Hard gates. Reject a candidate that fails any gate for the modules it claims, citing evidence.
- G1 No external server to operate: no Postgres, Redis, Kafka, NATS, object storage or cluster. Embedded stores, files, or one self-contained binary only.
- G2 Its resident footprint fits a 200-300MB budget for the whole orchestration stack on one device, excluding the agent processes themselves (under 60MB per module is the target), with about 0% idle CPU.
- G3 State survives kill -9 and reboot, and stored state can be bounded by TTL or retention.
- G4 Availability over consistency: when the candidate's process or the network is down, already running agents keep running and new work queues locally. Nothing is dropped.
- G5 Runs on macOS (arm64 and x86_64) and Linux.
- G6 Open source license that allows internal use and modification. Flag SSPL, BSL and paid tiers explicitly.
- G7 Maintained: 10 or more GitHub stars and a release or commits within the last 6 months, as of the date you ran.

Scored criteria (0 absent, 1 workaround of 150 lines or more, 2 workaround under 150 lines or partial, 3 native). Weight in brackets.
- S1 [3] Park and wake: a waiting session holds no process and no slot, and is woken by an event (durable promise, signal, message, timer).
- S2 [3] Soft caps: per-device and per-key (repo) concurrency limits, where surplus work queues instead of failing. Weighted costs per key score higher.
- S3 [3] Resume after the orchestrator dies, with the same harness or a different one, from a persisted session id or transcript.
- S4 [2] Harness-agnostic dispatch: ACP or an equivalent universal agent API, not tied to one vendor's agent.
- S5 [2] Cross-device: delegation or placement across machines without a shared database, tolerant of partitions.
- S6 [2] Locks and leases for agents: advisory file or tool leases with TTL.
- S7 [2] Await tracking: each session records what it waits on, visible from a CLI or API.
- S8 [2] Rate limiting by provider quota or token budget, not only by count.
- S9 [2] Priority honored across keys, not only within a partition.
- S10 [2] Enqueue or dispatch from a fresh shell in 300ms or less (100ms is the target).
- S11 [1] Composable: a library or a small binary with a CLI or API we can wrap, not a full app that must own the UI.
- S12 [1] Published density or concurrency benchmarks with a reproducible method.
- S13 [1] Contribution path (we may patch it) and language fit (TypeScript or Python best, then Go or Rust as a single binary).
- S14 [1] Adaptive caps: concurrency levels or limits driven by user presence, memory pressure, thermal state or battery, with hysteresis.

Anti-goals. Do not reward: deterministic step replay of code inside the worker (our agents resume from transcripts), workflow versioning, serverless or HTTP push to hosted functions, HA clusters, multi-tenant billing, hosted-only clouds, dashboards.

Already evaluated, do not re-report except to correct a fact: DBOS Transact (rejected on measurements), Inngest, litequeue, gpahal/durable-execution, Absurd, OpenWorkflow, Restate, River, Rivet Actors and Sandbox Agent, Orca, T3 Code, MCP Agent Mail, beads and Gas Town or Gas City, and every product in `docs/research/orchestrators-landscape-a.md` and `-b.md` (Conductor alternatives such as Multica, OpenHands, Paperclip, OpenClaw, Herdr, Paseo, Cloudroom, Podium, bb, zmx).

Where to look. Agent orchestrators and agent IDEs with a CLI, universal coding-agent APIs, ACP clients and proxies, local-first sync engines, embedded job queues with keyed concurrency, actor runtimes with hibernation, durable promise libraries, multi-agent coordination servers (inboxes, file leases), rate limiters for LLM quotas, presence or load aware schedulers (BOINC style "in use" profiles), harness routers that assign roles to models, metric-driven config tuners and plugin hosts that support safe self-improvement loops. Vocabulary: "park", "hibernate", "durable promise", "awakeable", "concurrency key", "lease", "visibility timeout", "heartbeat", "work stealing", "local-first", "single binary", "ACP", "session/load". Do not limit yourself to things called workflow engines.

Evidence rules. Rank sources: the project's own docs and source, then its issue tracker and changelog, then independent write-ups, then marketing. Tag numbers from blogs or landing pages as B and do not trust them. Unknown stays unknown, never inferred from the name or the category. Every field needs a URL.

Output. First a ranked list of at most 8 candidates with the modules each covers, then one JSON object per candidate using the schema below, then a section "rejected, and the first gate each failed", then a proposed stack: one candidate or our own glue per module.

```json
{
  "name": "", "url": "", "version": "", "last_release": "YYYY-MM-DD", "stars": null, "license": "", "language": "",
  "modules": [], "store": "", "extra_processes": [],
  "gates": {"G1": {"pass": null, "evidence": ""}, "G2": {}, "G3": {}, "G4": {}, "G5": {}, "G6": {}, "G7": {}},
  "scores": {"S1": {"score": null, "evidence": ""}, "S2": {}, "S3": {}, "S4": {}, "S5": {}, "S6": {}, "S7": {}, "S8": {}, "S9": {}, "S10": {}, "S11": {}, "S12": {}, "S13": {}, "S14": {}},
  "unknowns": [], "weighted_total": null, "suggested_glue_lines": null
}
```

For the top 3, describe the adapter shim from section 3 for the modules they cover, and say what you could not verify without running it.

---

## 2. Calibration: how our own scheduler backends score

These are the M4 scheduler numbers measured so far. Use them to sanity check an agent's scorecard. M means measured with `bench/bench.py`.

| Item | SQLite (current) | DBOS spike |
|---|---|---|
| G2 idle RSS | 25MB (M) | 82MB (M) |
| G3 recovery after kill -9 | 16.7s, waits for the lease (M) | 2.7s (M) |
| S1 waiting job frees its slot | 3 (M) | 0 (M), suspend is Enterprise only |
| S2 caps hold | 3 (M), weighted costs in own code | 2 (M), weights via a glue table |
| S9 global priority | 3 (M) | 0 (M), per partition only |
| S10 enqueue median | 234 to 293ms under load (M) | 2431ms (M) |

The S10 numbers were taken with other heavy jobs running on the machine, so treat them as upper bounds.
For scale: idle harnesses measured 57MB (maki) to 355MB (Kimi), and a live Claude Code turn 598 to 613MB with children (M), so the G2 budget excludes agent processes.

## 3. Adapter contract (M4 scheduler)

A candidate is tested by wrapping it in an executable shim, so the same benchmark runs against any of them.
Invocation: `python bench/bench.py --cli "<shim command>" --backend custom --out result.json`.

The shim implements:
- `daemon`: runs in the foreground until killed. Every process it starts must stay in the shim's process group (no setsid, no double fork), so the benchmark can sum RSS over the whole stack. Jobs must start their own session so they are excluded from that sum.
- `enqueue --cwd DIR [--priority N] --shell -- "CMD"`: stores the job durably, prints an id, exits 0. The job later runs `/bin/sh -c CMD` with DIR as working directory, as its own process group. DIR is also the per-repo cap key. Higher `--priority` runs first.
- `stats`: optional, prints JSON.

Environment the shim reads: `FLEET_DB` (state path, inside a temp dir), `FLEET_CAP` (machine cap), `FLEET_REPO_CAP` (always 1), `FLEET_LEASE_S`, `FLEET_MACHINE`, `FLEET_CONFIG` (TOML file, may contain `[slots]` limits for the tool-lease scenario).

Semantics the shim must preserve: a nonzero exit marks the job failed and is not retried, except after a daemon crash, where in-flight jobs run again (at-least-once).

## 4. Acceptance test

Implemented in `bench/bench.py` (M4 scheduler, with shell jobs standing in for agents):

| Scenario (`--only`) | Checks | Gate or score |
|---|---|---|
| `cli` | median and p95 enqueue time from a cold process | S10 |
| `idle` | RSS and CPU of the whole stack after 20s idle | G2 |
| `throughput` | 60 trivial jobs at cap 6, makespan and peak RSS | G2 |
| `cap` | cap 3, 9 jobs, max observed concurrency from job-written timestamps | S2 |
| `repo` | 4 jobs on one repo plus 2 others, shared repo concurrency must be 1 | S2 |
| `priority` | cap 1, blocker running, jobs queued with priorities 0, 5, 1, 9 on different repos, expected order 9, 5, 1, 0 | S9 |
| `chaos` | kill -9 the daemon group at 1.5s, restart, all 9 jobs must finish, reports recovery time and duplicate runs | G3, G4 |
| `toolpark` | two cost-2 tool jobs on one project with limit 2, plus a trivial job at cap 2: tool concurrency must be 1, and the trivial job should run while one is parked | S1, S2, S6 |
| `orchestrator-kill` | K stub ACP jobs through fleet (`bench/acp_client.py` driving `bench/stub_acp_agent.py`), kill -9 the daemon group mid-turn, restart: every session must complete; counts `orchkill_all_done`, `orchkill_duplicate_turns`, `orchkill_resumed_via_session_load`, `orchkill_restarted`, `orchkill_recovery_s` | G4, S3 |
| `live-density` | step up concurrent stub ACP sessions at a given `STUB_BALLAST_MB` (60 codex/maki-like, 240 claude-like): orchestrator RSS separate from agent RSS, `density_fixed_overhead_mb`, `agent_rss_per_session_mb`, `live_sessions_per_gib_agents` | G2, S12 |
| `noise-floor` | repeat a chosen subset of scenarios N times (`--repeats`, default 10; `--noise-scenarios`, default cli,cap,chaos): mean, stdev, min, max and cv_pct per metric, so tuning ignores changes inside the noise | improver prerequisite |
| `state-loss` | live jobs, parked jobs, a tool lease and an ACP session mid-turn all at once; kill -9 the daemon, restart: counts `stateloss_jobs_lost`, `stateloss_jobs_run_twice`, `stateloss_duplicate_turns`, `stateloss_leases_leaked`, and diffs the job rows and the stub agent's session state before versus after | G3, G4, S3 |

A scheduler passes when `cap_holds`, `repo_cap_holds`, `chaos_all_done` and `tool_cap_holds` are true and `enqueue_cli_median_ms` is 300 or less. `priority_ok` and `tool_trivial_ran_while_parked` decide S9 and S1. For the ACP scenarios the pass criteria are `orchkill_all_done` true, `orchkill_restarted` less than the number of killed jobs (resumption through `session/load` must be the normal path), and for `live-density` an orchestrator RSS within the G2 budget and an `agent_rss_per_session_mb` within 20% of the harness's known footprint. Method and measured numbers: `docs/bench-v2.md`.

Planned, needed for the concurrency-first and multi-device requirements (not implemented yet):

| Scenario | Checks | Gate or score |
|---|---|---|
| `park-density` | open 1,000 then 10,000 parked sessions, orchestrator RSS and bytes per session, then TTL expiry reclaims storage | G2, G3, S12 |
| `wake-latency` | event to first agent output for a parked ACP session, p50 and p99, per harness | S1, S12 |
| `harness-swap` | resume a parked session on a different harness from its exported context | S3, S4 |
| `partition` | cut the hub link: spokes keep running and queueing, global overshoot stays within the sum of allowances, nothing is dropped, state converges after reconnect | G4, S5 |
| `presence-drop` | switch the device from away to focus with 6 live sessions: QoS drops at once, surplus parks at the next turn boundary, no turn is killed, level does not flap | S14, S1 |
| `lock-contention` | two agents request the same file lease: one waits parked, wakes on release or TTL | S6, S7 |

## 5. Decision rule

Pick per module, not per tool. A candidate is adopted for a module when it passes every gate, scores at least 60% of the weighted points relevant to that module, and the glue it needs is smaller than the code it replaces.
Weights sum to 27, so the ceiling is 81 points over all modules.
Where no candidate qualifies, keep our own module (the SQLite scheduler, with leases reaped at daemon start) and record the gap as a contribution target.
