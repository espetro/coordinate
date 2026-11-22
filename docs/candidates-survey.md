# Candidate survey

Evidence tags: M = measured by us (`bench/bench.py`), R = read in the project's own docs, B = blog or aggregator claim, K = from memory, unverified.
Unknown stays unknown. Nothing below was run except DBOS.

## Re-framed view by module (2026-11-22)

The requirements changed from "replace fleet's per-machine job queue" to an orchestration layer for agent sessions, split into modules M1 to M6 (`docs/orchestrator-framing.md`, rubric in `docs/tool-search-rubric.md`).
Under that framing, the question per candidate is which module it could own, not whether it replaces fleet.

| Candidate | License | Modules it could own | Main blocker | Fit |
|---|---|---|---|---|
| Restate | BSL-1.1 with an Additional Use Grant for internal use (R, LICENSE read in spike) | M4 scheduler (keyed limits per scope and limit key), M5 awaits (awakeables, durable promises), M3 (Virtual Object state per session key) (R) | Handlers run as an HTTP service, push model; idle RSS, parking semantics and license unverified | Spiked: rejected for M4 and M5 (532MB idle, no global priority), watch list (`docs/restate-spike.md`) |
| Rivet Actors (`rivet-dev/rivet`, 7k stars) | Apache-2.0 (R) | M3 and M4 in spirit: one hibernating Actor per session, 72KB per Actor, wake on demand, SQLite per Actor, scheduling (R) | Needs its Rust control plane plus object storage; a local filesystem backend exists "for trying Rivet on one machine" (R). Actors run agent loops in-process, our agents are external CLIs | Spiked: borrow the design only (128MB idle, 1.5GB at 10k parked actors, 3.1% idle CPU) (`docs/rivet-spike.md`) |
| Sandbox Agent (`rivet-dev/agents`, 1.7k stars for the repo) | Apache-2.0 (R) | M2 dispatcher: one HTTP API over Claude Code, Codex, OpenCode, Amp and Pi with unified events and sessions (B, landing page) | Overlaps ACP; runs as a server per sandbox | Compare against ACP as the M2 interface |
| Orca (`stablyai/orca`) | MIT (R) | Control panel, plus M4 and M5 patterns: Run inbox, Tasks, Dispatches, heartbeats, `worker_done` with dispatch ids, `ask`, decision gates, federated workers on other hosts, nested worker depth 4 (R) | A desktop app that owns its state, not a library; no concurrency caps found in the orchestration docs | Second control panel and the best reference for await tracking; check its CLI as an M1 or M4 driver |
| T3 Code | MIT (K) | Control panel, M1 connector (links, `delegate_task`, read-only remote threads), placement hint (auto balance by CPU and memory at thread creation) (R) | Links are one way and do not chain, threads are not replicated, no global caps (R) | Keep as M1 and the panel |
| MCP Agent Mail (Dicklesworthstone, Python and Rust versions) | unknown | M5 locks (advisory file leases with TTL, exclusive or shared, pre-commit guard), M6 messages (identities, inboxes, threads, Git plus SQLite) (R, repo descriptions) | Advisory only; star count and maintenance not checked | Candidate for M5 locks and M6 |
| beads (`gastownhall/beads`), Gas Town, Gas City | unknown | M6 context and M5 claims: hash ids, dependency graph, `supersedes`, claims (R) | Now Dolt-backed; open issues on stuck merges, dropped comments, unbounded Dolt memory, agent mode not engaging (R) | Copy the data model, not the implementation (`docs/research/shared-context-crdt.md`) |
| Herdr (52.3k stars) | unknown, check | M2 tmux fallback: single Rust binary owning terminals, one server per machine over SSH, 22MB idle (M) | No queue, no locks | Spiked: stay on tmux (46MB idle vs 4.8MB) (`docs/term-fallback-spike.md`) |
| zmx (2.3k stars) | MIT (R) | M2 tmux fallback | Not measured | Compare with Herdr |
| Cloudroom, Podium, Paperclip, Orchestrator.inc | various | Patterns only: park after idle and resume, single-writer device stores, work as rows, detached ACP host (R) | Postgres, closed parts or scope | Copy patterns (`docs/research/orchestrators-landscape-*.md`) |
| River OSS | OSS core, Pro paid (R) | M4 per device | Go rewrite, SQLite experimental, keyed limits are Pro | Weaker now: no park and wake, no awaits |
| OpenWorkflow | unknown | M4 later | No concurrency controls yet (R) | Watch |
| Absurd | Apache-2.0 (R) | M5 design ideas (first-emit-wins events, lease claims) | Postgres (R) | Reference only |
| DBOS | MIT | M4 | Measured: CLI latency, memory, per-partition priority, paid suspend (M) | Rejected |

