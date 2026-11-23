# Orchestrator framing

Date: 2026-11-22. Supersedes the "job queue for one machine" framing used in `.agents/docs/dbos-spike.md` and the first version of `.agents/docs/candidates-survey.md`.
Evidence tags: M = measured by us, R = read in the project's own docs, B = blog or marketing claim, K = from memory, unverified.

## What we are building

An orchestration layer for coding-agent sessions that can run on its own, but is mainly driven from a control panel such as T3 Code or Orca.
"Orchestration layer" means several modules, each with a single responsibility, built from maintained OSS tools (10+ GitHub stars, active as of November 2026) plus our own glue.

### Requirements

1. Footprint: no external long-running server (Postgres, Redis, Kafka and similar). The orchestration stack on one device stays under 200-300MB RSS. Stored state is bounded by a TTL and garbage collected.
2. Durable store: state survives kill -9 and reboot.
3. Availability over consistency: agents keep working when the orchestrator is down or a device is unreachable. Concurrency caps are soft. With a global cap of 12 split 3+5+5 per device, a temporary overshoot is acceptable, and surplus sessions are queued or rate limited, never dropped.
4. Multi-harness through a dispatcher interface: ACP today, with a tmux fallback.
5. Multi-device through a connector interface: T3 links over Tailscale today, a DAG `kinosmac -> kinosmac-pro` and `kinosmac -> ovhcloud`.
6. Shared context across harnesses and devices.
7. Concurrency-first, in the Node.js sense: one cheap scheduler handles hundreds to thousands of sessions because most of them are waiting. This replaces the current anti-pattern where T3 only dispatches and each harness spawns subagents of its own kind only.
8. Durable execution: dispatch, wait for completion, pause and resume. If the orchestrator stops, a session resumes where it stopped, with the same harness or a different one.
9. Soft concurrency cap: limit live agents, suspend the ones that are waiting, run the ones that are ready. Combine queueing, rate limiting and load balancing.
10. Tracking awaits: know what each session is waiting on (a human, another agent, a lock, a rate limit, CI), and coordinate locks and rate limits between agents.
11. Secondary: a defensible, benchmarked number of concurrent agents.

## Assessment 1: what "concurrent agents" can mean for us

A live harness process is heavy. This Claude Code session measured 366MB RSS (M), more than the whole orchestrator budget.
So the 200-300MB budget applies to the orchestration stack only, and the number of live harness processes is bounded by device memory and provider rate limits, not by the scheduler.

The Node.js analogy holds once a session is split into two states:
- Live: a harness process is attached and running a turn. Costs hundreds of MB. Counted against the device cap.
- Parked: no process. The orchestrator keeps a small record (harness, session id, cwd, device, what it is waiting on, transcript pointer). Costs kilobytes. Woken by an event, then resumed through ACP `session/load` or the harness's own resume flag.

The scheduler is the event loop. Awaiting a human, a subtask, a lock or CI parks the session and frees its slot. "Thousands of concurrent agents" then means thousands of open sessions, with a small number live at once.

Rivet's "7,242x more agents per server" is 512 MiB (E2B's default sandbox allocation, a limit, not measured use) divided by 72.4 KiB per Actor (R). Its own benchmark repo measured 314.6 KiB per actor plus 367 KiB on the backend, about 769x counted fully, and excludes a fixed overhead of 1 to 5.7 GiB. The "agent" is an idle Actor that answers a ping inside a shared process, with no model loop and no CLI harness (details in `.agents/docs/research/rivet-density-claim.md`). The number does not transfer to external harness processes, but the idea does: keep parked sessions cheap and outside any process.

Harness footprint varies by 6x, so harness choice is a scheduling input (`.agents/docs/research/harness-footprint-and-roles.md`, idle RSS after ACP `initialize`, M): maki 57MB and Codex app-server 59MB (Rust), Devin 107MB, Claude Code 237MB, Cursor 239MB, OpenCode 288MB, Kimi 355MB. MCP servers add about 241MB per Claude Code or Devin process. A live Claude Code turn measured 297 to 407MB, 598 to 613MB with children (M). Live RSS for the other harnesses is still unknown.

The defensible numbers we can publish are therefore:
- Live sessions per GiB of device memory, per harness, counting child processes.
- Parked sessions per device at a fixed orchestrator RSS, and bytes per parked session, using a step-up memory test like Rivet's.
- Wake latency: from event to a resumed harness producing its first token, p50 and p99, split by stage, per harness.
- Scheduler overhead: CPU and RSS at N parked and M live sessions.
- Maximum sustained live sessions before memory pressure or provider rate limits.
Two rules: never put parked and live sessions in one ratio, and always publish the fixed overhead.

