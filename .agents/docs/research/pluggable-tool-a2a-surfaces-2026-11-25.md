# Pluggable tool-cap and agent-to-agent surfaces

Date: 2026-11-25 (ran `date`). Scope: whether coordinate benefits from two integration surfaces, each modular with a default implementation the user can replace or extend, and each useful both to sessions running as coordinate jobs and to sessions running outside the queue (incremental adoption). Surface one: tool-level concurrency control (vitest, tsc, rustc-class spawns that exhaust memory). Surface two: agent-to-agent messaging, in the style of agentrelay.com or the LF A2A protocol.

Evidence tags: (M) verified from code or a live experiment, (C) assessment or design recommendation.

## Verdict in one screen

Both surfaces are worth building, both are smaller than they look, and both should be built as *one daemon-owned lease/message core with thin, replaceable adapters at the edges* rather than as features of the scheduler. The adoption ladder is the design constraint: a user who never enqueues a single job must still get value from `coordinate` as (a) a standalone tool lease issuer for their interactive agent sessions, or (b) a local agent mailbox. The queue then becomes an optional better-integrated consumer of the same primitives, not a prerequisite.

Do not adopt the LF Agent2Agent protocol as the wire format; adopt its addressing model (stable agent identity plus agent card) as inspiration only. Do integrate or interoperate with Agent Relay (agentrelay.com) as an optional connector plugin, because it is open source, TypeScript, local-first capable, and already solves delivery-into-running-sessions for Claude Code and Codex. Do build the native mailbox (already planned as P2) first, because every a2a use case inside one device is a mailbox problem, not a protocol problem.

## Part 1: the tool surface

### What exists today

Tool slots exist only as static declarations: `coordinate enqueue --slot tool:vitest` lands in `payload.slots`, `slotKeys()` folds them into the lease keys at claim time, and the daemon holds them in `concurrency_slots` for the job's whole lifetime (M, `src/queue.ts:418-432`, `src/main.ts:27`). There is no spawn-time enforcement, no shim, no dynamic mid-job acquisition, no classifier (the port explicitly dropped tool-class matching, `src/queue.ts:2`). The full design for the in-queue version already exists in `toolcaps-design.md` (D1-D10) and its SoTA in `toolcaps-research.md`; this document does not re-litigate those decisions, it extends them to the pluggable, outside-the-queue case.

### Why the surface must be separate from the scheduler

The user's constraint "works with sessions outside coordinate" is actually forced by the threat model, not just by adoption marketing. The heavy memory churn on a machine comes from wherever agents run, and today most interactive sessions are T3 threads or manual shells that never touch the queue (C). A cap system that only governs enqueued jobs caps the minority. Meanwhile the enforcement layers doc already accepts this shape: layer 1 is a PreToolUse hook that works on any session of a hook-capable CLI, job or not, and layer 2 is PATH shims, likewise queue-independent (`.agents/docs/enforcement.md`). The tool surface is the same idea generalized from "refuse agent spawns" to "meter heavy tool spawns".

### The seam design (C)

Five seams, each with a default implementation, each replaceable by config alone:

```
spawn event -> [classifier] -> [policy] -> [acquire/lease core] -> [enforcement adapter]
                                          (concurrency_slots,
                                           SQLite, daemon-owned)
```