What no candidate covers: soft global caps across devices with partition tolerance, provider quota rate limiting for agent launches, and resuming a session on a different harness. These stay our glue, and the planned bench scenarios in the rubric (`partition`, `harness-swap`, `park-density`) are where to measure them.

Proposed stack to test, per module:
- M1 connector: T3 links over Tailscale, kinosmac as hub (no change).
- M2 dispatcher: ACP, with Sandbox Agent evaluated as an alternative interface.
- M3 and M4: our SQLite scheduler, extended with parked sessions (Restate and Rivet spiked and rejected, see framing Assessment 9).
- M5: our own await records (Restate rejected), MCP Agent Mail style leases for files, our toolcaps for tools.
- M6: append-only, single-writer files per device synced through a bare git repo on kinosmac, with a beads-style data model; Automerge or Loro only for shared notes if concurrent edits prove real.
- Harness choice: priority, roles and learned footprint per harness (`docs/research/harness-footprint-and-roles.md`).
- Tmux fallback: stay on tmux.
- Improver: tiered self-improvement loop (`docs/research/self-improving-stack.md`).
- Caps: three presence levels per device (`docs/research/presence-aware-concurrency.md`).
- Panel: T3 Code, with Orca as a second client.

## Scheduler-only view (2026-11-21)

The rest of this document is the earlier survey, scored for the M4 scheduler module only. Its gate ids (G1 to G8, S1 to S12) follow the previous rubric version in git history (commit 8cf0ecd), not the current one.

### The framing problem

All five are step-replay workflow engines or queues built around code that runs inside the worker.
Fleet's unit of work is different: an external process (a shell command or an ACP coding agent) that runs for minutes to hours and is resumed by the agent's own `session/load`.
What fleet actually needs is a local durable queue with leases, per-key caps, a reaper and a cheap CLI.
Step replay, workflow versioning, serverless push and HA clusters are not requirements, and the spike showed they cost memory and latency.
So the question for each candidate is "how much of the queue and caps layer does it give us for free, and what does it cost on a 3 machine fleet with SQLite-sized budgets".

### Gate status

| Gate | DBOS | Absurd | OpenWorkflow | Restate | River |
|---|---|---|---|---|---|
| G1 no external server | pass (M) | **fail**, needs Postgres (R) | pass, SQLite via node:sqlite or bun:sqlite (R) | pass, single binary but a second process for handlers (R) | pass, Go library; SQLite driver experimental (R) |
| G2 local durable store | pass (M) | pass if Postgres is run locally | pass (R) | pass, fsync before ack, persistent volume required, no HA on one node (R) | pass (R) |
| G3 idle stack RSS under 200MB | pass, 82MB (M) | Postgres alone likely 50-100MB (K) | unknown, Node runtime (K) | unknown; "under 50MB idle" is a blog claim (B), plus our handler process | unknown; Go binaries are usually small (K) |
| G4 enqueue CLI under 300ms | **fail**, 2431ms (M) | unknown | unknown, `npx` CLI is likely slow (K) | unknown, HTTP call to ingress (R) | likely pass if the CLI is Go (K) |
| G5 machine cap plus per-repo cap | pass (M) | **no flow control** by design (R) | **fail**: per-worker concurrency only, concurrency controls listed as planned (R) | pass in principle: scope plus two-level limit key (R); counts only, no weights | partial: OSS has per-process MaxWorkers; global and partitioned limits are Pro (R) |
| G6 kill -9 recovery | pass, 2.7s (M) | pass, lease claims (R) | pass, workers resume unfinished work (R) | pass, journal replay (R) | unknown, rescuer exists (K) |
| G7 macOS and Linux | pass | pass | pass (Node 22.22+ or Bun) (R) | pass, single binary (R) | pass (K) |
| G8 license | MIT | Apache-2.0 (R) | unknown | runtime BSL per a 2024 comment (B), verify | OSS core open, Pro is paid (R) |

### Scored criteria that separate the candidates

