# Tool concurrency caps — fleet design (v1, post-research)

Date: 2026-11-20
Research basis: [toolcaps-research.md](toolcaps-research.md) (SoTA + 7 adversarial POVs)
Supersedes: ad-hoc global flock locks (`/tmp/tsc.lock` etc.) and the "mandatory registration" phrasing from earlier discussion.

## Architecture

Agents run with **high caps** (MBP 6-8, laptop 3+, VPS 6+) — agents are cheap; the tooling they invoke causes OOM/contention. Tool runs are rate-limited at the **process-spawn boundary**; when a heavy tool hits its cap, the job **parks** (durable pause, worker process exits, state in SQLite) and the freed capacity dispatches other sessions. Fleet's park/resume via `session/load` is the mechanism — this is the durable-execution payoff.

Framing: agents = services; tools = dependencies with side effects; fleet = the harness providing rate limiters, queues, load balancing around them.

## Design decisions (each traces to an adversarial finding)

| # | Decision | Defends against |
|---|---|---|
| D1 | Enforcement at spawn shim inside job context (resolved binary path + cwd), not prompt-level | Bypass via generic `bash("npx vitest")`; prompt rules are advisory only |
| D2 | Lease key = `tool-class × project-dir` (resolved binary + nearest git root), never argv-exact | Attribution collisions/misses (`pnpm test` vs `npx vitest` must hit same class) |
| D3 | Weighted leases: config maps tool-class → slot cost (default 1; vitest/build classes can cost 2+) | Count-only limiting ignores resource weight (Temporal slot-supplier model) |
| D4 | Heavy classes only (vitest, tsc, cargo build/test, docker, package-manager installs); trivial tools (grep/cat/read) exempt — no lease round-trip | Latency: 0.1–2s acquire+resume dominates ms-class tool calls |
| D5 | Ordered acquisition: repo lease always before tool leases; global key order | Deadlock (circular wait between repo and tool leases) |
| D6 | Per-key fair FIFO + aging (Hatchet Group Round Robin model) | Starvation/priority inversion on contended keys |
| D7 | Park only at boundaries between tool runs, never mid-tool-call; mid-run caps mean "wait before next spawn", current tool finishes | Mid-tool-call pause kills 40-min suites (resume = rerun from scratch) |
| D8 | Respect tools' own jobserver/self-parallelism: fleet caps *cross-job* instances; inner parallelism stays with the tool (don't pass contradictory -j flags) | Double-capping (fleet:1 + vitest spawning 8 workers) |
| D9 | Registered by default, best-effort enforcement + **audit log of unmatched spawns** (daemon records unregistered heavy-binary spawns seen in job process trees) | Mandatory registration is unrealistic for LLM agents; audit makes misses visible and tunable |
| D10 | macOS: shim + process audit (no eBPF); Linux: same shim, optional cgroup accounting later | OS heterogeneity; eBPF non-portable to macOS |

## Mechanism in fleet terms

1. Job payload `slots` (already specced): static declarations for known-heavy work, e.g. `slots: ["vitest:proj"]`.
2. Spawn shim (`fleet-shim`, wraps the job's command env): on exec of a heavy class, calls the daemon over its local socket: `acquire(tool-class, project-dir, cost)`. Grant → proceed; cap reached → return "parked" with park reason.
3. On park-at-boundary: fleetd marks job `waiting`, writes resume handle (`session/load` id), worker exits → slot freed. On release (slot available, fair-FIFO), requeue → dispatcher resumes the session. Same path as existing park/resume.
4. Park-at-spawn-mid-run (tool already running when next heavy spawn hits cap): the shim *blocks* the spawn (bounded wait with timeout) instead of parking — the agent's turn continues once granted; timeout → structured error the agent can read (FrontMCP's "busy vs broken" pattern).
5. Audit log: daemon records every heavy-binary spawn observed in job trees (via shim accounting + process-tree scan at heartbeat), flags unmatched ones (no lease). Feeds cap tuning.

## What we deliberately do NOT build

- eBPF/ptrace enforcement (OS-fragile, unnecessary for best-effort + audit)
- Prompt-level-only enforcement (advisory, skippable)
- Weighted cost modeling from live CPU/RAM (Temporal-style slot suppliers) — static per-class costs first; revisit if caps misbehave
- MCP-gateway integration (our tools run as processes, not MCP calls, for now — revisit if fleet agents move tool access behind an MCP server)

## Open questions

- Default heavy-class list per machine (macOS vs VPS differ; config not code).
- Do package-manager installs (npm/pnpm/uv) get per-machine caps or per-project? (Cache contention suggests per-machine.)
- Whether T3-dispatched (non-fleet) sessions ever join the same lease space — for now, fleet-internal only; global flock stays for T3-thread-initiated heavy runs until proven necessary.

## References

- SoTA details and adversarial analysis: [toolcaps-research.md](toolcaps-research.md)
- FrontMCP rate/concurrency limits (queue-then-refuse, busy-vs-broken codes); Harper per-(session,tool) token buckets; Temporal resource slot suppliers (weighted via cgroups); Hatchet keyed concurrency + Group Round Robin + slot cost; River Pro partitioned limits
