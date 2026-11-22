# Orchestrator framing

Date: 2026-11-22. Supersedes the "job queue for one machine" framing used in `docs/dbos-spike.md` and the first version of `docs/candidates-survey.md`.
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

Rivet's "7,242x more agents per server" is 512 MiB (E2B's default sandbox allocation, a limit, not measured use) divided by 72.4 KiB per Actor (R). Its own benchmark repo measured 314.6 KiB per actor plus 367 KiB on the backend, about 769x counted fully, and excludes a fixed overhead of 1 to 5.7 GiB. The "agent" is an idle Actor that answers a ping inside a shared process, with no model loop and no CLI harness (details in `docs/research/rivet-density-claim.md`). The number does not transfer to external harness processes, but the idea does: keep parked sessions cheap and outside any process.

Harness footprint varies by 6x, so harness choice is a scheduling input (`docs/research/harness-footprint-and-roles.md`, idle RSS after ACP `initialize`, M): maki 57MB and Codex app-server 59MB (Rust), Devin 107MB, Claude Code 237MB, Cursor 239MB, OpenCode 288MB, Kimi 355MB. MCP servers add about 241MB per Claude Code or Devin process. A live Claude Code turn measured 297 to 407MB, 598 to 613MB with children (M). Live RSS for the other harnesses is still unknown.

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

What T3 Code provides across devices (R, `docs/user/remote-access.md`):
- Threads live on the machine that runs them. There is no replicated thread store.
- Through a link you can read another machine's thread live and read-only, and `delegate_task` runs a task there and wakes the caller with the result, across restarts.
- Files, images and published visuals stay on the host machine.
- Links expire after 30 days unused and must be paired again.

So T3 gives cross-device delegation and visibility, not shared context. A context module needs its own store:
- Repo-scoped context: git (branches, notes, handoff files), already shared.
- Session-scoped context: the session record plus a transcript pointer, exported on handoff so a different harness can resume with a summary.
- Cross-agent messages and leases: an inbox with ack and advisory leases, as in MCP Agent Mail (R, see survey) or Orca's run inbox (R).

Research on beads, Gas Town and CRDTs (`docs/research/shared-context-crdt.md`): beads (`gastownhall/beads`) now stores everything in Dolt; its old git JSONL plus SQLite design survives in `Dicklesworthstone/beads_rust`. Its open issues (stuck merges over ssh, sibling children that cannot merge, silently dropped comments, migrations breaking cross-machine merges, unbounded Dolt memory, agent mode not engaging under Claude Code) argue for copying its data model (hash ids, claims, dependency graph, `supersedes` links, device-local leases) and not its implementation.
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

No agent tool surveyed changes agent count by user presence (`docs/research/presence-aware-concurrency.md`). T3 Code reads idle, lock, thermal and battery state only for its own polling, Claude Squad has a fixed limit of 10.
Prior art is volunteer computing: BOINC has "in use" and "not in use" profiles (default memory limit 50% in use, 90% idle), Folding@home treats display sleep, screensaver, login window or lock as idle and waits 1 to 20s before switching, then resumes from a checkpoint. macOS background scheduling asks jobs to finish the current step and pause.
Signals available on macOS without root: HID idle time, `pmset` assertions (caffeinate holds them, which hides real idleness), memory pressure level, `pmset -g therm`, battery. `taskpolicy -b -p <pid>` lowered a running process from priority 31 to 4 and `-B` restored it (M).
Adversarial points: memory, not agent count, is the binding constraint; lowering QoS is instant but frees no memory; idle time misses video calls and reading; provider quota may bind before the device does.
Position: three levels per device (focus, away, overnight). Drop a level immediately on user activity, raise only after the condition holds for a while (hysteresis). Memory pressure, heat and low battery can only lower the cap. On a drop, first lower QoS of background agents, then park the surplus at the next turn boundary; never kill a running turn. Alternatives kept: a memory budget that reserves more while present, or keep the count and only lower QoS while present.