| Criterion | DBOS | Absurd | OpenWorkflow | Restate | River |
|---|---|---|---|---|---|
| S1 global priority across keys | **fail** (M), per-partition only | not documented | planned (R) | planned (R) | pass: jobs fetched by priority then scheduled_at (R) |
| S2 park without holding a machine slot | **fail** (M), suspend is Enterprise | events suspend the task (R), but no caps to park on | child workflows free the worker slot (R) | unknown, must test | unknown; snooze may do it (K) |
| S3 weighted per-key cost | glue, 1 table | no | no | no, counts only (R) | no |
| S5 long job without checkpoints | pass | lease extends only on checkpoint or heartbeat call (R) | unknown | unknown, long HTTP stream per invocation (K) | unknown (K) |
| Own code removed from fleet | about 0 (still own queue.py) | n/a | small | medium: caps, queue, reaper | medium to large, but a Go rewrite |

### Per candidate notes

#### DBOS (measured)

See `docs/dbos-spike.md`. Wins crash recovery (2.7s vs 16.7s). Loses CLI latency (import 1.8s), memory, global priority, and parking holds a slot unless the paid Enterprise suspend mode is used.

#### Absurd (Earendil, Armin Ronacher)

One SQL file (1,685 lines per a blog count (B)) installs the engine into Postgres. Pull-based workers, thin SDKs for TypeScript, Python and an experimental Go one. Apache-2.0.
Task-level retries, steps as checkpoints, events and sleep, idempotency keys at spawn, cancellation policies (R).
The comparison page says it deliberately does not own flow control such as concurrency limits, throttling or prioritization (R).
Verdict: reject as a dependency, Postgres per machine is the wrong substrate and the logic lives in stored procedures so a SQLite port is a rewrite.
Keep as a design reference: lease claims extended on checkpoint writes, first-emit-wins events (a clean wake primitive for parked jobs), spawn-time idempotency keys, `maxDelay` cancellation when no checkpoint is written.

#### OpenWorkflow

TypeScript, Node 22.22+ or Bun, Postgres or SQLite. SQLite is documented for development, testing and "small-scale production with low throughput", which fits one worker per machine (R).
Concurrency is per worker only. The roadmap lists "Workflow priority and concurrency controls" as planned, and its own Inngest comparison says it cannot yet limit concurrency by customer or resource (R).
Verdict: not yet. The missing feature is exactly our core need and it is on their roadmap, so this is a contribution target rather than something to adopt now.

#### Restate

Single Rust binary with embedded storage, no external database. Handlers run as your own HTTP services that Restate invokes (push model), so a per-machine setup is two processes: the Restate server and our worker service (R).
Flow control is the closest native match found so far: concurrency limits per scope, plus a two-level `limit-key`, set through a rule book managed with `restate rules`. An invocation counts against every level it touches. Map machine cap to a scope and repo cap to a limit key (R).
Gaps: counts only (no cost weights), priorities and rate limits are listed as planned, and the docs do not say whether a suspended invocation releases its slot (R).
Single node has no HA, which is fine for a per-machine queue (R).
Open questions to test: idle RSS of server plus worker, `restate` CLI enqueue latency, parking semantics, hours-long invocations over one HTTP stream, and the exact license text (the fetch of the LICENSE file returned no text).
Verdict: best candidate for the next spike.

#### River

Go. Postgres first, SQLite since 0.23, officially experimental, about 10k jobs per second on a laptop (about a quarter of Postgres), single-connection pool plus WAL recommended (R).
Open source gives per-queue MaxWorkers per process. Pro (paid) adds global and local concurrency limits, partitioning by job args or kind, workflows and sequences. Limits build on normal priority ordering (R). Pro pricing was not retrieved.
With one daemon process per machine, MaxWorkers is exactly the machine cap. The repo cap needs Pro partitioning, or a workaround such as an in-worker gate that snoozes the job (K, verify).
Advantage nobody else has here: a Go CLI and daemon start in milliseconds, which removes the CLI latency problem that sank DBOS.
Costs: rewrite the 576 lines of queue and daemon in Go, SQLite experimental, Pro license question.
Verdict: second candidate for a spike, specifically the OSS-only configuration.

### Ranking against the scheduler rubric

1. Restate spike: tests native keyed caps and parking, the thing DBOS failed.
2. River OSS spike: tests latency, priority, and snooze-based parking.
3. Cheap win with no dependency: reap expired leases when the SQLite daemon starts, which captures most of the recovery gain DBOS showed.
4. OpenWorkflow: watch the roadmap, consider contributing concurrency controls.
5. Absurd: design reference only.
