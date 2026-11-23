# Actor model for coordinate: Rivet at the source, alternatives, and what to borrow

Date: 2026-11-22. Question: would `coordinate` (formerly fleet) benefit from Rivet's actor model approach? Status: research, nothing implemented. The Rivet queue adapter spike (spk-rivetfill) was still running when this was written and is not included.

Evidence tags as in `orchestrator-framing.md`: M = measured by us, R = read in the project's own docs or source, B = blog or marketing claim, K = from memory, unverified.

Inputs: `.agents/docs/orchestrator-framing.md`, `.agents/docs/rivet-spike.md`, `.agents/docs/research/rivet-density-claim.md`, `.agents/docs/readoption-design.md`, `.agents/docs/timecap.md`, `.agents/docs/research/observability.md`, `.agents/docs/bench-v2.md`, `.agents/docs/candidates-survey.md`, `src/fleet/queue.py`, `src/fleet/daemon.py`, rivet.dev docs and changelog, `github.com/rivet-dev/rivet` (6,973 stars, Apache-2.0, pushed 2026-11-22, M via GitHub API).

## 0. Short answer

Yes to the model, no to the dependency. Rivet's useful idea is not "an object per session in memory" but four durable primitives keyed by one identity: state, a persistent inbox, alarms that wake a sleeping instance, and a guarantee of one live activation. We already have three of the four in a weaker form (job row, `waiting_on`, `deadline_at`, lease), and the readoption design adds the fourth (host `flock`). What we lack is the inbox: today a wake is an edge-triggered `UPDATE ... WHERE waiting_on=?` with no payload and no memory, so a signal that arrives before the wait is lost and a waking session cannot learn what woke it. Recommendation: option B, borrow the model as a `sessions` identity plus one `mailbox` table with `deliver_at` (which doubles as the alarms table) inside the existing `queue.db`, behind the existing single-writer daemon. The smallest experiment is a lost-wakeup and kill -9 bench on that table (section 7).

## 1. Rivet's actor model at the source

What rivetkit 3.x actually guarantees, read in the current docs (R unless tagged otherwise).

