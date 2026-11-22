# Orchestrators landscape B: how they orchestrate

Date: 2026-11-22 (ran `date`: Sun Nov 22 12:51 PST 2026). Scope: the open-source rows of `docs/research/assets/orchestrators-landscape-2026-11.png` plus extras with 1k+ stars, read for runtime mechanics, not features. Modules M1-M6 and gates G1-G7 as in `docs/orchestrator-framing.md` and `docs/tool-search-rubric.md`.

Evidence tags: M = measured by us, R = read in the project's own source or docs (shallow clones of `main` on 2026-11-22), B = blog or marketing, K = from memory, unverified. Issue references are R (issue tracker). Stars and release dates come from the GitHub API on 2026-11-22 (M). Unknown stays unknown.

Method: `gh api` for metadata, shallow clones into `/tmp/orch-src`, targeted reads of orchestration, persistence, process and concurrency code and docs, `gh issue list` for open issues about leaks, lost state and stuck sessions. No agent was started. Idle RSS was not measurable for any product without installing and running it, except the T3 runtime already running on this laptop.

## Corrections to the shared table

The table's star counts are stale or wrong for most rows (M, GitHub API, 2026-11-22):

| Product | Table | Real | Repo |
|---|---|---|---|
| Orca | 115k | 132,872 | [stablyai/orca](https://github.com/stablyai/orca) |
| T3 Code | 47k | 71,391 | [pingdotgg/t3code](https://github.com/pingdotgg/t3code) |
| bb | 4.9k | 5,890 | [get-bb/bb](https://github.com/get-bb/bb) |
| Maestro | 3.5k | 3,622 | [RunMaestro/Maestro](https://github.com/RunMaestro/Maestro) |
| Supacode | 2.4k | 2,400 | [supabitapp/supacode](https://github.com/supabitapp/supacode) |
| Synara | 1.6k | 2,282 | [Emanuele-web04/synara](https://github.com/Emanuele-web04/synara) |
| Nimbalyst | 2k | 2,096 | [nimbalyst/nimbalyst](https://github.com/nimbalyst/nimbalyst) |
| Cloudroom | 1.4k | 1,826 | [davidondrej/cloudroom](https://github.com/davidondrej/cloudroom) |
| Traycer | 1.7k | 1,769 | [traycerai/traycer](https://github.com/traycerai/traycer) |
| Ghostex | 1.4k | 1,723 | [maddada/Ghostex](https://github.com/maddada/Ghostex) |
| Sculptor | 245 | 285 | [imbue-ai/sculptor](https://github.com/imbue-ai/sculptor) |
| Podium | 10 | 51 | [madeinorbit/podium](https://github.com/madeinorbit/podium) |

Other corrections (R):
- Supacode is not under an OSI license. Its LICENSE is FSL-1.1-ALv2 (Functional Source License, converts to Apache 2.0 later) ([LICENSE](https://github.com/supabitapp/supacode/blob/main/LICENSE)). Flag under G6.
- Traycer is "open source" only for clients, CLI and protocol. "The Traycer Host and cloud backends are not here; the CLI provisions a signed host from GitHub Releases" ([AGENTS.md](https://github.com/traycerai/traycer/blob/main/AGENTS.md)). The part that orchestrates is closed.
- Synara "began as a clone of T3 Code" in March 2026 ([scripts/check-brand-identity.ts](https://github.com/Emanuele-web04/synara/blob/main/scripts/check-brand-identity.ts), [CHANGELOG.md](https://github.com/Emanuele-web04/synara/blob/main/CHANGELOG.md)). It still runs on port 3773 like T3 and uses `node:sqlite` with an Effect SQL client port.
- Cloudroom's desktop app is built on bb ([README](https://github.com/davidondrej/cloudroom/blob/main/README.md)); the orchestration piece is its own Rust core.
- Nimbalyst is the renamed Crystal ([stravu/crystal](https://github.com/stravu/crystal), 3,128 stars, last release v0.3.5 on 2026-02-26, description "(Crystal is now Nimbalyst)").
- Vibe Kanban (28,784 stars) is "sunsetting" and continues as community-maintained open source ([README](https://github.com/BloopAI/vibe-kanban/blob/main/README.md), [vibekanban.com/blog/shutdown](https://www.vibekanban.com/blog/shutdown)).
- `superset-sh/superset` now redirects to `ParadevAI/Paradev` (16,477 stars), the table's "Paradev" row; `ComposioHQ/agent-orchestrator` redirects to `OrchestratorInc/agent-orchestrator` (15,021 stars), the table's "Orchestrator" row; `coder/mux` is now `coder/xum` (2,081 stars) (M, GitHub API redirects). Paradev and Orchestrator are in the table but outside this brief, so not analyzed.

## Comparison table

Legend for columns: Process = how an agent runs. Cap = concurrency control on live agents. Durable = what survives kill -9 or reboot. Remote = multi-device model. Store = embedded storage engine.

| Product | License | Last release | Process model | Cap on live agents | Durable across kill -9 / reboot | Remote model | Store |
|---|---|---|---|---|---|---|---|
| Orca | MIT | v1.4.271, 2026-11-22 | PTY per agent in a separate terminal daemon; ACP and native chat adapters | Coordinator `maxConcurrent` default 4 per run; host terminal limit up to 4096 | PTYs survive app quit (daemon); scrollback checkpoints; agent exit shows a Restart chip | Paired Remote Orca Server over Tailscale; federated dispatch with relay and ack sequences | better-sqlite3 WAL |
| T3 Code | MIT | v0.1.12-nightly, 2026-11-22 | Provider adapters: Codex app-server, Claude Agent SDK, ACP, OpenCode, Pi | None on agents found; idle provider sessions stopped after 30 min | Event store + outbox in one SQLite tx; restart continuation (max chain 3) | Links over Tailscale/relay, one hop, `delegate_task` across machines; auto balance at thread creation | node:sqlite |
| Maestro | AGPL-3.0 | v1.1.1-RC, 2026-11-21 | Process per turn (Claude `--print`), PTY for terminals | Cue `max_concurrent` per session (default 1), bounded queue that drops oldest | Cue queue persisted, restored on start, stale entries dropped | Agents spawned over SSH remotes | better-sqlite3 WAL + JSON stores |
| bb | MIT | desktop-nightly, 2026-07-30 (main active) | Host daemon per machine runs provider processes (Codex app-server, Claude SDK, ACP bridge) | None on agents; weighted priority pools for git/gh only | Server SQLite is source of truth; daemon reconnects | Central server + enrolled host daemons over WebSocket | better-sqlite3 + Drizzle |
| Supacode | FSL-1.1-ALv2 | tip, 2026-02-11 (main active) | Terminal per worktree inside zmx session daemons | None | zmx sessions survive app quit; reboot unknown | SSH remote repos, zmx on host for reattach | Unknown (no SQLite found) |
| Nimbalyst | MIT | v0.84.3, 2026-11-21 | Claude Agent SDK, Codex app-server, ACP, OpenCode server | None on agents found | PGLite DB stores sessions and provider session ids | Cloud sync server for collab (separate project) | PGLite (Postgres in WASM, worker thread) |
| Traycer | MIT (clients only) | host-v1.5.4, 2026-11-13 | Closed Host; terminal agents in PTY with upstream session id | Unknown (host closed) | Resume by upstream session id on the original host | One Host per machine, cloud sync of Tasks | Unknown (host closed); Yjs in protocol |
| Synara | MIT | v1.6.5, 2026-11-21 | T3-derived provider adapters | None on agents found (MCP chats capped at 2, issue #1712) | node:sqlite, T3-style | Self-hosted server over Tailscale with token | node:sqlite |
| Cloudroom | Apache-2.0 | gui-v162, 2026-11-21 | Rust core next to each harness CLI; ACP, Codex app-server, Pi RPC | Startup queue at half the CPUs; no cap on running sessions | fsynced receipts; sleep after 30 min; restart relaunches only recent or queued sessions | Sandbox per cloud thread, teleport between Mac and cloud | File-based history (no DB crate) |
| Ghostex | MIT | v11.15.0, 2026-11-22 | Rust gxserver; zmx/wmx daemon per session; ACP | Unknown | zmx sessions outlive app; coordinators restore | Connected computers with held sends and relay | rusqlite |
| Sculptor | MIT | sculptor-v0.50.0, 2026-11-16 | Claude Code as stream-JSON process with control protocol; Pi; any terminal agent | Unknown | "Interrupted turn survives a quit or crash"; queue and questions persisted | None found | SQLite via SQLAlchemy + Alembic |
| Podium | Apache-2.0 | dev, 2026-08-25 (main active) | Daemon per machine; agent CLIs in durable `podium-host` PTYs (was abduco) | Unknown | Durable PTY host, SQLite oplog + outbox | Hub and nodes; daemons dial into a server; offline local agents | bun:sqlite |
| Claude Squad | AGPL-3.0 | v1.0.20, 2026-08-20 | tmux session per agent | Hard limit 10 instances | tmux survives app quit, not reboot; `state.json` | None | JSON file |
| Vibe Kanban | Apache-2.0 | v0.1.46, 2026-11-15 | Executors per harness incl. ACP | Unknown | SQLite | Relay crates; remote crate needs Postgres | sqlx SQLite (local), Postgres (remote) |
| Xum (ex Mux) | AGPL-3.0 | v0.32.5, 2026-11-22 | Own agent loop on Vercel AI SDK (not a CLI wrapper) | Workflow `maxParallel` | `chat.jsonl` per workspace | SSH runtime | JSONL files |

## Per-product notes

### Orca (stablyai/orca)

Process model (R): terminals and agent CLIs run in a separate terminal daemon (`src/main/daemon`), not as children of the Electron app. The daemon's AGENTS.md documents a socket ownership protocol built after "terminals that accept keystrokes and never run them" ([daemon/AGENTS.md](https://github.com/stablyai/orca/blob/main/src/main/daemon/AGENTS.md)). There is also an `acp/` adapter and per-provider directories in `src/main` ([src/main](https://github.com/stablyai/orca/tree/main/src/main)).

Concurrency (R): the orchestration `Coordinator` defaults `MAX_CONCURRENT_DEFAULT = 4` dispatched tasks per run, polls every 2s, and creates "at most one terminal per tick to avoid a spawn burst" ([coordinator.ts](https://github.com/stablyai/orca/blob/main/src/main/runtime/orchestration/coordinator/coordinator.ts)). A per-host terminal limit is stored in `~/.orca/host-settings/<hash>/terminals.json`, max 4096 or the system PTY limit ([host-terminal-policy.ts](https://github.com/stablyai/orca/blob/main/src/main/daemon/admission/host-terminal-policy.ts), [terminal-limit-policy.ts](https://github.com/stablyai/orca/blob/main/src/shared/terminal/runtime-policy/terminal-limit-policy.ts)). No provider-quota throttle in the coordinator.

Storage (R): orchestration DB is better-sqlite3 with `busy_timeout=5000`, `auto_vacuum=INCREMENTAL`, WAL, `synchronous=NORMAL`, `journal_size_limit=8MiB`, `temp_store=MEMORY`; mutation receipts capped at 10,000 rows and 30 days ([orchestration-db.ts](https://github.com/stablyai/orca/blob/main/src/main/runtime/orchestration/db/orchestration-db.ts), [mutation-receipt-capacity.ts](https://github.com/stablyai/orca/blob/main/src/main/runtime/orchestration/db/mutation-receipts/mutation-receipt-capacity.ts)). Terminal history is file-based with checkpoints and cold restore ([daemon/history](https://github.com/stablyai/orca/tree/main/src/main/daemon/history)).

Remote Orca Server (R): one computer runs Orca and keeps "projects, worktrees, terminals, tabs, provider accounts, and agent sessions"; the laptop is a UI client. Recommended path is both desktop apps on the same tailnet, a per-client revocable token, agents "keep running when the client laptop sleeps". Headless `orca serve` exists. Beta ([remote-servers.mdx](https://github.com/stablyai/orca/blob/main/docs/site/content/docs/remote-servers.mdx)).

Federated workers (R): agents reach an agent on a paired server with `orchestration send --on <server>` ([orca-cli.md](https://github.com/stablyai/orca/blob/main/skill-guides/orca-cli.md)). Under the hood, `RuntimeOrchestrationFederation` runs one self-rescheduling relay per federated dispatch: 1s base, exponential backoff to 30s, "a failure never ends a relay, since an unreachable host or dispatch can come back", and acknowledgement checkpoints by sequence (`to_home_acknowledged_sequence`) ([federation-relay-scheduler.ts](https://github.com/stablyai/orca/blob/main/src/main/runtime/orchestration/federation/relay/federation-relay-scheduler.ts), [runtime-orchestration-federation.ts](https://github.com/stablyai/orca/blob/main/src/main/runtime/orchestration/federation/runtime-orchestration-federation.ts)). Federation pulls at most 6 pages per sync ([federation-sync.ts](https://github.com/stablyai/orca/blob/main/src/main/runtime/orchestration/legacy-remote-home/federation-sync.ts)).

Durability (R): PTYs outlive app restarts through the daemon; an exited agent shows a Restart chip that "rehydrates the same agent with the same working directory" ([agents-sessions.mdx](https://github.com/stablyai/orca/blob/main/docs/site/content/docs/model/agents-sessions.mdx)). Native chat sessions do not survive an Orca restart yet ([#42611](https://github.com/stablyai/orca/issues/42611)).

Adversarial (R, open issues): "A live daemon never reaps detached agent PTYs, so idle sessions exhaust RAM (host cap does not evict)" ([#40261](https://github.com/stablyai/orca/issues/40261)); app updates leave old daemon generations running ([#9138](https://github.com/stablyai/orca/issues/9138)); Windows daemon exits when backgrounded, killing all PTYs ([#16797](https://github.com/stablyai/orca/issues/16797)); restart rehydrates dead PTY records without liveness check ([#21343](https://github.com/stablyai/orca/issues/21343)); a terminal with a startup command comes back as a bare shell after daemon loss ([#24152](https://github.com/stablyai/orca/issues/24152)). Orca keeps every agent live; it has no park state, which is exactly the failure #40261 describes.

Modules: M1 (federation relay), M2 (daemon + adapters), M3 (SQLite), M4 (per-run cap only), M5 (inbox, decision gates). Not a library: Electron app, 410MB shallow clone.

### T3 Code (pingdotgg/t3code)

Process model (R): provider packages for Codex app-server, ACP, OpenCode, Pi, Cursor and others ([packages](https://github.com/pingdotgg/t3code/tree/main/packages)); the server owns provider sessions in `ProviderSessionManager`.

Orchestration core (R): event-sourced. The V2 orchestrator "serializes commands and decides events without performing provider or filesystem work"; `EventSink` "commits events, persisted projections, the accepted command receipt, and outbox effects in one database transaction"; the effect worker performs side effects after commit; "effects tied to a lost provider process cannot simply replay; recovery retires them before admitting new work" ([overview.md](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md), [EffectOutbox.ts](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/EffectOutbox.ts)). Settled effects are kept 7 days; the event log keeps about a day for replay, after which projections are authoritative ([overview.md](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md)). Store is `node:sqlite` ([Sqlite.ts](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/persistence/Sqlite.ts)).

Park and wake (R): provider sessions have `DEFAULT_IDLE_TIMEOUT_MS = 30 min` and `DEFAULT_MAX_IDLE_PIN_MS = 4 h`, after which the session stops with reason `idle_timeout` ([ProviderSessionManager.ts](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/ProviderSessionManager.ts)). This is a time-based park, not a cap-driven one.

Queues and caps (R): queued runs interleave completions and messages by request time so neither starves the other ([QueuedRunOrder.ts](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/QueuedRunOrder.ts)). `DispatchModeLimit` caps runtime permission modes, not counts ([DispatchModeLimit.ts](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/DispatchModeLimit.ts)). I found no cap on live agents: the only `maxConcurrent*` hits are browsers (2), live commands (64) and device sessions ([HtmlRender.ts](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/htmlRender/HtmlRender.ts), [CommandOutputHub.ts](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/CommandOutputHub.ts)). Rate limits: `UsageLimitRecoveryWorker` re-arms a thread after a provider usage-limit window, max 24h overdue ([UsageLimitRecoveryWorker.ts](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts)).

Restart (R): `RestartContinuation` sends a continue prompt to runs a server restart cut short, at most 3 in a chain per 5 minutes so "a turn that keeps crashing the server" cannot loop ([RestartContinuation.ts](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/RestartContinuation.ts)).

delegate_task (R): always creates a child thread; `mode: "wait"` returns on result, timeout (does not cancel) or pending blocking question; with `next`, completion wakes the parent across restarts; requires an active parent run ([orchestrator-mcp-server.md](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/orchestrator-mcp-server.md), [remote-access.md](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md)).

Scheduled tasks (R): `ScheduledTaskService` with interval schedules and verified, deduplicated webhooks ([scheduledTasks](https://github.com/pingdotgg/t3code/tree/main/apps/server/src/scheduledTasks)); a generic `Scheduler` that waits for startup recovery before firing due work ([Scheduler.ts](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/scheduling/Scheduler.ts)).

Load balancing (R): auto balance is off by default, per-client preferences (Prefer, Normal, Less often, Manual only), checks CPU and memory once when choosing a draft's machine, existing threads never move, "links still do not chain" ([remote-access.md](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md)).

Footprint (M): the T3 runtime 0.1.10 on this laptop, with several live threads, showed processes of 863MB, 111MB, 18MB and a 4MB resource monitor (`ps`, 2026-11-22). Not idle, and includes the server's own caches, so not comparable to G2.

Adversarial (R): OpenCode adapter leaks exit listeners until an LXC host freezes ([#39121](https://github.com/pingdotgg/t3code/issues/39121)); ACP background tasks stuck RUNNING after kill or timer expiry ([#25599](https://github.com/pingdotgg/t3code/issues/25599)); hidden preview webviews stay alive (~2.7GB) until restart ([#15579](https://github.com/pingdotgg/t3code/issues/15579)). Placement happens once; there is no rebalancing or cap-driven queueing.

Modules: M1 (links, delegate), M2 (adapters), M3 (event store + projections), M5 (pending requests, usage-limit recovery). M4 partial (queue order, idle park). App, not a library; `packages/effect-acp` and `packages/effect-codex-app-server` are separate packages worth checking as libraries ([packages](https://github.com/pingdotgg/t3code/tree/main/packages)).

### Maestro (RunMaestro/Maestro)

Process model (R): each agent has an AI process and a terminal process; Claude Code runs in batch mode `--print --output-format json`, "process exits after response", stream-json when images are attached; PTYs via node-pty for terminals ([ARCHITECTURE.md](https://github.com/RunMaestro/Maestro/blob/main/ARCHITECTURE.md)). Tabs resume provider sessions ([ARCHITECTURE.md](https://github.com/RunMaestro/Maestro/blob/main/ARCHITECTURE.md)). Process-per-turn is a natural park: no process between turns.

Concurrency (R): the Cue event engine has `max_concurrent` per session (default 1), a self-overlap guard per subscription, a bounded `queue_size` where "when full, the oldest entry is dropped", staleness drop at `timeout_minutes`, chain depth max 10, and fail-open queue persistence in better-sqlite3 WAL ([CLAUDE-CUE.md](https://github.com/RunMaestro/Maestro/blob/main/CLAUDE-CUE.md)). Agent Resilience resends on 529 or quota, waiting for the reset time read from the error ([README](https://github.com/RunMaestro/Maestro/blob/main/README.md)).

Remote (R): SSH remotes per session (`sshRemoteId`) ([CLAUDE-SESSION.md](https://github.com/RunMaestro/Maestro/blob/main/CLAUDE-SESSION.md)). Shared context: Group Chat with a moderator agent, `@mention` consults that forward a conversation slice ([README](https://github.com/RunMaestro/Maestro/blob/main/README.md)).

Adversarial (R): dropping the oldest queue entry violates our "never dropped" requirement. Main process memory grows per Auto Run task ([#2084](https://github.com/RunMaestro/Maestro/issues/2084)); closing a busy tab leaves the process running and "dispatches starve in the queue" ([#1976](https://github.com/RunMaestro/Maestro/issues/1976)). AGPL-3.0 limits library reuse.

Modules: M2 (batch-mode spawn), M4 (Cue queue). Copy the self-overlap guard and staleness rules, not the drop-oldest policy.

### bb (get-bb/bb)

Process model (R): a central Server stores all state in SQLite and routes work to Host daemons over WebSocket; each enrolled machine runs a host daemon that "runs agent provider processes" ([system-overview.md](https://github.com/get-bb/bb/blob/main/docs/system-overview.md)). `packages/agent-runtime` has Codex and ACP topologies, resume and recovery tests ([agent-runtime/src](https://github.com/get-bb/bb/tree/main/packages/agent-runtime/src)).

Concurrency (R): no agent cap found, but a well-specified admission queue for git/gh: separate local and network pools, local slots `availableParallelism() - 2` clamped 4-6, network 4 with at most 2 `gh`, priority classes with reserved headroom, "an old waiter gains one priority level every 15 seconds", timeouts start at admission ([vcs-process-admission.md](https://github.com/get-bb/bb/blob/main/docs/vcs-process-admission.md)).

Remote (R): one server owns the DB; "while the server machine is asleep or off, nothing can reach bb and running threads may stop" ([multiple-devices.md](https://github.com/get-bb/bb/blob/main/docs/multiple-devices.md)). Fails our G4 for M1.

Adversarial (R): host process grew to 77GB RSS with orphaned dev processes ([#1660](https://github.com/get-bb/bb/issues/1660)); finished worker threads never stopped, leaking idle provider processes ([#2284](https://github.com/get-bb/bb/issues/2284)).

Modules: M2, M3. Worth copying: the weighted, aged-priority admission pools for M5 tool leases.

### Supacode (supabitapp/supacode)

Process model (R): native Swift app; "Sessions run inside zmx, a lightweight session daemon, not as children of the app"; remote SSH repos multiplex one SSH connection and reattach through zmx on the host; agent presence (busy, awaiting input, idle) through installed hooks ([README](https://github.com/supabitapp/supacode/blob/main/README.md)). CLI talks to the app over a Unix socket ([supacode-cli.md](https://github.com/supabitapp/supacode/blob/main/Resources/Skills/supacode-cli.md)).

zmx itself (M): [neurosnap/zmx](https://github.com/neurosnap/zmx), 2,292 stars, MIT, pushed 2026-11-18. Ghostex vendors and patches it too.

Caps, queues, shared context: none found. License FSL-1.1-ALv2 (R). Adversarial: worktree refresh creates gh process storms and 200+ load averages ([#830](https://github.com/supabitapp/supacode/issues/830)).

Modules: M2 fallback only. zmx is a candidate for our tmux fallback (single binary, per-session daemon).

### Nimbalyst (nimbalyst/nimbalyst)

Process model (R): providers are Claude Agent SDK, Codex app-server, ACP (Codex ACP, Copilot, Grok), OpenCode local server, Cursor headless NDJSON ([AI_PROVIDER_TYPES.md](https://github.com/nimbalyst/nimbalyst/blob/main/docs/AI_PROVIDER_TYPES.md)).

Storage (R): PGLite (Postgres in WASM) in a Node worker thread; `ai_sessions` row stores `provider_session_id` and JSONB messages ([DATABASE_SCHEMA.md](https://github.com/nimbalyst/nimbalyst/blob/main/docs/DATABASE_SCHEMA.md)). The collaboration sync server (`wss://sync.nimbalyst.com`, a Cloudflare Worker) "is a separate project" ([LICENSING.md](https://github.com/nimbalyst/nimbalyst/blob/main/LICENSING.md)).

Concurrency: none on agents found; a session write outbox has `maxConcurrent` 3 ([sessionWriteOutbox.ts](https://github.com/nimbalyst/nimbalyst/blob/main/packages/runtime/src/sync/sessionWriteOutbox.ts)).

Adversarial (R): orphaned Claude agent-SDK processes (PPID 1) accumulate so all MCP servers flap ([#738](https://github.com/nimbalyst/nimbalyst/issues/738)); tool output lost after dispatch ([#1425](https://github.com/nimbalyst/nimbalyst/issues/1425)); hundreds of orphaned git.exe from embedded Codex ([#1149](https://github.com/nimbalyst/nimbalyst/issues/1149)).

Modules: M3 only, and PGLite is heavier than SQLite for our budget (footprint unknown, not measured).

### Traycer (traycerai/traycer)

Scope (R): the repo holds clients, CLI and protocol; the Host and cloud backends are closed ([AGENTS.md](https://github.com/traycerai/traycer/blob/main/AGENTS.md)). So process model, caps and storage of the orchestrating part are unknown from source.

From docs (R): one Host process per machine owns folders, terminals, git and agents; Tasks sync through Traycer's cloud while "live work still runs on the host that started it"; offline states show whether the host or only the window holds unsynced changes ([hosts.mdx](https://github.com/traycerai/traycer/blob/main/mintlify/concepts/hosts.mdx), [sync-and-offline.mdx](https://github.com/traycerai/traycer/blob/main/mintlify/concepts/sync-and-offline.mdx)). Terminal Agents run in a PTY and resume by the stored upstream session id on the original host ([terminal-agents-vs-terminals.mdx](https://github.com/traycerai/traycer/blob/main/mintlify/concepts/terminal-agents-vs-terminals.mdx)). Agents can create children on other hosts, message each other, and "claim a role" ([agent-to-agent.mdx](https://github.com/traycerai/traycer/blob/main/mintlify/concepts/agent-to-agent.mdx)). The protocol has a host rate-limit schema ([protocol/src/host/rate-limit](https://github.com/traycerai/traycer/tree/main/protocol/src/host/rate-limit)) and depends on Yjs ([protocol/package.json](https://github.com/traycerai/traycer/blob/main/protocol/package.json)).

Adversarial (R): host crash loop on V8 OOM with shrinking intervals ([#2366](https://github.com/traycerai/traycer/issues/2366)); memory grows until OOM because the idle sweep skips leased epics, plus stuck cloud outbox ([#3429](https://github.com/traycerai/traycer/issues/3429)); users ask for a per-host memory ceiling ([#2710](https://github.com/traycerai/traycer/issues/2710)).

Modules: none adoptable (host closed). Fails G6 for the orchestration part.

### Synara (Emanuele-web04/synara)

T3 Code clone from March 2026 (R, see corrections). Differences found: an `agentGateway` with `sessionLease` (capabilities derived from session-start facts) and "Hub" work routing where the server freezes a coordinator-proposed task key so a retry "still addresses the same worker instead of forking a second one" ([sessionLease.ts](https://github.com/Emanuele-web04/synara/blob/main/apps/server/src/agentGateway/sessionLease.ts), [hubWorkRouting.ts](https://github.com/Emanuele-web04/synara/blob/main/apps/server/src/agentGateway/hubWorkRouting.ts)). Remote is a self-hosted server bound to the tailnet with an auth token ([REMOTE.md](https://github.com/Emanuele-web04/synara/blob/main/REMOTE.md)).

Adversarial (R): MCP clients can run only 2 chats at once and finished chats block new ones forever ([#1712](https://github.com/Emanuele-web04/synara/issues/1712)); provider session failures including resume without rollout and lost state ([#1987](https://github.com/Emanuele-web04/synara/issues/1987)).

Modules: same as T3. Copy the idempotent task key idea for M4 dispatch.

### Cloudroom (davidondrej/cloudroom)

Process model (R): a Rust core (axum + tokio, no DB crate in Cargo.toml) runs next to each harness CLI, "the harness keeps its agent loop, tools, and login; core keeps the sandbox, the process, the queue, the recorded history, and recovery" ([README](https://github.com/davidondrej/cloudroom/blob/main/README.md), [core/Cargo.toml](https://github.com/davidondrej/cloudroom/blob/main/core/Cargo.toml)). Harnesses: Codex app-server, Pi `--mode rpc`, OpenCode/droid/OpenClaw over ACP, Cursor print mode ([harnesses.md](https://github.com/davidondrej/cloudroom/blob/main/core/docs/harnesses.md)).

Park and wake (R): "After 30 minutes without activity, Core stops the session's harness process and marks it `sleeping`. History stays on disk." The next prompt resumes the same native conversation. "Restart relaunches only sessions with queued work or activity in the last 30 minutes ... so a reboot does not refill memory" ([session-lifecycle.md](https://github.com/davidondrej/cloudroom/blob/main/core/docs/session-lifecycle.md)).

Durability (R): queued prompts are acknowledged from one fsynced receipt, idempotent by request id; unfinished dispatched work becomes `unknown_after_restart` and "is never resent"; one recovery attempt after unexpected exit, then `process_lost`, no restart loop ([session-lifecycle.md](https://github.com/davidondrej/cloudroom/blob/main/core/docs/session-lifecycle.md)).

Concurrency (R): "New and restored harnesses share a startup queue. At most half the available logical CPUs (minimum one) initialize concurrently; this does not cap running sessions" ([session-lifecycle.md](https://github.com/davidondrej/cloudroom/blob/main/core/docs/session-lifecycle.md)). Disk guard with hysteresis: warn at 5GB, freeze agents under 2GB, resume above 2.5GB, kill the top disk writer after 30s ([storage.md](https://github.com/davidondrej/cloudroom/blob/main/core/docs/storage.md)).

Adversarial (R): "Shared-sandbox fan-outs can OOM-kill the parent's own harness: no admission control" ([#65](https://github.com/davidondrej/cloudroom/issues/65)); queued messages stay `thread-busy` on idle threads ([#147](https://github.com/davidondrej/cloudroom/issues/147)); thread stuck after missing native conversation ([#82](https://github.com/davidondrej/cloudroom/issues/82)).

Modules: M2 and M3 by design, M4 park/wake. Closest public reference for our parked-session model. Core is a single Rust binary with an HTTP API ([api.md](https://github.com/davidondrej/cloudroom/blob/main/core/docs/api.md)); whether it runs outside a sandbox as a local daemon on macOS is unverified (setup targets Ubuntu 24.04).

### Ghostex (maddada/Ghostex)

Process model (R): Rust `gxserver` (axum, tokio, rusqlite); session daemons are zmx (POSIX, WSL) and wmx (Windows ConPTY), with a `WIRE_GENERATION` contract so old daemons keep serving sessions across app updates ([AGENTS.md](https://github.com/maddada/Ghostex/blob/main/AGENTS.md), [server/Cargo.toml](https://github.com/maddada/Ghostex/blob/main/server/Cargo.toml)). ACP module present ([server/src/acp](https://github.com/maddada/Ghostex/tree/main/server/src/acp)).

Coordination (R): Coordinators manage threads across machines (`coordinator_remote_runtime.rs`, `connected_computers/held_sends.rs`, `coordinators/auto_sleep.rs`, `sleep_threads.rs`, `stopped_by_restart.rs`) ([server/src/server](https://github.com/maddada/Ghostex/tree/main/server/src/server), [coordinators](https://github.com/maddada/Ghostex/tree/main/server/src/coordinators), [connected_computers](https://github.com/maddada/Ghostex/tree/main/server/src/connected_computers)). Report delivery gives up after 10 minutes of failures while online, "and never gives up while it is offline: time offline or away doesn't count" ([coordinator_report_retry.rs](https://github.com/maddada/Ghostex/blob/main/server/src/server/coordinator_report_retry.rs)).

Caps: unknown. Adversarial: few open issues found, mostly UI ([#714](https://github.com/maddada/Ghostex/issues/714), [#688](https://github.com/maddada/Ghostex/issues/688)).

Modules: M1 (held sends), M2 fallback (zmx). Copy the offline-aware retry clock.

### Sculptor (imbue-ai/sculptor)

Process model (R): Claude Code "as a streaming JSON process with its control protocol enabled", Pi integrated, any terminal agent supported; "An interrupted turn survives a quit, or a crash of Sculptor itself"; queue and pending questions persist across reloads ([integrated_harnesses.md](https://github.com/imbue-ai/sculptor/blob/main/docs/help/integrated_harnesses.md)). Workspaces are worktrees by default, or full clones ([workspaces.md](https://github.com/imbue-ai/sculptor/blob/main/docs/help/workspaces.md)). Backend Python FastAPI, SQLAlchemy + Alembic on `~/.sculptor/database.db` ([sculptor/pyproject.toml](https://github.com/imbue-ai/sculptor/blob/main/sculptor/pyproject.toml), [bump_migrations.py](https://github.com/imbue-ai/sculptor/blob/main/sculptor/sculptor/scripts/bump_migrations.py)). Docker providers exist in environment_service ([sculptor/pyproject.toml](https://github.com/imbue-ai/sculptor/blob/main/sculptor/pyproject.toml)).

Caps, remote, locks: none found. The README says it is not yet taking external contributions ([README](https://github.com/imbue-ai/sculptor/blob/main/README.md)). Modules: M2 reference for Claude control-protocol integration only.

### Podium (madeinorbit/podium)

Process model (R): `apps/daemon` on each dev machine "wraps agent CLIs and streams PTYs"; harnesses run in durable `podium-host` PTYs (older sessions on abduco are still adopted) ([ARCHITECTURE.md](https://github.com/madeinorbit/podium/blob/main/ARCHITECTURE.md), [SPEC.md](https://github.com/madeinorbit/podium/blob/main/docs/SPEC.md), [data-and-upgrades.md](https://github.com/madeinorbit/podium/blob/main/docs/data-and-upgrades.md)). Each server owns a janitor worker thread, not a separate process ([ARCHITECTURE.md](https://github.com/madeinorbit/podium/blob/main/ARCHITECTURE.md)).

Topology and durability (R): "daemons dial into a server; clients dial into a server; nodes dial into a hub". Every node keeps SQLite + oplog + outbox; with the hub unreachable "the desktop keeps working against its local agents"; sending to an unreachable agent is a pending state, not an error ([offline-sync-architecture.md](https://github.com/madeinorbit/podium/blob/main/docs/offline-sync-architecture.md)). Writes: outbox with client-generated idempotency ids, drained on reconnect; reads: oplog with server sequence and `changesSince(cursor)`; conflicts: "writer authority for daemon-observed rows (session state has exactly one legitimate writer)", per-field LWW for user-authored rows ([offline-sync-architecture.md](https://github.com/madeinorbit/podium/blob/main/docs/offline-sync-architecture.md)). It rejected Turso sync, Replicache, Zero/ElectricSQL/PowerSync, Dexie, CRDTs as backbone and LanceDB with reasons ([offline-sync-architecture.md](https://github.com/madeinorbit/podium/blob/main/docs/offline-sync-architecture.md)). OSS core and hub, closed cloud module ([offline-sync-architecture.md](https://github.com/madeinorbit/podium/blob/main/docs/offline-sync-architecture.md)).

Caps: unknown. Shared context: a task system with subtasks and dependencies that agents operate ([README](https://github.com/madeinorbit/podium/blob/main/README.md)). Issues: none matched the search (issue tracker may be little used). 51 stars, young; "dev" is the only release tag (2026-08-25), main active.

Modules: M1, M3, M6 design. Its sync design is the closest match to our Assessment 2 and 3 and independently reaches the same conclusions (single writer per device, no CRDT for state).

### Extras (1k+ stars, not in the table)

Claude Squad ([smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad), 8,849 stars, AGPL-3.0, v1.0.20 on 2026-08-20): one tmux session per agent (`tmux new-session -d -s claudesquad_<name>`), history-limit 10000 ([tmux.go](https://github.com/smtg-ai/claude-squad/blob/main/session/tmux/tmux.go)); `GlobalInstanceLimit = 10` refuses creation beyond 10 ([app.go](https://github.com/smtg-ai/claude-squad/blob/main/app/app.go)); state in `state.json` ([state.go](https://github.com/smtg-ai/claude-squad/blob/main/config/state.go)); a detached daemon only runs AutoYes ([daemon.go](https://github.com/smtg-ai/claude-squad/blob/main/daemon/daemon.go)). Adversarial: prompt sent before the CLI is ready is lost ([#266](https://github.com/smtg-ai/claude-squad/issues/266)); Bubble Tea input races tmux attach ([#325](https://github.com/smtg-ai/claude-squad/issues/325)). Modules: M2 tmux fallback reference.

Vibe Kanban ([BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban), 28,784 stars, Apache-2.0, v0.1.46 on 2026-11-15, sunsetting): Rust; executors for ACP, Claude, Codex, Cursor, OpenCode and others ([executors](https://github.com/BloopAI/vibe-kanban/tree/main/crates/executors/src/executors)); local store sqlx SQLite with preupdate hooks ([db/Cargo.toml](https://github.com/BloopAI/vibe-kanban/blob/main/crates/db/Cargo.toml)); the `remote` crate uses Postgres ([remote/Cargo.toml](https://github.com/BloopAI/vibe-kanban/blob/main/crates/remote/Cargo.toml)), failing G1 for remote. Adversarial: Claude executor never signals completion, sessions stuck running ([#2495](https://github.com/BloopAI/vibe-kanban/issues/2495)); memory leak with long sessions ([#3352](https://github.com/BloopAI/vibe-kanban/issues/3352)). Modules: M2 (Rust executors), maintenance risk.

Xum, ex Mux ([coder/xum](https://github.com/coder/xum), 2,081 stars, AGPL-3.0, v0.32.5 on 2026-11-22): its own agent loop on the Vercel AI SDK ([package.json](https://github.com/coder/xum/blob/main/package.json)), local, worktree and SSH runtimes ([README](https://github.com/coder/xum/blob/main/README.md)), `~/.xum/sessions/<workspace>/chat.jsonl` with self-healing load ([docs/AGENTS.md](https://github.com/coder/xum/blob/main/docs/AGENTS.md)), workflow fan-out with `maxParallel` ([WorkflowRunner.ts](https://github.com/coder/xum/blob/main/src/node/services/workflows/WorkflowRunner.ts)). It is a harness, not an orchestrator of external CLIs; out of scope for M2.

Crystal: superseded by Nimbalyst (see corrections). Uzi ([devflowinc/uzi](https://github.com/devflowinc/uzi)) has 584 stars and no commits since 2025-06-04 (M), below the 1k bar and stale.

## Module map

| Product | M1 connector | M2 dispatcher | M3 session store | M4 scheduler | M5 coordination | M6 context | Adopt as library? |
|---|---|---|---|---|---|---|---|
| Orca | Federation relay to paired servers | Daemon PTYs, ACP | SQLite WAL, capped receipts | Per-run cap 4 | Inbox, decision gates, ask | Run messages | No (app) |
| T3 Code | Links, delegate_task | Adapters | Event store + projections | Queue order, idle park | Pending requests, usage-limit recovery | Context handoffs | Maybe `effect-acp`, `effect-codex-app-server` packages |
| Maestro | SSH spawn | Process per turn | JSON + SQLite | Cue queue | Resilience retry | Group chat | No (AGPL app) |
| bb | Server + host daemons | Agent runtime | SQLite | None | Git/gh admission pools | Manager threads | No |
| Supacode | SSH + zmx | zmx | Unknown | None | None | None | zmx (separate repo) |
| Nimbalyst | Cloud sync (separate) | SDK/ACP | PGLite | None | None | Wiki, tracker | No |
| Traycer | Cloud sync (closed) | Closed host | Closed | Unknown | Role claims | Shared task context | No |
| Synara | T3 links | T3 adapters | node:sqlite | Hub routing | Session lease | Mind memory | No |
| Cloudroom | Teleport, relay | Rust core | Files + fsynced receipts | Sleep/wake, startup queue | Disk guard | Child reports | Maybe core binary (unverified locally) |
| Ghostex | Connected computers, held sends | zmx/wmx | rusqlite | Auto sleep | Report retry | Coordinator boards | No |
| Sculptor | None | Claude control protocol | SQLite | None | Persistent questions | None | No |
| Podium | Hub/node outbox + oplog | Daemon + podium-host | bun:sqlite | Unknown | Unknown | Task graph | Design only |
| Claude Squad | None | tmux | JSON | Hard 10 | None | None | No |
| Vibe Kanban | Relay (remote needs Postgres) | Rust executors | sqlx SQLite | Unknown | Approvals | Kanban | Maybe executors crate, but sunsetting |

## Patterns worth copying

1. Time-based park with a reboot rule (Cloudroom, T3). Stop the harness after 30 minutes idle, keep history, resume the native conversation on the next event; on restart relaunch only sessions with queued work or recent activity, so "a reboot does not refill memory" ([Cloudroom session-lifecycle.md](https://github.com/davidondrej/cloudroom/blob/main/core/docs/session-lifecycle.md), [T3 ProviderSessionManager.ts](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/ProviderSessionManager.ts)). Neither ties park to a cap; our scheduler should park on both idle time and cap pressure.
2. Never resend in-flight work after a crash (Cloudroom). Queued work replays; dispatched work becomes `unknown_after_restart` and needs a human or a policy. One recovery attempt, then `process_lost`, no loops. T3's equivalent is a bounded restart continuation (3 per 5 minutes).
3. Intent, receipt and outbox in one transaction (T3, Podium). Commit the decision, the idempotency receipt and the side effect request together, perform effects after commit, retire effects bound to a lost process before admitting new work ([T3 overview.md](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md), [Podium offline-sync-architecture.md](https://github.com/madeinorbit/podium/blob/main/docs/offline-sync-architecture.md)).
4. Single-writer authority plus outbox and oplog for cross-device state (Podium). Device-observed rows have one writer; user-authored rows use per-field LWW; clients drain an idempotent outbox on reconnect and pull `changesSince(cursor)`. This confirms our M1/M6 position without a CRDT.
5. Relay per remote dispatch with capped backoff that never gives up, and acked sequences (Orca), plus an offline-aware retry clock that does not count time asleep or offline (Ghostex) ([Orca federation-relay-scheduler.ts](https://github.com/stablyai/orca/blob/main/src/main/runtime/orchestration/federation/relay/federation-relay-scheduler.ts), [Ghostex coordinator_report_retry.rs](https://github.com/maddada/Ghostex/blob/main/server/src/server/coordinator_report_retry.rs)).
6. Weighted admission with aging (bb). Separate pools per resource class, reserved headroom per priority class, one priority level per 15s of waiting, timeouts start at admission ([bb vcs-process-admission.md](https://github.com/get-bb/bb/blob/main/docs/vcs-process-admission.md)). Direct template for M5 tool leases and M4 per-key caps.
7. Startup throttle separate from the running cap (Cloudroom: half the CPUs initialize at once) and spawn smoothing (Orca: one new terminal per tick). Cheap protection against wake storms after a reboot.
8. Resource guards with hysteresis that pause instead of kill (Cloudroom disk guard 5/2/2.5GB). The same shape fits our memory-pressure and presence levels.
9. Queue hygiene from Maestro: self-overlap guard per trigger, staleness timeout recorded with a reason, fail-open persistence. Do not copy drop-oldest.
10. Session daemons for the tmux fallback: zmx ([neurosnap/zmx](https://github.com/neurosnap/zmx), MIT, 2.3k stars) used by Supacode and Ghostex, with a wire-generation contract so updates do not orphan sessions (Ghostex AGENTS.md). Orca's open issues (#9138, #40261) show what happens without generation handling and without reaping.
11. Idempotent task keys for coordinator retries (Synara hub routing): the server freezes the key so a retried plan addresses the same worker.

What nobody does (R, across all 15): park on cap pressure rather than idle time, throttle launches by provider quota (T3 and Maestro only recover after a limit hits), adapt caps to presence, or publish a density benchmark. Several have open issues about leaked or never-reaped agent processes (Orca #40261, bb #2284, Nimbalyst #738, Traycer #3429), which argues for a reaper keyed on our session store rather than on the UI's view of tabs.
