# Rivet spike: results

Branch `spike/rivet` (worktree `~/.worktrees/fleet-spikes/rivet`). Measured 2026-11-22 on the shared VPS (Linux x86_64, 6 cores, 11.7 GB RAM, uptime 1d23h, three other spike sessions running; `free -m` available was 8.3 GB at the idle measurement and 6.7 GB at the 10k measurement). Raw numbers in `bench/results-rivet-vps.json`; adapter code under `bench/adapters/rivet/`.

## Setup and versions

| Part | Version | Notes |
|---|---|---|
| rivetkit (npm) | 3.1.1 | TS registry library, Apache-2.0 per package.json (M) |
| rivet-engine | 3.1.1 | Rust binary, v3 architecture, musl x64, pulled in as `@rivetkit/engine-cli-linux-x64-musl` (66 MB) (M) |
| bun | 1.4.3 | via mise shim (M) |
| rivet-dev/rivet repo | 6,973 stars, pushed 2026-11-22, LICENSE file is Apache-2.0 (M, GitHub API) |

License verified: `rivet-dev/rivet` reports `apache-2.0` from the GitHub API license object (which reads the LICENSE file), and the rivetkit package ships `"license": "Apache-2.0"` (M). No SSPL/BSL flags.

Local run shape: `RIVET_RUN_ENGINE=1 RIVET_RUN_SERVICES=0 RIVETKIT_STORAGE_PATH=<dir> bun src/server.ts`. The bun runner (rivetkit registry, one `session` actor type) spawns the Rust engine as a child process; the engine uses its local filesystem storage backend (log shard plus object store under `RIVETKIT_STORAGE_PATH`), no S3, no Postgres, no docker (M). The `session` actor exposes `init`, `park` (sets waitingOn, calls `c.sleep()`), `wake`, `status`, and `spawnDetached` which runs `/bin/sh -c CMD` detached in its own process group and records the pid/pgid in vars. In-memory per-session fields live in `createVars` vars; the create-input plumbing to `createVars` did not deliver the `getOrCreate` input in this runtime, so an explicit `init` action sets harness/sessionId/cwd (M).

## Process count (gate G1)

Two processes: the bun runner and rivet-engine. No external server, no database, no docker (M). G1 passes.

## Results table (all M on this machine, shared load, treat small deltas as noise)

| Metric | Value |
|---|---|
| Idle RSS, whole stack (0 actors, after 20s) | 128.3 MB (runner 70.5 + engine 60.8) |
| Idle CPU, 0 actors (20s /proc sample) | engine 3.11%, runner 0.05% |
| Disk floor, 0 actors | 134.3 MB store (engine provisions log shard + object store) |
| Create 1,000 parked actors | 9.0 s (110.7/s) |
| RSS after 1,000 parked (settled) | 414 MB total (runner 157 + engine 257) |
| Marginal disk per parked actor (1k) | 18.2 KB |
| Create 10,000 parked actors | 104.7 s (86/s) |
| RSS after 10,000 parked (settled ~3 min) | 1,489 MB total (runner 281 + engine 1,211; peak 1.69 GB during load) |
| Marginal disk per parked actor (10k) | 24.4 KB |
| Idle CPU at 10k parked (20s sample) | engine 3.26%, runner 0.0% |
| Wake p50 / p99, hibernated actor at 1k parked | 4.9 ms / 2,034 ms (3 of 40 samples were 1.3-2.0 s spikes; rest 3-19 ms) |
| Wake p50 / p99 at 10k parked | 6.4 ms / 10.6 ms (no spikes in that run) |
| kill -9 both processes, restart to healthy | ~10-20 s; actor identity and handles survive |
| Ephemeral actor vars after kill -9 | lost (reset to createVars defaults) |
| Spawned detached child after kill -9 of runner+engine | still running (own process group, verified pgid == pid) |