## Assessment 2: one orchestrator per device or one central orchestrator

The topology decides most of this. T3 links go one way and do not chain: "a link reaches one machine and does not carry on through that machine's own links" (R). With the current DAG, kinosmac-pro and ovhcloud cannot reach each other, only kinosmac reaches both. The topology is already hub and spoke.

Recommendation: one orchestrator per device (local-first), with kinosmac as the coordinator for placement only.
- Each device owns its queue, its sessions, its local soft cap and its durable store. It keeps running sessions, parking and waking them with no network.
- The hub places new work. It reads each device's published state (live count, queued count, free memory) over the connector and picks a device. T3 already does a version of this: auto balance picks a machine for new threads by CPU and memory, as a per-client preference, at thread creation only (R).
- The global cap is a budget, not a lock. The hub lends each device an allowance (for example 3+5+5 of 12). A device that cannot reach the hub keeps its last allowance. The worst case overshoot is bounded by the sum of allowances, and extra work queues locally.
- No CRDT is needed for caps: each count has a single writer (its device), so publishing per-device state is enough. CRDTs or an append-only log only become relevant for multi-writer shared context (notes, memory), and git already provides that for repo-scoped context.
- If kinosmac is off, spokes keep working but nothing new is placed across devices. Adding a reverse link (spoke to hub) or a spoke-to-spoke link removes the single coordinator, at the cost of electing one.

Centralized alternative: one orchestrator on the always-on VPS (ovhcloud) with thin agents on each device. Simpler global view, but a laptop off the network stops getting work and its live sessions lose their scheduler. It fails requirement 3.

## Assessment 3: shared context with T3 today

What T3 Code provides across devices (R, `.agents/docs/user/remote-access.md`):
- Threads live on the machine that runs them. There is no replicated thread store.
- Through a link you can read another machine's thread live and read-only, and `delegate_task` runs a task there and wakes the caller with the result, across restarts.
- Files, images and published visuals stay on the host machine.
- Links expire after 30 days unused and must be paired again.

So T3 gives cross-device delegation and visibility, not shared context. A context module needs its own store:
- Repo-scoped context: git (branches, notes, handoff files), already shared.
- Session-scoped context: the session record plus a transcript pointer, exported on handoff so a different harness can resume with a summary.
- Cross-agent messages and leases: an inbox with ack and advisory leases, as in MCP Agent Mail (R, see survey) or Orca's run inbox (R).

Research on beads, Gas Town and CRDTs (`.agents/docs/research/shared-context-crdt.md`): beads (`gastownhall/beads`) now stores everything in Dolt; its old git JSONL plus SQLite design survives in `Dicklesworthstone/beads_rust`. Its open issues (stuck merges over ssh, sibling children that cannot merge, silently dropped comments, migrations breaking cross-machine merges, unbounded Dolt memory, agent mode not engaging under Claude Code) argue for copying its data model (hash ids, claims, dependency graph, `supersedes` links, device-local leases) and not its implementation.
The adversarial point holds: each device is already the single writer of its own records, CRDTs merge bytes and not intent, and contradicting facts need `supersedes` links, expiry and a hub-side compaction pass rather than a CRDT.
Position for M6: append-only files with one writer per device and kind, synced through a bare git repo on kinosmac. A git-bug style operation log for work items if they need automatic merges. Automerge or Loro only for shared notes, and only if a spike shows real concurrent edits. Ruled out: Dolt-based beads, cr-sqlite (stalled), ElectricSQL, PowerSync, Letta, mem0, LiteFS.
Open: whether spokes can open connections to kinosmac over Tailscale (T3 links are one way, Tailscale itself may not be).

## Assessment 4: tracking awaits, state of the art

Every system surveyed models a wait as a durable record plus a wake condition, so the waiter can release its resources:
- Durable promises and awakeables (Restate), signals and updates (Temporal), events with first-emit-wins (Absurd), suspended workflows waiting on a message (DBOS `recv`, suspend is Enterprise only) (R).
- Agent-specific, Orca (R): a Run with an inbox, Tasks, Dispatches (one attempt of a task), worker heartbeats every 1-60 minutes, `worker_done` exactly once with the task and dispatch ids so stale retries cannot complete the wrong attempt, `ask` for blocking questions, and decision gates that block a task until resolved.
- Locks: advisory file leases with a TTL, exclusive or shared, on file globs, with an optional pre-commit guard (MCP Agent Mail) (R). Our weighted tool leases (`toolcaps`) are the same idea for heavy commands.
- Rate limits: per-provider usage tracking is now in control panels (Orca shows limits and reset times) (R). None of the surveyed tools throttles agent launches by provider quota. That stays our glue.