| Aspect | What Rivet does | What is lost on crash | Source |
|---|---|---|---|
| Durable state | Per-actor embedded SQLite, `c.db`. "every committed write is replicated before it is acknowledged". The older `c.state` and KV APIs are listed under deprecated docs. | Nothing committed. Durability is at SQL commit. | rivet.dev/actors/docs/state |
| Ephemeral state | `c.vars`, created by `createVars` on every start, "Never persisted", dropped on stop. | Everything in vars. Our spike lost pid, pgid and session fields stored there on kill -9 (M). | same; `.agents/docs/rivet-spike.md` |
| Snapshot pattern | User-implemented periodic save of in-memory state, the docs example saves every second: "A crash loses at most this much progress". | Up to one interval. | rivet.dev/actors/docs/state |
| Sleep (hibernation) | An actor sleeps after `sleepTimeout` (default 30s) with no requests, no non-hibernatable connections, no running `run` handler, no `keepAwake`. `sleepGracePeriod` (default 15s) bounds shutdown work, then "the actor proceeds with sleep anyway". In-flight actions are not awaited. | Not applicable while asleep: a sleeping actor is only its durable data. | rivet.dev/actors/docs/lifecycle |
| Wake | Any request to a sleeping actor wakes it; crashes, restarts, upgrades and evictions also run `onWake` with persisted state. Measured wake p50 5-6ms, p99 10.6ms at 10,000 parked, with 3 of 40 samples at 1.3-2.0s in the 1,000 run (M, actor only, no agent process). | | lifecycle; rivet-spike.md |
| Hooks on crash | `onSleep` "may not always be called in situations like crashes or forced terminations". | Any cleanup written in `onSleep`. | lifecycle |
| Scheduling (alarms) | `c.schedule.after(ms, action)` and `c.schedule.at(ts, action)`, plus `c.cron`. "survive sleep, restarts, upgrades, and crashes" and "Rivet wakes the actor when the next action is due". Many schedules per actor, listable and cancellable. "Failed runs are not retried immediately"; a one-shot "is complete after its attempted invocation". | Schedules survive. A failed one-shot is not retried, so delivery is closer to at-most-once on handler failure. | rivet.dev/actors/docs/schedule |
| Actions | Request and response RPC. "By default, actions run in parallel and interleave at every `await`." The docs tell you to use one SQL statement or a transaction to stay atomic. | In-flight actions on crash; the caller sees an error. | rivet.dev/actors/docs/actions |
| Queues (the mailbox) | Added 2026-02. Messages "persist through sleep, crashes, and deploys, processed one at a time", consumed in a long-lived `run` handler via `c.queue.next()` or `c.queue.iter()`. `completable: true` lets the handler reply; callers can fire and forget, wait for ack, or wait for a typed reply with a timeout. Delivery semantics (at-least-once or not) and whether a send wakes a sleeping actor are not stated. | Messages survive; whether a message being processed at crash time is redelivered is not documented. | rivet.dev/changelog/2026-02-25-queues-for-rivet-actors |
| Events | Broadcast only to clients connected with `.connect()`; no persistence or replay documented. | Events to absent clients. | rivet.dev/actors/docs/events |
| Connections | Persistent client connections with `onBeforeConnect`, `onConnect`, `onDisconnect`; WebSocket hibernation is beta and off by default. | Connections drop on crash, clients reconnect. | events and lifecycle pages |
| Workflows | `workflow()` as the actor's `run` handler: checkpointed `ctx.step`, `ctx.sleep`, `ctx.queue.next` to wait on messages, "Crashes, deploys, and restarts pick up where they left off". Whether a step interrupted mid-execution is re-run is not stated. | Work since the last checkpoint. | rivet.dev/changelog/2026-02-24-introducing-rivet-workflows |
| Single-threaded execution | Not a strict guarantee any more. JS actors run on one event loop, but actions interleave at every await. Serial "one at a time" processing exists only for queue messages in the `run` loop. | | actions and queues pages |
| Single activation | Implied (one address per actor, the control plane routes and wakes), not stated as a global uniqueness guarantee on the architecture page. | | rivet.dev/docs/architecture |
| Local mode vs engine | `RIVETKIT_STORAGE_PATH` is documented as where "the local development control plane keeps Rivet Actor data". Self-hosted production is a control plane with a persistent local disk per instance plus an object storage bucket (S3, GCS, Azure), one instance "to try Rivet", three or more in production. Our spike ran the local mode: bun runner plus a Rust engine child process (66MB binary), 2 processes (M). | | environment-variables.mdx in the repo; rivet.dev/docs/self-hosting |
| Languages | Actors are written in TypeScript (Node or Bun, native or wasm bindings) or Rust (GA 2026-11-06). Python: `rivetkit-python/client` exists in the repo as a client only (maturin build, version `0.9.0-rc.1`, README still uses the old `tags` API), and neither `rivetkit-client` nor `python-rivetkit-client` is on PyPI (M, PyPI JSON API returns 404). No way to define an actor in Python. | | repo tree; PyPI |

Measured footprint (M, VPS, `.agents/docs/rivet-spike.md`): 128MB idle for the stack (runner 70.5MB plus engine 60.8MB), engine idle CPU 3.1%, 414MB at 1,000 parked, 1,489MB at 10,000 parked (engine 1,211MB, did not return to the 1k level after settling), 18-24KB disk per parked actor, 134MB disk floor. The 72.4KB per actor headline is a Rust-SDK, FoundationDB-backed marginal number with no published samples; Rivet's own reproducible benchmark measured 314.6KiB per held actor plus 367KiB on the engines (`.agents/docs/research/rivet-density-claim.md`).

Two readings matter for us. First, Rivet itself has moved away from the textbook actor (serial mailbox, one message at a time) for actions: the serial path is now an explicit queue plus a `run` loop, and correctness inside an actor is delegated to SQL transactions. Second, Rivet's durable state is a SQLite database per actor. The model, at its core, is "a keyed SQLite plus an inbox plus alarms plus routing", which is close to what a row-per-session in one SQLite file already is, minus the routing.