## Assessment 6: harness priority and roles

Proposed config (not implemented): the user lists harnesses with a priority, roles, provider quota pool, allowed devices and a seed footprint. The scheduler applies pins, filters on role, quota and memory headroom, then ranks by role match, priority, quota headroom and footprint, and learns typical and worst-case RSS per harness from live sessions.
Role claims are mostly practitioner opinion: oh-my-opencode (now oh-my-openagent) routes Claude to planning and the main agent and GPT to deep work and plan review, without a cited benchmark. Only Aider's architect/editor mode (85% vs 79.7%) and Anthropic's research eval (+90.2% at about 15x tokens) publish numbers. Cognition's single-threaded agent argument, the MAST failure taxonomy and Anthropic's note that coding parallelises poorly push back.
Position: use roles as a scheduling tool (spread quota, cross-provider review, cheap exploration on light harnesses), not as a capability claim, and measure before trusting any role mapping.

## Assessment 7: how other orchestrators do it

Two reports cover 27 products from the landscape table the user shared plus Claude Squad, Vibe Kanban and Xum (`docs/research/orchestrators-landscape-a.md`, `docs/research/orchestrators-landscape-b.md`, table image in `docs/research/assets/`). The table's star counts and feature dots are stale or wrong in places (Orca 132.9k, T3 Code 71.4k; Supacode is FSL-1.1; Traycer's host is closed; OpenHands orchestration moved to `software-agent-sdk`).
None passes our gates as a whole orchestrator: Multica, Paperclip, QM and Paradev's cloud need Postgres or Redis; OpenClaw, Paseo, OpenChamber and Paperclip have open unbounded-memory bugs; Orca, bb, Nimbalyst and Traycer have open orphaned-process bugs; no desktop tool resumes every session after reboot by default.
Nobody parks agents when a cap is hit (only after idle time), throttles launches by provider quota, adapts limits to user presence, or publishes density benchmarks. Those remain our differentiators.
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