Notes: parked here means the actor called `c.sleep()` after `park`, i.e. a hibernated actor with no resident instance beyond its durable record. The 1.3-2 s wake spikes at 1k appeared in bursts (3/40) and did not reproduce in the 10k run; I did not isolate the cause (likely log-shard flush or tablet recovery timing), so p99 at 1k should be treated as bimodal. Engine RSS at 10k did not return to its 1k level even after several minutes of settle.

## Gates

| Gate | Verdict | Evidence |
|---|---|---|
| G1 no external server | pass | 2 processes, filesystem backend only (M) |
| G2 200-300 MB budget, ~0% idle CPU | fail | 128 MB idle is inside budget but 3.1% engine idle CPU is not ~0%; at 1,000 parked it is 414 MB and at 10,000 it is 1.49 GB, 5x over budget (M) |
| G3 state survives kill -9 | partial | actor identity and routing survive; the documented in-memory `vars` are lost by design, durable data belongs in per-actor SQLite (`c.db`), which this spike did not model, so full G3 is unverified (M) |
| G4 agents keep running when orchestrator dies | pass | detached spawned process kept running across kill -9 of runner and engine (M) |

## Scores

| Score | Value | Evidence |
|---|---|---|
| S1 park and wake | 3 | `c.sleep()` parks with no process and no slot; any action call wakes it; p50 5-6 ms (M) |
| S3 resume after orchestrator dies | 1 | identity survives, but session fields in vars are wiped on restart; durable resume needs the actor SQLite path plus our own schema, i.e. real glue on our side (M) |
| S12 published density benchmark | 2 | Rivet publishes a method-reproducible actor-vs-DO benchmark, but its headline 72.4 KB/actor is a Rust-SDK number whose raw samples are not published, and our measured marginal cost here was 18-24 KB disk plus ~100-130 KB engine RSS per parked actor, worse than the 314.6 KiB their own reproducible run reports (M; see `.agents/docs/research/rivet-density-claim.md`) |

## External agent processes in its model

Spawning and tracking OS processes works mechanically: an action can `spawn(..., {detached: true})`, record pid/pgid, and the child survives engine death, which is exactly the G4 shape we need (M). But it fits poorly as a session store: the pid and the whole session record lived in ephemeral vars and were lost on restart, so anything durable must be written to the actor's SQLite instead, and every session field becomes a schema plus migration. There is also no built-in notion of "reap this pid" or waitpid bridging across hibernation; the actor would have to poll or be woken by an external watcher, which is glue we would own. Rivet's density story (the 7,242x claim) is about in-process actors, not external CLI harnesses; our unit stays 0.6 GiB live regardless of how cheap the parked record is.

## Verdict

M3 session store: borrow the design only. The hibernate/wake primitive is excellent (single-digit-ms wake, no process while parked), but 24 KB disk and ~120 KB resident per parked session against a 1.2 GB engine at 10k sessions fails G2 by 5x, and durable session fields need our own SQLite schema anyway, at which point a plain row store gives the same thing for 25 MB total (the SQLite baseline in `.agents/docs/dbos-spike.md`).

M4 park/wake layer: reject as the standalone layer, adopt the pattern. If we ever need thousands of event-addressable parked sessions with sub-10 ms wake and cross-device placement, revisit with the Postgres or FoundationDB backend and a budget re-measure; on the local filesystem backend the engine's memory does not scale to our target.

## Open questions

- What causes the 1.3-2 s wake spikes seen in 3 of 40 samples at 1k parked (log-shard flush, tablet recovery, GC)? Not isolated.
- Does per-actor SQLite (`c.db`) survive kill -9 cleanly, and what is its size floor per empty actor? Unverified; would decide whether G3 passes fully.
- Would the engine's per-actor resident cost drop materially with more aggressive hibernation settings or an explicit eviction sweep? Untested.
- Cross-device: multiple runners against one engine over Tailscale was not exercised (out of scope for M3/M4 here).
- Engine idle CPU was 3.1-3.3% throughout; is that reducible via config (maintenance intervals)? Unchecked.