## 2. Other actor and virtual-actor systems, judged for coordinate

| System | Model | Durable state | Mailbox and serial execution | Alarms | Python, no extra server | Fit |
|---|---|---|---|---|---|---|
| Cloudflare Durable Objects (design reference) | One globally unique instance per id, input and output gates, hibernatable WebSockets (K for gate details) | Transactional storage API plus SQLite per object (K) | Single-threaded with gates (K) | One alarm per object, `setAlarm` overrides, "guaranteed at-least-once execution", retried with backoff from 2s up to 6 times (R, developers.cloudflare.com) | No, Cloudflare only | Reference for semantics: one activation, one alarm slot that the object re-arms from its own storage, at-least-once alarm |
| Orleans virtual actors (grains) | Activation on first call, deactivation when idle, single activation per grain id, turn-based (K) | Pluggable grain storage, explicit `WriteStateAsync` (K) | Turn-based, non-reentrant by default (K) | Timers (in-memory, only while active) and reminders (persisted, activate the grain) (K) | No, .NET; a silo plus a membership store | Reference for the timer vs reminder split and single activation |
| Akka and Pekko | Actors with supervision; Cluster Sharding for entities, passivation when idle, "remember entities" to restart them (K) | Event sourcing via Akka Persistence: journal plus snapshots (K) | Strict one message at a time (K) | Scheduler messages, durable only if persisted (K) | No, JVM | Reference for passivation and event-sourced entity state |
| Dapr actors | Virtual actors over a sidecar; placement service routes ids (R) | Configured state store (R) | Turn-based: "no more than one thread can be active inside an actor object's code at any time" (R) | Timers fire only while active; reminders "fire whether the actor is active or inactive, activating it first if needed" (R) | Python SDK exists (`dapr` 1.19.0, 2026-10-22, M via PyPI), but needs the `daprd` sidecar, placement or scheduler service and a state store | Fails requirement 1 (several long-running services) |
| Restate virtual objects | Keyed objects; "At most one handler with write access can run at a time per object key", shared read-only handlers run concurrently (R) | K/V per key, journaled durable execution (R) | Exclusive handlers "Mimicks a queue per object key" (R) | Durable timers and awakeables (R) | Python SDK, but a server process | Spiked: 532MB idle, no global priority, rejected for M4 and M5 (M, `.agents/docs/restate-spike.md`) |
| Ray actors | Python classes as remote actors, named and detached actors outlive their creator (K) | None by default; checkpointing is user code (K) | Serial per actor by default, async actors interleave (K) | None built in (K) | Python-native, but `ray start` runs a head node (GCS, raylet, dashboard, worker processes), likely hundreds of MB idle (K, not measured); `ray` 2.60.0 is active (M, PyPI) | Wrong shape: compute cluster, not a durable session store; fails the memory budget |
| Thespian | Python actors with a multiprocess admin system, location-transparent messaging (K) | None (K) | One message at a time (K) | `wakeupAfter` timers, in memory (K) | Python, but an admin process; last release 4.0.1 on 2025-03-12, 357 stars (M) | Stale and not durable |
| pykka | In-process actors on threads or gevent, futures, `ActorRegistry` (K) | None (K) | One message at a time per actor thread (K) | None (K) | Python library, no server; 4.5.0 on 2026-10-10, 1,338 stars (M) | Fits the budget but solves the in-memory part only; a thread per session and no durability is the opposite of a parked session |

Pattern across all of them: the durable part of every virtual-actor system is a keyed record, a persisted inbox or journal, and persisted reminders. The in-memory actor (pykka, Thespian, Ray, the JS object in Rivet) is the activation, and it is the part we should not keep resident, because our activation is a 60-600MB harness process (M, `.agents/docs/research/harness-footprint-and-roles.md`), not a 300KB object.

## 3. What the actor model would mean for each coordinate module

The mapping below uses Orleans and Durable Objects vocabulary: an identity, its durable state, its inbox, its reminders (durable alarms), and at most one activation.

