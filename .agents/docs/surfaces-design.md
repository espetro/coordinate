# Surfaces design: one primitive core for sessions, tool runs and a2a endpoints

Date: 2026-11-26 (ran `date`). Builds on `research/pluggable-tool-a2a-surfaces-2026-11-25.md` (seam analysis and landscape) and `toolcaps-design.md` (D1-D10). This document defines the common abstraction the three surfaces share, the N-sized semaphore lease model with queued waits and cancellation, and the extension contract that lets users add surfaces of their own.

Evidence tags: (M) verified from code, (C) design recommendation.

## Why one abstraction

The three target surfaces turn out to be the same composition with different weights (C):

| | identity | capacity leases | input mailbox | lifecycle events | volatile |
| --- | --- | --- | --- | --- | --- |
| agent session (job) | long-lived, named | machine + repo + tool slots | prompts, wake messages | full job lifecycle | no: durable execution |
| tool run | ephemeral, per spawn | tool-class units | grant/refusal delivery | acquire, release, expire | yes: kills, interrupts, abandons |
| a2a endpoint | long-lived, named | optional inbox backpressure | messages | register, heartbeat, gone | no |

If each surface gets its own machinery the daemon triples in size and the semantics drift apart. If they share primitives, every improvement (aging, reaping, observability, TTL) lands on all three at once, and a user-defined fourth surface (say, a deploy lock or a GPU pool) is configuration plus adapter commands rather than a fork (C).

## The primitive core

Five primitives, all in the same SQLite database, all core-owned. Core-owned means the schema and the transactional invariants are not a plugin contract; plugins interact through the CLI and the adapter process boundary, never through direct SQL (C).

### 1. Entities: addressable owners with heartbeats

Today leases and waits can only be owned by rows in `jobs` (`concurrency_slots.job_id` is a foreign key, M `src/queue.ts:104-109`). That is the single limitation behind the user's note: everything that is not a queue job is invisible. The generalization is an `entities` table (C):

```
entities(
  id TEXT PRIMARY KEY,        -- 'job:17', 'pid:4821', 'agent:backend', 'session:<uuid>'
  kind TEXT NOT NULL,         -- 'job', 'process', 'agent', 'endpoint', user-defined kinds
  device TEXT NOT NULL,
  heartbeat_ts REAL,          -- null for entities that cannot heartbeat (one-shot processes)
  meta TEXT NOT NULL DEFAULT '{}',
  created_at REAL NOT NULL,
  expires_at REAL             -- hard TTL backstop for every entity
)
```

Ownership rules by kind (C):

- `job:<id>`: liveness is the job row itself; the daemon heartbeats it through the claim loop as today.
- `pid:<n>`: liveness is probed with `kill(pid, 0)` (plus start-time comparison where the platform allows; macOS has no pidfd, so a short TTL is the real guarantee).
- `agent:<name>` / `endpoint:<name>`: liveness is an explicit heartbeat the owner must refresh (`coordinate agent heartbeat` or implicit on any CLI call with `--self`), with a TTL in the tens of seconds.
- Registration is one CLI call and is open to any process on the machine, job or not. This is what makes rung 1 of the adoption ladder real.

### 2. Leases: N-sized weighted semaphores, not locks

The `concurrency_slots` table already has the right shape: rows keyed by `key` with a `cost`, and `slotLimit(key)` giving per-key N with wildcard support (M `src/config.ts:452-473`). What is missing is ownership generality and per-grant identity. Evolved schema (C):

```
leases(
  grant_id TEXT PRIMARY KEY,  -- opaque, returned at acquire, needed for release
  key TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES entities(id),
  cost INTEGER NOT NULL DEFAULT 1,
  acquired_at REAL NOT NULL,
  lease_expires_at REAL NOT NULL
)
```