Report: `docs/research/self-improving-stack.md`. Every working loop (Karpathy's autoresearch, AlphaEvolve and OpenEvolve, GEPA) mutates one bounded artifact, scores it with an evaluator the loop cannot edit, and keeps or reverts. The 2026 evidence is cautionary: classical optimizers (CMA-ES, TPE) beat LLM agents on fixed numeric search spaces, evolved agents regress on previously solved tasks, the Darwin Godel Machine gamed its own check, and DGM or SICA runs cost USD 7,000 to 22,000. RSA (population aggregation) is proven on reasoning, unknown for repo-level coding. DeepSeek Harness makes everything a plugin with effects undone on unload, but has no metric-driven loop and runs agent-installed plugins in-process.
Position, four tiers:
- Immutable: durable store, safety gates, the bench, the metrics, the improvement loop itself.
- Numeric config (caps, presence thresholds, harness weights): Bayesian or bandit tuning, applied automatically, auto-revert on regression.
- Prompts and briefs: GEPA-style evolution behind a no-regression gate.
- Agent-written plugins: out of process, promoted only by a human.
Fitness is hard constraints from the bench plus several objectives, never one scalar. Promotion path: offline bench, replay of past tasks, shadow, one-device canary, each change a git commit with automatic revert. A live A/B on task success needs about 390 tasks per arm, months at personal volume, so task success comes from replay and only frequent metrics (wake latency, RSS) tune on live telemetry. First step: measure the bench noise floor.
This requires every module to sit behind the interfaces below, so the loop swaps implementations rather than editing source.

## Assessment 9: spike results (2026-11-22, VPS)

Four spikes ran on the VPS against the adapter contract and bench (`docs/restate-spike.md`, `docs/rivet-spike.md`, `docs/term-fallback-spike.md`, `docs/bench-v2.md`). All numbers are M on the shared VPS, load recorded in each result file.

| | Our SQLite scheduler | Restate 1.8.1 | Rivet 3.1.1 (local fs) |
|---|---|---|---|
| Idle RSS, whole stack | 18.5MB | 532MB | 128MB |
| Enqueue median | 160ms (119ms in the noise run) | 169ms via shim, 22ms via curl | n/a |
| Throughput, 60 jobs | 8.6 jobs/s | 5.8 jobs/s | n/a |
| kill -9 recovery | 14.5s | 3.5s | 10-20s restart |
| Caps, repo cap, tool park | pass | pass (park via sleep-poll, frees slot) | n/a |
| Global priority | pass | fail (planned upstream) | n/a |
| 10,000 parked sessions | not yet measured | not measured | 1,489MB RSS, 24KB disk each |
| Wake latency | not yet measured | not measured | p50 5-6ms, p99 10.6ms at 10k |
| License | ours | BSL-1.1, internal use allowed | Apache-2.0 |
| Verdict | keep and extend | reject for M4 and M5, watch | borrow the design only |

Our scheduler under the new bench (`docs/bench-v2.md`): fixed overhead 18.5MB plus about 0.4MB per live session; with a 60MB-class harness about 14 live sessions per GiB. After kill -9 of the daemon mid-turn, 3 of 3 stub ACP sessions resumed via `session/load` with one duplicate turn each. Noise floor: enqueue cv 4.9%, cap makespan cv 1.0%, chaos recovery cv 0.07% (measured under load, redo on an idle machine).
Terminal fallback (`docs/term-fallback-spike.md`): stay on tmux (4.8MB idle, flat to 20 sessions, 10ms create, 7ms input/output roundtrip). Herdr idles at 46MB and needs a JSON client; zmx's per-session daemon model fits best architecturally but needs a structured wrapper and its RSS was not measured validly.
Gap found: when the daemon stops, ACP agents of in-flight jobs keep running (consistent with requirement 3), but a restarted daemon cannot re-adopt them; it orphan-kills and resumes via `session/load`, costing one duplicate turn. Re-adoption (as in Orchestrator.inc's detached ACP host) is the next design item for M2.
Process note: two spike agents were SIGKILLed during other sessions' kill -9 tests; the term-fallback bench now verifies PID ownership before signalling. Any kill test must do the same.

Conclusion: no candidate beats our own SQLite scheduler on the gates. The plan is glue plus borrowed designs: Rivet-style hibernate and wake for parked sessions, Restate-style suspension without holding a slot (we already have it), detached ACP hosts for re-adoption, and the remaining bench scenarios (park-density, wake-latency, harness-swap, partition, presence-drop, lock-contention) to measure each step.

## Modules

| Module | Responsibility | Today | Interface |
|---|---|---|---|
| Connector | Reach other devices, publish device state, delegate work | T3 links over Tailscale | `connect`, `publish_state`, `delegate`, `read_remote` |
| Dispatcher | Start, prompt, cancel, resume a session on a harness | ACP, tmux fallback (spiked: stay on tmux) | `start`, `prompt`, `cancel`, `load`, `export_context` |
| Session store | Durable session records, TTL and GC | fleet SQLite, T3 threads | `put`, `get`, `park`, `wake`, `expire` |
| Scheduler | Queue, soft caps, priority, placement, park and wake | fleet daemon | `enqueue`, `admit`, `park`, `wake`, `stats` |
| Coordination | Locks, tool leases, rate limits, awaits | fleet toolcaps | `acquire`, `release`, `await`, `signal` |
| Context | Shared notes and handoffs across harnesses and devices | git, T3 threads | `append`, `read`, `handoff` |
| Control panel | Human view and control | T3 Code, Orca | consumes the modules above |
| Improver | Propose, evaluate, keep or revert config, prompts and plugins | none | `propose`, `evaluate`, `promote`, `revert` |

The rubric in `docs/tool-search-rubric.md` scores candidates per module, so a stack can combine several tools.