| Module | Actor reading | Activation | Inbox messages | Alarms | Gains | Does not help with |
|---|---|---|---|---|---|---|
| Session store (M3) | Session as actor: key = coordinate session id (stable across turns, attempts, harnesses and devices) | The per-session ACP host from `readoption-design.md` with its `host.lock` flock; parked = no activation | `prompt` (from T3, Orca, a parent agent), `answer` (human reply to a permission request or question), `child_done` (subtask result), `lease_granted`, `ci_status`, `cancel`, `handoff` (move to another harness or device) | await TTL, turn deadline (`deadline_at`), pre-deadline warning, retry backoff, GC by TTL | One identity that outlives jobs; wakes carry payloads; no lost signals; any-of waits with a timeout | Global admission and priority across sessions |
| Scheduler (M4) | Not an actor. It is the event loop that activates actors, like a Rivet control plane or an Orleans silo | The daemon | Reads due messages and alarms, decides admission against caps | Its own tick | Admission becomes "pick sessions with deliverable messages, highest priority first", one query | Caps and priority are aggregates over all actors, which actor systems do not model (Restate and Rivet have no global priority either) |
| Device (M1 connector, caps) | Device as actor: key = device name; state = allowance from the hub, presence level, memory pressure, published counts | The device's own daemon | `allowance_set` from the hub, `presence_changed`, `pressure`, `drain` | presence hysteresis timers, publish interval, hub-silence timeout (keep last allowance) | Matches Assessment 2's "one writer per count" exactly: only the device mutates its counters, the hub only sends messages | The hub's placement decision is still a function over all devices |
| Locks and leases (M5) | Lease key as actor: key = `repo:<name>`, `tool:vitest`, `file:<glob>`; state = holders with cost and expiry; inbox = FIFO waiters | None needed, the daemon processes it inline | `acquire` (with cost), `release`, `holder_dead` | lease expiry per holder | FIFO grants instead of today's release-all-and-recheck (`q.release(c, event)` wakes every job parked on the key); a grant is a message to the waiting session, so the session wakes with the lease already held | Weighted caps already work (M, `tool_cap_holds`); the gain is fairness and fewer wasted claims, not correctness |
| Coordination, awaits (M5) | An await is "a session waiting on its inbox for a message kind, or an alarm" | | the message kinds above | await TTL | Requirement 10 ("know what each session is waiting on") becomes a query over undelivered predicates and pending alarms, which `fleet why <id>` can print | Cross-device awaits still need the connector to carry messages |
| Dispatcher (M2) | The host is the activation; the journal is the activation's log | Per-session host | | | Re-adoption (I1, at most one live host per session) is the single-activation guarantee of Orleans and Durable Objects, and `flock` is the activation lock | Nothing new; readoption already designs it |
| Context (M6) | Not an actor. Append-only single-writer files per device, synced through git | | | | | Multi-writer merge, which actors avoid by routing, not solve |
| Improver | Not an actor | | | | | |

What changes conceptually: the unit becomes the session, and a job becomes one turn of a session (one activation running one prompt). Today `jobs` conflates both: the ACP session id lives in `payload`, a park ends the job's run, and nothing ties successive jobs of the same conversation together except that payload field.

## 4. What we already have that is equivalent

Read in `src/fleet/queue.py` and `src/fleet/daemon.py` (R) and the design docs.