Semantics: each key is a semaphore with `slotLimit(key)` units; a grant consumes `cost` units. This is the N-sized lock the notes ask for: `vitest` on this machine might be N=4 units where a suite costs 2, so two suites or four lint-class runs proceed concurrently. Token buckets (rate rather than concurrency) are a policy-layer variation sharing the same waits machinery, noted as future work rather than built now, because memory pressure is a concurrency problem, not a rate problem (C).

Lease TTLs stay short and are never silently auto-renewed: the holder heartbeats or the lease evaporates. For volatile tool runs this is the self-cleaning property that makes the system safe to adopt best-effort; a killed `vitest` can never leak capacity beyond one TTL interval (C).

Migration: `job:<id>` entities are materialized for existing jobs, and the claim path inserts into `leases` instead of `concurrency_slots`. The old table is dropped after one release cycle.

### 3. Waits: a first-class durable queue, cancellable

This is the genuinely new primitive and the core of the user's note. Today waiting is an implicit side effect: a job parks on a `waiting_on` string, and there is no waiter identity, no position, no timeout, no cancel (M `src/queue.ts:647-660`). For volatile tool runs that is wrong in both directions: a wait must be able to outlive the noise around it (so "runs get ran at some point"), and it must be cheap to abandon (because the run may die, be interrupted or be replanned while waiting) (C).

```
waits(
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES entities(id),
  cost INTEGER NOT NULL DEFAULT 1,
  enqueued_at REAL NOT NULL,
  deadline_at REAL,           -- null = wait forever; volatile callers set one
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK(state IN ('queued','granted','cancelled','expired')),
  grant_id TEXT               -- set on grant, references leases.grant_id
)
```

Guarantees (C):

- **Eventual grant**: per-key strict FIFO with aging. Strict FIFO per key is the simplest correct fairness rule and matches Hatchet's keyed model; aging already exists for jobs and is not needed inside one key's FIFO because FIFO ordering is itself the anti-starvation guarantee. Head-of-line fitting: a head waiter whose cost exceeds the key limit is rejected at enqueue time (config error, as already done in `spawnJob`, M `src/daemon.ts:361-365`), so the head can always eventually fit; smaller waiters behind it never jump ahead. This trades a little throughput for a proof shaped argument: free units monotonically return, the head consumes them, induction over the queue.
- **Cancellation**: `coordinate lease cancel <wait-id>` transitions the row to `cancelled`; a cancelled or expired wait is skipped by the granter and garbage-collected. The reaper also cancels all waits of dead owners, which is what makes volatility safe: a Ctrl-C'd agent or a killed shim never blocks the queue behind it.
- **Two delivery modes**. Synchronous: `coordinate lease acquire tool:vitest:proj --cost 2 --wait 60s` blocks in the CLI (polling the DB in WAL mode is cheap, and atomic check-and-grant inside one transaction is correct even with several pollers because SQLite serializes writers) and exits 0 with the grant id on stdout, 3 on timeout, 4 on refusal. This mode needs no daemon at all, which preserves adoption rung 1. Asynchronous: the wait is registered and the grant arrives as a mailbox message (`lease.granted`) or wakes a parked job, which is the mode jobs and a2a endpoints use.
- **Job parks unify**: the existing `jobs.waiting_on` mechanism becomes a wait owned by the job entity whose grant action is "requeue the job" rather than a degenerate string match. The `wait-on`/`release` event verbs survive as a compatibility shim over named semaphore keys with effectively infinite N, since event signaling is not capacity.

### 4. Mailbox

As spec'd in the P2 plan and the pluggable-surfaces research: `mailbox(owner_id, kind, payload, dedupe_key, deliver_at, state)` addressed to entities rather than only jobs, with dead letters and wake-carries-data. No change to that spec; the only addition is that entities are the address space (C).

### 5. Events

The existing append-only events table stays the single observability feed. Lease grants, wait cancellations and mailbox deliveries emit events the same way job transitions do, so `forward --exec` consumers and the audit loop see tool and a2a activity with no new machinery (C).

## How the surfaces compose