For us, an await is one of: human (permission request or question), agent (subtask result), resource (lock, tool lease, rate limit), external (CI, PR review, timer). Each parks the session with a wake condition, and the scheduler wakes it when the condition fires or the TTL expires.

## Assessment 5: concurrency levels by presence

No agent tool surveyed changes agent count by user presence (`.agents/docs/research/presence-aware-concurrency.md`). T3 Code reads idle, lock, thermal and battery state only for its own polling, Claude Squad has a fixed limit of 10.
Prior art is volunteer computing: BOINC has "in use" and "not in use" profiles (default memory limit 50% in use, 90% idle), Folding@home treats display sleep, screensaver, login window or lock as idle and waits 1 to 20s before switching, then resumes from a checkpoint. macOS background scheduling asks jobs to finish the current step and pause.
Signals available on macOS without root: HID idle time, `pmset` assertions (caffeinate holds them, which hides real idleness), memory pressure level, `pmset -g therm`, battery. `taskpolicy -b -p <pid>` lowered a running process from priority 31 to 4 and `-B` restored it (M).
Adversarial points: memory, not agent count, is the binding constraint; lowering QoS is instant but frees no memory; idle time misses video calls and reading; provider quota may bind before the device does.
Position: three levels per device (focus, away, overnight). Drop a level immediately on user activity, raise only after the condition holds for a while (hysteresis). Memory pressure, heat and low battery can only lower the cap. On a drop, first lower QoS of background agents, then park the surplus at the next turn boundary; never kill a running turn. Alternatives kept: a memory budget that reserves more while present, or keep the count and only lower QoS while present.

## Assessment 6: harness priority and roles

Proposed config (not implemented): the user lists harnesses with a priority, roles, provider quota pool, allowed devices and a seed footprint. The scheduler applies pins, filters on role, quota and memory headroom, then ranks by role match, priority, quota headroom and footprint, and learns typical and worst-case RSS per harness from live sessions.
Role claims are mostly practitioner opinion: oh-my-opencode (now oh-my-openagent) routes Claude to planning and the main agent and GPT to deep work and plan review, without a cited benchmark. Only Aider's architect/editor mode (85% vs 79.7%) and Anthropic's research eval (+90.2% at about 15x tokens) publish numbers. Cognition's single-threaded agent argument, the MAST failure taxonomy and Anthropic's note that coding parallelises poorly push back.
Position: use roles as a scheduling tool (spread quota, cross-provider review, cheap exploration on light harnesses), not as a capability claim, and measure before trusting any role mapping.

## Assessment 7: how other orchestrators do it

Two reports cover 27 products from the landscape table the user shared plus Claude Squad, Vibe Kanban and Xum (`.agents/docs/research/orchestrators-landscape-a.md`, `.agents/docs/research/orchestrators-landscape-b.md`, table image in `.agents/docs/research/assets/`). The table's star counts and feature dots are stale or wrong in places (Orca 132.9k, T3 Code 71.4k; Supacode is FSL-1.1; Traycer's host is closed; OpenHands orchestration moved to `software-agent-sdk`).
None passes our gates as a whole orchestrator: Multica, Paperclip, QM and Paradev's cloud need Postgres or Redis; OpenClaw, Paseo, OpenChamber and Paperclip have open unbounded-memory bugs; Orca, bb, Nimbalyst and Traycer have open orphaned-process bugs; no desktop tool resumes every session after reboot by default.
No agent orchestrator parks agents when a cap is hit (only after idle time; outside agents, Hatchet evicts durable tasks by capacity, see `.agents/docs/research/observability.md`), throttles launches by provider quota, adapts limits to user presence, or publishes density benchmarks. Those remain our differentiators.
Patterns to copy:
- Park and wake: Cloudroom stops an agent after 30 minutes idle and resumes the same conversation on the next message, restarts only sessions with queued or recent work after reboot, and marks mid-turn work at crash time as unknown instead of resending it. T3 Code also stops idle sessions after 30 minutes and records decisions with pending side effects in one SQLite transaction.
- Session survival: Orchestrator.inc runs a detached ACP host per session so the agent outlives orchestrator restarts.
- Work as data: Paperclip's short runs with the next step stored as a row.
- Scheduling: OpenClaw lanes and bb's weighted queue with priority aging (every 15s in bb), Multica's one-claim-per-(issue, agent) rule as a per-repo cap, Cloudroom's start-rate limit and disk guard, Orca's per-dispatch retry, Ghostex's retry clock that ignores offline time.
- Locks: OpenHands file leases with a generation counter.
- Multi-device: Podium (each device keeps its own SQLite, one writer per record, hub merges on reconnect, CRDTs and sync engines rejected with reasons) and Emdash (device is source of truth) match our Assessment 2 and 3 positions.
- Quota: OpenChamber falls back to another account or model on provider limits.
- Reaper: drive it from our session store, not a UI's tab list.
Adoptable as libraries: Herdr (single Rust binary, one server per machine over SSH, 22MB idle and 0% CPU measured (M)) or zmx (MIT, 2.3k stars) as the M2 tmux fallback.