| Actor concept | coordinate today | Equivalent? | Gap |
|---|---|---|---|
| Durable actor state | `jobs` row: `payload` (harness, ACP session id, cwd), `status`, `priority`, `runtime_used_s`, `outcome`; survives kill -9 with 0 jobs lost and payload unchanged (M, `state-loss`) | Yes, for one turn | No session identity across jobs; no version column for optimistic concurrency |
| Ephemeral vars | `running: dict[int, Popen]`, `last_hb`, backoff | Yes, and readoption moves everything that matters out of it (I4) | Being fixed by readoption |
| Hibernation | `status='waiting'`, no process, slots freed in the same transaction (`wait_on`) | Yes. Cost per parked session: 1,000 parked add 0.2MB RSS and 0.3 to 4.4KB in SQLite; an earlier 11,000 run showed 0MB RSS and 303 bytes each (M) | None on cost; Rivet is 414MB at 1,000 (M) |
| Mailbox wait | `waiting_on TEXT` (one event name) | Partly | Edge-triggered: `release()` only flips rows that are already waiting, so a signal before the park is lost (lost wakeup). No payload. One condition per job, no any-of or all-of. No dedupe. Release wakes all waiters on a key |
| Alarm | `deadline_at` (running-time cap, enforced after kill -9 in 4.29s, M) and `run_at` (delayed start) | Partly | Only two fixed alarm kinds. No await TTL (a session waiting on a human that never answers waits forever), no pre-deadline warning, no retry-at for a rate limit except re-enqueue |
| Single writer | One daemon per device writes job transitions; CLI writes are conditional updates (`WHERE status IN (...)`) under `BEGIN IMMEDIATE`; leases fence by `lease_owner` | Yes for the device, by SQLite's single writer lock | Mutations of one job come from several writers (daemon, CLI, other agents through the CLI); correctness rests on each statement's WHERE clause rather than on one consumer |
| Single activation | Lease plus `pgid`; readoption adds `host.lock` flock, run token, boot id | Yes once readoption lands | Today a restarted daemon kills survivors and replays the turn (1 duplicate turn per live session, M) |
| Turn-based execution | Daemon loop is single-threaded; one host per job | Yes | |
| Routing and placement | Hub places by published device state (designed, not built) | Design only | Messages to a session on another device need the connector |
| Events to clients | Planned `events` table plus `fleet tail -f` (`research/observability.md`) | Yes in design | |

Bottom line for section 4: the actor model is mostly a renaming of what we have, with one real missing primitive (a persistent, level-triggered inbox with payloads) and one missing generalization (alarms as rows rather than two hard-coded columns).

## 5. Concrete benefits and their costs

Benefits we would gain by adopting the model (in any form):

1. No lost wakeups. A message persisted before the waiter parks is consumed at park time, so "subtask finished before the parent called wait", "human answered while the session was still mid-turn" and "CI finished before the agent parked" all work. Today each of these leaves the session waiting forever (R, `release()` code), and there is no await TTL to rescue it.
2. Wakes carry data. The continuation prompt needs the answer, the subtask summary or the CI result. With a payload in the message, the host builds the continuation from the inbox instead of re-reading external state.
3. Any-of waits with a timeout: wait for `answer` or `cancel`, or an alarm in 2h, expressed as rows, which gives requirement 10's stale-await alert for free (an alarm that fired is a stale await).
4. Idempotent signals by dedupe key (first-emit-wins, as in Absurd): a retried `child_done` or a duplicate CI webhook is a no-op, which matches readoption's I5 fencing.
5. Fair leases: FIFO grants per lease key instead of a thundering herd on release.
6. One place for every mutation of a session: other agents and the CLI append messages, only the daemon applies them. This is how the `FLEET_JOB_ID` CLI guard (Assessment 10) gets simpler: an agent may append messages to its own children and to itself, never mutate rows.
7. A cleaner unit for the bench and the panel: per-session timelines (messages in, activations, alarms) are exactly what `fleet why <id>` and Orca or T3 want to show.

Costs and limits:

- Memory: option B adds no process. Expected cost is rows: one session row plus a few message rows per parked session, likely under 1KB each (K, to be measured), against Rivet's roughly 100-130KB resident per parked actor on the engine (M).
- Code: one table, a consume-on-park path, a due-alarm query in the tick, a version column, and a migration that splits session identity out of `jobs.payload`. Estimate 150-300 lines plus tests (K).
- Latency: our wake is tick-driven. The daemon's poll interval was about 0.8s in the timecap run (M), and the 218ms p50 wake measured so far includes spawning a real agent and ACP `session/load`, so the scheduler share is not split out. Rivet's 5-6ms wake (M) is an actor with no agent process; the comparable number for us is "message inserted to host spawned", which needs its own measurement. A sub-10ms scheduler share would need a wake channel (a unix socket or FIFO poke after commit), not an actor runtime.
- Things the model does not buy: global priority, soft global caps, provider quota throttling, presence levels, placement. These are cross-actor aggregates and stay scheduler code. None of the actor systems surveyed offers global priority across keys (R for Restate and Rivet).

