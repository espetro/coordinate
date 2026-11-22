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

This is the same trick behind Rivet's numbers. The "~7K" on github.com/rivet-dev is the star count of the `rivet` repo, not an agent count (R). Rivet's actual density claim is 72KB RAM per Actor, 4.99ms p99 cold start, and "hundreds of thousands" per server, achieved by keeping the agent loop and state in a hibernating Actor and reaching the sandbox only through tools ("separating the head from the hands") (R, vendor benchmark with a published repo).

The defensible numbers we can publish are therefore:
- Parked sessions per device at a fixed orchestrator RSS, and storage per parked session.
- Wake latency: from event to a resumed harness producing its first token, p50 and p99, per harness.
- Live sessions per GB of device memory, per harness.
- Scheduler overhead: CPU and RSS at N parked and M live sessions.

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

## Assessment 4: tracking awaits, state of the art

Every system surveyed models a wait as a durable record plus a wake condition, so the waiter can release its resources:
- Durable promises and awakeables (Restate), signals and updates (Temporal), events with first-emit-wins (Absurd), suspended workflows waiting on a message (DBOS `recv`, suspend is Enterprise only) (R).
- Agent-specific, Orca (R): a Run with an inbox, Tasks, Dispatches (one attempt of a task), worker heartbeats every 1-60 minutes, `worker_done` exactly once with the task and dispatch ids so stale retries cannot complete the wrong attempt, `ask` for blocking questions, and decision gates that block a task until resolved.
- Locks: advisory file leases with a TTL, exclusive or shared, on file globs, with an optional pre-commit guard (MCP Agent Mail) (R). Our weighted tool leases (`toolcaps`) are the same idea for heavy commands.
- Rate limits: per-provider usage tracking is now in control panels (Orca shows limits and reset times) (R). None of the surveyed tools throttles agent launches by provider quota. That stays our glue.

For us, an await is one of: human (permission request or question), agent (subtask result), resource (lock, tool lease, rate limit), external (CI, PR review, timer). Each parks the session with a wake condition, and the scheduler wakes it when the condition fires or the TTL expires.

## Modules

| Module | Responsibility | Today | Interface |
|---|---|---|---|
| Connector | Reach other devices, publish device state, delegate work | T3 links over Tailscale | `connect`, `publish_state`, `delegate`, `read_remote` |
| Dispatcher | Start, prompt, cancel, resume a session on a harness | ACP, tmux fallback | `start`, `prompt`, `cancel`, `load`, `export_context` |
| Session store | Durable session records, TTL and GC | fleet SQLite, T3 threads | `put`, `get`, `park`, `wake`, `expire` |
| Scheduler | Queue, soft caps, priority, placement, park and wake | fleet daemon | `enqueue`, `admit`, `park`, `wake`, `stats` |
| Coordination | Locks, tool leases, rate limits, awaits | fleet toolcaps | `acquire`, `release`, `await`, `signal` |
| Context | Shared notes and handoffs across harnesses and devices | git, T3 threads | `append`, `read`, `handoff` |
| Control panel | Human view and control | T3 Code, Orca | consumes the modules above |

The rubric in `docs/tool-search-rubric.md` scores candidates per module, so a stack can combine several tools.