**Tool runs** (the volatile case). Lifecycle: shim or hook intercepts a spawn, classifies it, registers a `pid:<n>` entity (or reuses the ambient `session:` entity of the calling agent), opens a wait with a deadline (tens of seconds to a few minutes; tool runs should not queue forever), and on grant spawns the real binary with the lease heartbeat refreshed by a tiny babysitter or by the shim process itself staying alive as the parent. Release paths, in order of preference: explicit release when the tool exits, cancel of the wait if the spawn is abandoned, owner-death reaping when the process tree dies, TTL expiry as the final backstop. Four independent cleanup paths are not redundant; they are the correct response to volatility, ordered so the common case is cheap and the worst case is bounded by one TTL (C).

**Agent sessions** are what coordinate already does, re-expressed: the job entity holds machine and repo leases for its lifetime, parks as waits, receives prompts through the mailbox. The static `--slot` declaration remains valid and simply pre-registers waits at claim time.

**A2A endpoints** are entities with heartbeats plus a mailbox and a delivery adapter. Backpressure, when wanted, is a semaphore lease on `inbox:<name>`: senders acquire a unit to deliver, units return when the endpoint drains. That gives flow control with zero new machinery, which is the strongest validation of the abstraction (C).

## The extension contract

A user-defined surface is (C):

1. A new entity kind, declared by using it: kinds are open strings, and the registry does not enumerate them.
2. Optional config declaring lease keys and limits in `[slots]`, exactly as tool classes already do.
3. Optional adapter commands following the process boundary: a classifier (stdin spawn JSON, stdout class/cost), a policy (stdin acquire request, stdout proceed/wait/refuse), a delivery hook (stdin mailbox message JSON). Same contract style as `forward --exec`; foreign code never runs inside the daemon.
4. Everything else — entity registration, lease acquire/release/cancel, waits, mailbox send/receive, events — is the shared CLI surface and needs no per-surface code.

What is deliberately not offered: in-process plugins, direct SQL as a contract, user-defined primitive types. The five primitives are closed; composition is open. That line is what keeps the durability guarantees provable while still letting users extend behavior at every decision point that matters (C).

## Volatility handling summary

The notes call out removal/cancel as first-class because tool runs are volatile. The complete cancellation matrix (C):

| Situation | Mechanism | Bounded by |
| --- | --- | --- |
| run finishes normally | explicit `lease release <grant-id>` | immediate |
| run abandoned while queued | `lease cancel <wait-id>`, or shim death means nobody ever claims the grant | immediate |
| wait outlives its usefulness | wait `deadline_at` expires it | caller-chosen timeout |
| owner process dies mid-run | reaper probes `pid:` entities, releases leases, cancels waits | reaper interval |
| daemon or reaper absent | lease TTL expiry | `LEASE_S` (30s today) |
| owner lies or cannot heartbeat | entity `expires_at` hard backstop | registration TTL |

## Open questions

- Does the synchronous CLI poll loop need the daemon for fairness under contention, or is transactional SQLite ordering close enough at machine scale? Expectation: close enough up to dozens of concurrent waiters; measure before adding a granter (C).
- Heartbeat cost for short tool runs: a 20s `tsc` run inside a 30s TTL may never need one. Probably only lease-holders beyond one TTL heartbeat; the shim staying alive as the parent process makes this nearly free (C).
- Should `pid:` entities verify start time on Linux (pid reuse) and accept the macOS gap, or use uniformly short TTLs and skip platform-specific liveness? Leaning short TTLs for portability, consistent with D10 (C).

## Bottom line

The lease system stops being a lock glued onto jobs and becomes a small durable semaphore service: weighted N units per key, FIFO waits with deadlines and cancellation, entities of any kind as owners, four layered cleanup paths so volatile tool runs can never wedge capacity. Sessions, tool runs and a2a endpoints are then three compositions of the same five primitives, and a user's fourth surface is configuration plus adapter commands at the established process boundary.