Costs specific to adopting rivetkit itself:

- Budget: 128MB idle, 414MB at 1,000 parked, 1,489MB at 10,000 (M). It fails the 200-300MB budget at about 500-700 parked sessions by linear interpolation (K, from the two measured points), and the local storage mode is documented as the development control plane (R).
- Language: actors only in TypeScript or Rust. coordinate would talk to it over HTTP from Python with an unpublished, stale Python client, or ship its own client (R, M).
- Two sources of truth: our caps, leases, priority and audit live in `queue.db`; session state would live in Rivet's per-actor SQLite. Every transition that touches both (park and free a slot) becomes a cross-store write with no shared transaction, which breaks the "write the event in the same transaction as the state change" rule of the observability design.
- Operational: a second runtime (bun or Node) and a 66MB Rust engine binary per device, 3.1% idle CPU (M), 134MB disk floor (M), and an upgrade path tied to a fast-moving v3 API (state and KV already deprecated in favour of `c.db`, queues added in 2026-02).
- Semantics we would still glue: no built-in process reaping or waitpid across hibernation (M, spike), at-most-once one-shot schedules on failure (R), undocumented queue redelivery on crash (R).

## 6. Options

### Option A: adopt rivetkit as a dependency

Shape: a bun process per device runs a `session` actor type; each session actor stores its record in `c.db`, uses `c.queue` as the inbox and `c.schedule` as alarms; the Python daemon calls it over HTTP for park, wake and signal, and keeps caps and priority in `queue.db`.

For: production-grade primitives already written (queues with completable replies, durable schedules that wake, workflows); an inspector UI; cross-device routing if we ever run a real control plane.

Against: fails the memory budget at about a thousand parked sessions on the measured backend, its local mode is positioned for development, it is a second runtime and a second store, Python is a second-class client, and the gain over option B is the code we would not write (a few hundred lines) at the cost of a dependency larger than the whole orchestrator. Kill criterion already met by the M numbers unless the running queue adapter spike shows a different backend or settings that cut the per-actor resident cost by 5x or more.

### Option B: borrow the model (recommended)

Shape, all inside `queue.db`, no new process:

- `sessions(id, device, harness, acp_session_id, cwd, state, version, current_job, transcript_ptr, created_at, expires_at)`: the actor identity and durable state. `jobs` becomes turns: `jobs.session_id` references it.
- `mailbox(id, session_id, kind, payload, dedupe_key UNIQUE, deliver_at, created_at, consumed_at, consumed_by_job)`: the inbox. An alarm is a message to self with `deliver_at` in the future, so there is no separate alarms table (Durable Objects keep one alarm slot and re-arm from storage; one indexed `deliver_at` column is the same idea with many slots). Index on `(session_id, consumed_at, deliver_at)` and on `(deliver_at)` for the tick.
- Wait predicate: `waiting_on` becomes a list of message kinds (any-of). `wait_on(session, kinds, timeout)` runs in one `BEGIN IMMEDIATE`: if a deliverable message of a listed kind exists, consume it and do not park; otherwise park and insert the timeout alarm. `signal(session, kind, payload, dedupe_key)` only inserts; it never touches session state.
- Single writer per session: only the daemon's `step(session)` applies messages, one at a time, with `UPDATE sessions SET ..., version = version + 1 WHERE id = ? AND version = ?`. SQLite's writer lock already serializes; the version column catches a stale writer (an old daemon epoch, a CLI call racing a transition).
- Device actor: a `devices` row plus messages addressed to `device:<name>` for allowance, presence and pressure changes; the connector delivers hub messages as inserts.
- Lease actor: waiters as messages addressed to `lease:<key>`, granted FIFO by the daemon, the grant delivered as a `lease_granted` message to the waiting session. Keep the existing `concurrency_slots` accounting.
- Activation: the readoption host, unchanged. Wake = consume message, claim a slot, spawn the host with the payload in its journal header.
- GC: consumed messages and expired sessions are deleted by the same TTL and row-cap sweep planned for the `events` table.