1. **Classifier**: maps a spawn (argv, cwd, env) to a tool class and cost, or to exempt. Default: built-in table shipped in the binary (vitest, jest, tsc, turbo, vite build, cargo build/test, rustc, go build/test, docker build, package-manager installs), keyed on resolved binary plus nearest git root, per D2/D4 of the toolcaps design. Replaceable: `[tools] classifier = "/path/to/cmd"` receives the spawn as JSON on stdin and answers `{class, cost}` or `{exempt: true}` on stdout, same process-boundary style as `forward --exec`. User rules extend rather than replace: user table is consulted first, built-in second.
2. **Policy**: given the class, decide acquire-and-proceed, block-wait with timeout, or refuse with a structured error. Default: per-class caps in `config.toml` with the settings table as the runtime-adjustable override, exactly like machine/repo caps already work. Replaceable: external policy command, same stdin/stdout contract, so a user can implement tenant fairness, time-of-day rules, or a team-wide server without forking coordinate.
3. **Lease core**: the only non-replaceable piece. `concurrency_slots` in SQLite, lease TTLs, fair FIFO per key with aging, ordered acquisition (repo before tool, D5), audit log of unmatched spawns (D9). This stays core-owned because durability and the wait-for graph are the product; the plugin boundary must not be able to corrupt lease state.
4. **Enforcement adapter**: how a spawn actually gets intercepted. Default and first to build: the PreToolUse hook adapter for hook-capable agent CLIs (Claude Code, devin), reusing the installed `coordinate-guard` pattern from `enforcement.md` — the guard already inspects commands and exits 2; the tool adapter inspects and either passes, blocks with a bounded wait, or refuses with an LLM-readable busy error (FrontMCP's busy-vs-broken pattern). Second: a PATH shim binary (`coordinate-shim` symlinked as `vitest`, `tsc`...) for shells and CLIs without hooks. Third, later: MCP middleware for agents whose tools flow through an MCP server, which the toolcaps research identified as the SoTA location (FrontMCP, Harper) and which is the only adapter that can cover in-process tool use that never spawns a process. All adapters are thin: they classify, ask the lease core, and map the answer onto their platform's refuse/pass mechanism.
5. **Acquisition transport**: adapters need to ask the lease core from inside an arbitrary shell. Default: direct SQLite access through the `coordinate` CLI itself (`coordinate lease acquire tool:vitest --project X --cost 2 --wait 30s`, exit code communicates grant/refuse/timeout), because the CLI already opens the DB in milliseconds (M, 4.9ms median enqueue, 7ms startup) and there is no daemon socket today. This is honest best-effort: SQLite write contention at agent scale is fine (the bench shows 69 jobs/s through the same path). Replaceable later: a daemon unix socket if profiling ever shows the CLI round-trip dominating, but the research says do not build the socket for this alone.

### Incremental adoption ladder (C)

| Rungs | What the user installs | What they get |
| --- | --- | --- |
| 1 | `coordinate` binary + one hook config or one shim symlink | Heavy-tool caps across all interactive sessions on the machine, audit log, `coordinate cap show`. No queue, no daemon required for acquire/refuse; daemon adds fairness aging and reaping |
| 2 | plus `coordinated` running | Lease reaping on TTL, wait queue fairness, events feed for observability |
| 3 | plus `coordinate enqueue` for batch work | Static slots at claim time unify with dynamic leases, parked jobs release capacity, the full toolcaps design |
| 4 | plus custom classifier/policy commands | Their rules, their fairness, no fork |

Rung 1 is the answer to the user's question: yes, the tool surface benefits users who never adopt anything else, and it is the strongest argument for the seam design, because it means the lease core must not depend on job rows. Leases need an owner concept that is `job:<id>` or `session:<external-id>` or `pid:<n>`, with the reaper treating non-job owners as TTL-only.

### What this changes in the existing toolcaps design

- D9's audit log moves from nice-to-have to load-bearing, because outside-the-queue adoption is precisely the population that never registers anything. The audit table is the tuning feedback loop (C).
- The open question in `toolcaps-design.md` ("whether T3-dispatched non-fleet sessions ever join the same lease space") is answered by this framing: yes, and it is the point. The global `/tmp/tsc.lock` flock era ends when rung 1 is installed (C).
- Jobserver integration (D8, passing a jobserver fd through) stays out of scope; no evidence anyone in the SoTA does it either.

## Part 2: the a2a surface

### Landscape (M, sources cited inline)

- **Agent Relay** (agentrelay.com, YC-backed, Apache-2.0, TypeScript, `github.com/agentworkforce/relay`, v18.x): a messaging layer for coding agents. Channels, threads, DMs, files, search, real-time events. Delivery model: `npx agent-relay init` installs hooks into Claude Code/Codex so sessions join a local server automatically and messages arrive inside running sessions as new turns. Hosted team workspaces or self-hosted; transcripts stay local in CLI-only mode. Also ships adjacent primitives: relayfile (integrations as a virtual filesystem), shared session capture, and flows (workflow enforcement in TypeScript). This is the closest living relative of coordinate's planned mailbox, but aimed at inter-agent chat across machines and teammates rather than durable execution.
- **LF Agent2Agent protocol** (ex-Google, Linux Foundation): passed 150 supporting organizations at its first anniversary in April 2026, with deep integration across Google, Microsoft and AWS platforms. It is a cross-organization interop RPC standard: agent cards, task lifecycle, JSON-RPC/gRPC. It solves trust and discovery across administrative boundaries, a problem coordinate does not have inside one tailnet.
- **MCP**: tool surface, not agent messaging; relevant only as one of the delivery adapters.
- Everything else in the academic/protocol space (NANDA, AGNTCY, IBM ACP) is either registry infrastructure or enterprise middleware, none of it local-first.

### What coordinate already is (M)

A careful look at the existing primitives shows coordinate is already an a2a substrate missing exactly three things:

- `wait-on`/`release` is agent-to-agent signaling with park/wake durability, but addressed to opaque event names, not to agents, and signals sent before the wait are lost (documented in the P2 plan).
- The events feed plus `forward --exec` is a broadcast bus any agent can tail, but it is one-way observability, not messaging.
- The P2 plan already specs `mailbox(job_id, kind, payload, dedupe_key, deliver_at)`: addressable per-job mailboxes, dead letters, wake-carries-data, timeouts, alarms as future messages. That is 80 percent of a local a2a system.

The missing three things: (1) stable agent addressing — today only jobs are addressable, and jobs are ephemeral while agents (in the user's mind) are long-lived identities like "the backend agent on the VPS"; (2) delivery into running sessions — a message must arrive as a prompt turn in a live ACP session or a hook-mediated turn in Claude Code/Codex, not just wake a parked job; (3) cross-device reach — the connector module is T3-only today.

### The seam design (C)

Same shape as the tool surface: one core, replaceable edges.

```
sender -> [address resolution] -> [mailbox core] -> [delivery adapter] -> recipient agent
                                   (SQLite mailbox table,
                                    dead letters, dedupe)
```

1. **Addressing**: names resolve to delivery targets. Default: `job:<id>` always works; `agent:<name>` is a row in a new `agents` registry table that any session (job or external) can claim with a heartbeat, mapping name to `{kind: acp-session|hook|external, target, device}`. Registration is one CLI call (`coordinate agent register --name backend --acp-session <id>`), so outside sessions self-enroll exactly like rung 1 of the tool ladder.
2. **Mailbox core**: the P2 mailbox table as spec'd, plus per-agent (not just per-job) mailboxes. Core-owned for the same reason as leases: dedupe, ordering, dead letters and TTL are the product. `coordinate send <addr> <message>` and `coordinate inbox [--self]` are the agent-facing verbs, NDJSON out.
3. **Delivery adapters**, replaceable per recipient kind: (a) ACP adapter, default for coordinate jobs — injects the message as the next prompt turn through the existing ACP lane, or parks it in the mailbox if the job is parked, which is the wake-carries-data path; (b) hook adapter for Claude Code/Codex sessions outside the queue — this is precisely what Agent Relay already built and open-sourced, so the adapter can be an optional dependency on their delivery mechanism rather than a reinvention; (c) relay adapter, the interop seam: forward messages addressed to `relay:<workspace>/<channel>` to an Agent Relay workspace through their CLI/SDK, and accept inbound webhooks or poll their event stream into local mailboxes. That is the whole integration with agentrelay.com: one adapter process, written against the same stdin/stdout process boundary as everything else.
4. **LF A2A interop**: explicitly deferred. If a future need appears (a user's agent must be callable by a corporate A2A client), the correct shape is a thin front-end adapter that exposes one coordinate agent as an A2A agent card plus task endpoint and translates task lifecycle onto mailbox messages. Building this now buys nothing locally; the addressing model is the only piece worth copying (C).

### Incremental adoption ladder (C)

| Rung | What the user installs | What they get |
| --- | --- | --- |
| 1 | `coordinate` binary | `send`/`inbox` between manually registered sessions on one machine; usable from any shell, any agent, no queue |
| 2 | plus `coordinated` | Durable delivery, dead letters, wake-on-message for parked jobs, cross-job signaling upgraded from opaque events to addressed mail |
| 3 | plus one adapter config | Delivery into non-coordinate Claude Code/Codex sessions, or bridging to a team Agent Relay workspace across machines |
| 4 | plus their own adapter command | Any transport: Slack, ntfy, MCP, their own relay. The contract is JSON on stdin |

### Why not just adopt Agent Relay wholesale

Evaluated seriously because it is open source and TypeScript (C). Reasons against as the core: it is a server plus cloud-workspace product whose durability model is not kill -9-clean local SQLite, its unit of identity is the session transcript rather than the durable job, and depending on it for the core would put a fast-moving external product inside coordinate's availability-over-consistency guarantee. Reasons for as an adapter: it is the only shipping implementation of hook-based delivery into running Claude Code/Codex sessions, it has the team/cross-machine story coordinate lacks, and the user explicitly asked. The seam design gets both: native local-first core, Agent Relay as a plug.

### Interaction between the two surfaces (C)

They share more than the seam shape. A refused tool lease should optionally deliver a mailbox message to the refusing session rather than only blocking its spawn, because busy-vs-broken is a messaging problem. The `agents` registry (a2a surface) doubles as the owner identity for non-job leases (tool surface). And both adapters install through the same mechanism: hook config snippets the user drops into their agent CLI settings. Build order should exploit this: lease core first (smaller, unblocks the OOM pain that motivated the question), then the mailbox core, then the delivery adapters, with Agent Relay interop last.

## Recommended build order

1. `coordinate lease acquire/release` verbs with non-job owners, the built-in classifier table, and one enforcement adapter (PreToolUse hook), plus the audit table. This is rung 1 of the tool ladder and kills the `/tmp/tsc.lock` flock pattern.
2. The P2 mailbox extended to per-agent addressing, `send`/`inbox` verbs, and the ACP delivery adapter (it is nearly free once the mailbox exists, since the ACP lane is built).
3. The hook-based delivery adapter for outside sessions, evaluating Agent Relay's open-source delivery mechanism as the implementation or the reference.
4. The relay adapter for cross-device/team interop.
5. LF A2A front-end only if external interop demand materializes.

Follow-up: the primitive abstraction and the N-sized lease/wait design are in `../surfaces-design.md` (2026-11-26).

## Bottom line

Both surfaces are the same architectural move applied twice: take the coordination primitives coordinate already owns (leases, mailbox, park/wake) and expose them through small, documented, process-boundary seams so that any session on the machine — queued or not — can meter its tools and message its peers. The default implementations cover vitest/tsc-class memory pressure and local agent messaging out of the box; the seams let users substitute their own classifier, policy, transport or relay without forking. Agent Relay is a complement to plug, not a dependency to adopt; LF A2A is a future adapter, not a foundation.