## Assessment 8: self-improvement

Report: `.agents/docs/research/self-improving-stack.md`. Every working loop (Karpathy's autoresearch, AlphaEvolve and OpenEvolve, GEPA) mutates one bounded artifact, scores it with an evaluator the loop cannot edit, and keeps or reverts. The 2026 evidence is cautionary: classical optimizers (CMA-ES, TPE) beat LLM agents on fixed numeric search spaces, evolved agents regress on previously solved tasks, the Darwin Godel Machine gamed its own check, and DGM or SICA runs cost USD 7,000 to 22,000. RSA (population aggregation) is proven on reasoning, unknown for repo-level coding. DeepSeek Harness makes everything a plugin with effects undone on unload, but has no metric-driven loop and runs agent-installed plugins in-process.
Position, four tiers:
- Immutable: durable store, safety gates, the bench, the metrics, the improvement loop itself.
- Numeric config (caps, presence thresholds, harness weights): Bayesian or bandit tuning, applied automatically, auto-revert on regression.
- Prompts and briefs: GEPA-style evolution behind a no-regression gate.
- Agent-written plugins: out of process, promoted only by a human.
Fitness is hard constraints from the bench plus several objectives, never one scalar. Promotion path: offline bench, replay of past tasks, shadow, one-device canary, each change a git commit with automatic revert. A live A/B on task success needs about 390 tasks per arm, months at personal volume, so task success comes from replay and only frequent metrics (wake latency, RSS) tune on live telemetry. First step: measure the bench noise floor.
This requires every module to sit behind the interfaces below, so the loop swaps implementations rather than editing source.

## Assessment 9: spike results (2026-11-22, VPS)

Four spikes ran on the VPS against the adapter contract and bench (`.agents/docs/restate-spike.md`, `.agents/docs/rivet-spike.md`, `.agents/docs/term-fallback-spike.md`, `.agents/docs/bench-v2.md`). All numbers are M on the shared VPS, load recorded in each result file. The Rivet queue-scenario numbers come from `bench/results-rivet-fill-vps.json` (the one-actor coordinator shim in `bench/adapters/rivet/`), added after the first Rivet spike, which covered only the session-store shape.

| | Our SQLite scheduler | Restate 1.8.1 | Rivet 3.1.1 (local fs) |
|---|---|---|---|
| Idle RSS, whole stack | 18.5MB | 532MB | 128MB |
| Enqueue median | 160ms (119ms in the noise run) | 169ms via shim, 22ms via curl | 270ms (215-270ms across runs, one-actor coordinator shim) |
| Throughput, 60 jobs | 8.6 jobs/s | 5.8 jobs/s | 4.3 jobs/s |
| kill -9 recovery | 14.5s | 3.5s | 10-20s restart |
| Caps, repo cap, tool park | pass | pass (park via sleep-poll, frees slot) | pass (cap 3, repo cap 1, tool lease park) |
| Global priority | pass | fail (planned upstream) | pass (9, 5, 1, 0) |
| 10,000 parked sessions | not yet measured | not measured | 1,489MB RSS, 24KB disk each |
| Wake latency | not yet measured | not measured | p50 5-6ms, p99 10.6ms at 10k |
| License | ours | BSL-1.1, internal use allowed | Apache-2.0 |
| Verdict | keep and extend | reject for M4 and M5, watch | borrow the design only |

Our scheduler under the new bench (`.agents/docs/bench-v2.md`): fixed overhead 18.5MB plus about 0.4MB per live session; with a 60MB-class harness about 14 live sessions per GiB. After kill -9 of the daemon mid-turn, 3 of 3 stub ACP sessions resumed via `session/load` with one duplicate turn each. Noise floor: enqueue cv 4.9%, cap makespan cv 1.0%, chaos recovery cv 0.07% (measured under load, redo on an idle machine).
Terminal fallback (`.agents/docs/term-fallback-spike.md`): stay on tmux (4.8MB idle, flat to 20 sessions, 10ms create, 7ms input/output roundtrip). Herdr idles at 46MB and needs a JSON client; zmx's per-session daemon model fits best architecturally but needs a structured wrapper and its RSS was not measured validly.
Gap found: when the daemon stops, ACP agents of in-flight jobs keep running (consistent with requirement 3), but a restarted daemon cannot re-adopt them; it orphan-kills and resumes via `session/load`, costing one duplicate turn. Re-adoption (as in Orchestrator.inc's detached ACP host) is the next design item for M2.
Process note: two spike agents were SIGKILLed during other sessions' kill -9 tests; the term-fallback bench now verifies PID ownership before signalling. Any kill test must do the same.

Conclusion: no candidate beats our own SQLite scheduler on the gates. The plan is glue plus borrowed designs: Rivet-style hibernate and wake for parked sessions, Restate-style suspension without holding a slot (we already have it), detached ACP hosts for re-adoption, and the remaining bench scenarios (park-density, wake-latency, harness-swap, partition, presence-drop, lock-contention) to measure each step.

## Assessment 10: outcome-driven jobs, time caps and agent self-awareness (2026-11-22)

Time cap per job: yes, and every job gets one. A job carries `max_runtime` (for example 15 minutes for a research question) and the machine config carries a default, so nothing is unbounded unless asked with `--max-runtime 0`. This is the `harness launch --box` rule moved into the scheduler, where it survives the session that launched it. The budget counts running time only, so a job parked on an await or a rate limit does not burn it, and the deadline is a column in SQLite (`deadline_at`), never daemon memory, so a kill -9 and restart still enforces it. On expiry the dispatcher sends ACP `session/cancel`, waits a grace period, then SIGTERM and SIGKILL on the process group, and the job ends as `timed_out`, a terminal status that is not retried. Built and merged (`feat/job-timecap`, `.agents/docs/timecap.md`): a forever agent with a 3s cap and 2s grace ends `timed_out` 4.2s after enqueue, its processes are gone 0.13s later and the slot is reused; after a daemon kill -9 the successor enforces the stored deadline 4.3s after the kill (M, VPS). The graceful path needs `fleet-acp` to forward `session/cancel` the way `bench/acp_client.py` now does. Not built yet: a warning before the deadline, and the CLI guard that refuses mutations when `FLEET_JOB_ID` is set.

Outcome-driven means the job states what done looks like (an output file, a commit, a PR) and the cap is the cost ceiling to get there. A timed out job is a result, not a failure to hide: it shows up in `fleet stats` and in the bench, and the Improver can learn from it (caps that always expire are mis-sized, prompts that always hang are bad).

Should agents read the dispatcher: yes, read-only, with identity via env. The daemon injects `FLEET_JOB_ID`, `FLEET_DEADLINE_AT`, `FLEET_MACHINE` and `FLEET_DB` at spawn. `fleet status --self` returns the job row (status, attempts, `waiting_on`, lease, deadline, runtime used and left) and `fleet stats` gives queue state. This closes the awareness loop at zero new infra: an agent can see it has 3 minutes left and write its summary, or see why it was parked. Adversarial points: an agent that can read the queue can also be prompted to act on it, so when `FLEET_JOB_ID` is set the CLI should refuse mutating commands (cancel, reprioritize, enqueue) unless an explicit allowance exists (for example a fan-out role that may enqueue children with a parent id). An MCP wrapper of the same read commands is optional and comes later; the CLI works in every harness today.

## Assessment 11: worktrees are not ours to enforce

T3 already creates and binds worktrees per thread (`workspaceStrategy`), and Orca has its own. Fleet should not duplicate that. The Workspace module is an interface (`prepare(job) -> cwd`, `release`, `describe`) with T3 as the default implementation when a job comes through T3, a pass-through implementation (use the given cwd as is) when standalone, and a plain `git worktree add` implementation only as a fallback for headless queue jobs. The scheduler keeps one thing: repo leases must key on the repository, not the worktree path, so two worktrees of one repo still share `repo:<name>` caps. `project_key` (src/fleet/queue.py) does not do this today: it looks for a `.git` directory, but in a worktree `.git` is a file, so a job in any worktree under `~/.worktrees` walks up to `/` and every worktree job of every repo shares one key (too strict, never too loose). Fix: resolve with `git rev-parse --git-common-dir` (or read the `gitdir:` line) and key on the main repository, with a test for two worktrees of one repo and two different repos.

## Assessment 12: measurement policy and the benchmark as a regression gate

No cell stays n/a. Each one is either measured or recorded as "not expressible" with the reason. Density runs go 1,000 first and 10,000 only when 1,000 extrapolates inside the budget (Rivet: 1,489MB at 10,000 parked, which is the number to beat; in progress: spk-park for SQLite and Restate, spk-rivetfill for Rivet's queue cells).

The bench measures trade-offs, not only megabytes: state lost on kill -9 (jobs lost, jobs run twice, duplicate turns, leases leaked, fields that differ before and after), wake latency, timeout precision, and the noise floor that decides what counts as a change. `bench/compare.py` turns a results file into a pass or fail against a committed Linux baseline, and a GitHub Actions workflow runs the quick set on every PR (built and merged, `.agents/docs/bench-ci.md`). First `state-loss` result (M, VPS): kill -9 of the daemon with 6 jobs in flight loses 0 jobs and 0 leases, parked jobs keep `waiting_on`, the durable ACP session id survives, but all 4 running jobs run twice and the mid-turn ACP session repeats 1 turn. That repeated turn is what `.agents/docs/readoption-design.md` removes. The gate catches an injected cap violation, a 400ms enqueue and lost jobs. The baseline is from the VPS; the first GitHub runner run will show how far runner numbers drift. The workflow is written but nothing is pushed: fleet has no remote yet, and creating one is the user's call.

## Assessment 13: observability (2026-11-22)

Full report: `.agents/docs/research/observability.md`. Fleet needs no observability service. An `events` table in the existing `queue.db`, written in the same transaction as each state change, with per-level TTL plus a row cap and batched deletes, replaces `spawn_audit` and costs 278 bytes and 35µs per event (M, laptop under load). Always-on alternatives do not fit the memory budget (Temporal dev 147MB, Phoenix 614MB, Langfuse recommends 16GiB); viewers such as Datasette start on demand. On top of the table: alert rules evaluated in the daemon tick (dead jobs, crash loops, cap pressure, oldest queued, stale awaits, orphan leases, rate limits, hung agents, pending permission prompts, timeouts, low memory or disk), `fleet events`, `fleet tail -f`, `fleet why <id>`, `fleet health` and `fleet alerts` as JSONL, ntfy notifications keyed per alert with a dead man's switch, and an OTel export that is off by default. Rate limits and permission prompts park a job instead of burning an attempt. Prompt text is never recorded.

## Modules

| Module | Responsibility | Today | Interface |
|---|---|---|---|
| Connector | Reach other devices, publish device state, delegate work | T3 links over Tailscale | `connect`, `publish_state`, `delegate`, `read_remote` |
| Dispatcher | Start, prompt, cancel, resume a session on a harness | ACP, tmux fallback (spiked: stay on tmux) | `start`, `prompt`, `cancel`, `load`, `export_context` |
| Session store | Durable session records, TTL and GC | fleet SQLite, T3 threads | `put`, `get`, `park`, `wake`, `expire` |
| Scheduler | Queue, soft caps, priority, placement, park and wake | fleet daemon | `enqueue`, `admit`, `park`, `wake`, `stats` |
| Coordination | Locks, tool leases, rate limits, awaits | fleet toolcaps | `acquire`, `release`, `await`, `signal` |
| Workspace | Give a job a working directory (worktree, sandbox or plain cwd) and release it | T3 `workspaceStrategy` | `prepare`, `release`, `describe` |
| Context | Shared notes and handoffs across harnesses and devices | git, T3 threads | `append`, `read`, `handoff` |
| Control panel | Human view and control | T3 Code, Orca | consumes the modules above |
| Improver | Propose, evaluate, keep or revert config, prompts and plugins | none | `propose`, `evaluate`, `promote`, `revert` |

The rubric in `.agents/docs/tool-search-rubric.md` scores candidates per module, so a stack can combine several tools.