For: fixes the one real gap (lost wakeups, no payloads, no await TTL) at kilobytes per session and zero processes; keeps one store and one transaction per transition; lines up with readoption (I1, I4, I5) and observability (the mailbox is half of `fleet why`); stays Python.

Against: we own the semantics (delivery, ordering, dedupe, poison messages) and must test them under kill -9; the sessions and jobs split is a schema migration; it is easy to over-build (per-actor handler classes, a framework) when a table and two functions are the point.

### Option C: ignore

Keep `waiting_on` and fix only the symptoms: add an await TTL column, make `release` record an unconsumed event row so an early signal is not lost. This is option B minus the vocabulary, and it converges on the same table once payloads and any-of waits are needed. Choose it only if the experiment in section 7 shows no lost wakeups in practice and no consumer needs payloads.

### Recommendation

Option B, scoped to the mailbox table, the consume-on-park path and alarms-as-messages first. Defer the `sessions` and `jobs` split until the mailbox proves itself, because the mailbox can key on `job_id` at first. Do not adopt rivetkit; revisit only if a cross-device control plane with sub-10ms routing becomes a requirement and a measured backend fits the budget. Keep Durable Objects as the semantic reference (single activation, alarm re-armed from storage, at-least-once alarms) and Orleans' timer versus reminder split (in-memory tick timers versus persisted alarms) as the naming.

## 7. Smallest experiment that proves or kills option B

Time box: one working day. Branch from main in `~/.worktrees/<ticket>/mailbox`. About 150 lines plus a bench scenario.

Build:
1. `mailbox` table with `deliver_at` and `dedupe_key`, keyed on `job_id` (no sessions split yet).
2. `signal(job, kind, payload, dedupe_key)` inserts only. `wait_on(job, kinds, timeout_s)` consumes a deliverable message or parks and inserts a timeout message, in one transaction. The daemon tick queues jobs that have a deliverable message (including due timeouts) and hands the consumed payload to the spawned process through an env var or the run directory.
3. `fleet signal` CLI, keeping `fleet release` as a thin alias.

Bench scenario `mailbox` (on the VPS, under `flock /tmp/tsc.lock`, compared with the idle noise floor):

| Case | Method | Pass | Kill |
|---|---|---|---|
| Lost wakeup | 1,000 iterations of signal then wait, and 1,000 of wait then signal, with random interleaving from two processes; baseline on today's `release` | 0 lost on the mailbox; baseline count recorded | If the baseline also loses 0 in every real await path we have (tool slot, human, child, CI), option C is enough |
| Payload | Signal with a 4KB payload, check the resumed stub agent receives it byte for byte | 100% | |
| Any-of plus timeout | Wait on `answer` or `cancel` with a 2s timeout; no signal | Wakes within timeout plus one tick with kind `timeout` | |
| Crash safety | kill -9 the daemon between insert and consume, and between consume and spawn, 10 times each | 0 messages lost, 0 consumed twice, 0 leases leaked | Any double consumption that cannot be fenced by the run token |
| Density | 10,000 parked jobs each with one pending timeout message | RSS delta within noise (today 18.4MB flat, M), bytes per parked session under 1KB extra | Over 5KB per session or measurable RSS growth |
| Scheduler wake | Time from `signal` commit to host spawn start, no agent, p50 and p99 over 200 samples; then with a FIFO poke | Number recorded next to Rivet's 5-6ms (M); poke variant under 20ms p99 | |

The experiment kills option B if the baseline shows no lost wakeups and no planned consumer needs payloads or any-of waits, or if crash safety cannot reach 0 double consumptions without a design larger than the one above. It proves option B if all pass cases hold 10 of 10 and density stays inside noise.

## 8. Adversarial points

Against adopting the actor model at all:

