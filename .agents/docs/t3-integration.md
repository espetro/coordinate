# T3 integration design

Date: 2026-11-23. Assessment and design for T3 thread support plus the pluggability seams it forces. Evidence tags: M = verified from code in this repo, C = speculation or design intent. Code references are on branch `docs/t3-integration` at the time of writing.

## 0. State of the code today (M)

What exists in `src/coordinate/`:

- Storage is SQLite only, accessed through module-level functions in `queue.py` that take a raw `sqlite3.Connection` (`queue.py:278` `enqueue`, `queue.py:294` `claim`, `queue.py:425` `finish`, `queue.py:447` `reap`, `queue.py:477` `wait_on`, `queue.py:491` `release`, `queue.py:521` `cancel`, `queue.py:539` `stats`). There is no storage interface; `daemon.py` and `cli.py` both call these functions and execute their own SQL in places (`daemon.py:137` reads `deadline_at` directly, `cli.py:133` selects job columns directly).
- The daemon is a single-threaded claim loop (`daemon.py:264` `run`) that spawns shell jobs and ACP jobs. ACP dispatch is hard-wired: `spawn_acp` (`daemon.py:161`) shells out to `fleet-acp run <agent> --cwd --prompt --pid-file ...`, optionally `--session <id>` for resume. There is no Dispatcher interface object in code; ARCHITECTURE.md's Dispatcher row ("`start`, `prompt`, `cancel`, `load`, `export_context`") is designed but not built as code (M: absent from `src/`; D per ARCHITECTURE.md's own tagging, line 45).
- Session resume today is exactly one provider: the ACP session id persisted into the job payload by `_pump_session` (`daemon.py:145-157`, first stdout line's `sessionId` -> `queue.set_session`, `queue.py:374`), replayed via `fleet-acp run --session` on the next attempt (`daemon.py:173`). Shell `cmd` jobs have no resume at all.
- There is no `events` table, no mailbox, and no completion notification anywhere in the runtime (M: grep for `events`, `mailbox`, `notify` over `src/coordinate/` finds nothing). `spawn_audit` (`queue.py:214`) is the only event-like table, written only on heavy spawns. ARCHITECTURE.md P2 (line 123) and orchestrator-framing.md Assessment 13 both plan an events table written in the same transaction as each state change; neither is built.
- State transitions that a visibility layer would care about all pass through a small set of queue functions: `claim`, `finish`, `reap`, `wait_on`, `release`, `cancel`, `finalize_timed_out`, `retry_dead`. `finish` (`queue.py:425`) is the completion point; it returns the freed tool-slot event key so the daemon can wake parked jobs (`daemon.py:282-288`). That return value is the existing germ of an event system.
- The bench adapter pattern (`bench/adapters/restate/shim.py`, 177 lines M) is a process-level contract: an executable shim implementing `daemon` / `enqueue` / `stats` over the documented FLEET_* env (tool-search-rubric.md section 3). It isolates a foreign backend by reimplementing the scheduler contract, not by plugging into ours.

Conclusion of section 0: the seams ARCHITECTURE.md names (Dispatcher, Connector, Workspace, Control panel) exist only as rows in a table. For T3 integration we have to create the seam, and the cheapest correct place to cut it is around the two things T3 needs from us: state changes (visibility) and session lifecycle (dispatch/resume).

## 1. Assessment of the three bridges

### Bridge (a) status bridge: events tail forwarded into T3 threads

Mechanics: P2 adds an `events(job_id, ts, kind, data)` table written inside the same transaction as each transition (the pattern Assessment 13 already measured at 278 bytes and 35 microseconds per event, M from that assessment). A monitor on each device tails new events (SQLite polling with `MAX(id)` is enough; WAL readers do not block the writer) and forwards transitions into an orchestrator thread via `t3_thread_send`. Jobs stay in coordinate; T3 gets one aggregate thread per device or per repo, not one per job.

- Cost: small. The events table is planned P2 work anyway; the monitor is a thin forwarder. (C on exact effort, M on the pattern being cheap.)
- Gives: transition visibility ("job 42 admitted", "job 42 done/failed/timed_out") wherever the orchestrator thread lives, on every device T3 links. Covers the ssh-poll shell-loop gap directly.
- Does not give: per-job threads, interactive steering of a job from T3, worktree isolation of the job's workspace under T3's model.
- Dependency: needs the P2 mailbox/events work first. It is the only bridge with zero new coordinate-side architecture beyond P2. (M on the dependency, C on "zero beyond P2" once forwarding is added.)

### Bridge (b) invert the flow: visible work in T3 threads, overflow in coordinate

Mechanics: a delegation rule, no code: anything you want to watch runs as a T3 thread (natively tracked, notifiable, cross-device readable, worktree-isolated); coordinate keeps only what T3 lacks: cap-enforced admission, park/wake, restart-surviving headless jobs, weighted tool leases.

- Cost: zero code. (M: it is a policy.)
- Honest tension, as stated in the task: it shrinks coordinate to admission control. But that is not a demotion; it is what the code actually is today (M: the whole runtime is a queue, caps, leases, park/wake and a spawn loop). ARCHITECTURE.md line 5 already frames coordinate as pluggable orchestration next to a control panel.
- What it loses: T3 threads have no coordinate-style soft caps across their own launches (T3's auto balance picks a machine per thread at creation only, R per orchestrator-framing.md Assessment 3), no park/wake of a mid-thread session, no weighted tool leases. So heavy T3-side fan-out remains uncapped. (C: unless T3 later exposes cap hooks.)
- It also loses durable ACP session resume for thread work: T3's own durability model covers its threads, ours does not touch them. That is acceptable, it is T3's job. (C on T3's exact guarantees.)

### Bridge (c) T3-as-dispatcher backend

Mechanics: the Dispatcher interface gains a `t3` implementation: on admit, coordinate asks the Connector to create a T3 thread on the target environment, stores the `threadId` in the job row (a `session`-like column or payload key, exactly where `set_session` puts the ACP id today, `queue.py:374`), and later transitions flow from T3 back into job status.

- Cost: two unbuilt things: (i) the Connector module (`connect`, `delegate`, ARCHITECTURE.md line 47, D), and (ii) a T3-side API to create a thread from outside a thread. Whether the latter exists is unverified; T3's documented cross-machine surface today is read-only live thread viewing plus `delegate_task` (R, Assessment 3). Creating a thread programmatically from a non-T3 process is C until checked.
- Gives: per-job threads, full visibility, T3's notifications, worktree isolation, and coordinate keeps caps and durability-of-record. Cleanest end state; matches the ARCHITECTURE diagram where Connector and Dispatcher both feed the Scheduler.
- Risk: it couples coordinate's admitted jobs to T3 availability on the target device, partially violating requirement 3 (agents keep working without the orchestrator). Mitigation: fallback dispatcher (ACP) when thread creation fails, and treat the threadId as advisory metadata, not the source of truth; the jobs row stays authoritative. (C design judgement.)

### Recommendation for our use

Do (a) first, keep (b) as the operating policy, and treat (c) as the target shape that (a) naturally grows into. Reasoning, against the code:

1. (a) needs only P2 events plus a forwarder, and P2's events table is the prerequisite for every other bridge anyway (M: nothing can observe anything today, grep confirms).
2. (b) costs nothing and covers the interactive 80% now; the delegation rule is exactly "visible work goes where the UI already is".
3. (c) is where we end up for headless jobs once the Connector exists, because the events forwarder of (a) already establishes the same thread-per-device channel and the job-row `threadId` slot is one column. Build (c) only after the Dispatcher interface exists (it is a prerequisite anyway) and after verifying the T3 thread-creation API. Until then the ssh-poll loop is replaced by (a)'s events tail.

Concrete near-term: implement P2 `events` with an append/statement-level API, add `coordinate events --follow`, run the forwarder into a per-device T3 thread. Re-evaluate (c) when the Connector module is built; the design below makes that a drop-in, not a rewrite.

## 2. Frontend/visibility interface (pluggable, T3 is one implementation)

There is no existing seam for frontends in `src/coordinate/` (M, section 0). Create one. It should not be a new daemon thread per frontend inside `coordinated` (that would break the single-threaded claim-loop simplicity, `daemon.py:1-3`); it should be a subscriber contract over the events stream, so any frontend runs as its own process.

Location: `src/coordinate/frontend.py` (the protocol) and `src/coordinate/events.py` (emission, P2). Frontend implementations live outside the core: `src/coordinate_frontends/t3.py`, `orca.py`, `terminal.py`, shipped as extras (`uv tool install coordinate[frontend-t3]` style, C on the packaging detail).

### Events contract (coordinate exposes)

```
# events.py, written in the same transaction as each transition (P2 design, Assessment 13)
emit(conn, job_id: int, kind: str, data: dict) -> None
# kinds: enqueued | admitted | started | parked(waiting_on) | released
#        | resumed(session_id) | done(outcome) | failed(outcome) | timed_out | cancelled | dead
follow(conn, since_id: int) -> Iterator[Event]   # poll MAX(id), returns ordered new events
```

Invariants a second storage backend must keep (M on the current ones): events are written atomically with the transition, monotonic per-device id, durable until TTL, tail-able by a separate read-only connection while the daemon writes (WAL readers, `queue.py:230`).

### Frontend protocol (the layer provides)

```
# frontend.py
class Frontend(Protocol):
    name: str
    def session_ref(self, job: dict) -> str | None:
        """Stable external reference for a job (T3 threadId, orca run id, tmux session), or None."""
    def on_event(self, ev: Event) -> None:
        """Forward one transition. Must be cheap and lossy-tolerant; coordinate never blocks on it."""
    def can_launch(self) -> bool:
        """True if this frontend can create a new visible session (bridge c)."""
    def launch(self, job: dict) -> str:
        """Create the external session, return its ref. Only called when can_launch()."""
    def notify(self, job: dict, summary: str) -> None: ...   # completion push, best effort
```

`coordinated` does not host frontends. A separate `coordinate-frontend <name>` process runs the follow loop: `follow()` then `on_event()`. Crash of a frontend never affects jobs; it resumes from `MAX(id)` it last acknowledged (store the cursor in its own file or the frontend's own store; C on which). This mirrors how `bench/adapters/restate/` isolates a backend at process level (M on the pattern) but in the opposite direction: adapters replace our scheduler, frontends consume our events.

Mapping of bridges to the protocol: (a) uses `follow` + `on_event` only, `can_launch` False. (c) additionally implements `can_launch`/`launch`, invoked by the dispatcher at admit time, storing the returned ref via the same `set_session`-shaped hook (`queue.py:374` generalized to `set_session_ref(conn, jid, owner, key, value)`).

## 3. Other user-facing layers: the contract per layer

Coordinate exposes to every layer: (i) the events stream (section 2), (ii) job rows read-only via `coordinate status [--self]` (M, `cli.py:124-140`), (iii) the mutating CLI verbs (`enqueue`, `cancel`, `wait-on`, `release`, `stats`, `dead retry`, M, `cli.py`), (iv) the env contract at spawn (M, `daemon.py:129-142`). The layer provides: launch of a visible session, resume of one, and notifications. Per layer:

- T3 Code: bridge (a) first (events -> `t3_thread_send` into an orchestrator thread, C on the exact send API from this repo's docs), then (c) (launch creates threads, needs the T3 external thread-creation API, unverified, C). Resume: T3 keeps its own thread state; coordinate records the threadId and does not attempt to resume T3 threads itself.
- Orca: Orca has its own runs/tasks/dispatch model with worker heartbeats and `worker_done` (R, Assessment 4). Contract: an Orca task wraps `coordinate enqueue`; completion reaches Orca via the events stream (bridge a). A coordinate job inside an Orca run gets caps and park/wake that Orca lacks. Frontend: `on_event` maps to Orca's run inbox; `launch` is not needed since Orca dispatches.
- Paperclip / Multica: both need Postgres (R, Assessment 7 gate failure for us). Their integration is mostly the DB seam (section 4) rather than the frontend seam: short-runs-as-rows maps to our jobs table (R, "work as data" pattern). Contract: expose the queue functions through the Store trait and let them run their UI against a Postgres-backed coordinate store; their own notification paths consume the events stream.
- tmux / iTerm: the terminal frontend is `on_event` printing transitions (or a tmux status hook) plus `launch` = `tmux new-session` driving the existing term-fallback dispatcher path (M: term-fallback-spike.md keeps tmux, 10ms create, 7ms roundtrip). This is also the local-user-visible version of bridge (a): `coordinate watch` is a one-evening build once `follow` exists (C on effort).
- Barebones agent CLIs headless (Claude Code `claude -p`, Codex exec): these are harnesses under the Dispatcher, not frontends. Their integration contract is the spawn env plus resume flags (section 5); visibility comes from the events stream via whichever frontend is running. They map to bridge (a) as consumers, not providers.

## 4. Storage seam

Today `queue.py` is module functions over a `sqlite3.Connection`, with daemon and cli executing raw SQL in places (M, section 0). A second backend (Postgres for paperclip, or just preference) needs a Store interface that owns schema, connections and all job/slot/event SQL, so `claim`'s `BEGIN IMMEDIATE` transaction and `queue.py:409`'s runtime-charge `UPDATE` become method bodies behind the interface.

### Store protocol sketch

Location: `src/coordinate/store.py` (Protocol + sqlite implementation moved from `queue.py`; `queue.py` becomes the sqlite impl or a thin re-export to keep the bench shim contract stable).

```
class Store(Protocol):
    # lifecycle
    def connect(self) -> None                      # open, migrate
    def migrate(self) -> None                      # schema versions, both backends
    def close(self) -> None
    # jobs (mirroring queue.py functions, M names)
    def enqueue(self, payload: dict, kind, priority, max_attempts, run_at, max_runtime_s) -> int
    def claim(self, owner: str, machine: str) -> Claim | None
    def set_proc / set_session_ref / heartbeat / finish / reap
    def wait_on / release / cancel / finalize_timed_out / retry_dead / expired_running
    def stats(self) -> dict
    def get_job(self, jid: int) -> dict | None     # replaces cli.py:133 raw SQL
    # events (P2) and slots
    def emit(...) / follow(...) 
    def acquire_tool_lease / release_tool_lease / slot_limit lookup stays in config, not store
```

Transaction semantics to specify per backend: `claim` must be one serialized transaction that reads caps, picks the row, inserts slot leases and updates the job (M: `BEGIN IMMEDIATE` at `queue.py:297`). On Postgres that is one `BEGIN` with `SELECT ... FOR UPDATE SKIP LOCKED` on candidate rows; the multiple-`RETURNING` use in `reap` (`queue.py:466`) maps to Postgres `RETURNING` directly, and CTEs where SQLite needs two statements.

Migration path: `coordinate migrate --store sqlite|postgres` with `COORDINATE_DB=postgres://...` in config; SQLite stays the default and the bench contract (`FLEET_DB` path, rubric section 3) stays sqlite-only (M: bench reads a path). Copy-based migration is straightforward (rows only; no sqlite-specific pragmas carry over), C on volume concerns at personal scale.

### SQLite-specific assumptions a second backend must preserve or consciously drop

- WAL behaviour: the fixed ~4.1MB WAL high-water while the daemon holds a connection (M, park-wake.md lines 36-47), reset when the last connection closes. Postgres has no analogue; the equivalent fixed cost is the Postgres server's own memory, which fails the G2 no-external-server gate by definition (M: ARCHITECTURE.md line 13). So postgres is an extension for users who already run it, never the default, and the docs must say the footprint claims do not transfer.
- Reclaim: `auto_vacuum=INCREMENTAL` plus `incremental_vacuum` shrinks the file after TTL deletes (M, park-wake.md lines 66-74); the production reclaim today does not shrink the file at all (M, line 76). Postgres reclaims via autovacuum with different timing. The Store interface should own a `reclaim()` method so each backend implements its own policy, and ARCHITECTURE.md's TTL-bounded-storage claim (line 13) should be scoped to the sqlite backend.
- Byte accounting: the 326/249 bytes per parked session numbers come from `dbstat` page accounting plus the WAL experiment (M, park-wake.md lines 49-63). They are sqlite-only numbers. On Postgres the per-row cost will be larger (tuple header, per-table pages, no shared small-page density); expect tens of bytes more per row plus fixed server overhead. Any ARCHITECTURE.md or park-wake.md footprint claim must keep the "(SQLite backend)" qualifier; the density claims (18.5MB idle, 0.2MB RSS per 1,000 parked, 112-115ms wake p50, M) are measurements of this stack and do not generalize. Concretely: park-wake.md's "280x cheaper than Restate" comparison is a sqlite-vs-Restate statement (M), not a property of coordinate.
- Density-relevant semantics a second backend must keep or consciously drop: parked time never charges runtime budget (`_charge_runtime`, `queue.py:405-410`), expired-lease reaping kills survivors before requeue (`reap`, `queue.py:456-458`), deadline enforcement readable by any daemon after restart (`expired_running`, `queue.py:513`). These are portable; the poll-interval wake behaviour (`BACKOFF_MAX` up to 2s, M, `daemon.py:30-38`) is store-independent but a Postgres deployment would typically add LISTEN/NOTIFY as the wake notification that park-wake.md line 105 names as the fix.

## 5. Resume-capability trait

Where it belongs: the Dispatcher interface, as a capability query the scheduler consults before choosing a backend for a job attempt. ARCHITECTURE.md already lists `load` on Dispatcher (line 45); make capability explicit.

```
# dispatcher.py
class Dispatcher(Protocol):
    def capabilities(self) -> Capabilities
        # resume: none | session_id | context_export
        # interactive: bool,  worktree_aware: bool
    def start(self, job) -> Handle
    def resume(self, job, session_ref) -> Handle   # only if capabilities.resume >= session_id
    def cancel(self, handle) -> None
    def export_context(self, handle) -> str
```

Resume providers today (M unless noted): ACP `session/load` via the persisted sessionId (`daemon.py:145-157`, `queue.py:374`, replayed with `fleet-acp run --session` at `daemon.py:173`). That is the only one built. Candidate ones not wired: harness CLI resume flags (`claude --resume`, `codex` equivalent; C on exact flags per CLI, standard practice), tmux session attach (a live pane is not a resume: it survives only while the server lives, no reboot resume; M on tmux semantics being process-lifetime, C on resurrect plugins which are unsupported by default). After reboot the only working path is the ACP session id or an exported-context handoff (D, `export_context`).

"Can this backend resume session X on this host": coordinate asks the dispatcher, keyed by the session ref's provider prefix stored in the payload (e.g. `{"session": "acp:<id>"}`, `{"session": "cc:<claude-uuid>"}`). The dispatcher answers for its own refs; cross-harness resume (harness-swap scenario, rubric section 4) goes through `export_context` and a fresh start, never a fake resume. The scheduler rule: if the payload has a session ref the chosen backend cannot resume, either pick a backend that can (same harness class first) or start fresh with the exported context, and record which happened in the outcome. The kill -9 recovery already depends on this being true for ACP (M: 3/3 resumed via `session/load`, Assessment 9).

## 6. Build order

For our own T3 use first, keeping the abstractions honest but unbuilt until needed:

1. P2 events table + `emit` in the transition functions of `queue.py` (same transaction) + `coordinate events [--follow]`. This is the shared prerequisite; the ssh-poll loop dies here. (M on prerequisite status, C on effort: small.)
2. T3 forwarder process implementing the section 2 protocol (`follow` -> `t3_thread_send`), per device. Bridge (a) complete.
3. Adopt the delegation rule (bridge b) as documented practice: visible interactive work in T3 threads, overflow/batch/headless through coordinate. No code.
4. Generalize `set_session` to `set_session_ref(jid, key, value)` and extract the Dispatcher protocol with the ACP implementation first (`spawn_acp` moves behind it, `daemon.py:161`). tmux fallback second, implementing `capabilities()` honestly (resume: none for a fresh pane).
5. Store trait extraction (section 4): move `queue.py` functions behind the Protocol, keep sqlite as the only implementation, keep `bench/adapters/` working. Do this after 1-4, when the call sites are stable.
6. Bridge (c): T3 dispatcher implementation via the Connector, gated on verifying the T3 external thread-creation API. Fallback to ACP on failure. Postgres Store only when a real consumer (paperclip) exists.

Explicitly left abstract until a second consumer appears: the Frontend protocol's `launch` path (only T3-bridge-c would use it), Postgres reclaim semantics, and cross-harness `export_context` format.

## 7. Claims summary

M from code: storage is sqlite function API with raw SQL leakage; no events/mailbox; ACP dispatch and resume hard-wired in `daemon.py`; daemon single-threaded; `finish` returns a wake event; bench adapter is a process contract. M from repo docs (measurements): footprint, density, wake latency, WAL/vacuum/bytes, ACP resume after kill -9, tmux costs. C: T3 `t3_thread_send` and external thread-creation APIs, Orca inbox mapping details, packaging as extras, Postgres cost estimates, effort estimates.