- It is a renaming. A job row, `waiting_on`, `deadline_at` and a lease already are state, mailbox wait, alarm and single writer. Calling them actors adds vocabulary, and vocabulary invites a framework (handler classes, dispatch tables) that a 495-line queue does not need.
- Our hard problems are not per-actor. Global priority, soft global caps, presence levels, quota throttling and placement are aggregates across sessions and devices, and every actor system surveyed is weak exactly there. The model localizes the easy part.
- The activation is the expensive part and the model does nothing for it. A parked record already costs bytes (M); what limits concurrency is 60-600MB per live harness tree and provider quota (M, R). Rivet's density story does not transfer (`rivet-density-claim.md`).
- Even Rivet stopped promising one-message-at-a-time for actions and tells users to rely on SQL transactions. If the reference implementation falls back to "make each transition one atomic SQL statement", we already do that.
- The lost-wakeup gap may be rare in practice: the tool-slot wake happens inside the single-threaded daemon, where park and release cannot interleave. It is only real for external signals (human, child agent, CI), which are mostly not built yet.
- A mailbox is a new place for unbounded growth and poison messages, and a new class of bugs (message consumed, process never spawned) that the bench must cover.

Against ignoring it (for adopting the model, borrowed):

- External awaits are the next things to build (human answers, child results, CI, rate-limit retries per Assessment 13), and every one of them needs a signal that can arrive before the wait and that carries data. Building them on an edge-triggered string column guarantees the lost-wakeup bug later.
- No await TTL today means a session waiting on a human that never answers waits forever; alarms as messages fix that and the stale-await alert with one mechanism.
- The session versus job conflation will bite at harness swap and cross-device handoff (requirement 8): something must hold the identity across turns, harnesses and devices, and that something is an actor in all but name.
- The readoption design already re-derived single activation, durable-before-relied-on and fenced completion. Naming them after Orleans and Durable Objects gives access to two decades of failure modes (activation races, reminder storms, at-least-once alarms) instead of rediscovering them.
- It is cheap: no process, no new store, kilobytes per session, and it can be killed by a one-day experiment.

Against option B specifically (for option A):

- We will reimplement delivery semantics that Rivet, Restate and Durable Objects have debugged; our first version will have bugs theirs do not.
- Rivet gives an inspector, cross-node routing and workflows for free; if coordinate ever needs thousands of sessions routed across devices with millisecond wake, we will have built a worse control plane.
- Counter: none of that is needed under the current topology (one daemon per device, hub for placement only), and the measured cost (128MB idle, 1.5GB at 10k, M) is paid on every device from day one.

## 9. Open questions

- Does a Rivet queue `send` wake a sleeping actor, and is a message being processed at crash time redelivered? Not documented (R); the running queue adapter spike may answer it.
- What is the scheduler-only share of our 218ms wake p50? Not split out yet.
- Does any current await path actually lose a signal today, or is it only a latent bug for planned external awaits? Section 7's baseline answers this.
- Should a session's mailbox cross devices (hub forwards a message to the device that owns the session), or should cross-device signals go through T3 `delegate_task`? Depends on whether spokes can reach kinosmac (framing Assessment 3).
- Where does the payload live for large results (a child's summary): in the message row with a size cap, or as a pointer into the run directory?

## Sources

- rivet.dev/actors/docs/state, /lifecycle, /schedule, /actions, /events; rivet.dev/changelog/2026-02-25-queues-for-rivet-actors, /2026-02-24-introducing-rivet-workflows, /2026-11-06-rust-sdk-for-rivet-actors-is-now-generally-available; rivet.dev/docs/architecture, /docs/self-hosting; rivet.dev/actors/docs/wasm-vs-native-sdk (all fetched 2026-11-22).
- github.com/rivet-dev/rivet: repo tree (`rivetkit-python/client`, `rivetkit-rust`, `rivetkit-typescript`, `engine/packages`), `docs/actors/content/docs/environment-variables.mdx`.
- PyPI JSON API for `rivetkit-client`, `python-rivetkit-client` (404), `pykka`, `thespian`, `ray`, `dapr`; GitHub API for pykka and Thespian activity.
- developers.cloudflare.com/durable-objects/api/alarms; docs.restate.dev/concepts/services; docs.dapr.io actors features and concepts.
- Local: the coordinate docs listed under Inputs, `src/fleet/queue.py` (`wait_on`, `release`, schema), `src/fleet/daemon.py` (park, wake loop).
