# Re-adoption of agents across a daemon restart

Date: 2026-11-22. Status: design, nothing implemented. Evidence tags: M = measured by us, R = read in source or a project's own docs, K = from memory, unverified.

Inputs: `docs/orchestrator-framing.md` (requirement 3, Assessment 7 and 9), `docs/bench-v2.md` (`orchestrator-kill`), `docs/fallback-design.md`, `src/fleet/daemon.py`, `src/fleet/queue.py`, `bench/stub_acp_agent.py`, `bench/acp_client.py`, `ARCHITECTURE.md`, and the sibling `fleet-acp` checkout (`src/run.js`, `bin/fleet-acp.js`).

## 1. Problem

Requirement 3 says agents keep working when the orchestrator stops. Today they do keep running (M, `orchkill_agents_alive_after_kill` = 3), but a restarted daemon cannot take them back. Its first tick runs `q.reap()`, which kills the surviving process groups recorded in `pgid` and `pidfile` and requeues the job; the retry resumes through ACP `session/load` and sends the prompt again. Measured cost: 3 of 3 sessions resumed, 1 duplicate turn each (M, `docs/bench-v2.md`).

Who owns the agent's stdio is more precise than "the daemon" (R, source). The daemon spawns one ACP client per job (`fleet-acp`, or `bench/acp_client.py` in the bench) with `start_new_session=True`. That client spawns the agent detached in its own process group and owns the agent's stdin and stdout. What the daemon owns is the client's stdout pipe (line 1 is the sessionId, line 2 the stopReason) and the `Popen` object whose `poll()` is the only completion signal. So when the daemon dies, the ACP connection is still intact; what is lost is (1) the completion signal, because a new daemon cannot `waitpid` a process that is not its child and the stopReason goes into a closed pipe, (2) the lease, because nobody heartbeats it, and (3) the identity of the run, because `lease_owner` is `nodename:pid` of the dead daemon. The per-job client is already a per-session host in all but name. That is the main finding of this design: re-adoption is mostly a contract change to an existing process, not a new process.

Secondary findings from the source (R):
- `run()` has a `finally` that SIGKILLs every running child. It only runs on a clean stop. Python's default SIGTERM handler terminates without unwinding (M, bench-v2 caveat), so a `systemctl stop` today accidentally does the right thing for availability and the wrong thing for hygiene (nothing closes). The intended policy must be written down: a daemon stop detaches, it does not kill.
- `kill_orphans` calls `os.killpg` on a pgid recorded before an outage of unbounded length, with no ownership check. Its own docstring flags PID reuse. Two spike agents were already SIGKILLed by other sessions' kill tests (M, framing Assessment 9).
- `claim()` and `acquire_tool_lease()` delete expired `concurrency_slots` rows. After an outage longer than `LEASE_S`, the first claim frees the slots of agents that are still running, so the cap overshoots by the number of survivors.
- Cancel of a running ACP job kills the client group at the next heartbeat, but the agent is in its own group (ARCHITECTURE.md known gaps). A host that owns the agent fixes this for free.
- The bench helper `_alive()` treats `PermissionError` as dead. For liveness, EPERM means the process exists.
- `fleet-acp` (Node) writes the stopReason to stdout at turn end. Node ignores SIGPIPE and surfaces EPIPE as an asynchronous stream error, so with the daemon gone the write most likely crashes the client after the turn completed (K, not tested). The turn's work is done but the outcome is lost, which is the worst kind of duplicate: a completed turn re-run.

## 2. Invariants

I1. At most one live host per job attempt, and at most one live agent process per ACP session. Two agents on one session id corrupt the transcript, which is worse than a duplicate turn.

I2. A daemon stop or crash never kills a host or an agent. Only an explicit cancel, a deadline, a lost-ownership fence or a terminal job state does.

I3. Never signal a pid without proving it is ours: same boot, same start time, and (where available) a race-free handle. When proof is impossible, do not signal; treat the process as alive and keep its lease (availability bias, and safe for I1).

I4. Every fact needed to adopt a run is durable before the daemon relies on it: in SQLite (daemon-written) or in the run directory (host-written, fsynced). Nothing that matters lives only in daemon memory.

I5. Completion is recorded exactly once, fenced by a per-attempt run token. A late or replayed completion from an old attempt is a no-op.

I6. Adoption happens before reaping and before claiming in the first tick after start, so expired leases of live hosts are never treated as dead and never freed for new claims.

I7. Zero duplicate turns when only the daemon dies. When the host or agent dies (or the machine reboots), the turn is lost mid-flight and exactly one continuation turn via `session/load` is allowed; it must carry the original turn id so it is not counted as, and does not behave as, a fresh duplicate prompt.

I8. A per-job deadline holds without the daemon. The host enforces it; the daemon re-enforces it on adoption.

## 3. Options

| | (a) Detached per-session ACP host | (b) tmux-owned agents, pipe-pane journal | (c) Accept duplicate, idempotent turns | (d) systemd or launchd transient unit per agent |
|---|---|---|---|---|
| Who owns agent stdio | the host (today's `fleet-acp` client, extended) | a tmux pane pty | unchanged (client, then reaped) | still needs (a): a unit gives detachment, not a JSON-RPC peer |
| Daemon kill -9, duplicate turns | 0 (adopt, read result from journal) | 0 if output parsing works | 1 per live session, made cheap | 0 only combined with (a) |
| Host or agent kill -9 | 1 continuation turn via `session/load` | tmux server kill -9 kills every agent at once (M, term-fallback spike: workload died with the server) | 1 continuation | 1 continuation; unit restart policy can relaunch the host |
| Reboot | no process survives; continuation via `session/load` | same | same | same (units are transient) |
| Extra RSS per live session | 0 if `fleet-acp` becomes the host (it already runs per job); about 13MB for a Python host (M, stub interpreter overhead); about 1-3MB for a compiled shim (K) | tmux 4.8MB total, flat to 20 sessions (M) | 0 | systemd bookkeeping only, no process (K) |
| Complexity | medium: host contract, journal, adopt phase, ownership checks | high for ACP: JSON-RPC over a pty needs raw mode, input via `send-keys` or `paste-buffer`, line limits, parsing scrollback | low to medium: turn ids, replay check, stub support | low on Linux (`systemd-run --user`), high on macOS (per-job plist via `launchctl bootstrap`, no transient-unit equivalent) |
| Failure modes | orphan hosts if the daemon never returns (Orchestrator.inc #5948, R); journal growth; Node client EPIPE today | shared fate on one tmux server; pty corrupts framing; no structured completion | still burns a turn and tokens; ambiguity whether the lost turn completed | DBus spawn latency (K); Linux-only; cgroup leftovers with `KillMode=process` |
| Prior art | Orchestrator.inc detached ACP host with acknowledged prompt replay (R); dtach, abduco, zmx per-session daemons (R, K) | Claude Squad, Supacode via zmx (R) | Orca `worker_done` with task and dispatch ids (R); Cloudroom marks mid-turn work as unknown instead of resending (R) | systemd scopes (K) |
| Fit | primary | keep for the M2 TUI fallback only | complement for the unavoidable continuation cases | optional Linux wrapper around (a) for memory accounting |

How (a) maps to the session-daemon patterns. dtach and abduco hold a pty in a master process, publish a unix socket per session, let clients attach and detach, and abduco keeps a finished session's exit status until a client collects it (K). zmx does the same per session, adds scrollback history, and Ghostex adds a wire-generation contract so old session daemons keep serving after an app update (R, landscape-b). Our host is the same shape with a JSON-RPC pipe pair instead of a pty, an ndjson journal instead of scrollback, a result record on disk instead of a lingering process holding an exit status, and a generation field in the journal header for the same upgrade reason. Rivet's hibernation (R, `docs/rivet-spike.md`) contributes two lessons: a hibernated session has no process at all (our parked state, and what a reboot forces on every live session), and anything held only in process memory (Rivet's actor vars, our `running` dict) is lost on restart, so it must be written to the durable store before it is relied on.

Why not (b) for ACP: tmux solves detachment and capture for terminal UIs, and the term-fallback spike already chose it for the TUI lane. For ACP it trades a clean pipe for a pty, and the single tmux server reintroduces the shared-fate problem that per-session daemons exist to remove.

Why not (c) alone: it keeps the duplicate and only lowers its price. The daemon-only crash is the common case (deploys, restarts, OOM of the daemon), and paying a turn for it contradicts requirement 8.

Why not (d) alone: a transient unit keeps a process alive across a daemon restart, which `KillMode=process` and `AbandonProcessGroup` already do, but somebody still has to be the ACP client. On macOS there is no cheap equivalent.

## 4. Recommendation

Adopt (a) by turning the existing per-job ACP client into the host, plus (c) for the continuation cases, plus an optional (d) wrapper on Linux later.

Host contract (fleet-acp and `bench/acp_client.py` implement the same one):
- Spawned by the daemon fully detached: new session, and a second fork so the host is never the daemon's child (dtach style). Fresh runs and adopted runs then go through one code path. stdin is `/dev/null`, stdout and stderr go to `run.log` in the run directory. Nothing is ever written to a pipe the daemon owns.
- Run directory `~/.fleet/runs/<job>-<attempt>/` with `journal.ndjson` (append-only, one JSON object per line), `run.log` and `host.lock`.
- Journal records, each fsynced at the points marked: `header` (generation, job id, attempt, run token, host pid, host start time, boot id, deadline_at; fsync), `agent` (agent pid and start time; fsync), `session` (session id; fsync, replaces the stdout line 1), `turn_start` (turn id; fsync), streamed ACP traffic (`session/update`, permission requests and answers; no fsync, size capped and rotated), `result` (stopReason or error class, `deadline`, `cancelled`; fsync, then exit).
- Liveness lock: the host holds an exclusive `flock` on `host.lock`, opened close-on-exec so the agent does not inherit it. The kernel drops it when the host dies, so a daemon probe with `LOCK_EX|LOCK_NB` answers "alive" or "dead" with no PID involved. This is immune to PID reuse and works on macOS and Linux on a local filesystem.
- Signals: SIGTERM means cancel gracefully (send `session/cancel`, wait for the turn to end up to a grace period, then the existing SIGTERM-then-SIGKILL agent stop, then a `result` record). The host enforces `deadline_at` itself with the same path.
- Environment injected into host and agent: `FLEET_JOB_ID`, `FLEET_RUN_TOKEN`, `FLEET_DEADLINE_AT`. These let toolcaps attribute nested spawns to the job and give a second ownership check (process environment is readable for same-uid processes on Linux through `/proc/<pid>/environ` and on macOS through `KERN_PROCARGS2`, K).
- One turn per host, as today. Multi-turn hosts, a unix socket for attach and replay, and relaying permission requests to a human come later (slice 6). The daemon does not need the socket for adoption: completion comes from the journal, cancel from a verified signal, liveness from the lock.

Daemon changes:
- Single instance: hold `flock` on `~/.fleet/daemon.lock` for the process lifetime. A second daemon (launchd restarting while an old one hangs) blocks instead of racing.
- Identity: `lease_owner` becomes `nodename` plus a `daemon_epoch` incremented in SQLite at each start. Fencing for completion and heartbeat moves to `run_token`, which is per attempt and does not change on adoption.
- Startup adopt phase, before the first reap and claim (I6). For each `running` job on this node:
  - Boot id differs from the recorded one: the machine rebooted. Signal nothing. Mark the attempt `interrupted` and requeue it with its session id for a continuation (section 6).
  - Journal has a `result` record: ingest it with `finish(run_token)` (done or failed), even if the host already exited. This covers the case where the turn finished while the daemon was down.
  - Lock busy (host alive): rewrite `lease_owner` to the new owner where `run_token` matches, extend the job lease and its `concurrency_slots` rows, and track the run in memory as an adopted handle. If `deadline_at` has passed, send a verified SIGTERM.
  - Lock free and no result: the host died mid-turn. Verify and kill any surviving agent group recorded in the journal (pid, start time, boot id), then requeue as a continuation.
  - Lock state unknown (EPERM, missing run directory on a valid boot): keep the lease and log; do not requeue (I1 and I3).
- Steady state: replace `Popen.poll()` with a handle that reports exit through the lock probe (or `pidfd` on Linux, `kqueue` `EVFILT_PROC` `NOTE_EXIT` on macOS, K) and reads the outcome from the journal. Heartbeats keep extending leases as today.
- Stop policy: install a SIGTERM handler that stops claiming, closes the DB and exits without touching hosts. Delete the kill-all `finally`. Cancel and park go through the verified SIGTERM to the host.
- `kill_orphans` and the reaper use a verified-signal helper only (section 7).

Leases while the daemon is down. Hosts do not write SQLite; the daemon stays the single writer (plus the CLI), which keeps the Node host free of a SQLite dependency and the WAL free of N writers. Leases and slot rows therefore expire during an outage. That causes no double run while the daemon is down, because only the daemon claims on a device. It causes double runs or cap overshoot only if a restarted daemon reaps or claims before it adopts, which I6 and the single-instance lock rule out. The alternative (hosts heartbeat their own lease rows) keeps caps accurate for outside readers during an outage, such as the hub reading published device state, at the cost of one SQLite writer per live session; revisit it when the connector publishes state while the daemon is down, which it cannot do today anyway.

Attempt accounting. A requeue caused by daemon loss, host loss or reboot increments `interruptions`, not `attempts`, so orchestrator trouble does not push a healthy job into `dead`. `interruptions` gets its own cap (for example 5) so a host that dies on every start still ends.

Memory. Hosts exist only for live sessions; parked sessions have none, so the parked-density story is unchanged. If `fleet-acp` is the host there is no extra process. Its Node RSS per live session has never been measured; measure it in the `live-density` scenario with the real client before committing. If it is above roughly 30MB per live session, port the host to a small compiled binary or to Python (about 13MB, M) without changing the contract.

## 5. State that must move into SQLite (or the run directory)

From `daemon.py` memory:

| In-memory today | What it carries | Where it goes |
|---|---|---|
| `running: dict[int, Popen]` | the set of live runs, their pid, the stdout pipe, the exit code | derived from `jobs` rows with `status='running'` on this node, plus `host_pid`, `host_start_us`, `boot_id`, `run_dir`, `run_token`; the exit outcome comes from the journal `result` record |
| `Popen.returncode` | done or failed | journal `result`, ingested into `jobs.status` and a new `exit_reason` column (`end_turn`, `error`, `deadline`, `cancelled`, `interrupted`) |
| `owner = nodename:pid` | lease identity, changes on every restart | `lease_owner = nodename`, `daemon_meta.epoch`, fencing by `jobs.run_token` |
| `_pump_session` thread and stdout line 1 | session id, with a window where it exists only in the pipe | journal `session` record (fsynced), persisted to `jobs.session_id` (and `payload.session` for compatibility) |
| `pidfile` on disk, `pgid` in `jobs` | agent pid for the reaper | journal `agent` record with pid and start time; `jobs.agent_pid`, `jobs.agent_start_us`; `pids/` directory retired |
| `last_hb`, `last_reap`, `delay` | timers | stay in memory, they carry no state |
| `_Parked` exception | park at the heavy-spawn boundary | already durable through `wait_on`, unchanged |

New columns and tables: `jobs.run_token`, `jobs.host_pid`, `jobs.host_start_us`, `jobs.boot_id`, `jobs.run_dir`, `jobs.session_id`, `jobs.turn_id`, `jobs.agent_pid`, `jobs.agent_start_us`, `jobs.exit_reason`, `jobs.interruptions`, `jobs.deadline_at` (already being added), `jobs.adopted_epoch`; table `daemon_meta(key, value)` holding `epoch` and the last seen `boot_id`. `pgid` and `pidfile` are kept until the migration is done, then dropped.

## 6. Turn identity and the continuation path (option c, scoped)

Each prompt gets a `turn_id` (job id, attempt, sequence), persisted in `jobs.turn_id` at claim and written to the journal `turn_start`. It is sent in the ACP request `_meta` field and as a short marker in the prompt text, because not every agent preserves `_meta` (K).

A continuation happens only when the turn's process is gone (host kill, agent kill, reboot). The host then calls `session/load`, which replays the conversation as `session/update` notifications (R, ACP spec, as far as the agent implements it). If the replay contains the turn marker followed by agent output, the host sends a short continuation prompt carrying the same `turn_id` ("turn X was interrupted, inspect the state on disk, finish it or report that it is done") instead of the original prompt plus the resume preamble. If the marker is absent, the turn never started on the agent side and the original prompt is sent, which is not a duplicate at all. This cannot make a lost turn free, but it makes it short and makes the bench able to tell a continuation apart from a duplicate.

## 7. PID reuse safety

Identity of a process = (boot id, pid, start time). Boot id: `/proc/sys/kernel/random/boot_id` on Linux, `kern.boottime` from `sysctl` on macOS. Start time: field 22 of `/proc/<pid>/stat` on Linux (clock ticks since boot), `proc_pidinfo(PROC_PIDTBSDINFO)` `pbi_start_tvsec` and `pbi_start_tvusec` on macOS through ctypes (K). Both are recorded by the host in its journal header and copied to SQLite on spawn or adoption.

Verified signal helper: if the boot id differs, refuse. On Linux, open `pidfd_open(pid)` first, then read the start time; if it matches, signal through `pidfd_send_signal`, which closes the reuse race completely (Python `os.pidfd_open` and `signal.pidfd_send_signal`, Linux 5.3 or later, K). On macOS, read the start time and signal immediately; the remaining window is microseconds and requires the pid to be reused within it. For a process group, verify the group leader and signal the group. Never signal pid 0, 1 or the daemon's own group. Every kill path (`kill_orphans`, reaper, cancel, deadline, bench cleanup) goes through this helper; the bench gets the same helper so kill tests stop hitting other sessions' processes.

Liveness never uses `kill(pid, 0)` alone. Primary signal: the host's `flock`. Secondary: verified identity.

## 8. Reboot

No host or agent survives. On the first start after boot, the adopt phase sees a boot id mismatch for every `running` job and signals nothing, so a reused pid after reboot can never be hit. Each such job becomes a continuation, queued in its normal priority order (resumes first among equals, so live work outranks new work after a reboot), subject to the device cap like any claim. Expected cost: exactly one continuation turn per session that was live at the reboot, and zero for sessions that were parked. Run directories of interrupted attempts are kept until the job is terminal, then garbage collected with the job's TTL. Startup is `RunAtLoad` on launchd and lingering user units on systemd, as today.

## 9. Per-job time cap

`deadline_at` is per job, absolute wall clock, persisted at enqueue or first claim, and it does not reset on adoption, continuation or reboot. The daemon passes it to the host as `FLEET_DEADLINE_AT`; the host enforces it with the graceful cancel path and writes `result` with `deadline`, so the cap holds while the daemon is down (I8). On adoption the daemon re-checks it and sends a verified SIGTERM if a live host is past it (covers a host started before deadlines existed or a host whose timer failed). A continuation is not started if `deadline_at` has passed; the job is marked failed with `exit_reason='deadline'`. `FLEET_JOB_ID` is inherited by the agent and its children, which lets toolcaps attribute heavy spawns, lets the daemon find stray descendants of a dead host by environment, and gives a second ownership check. Host clock jumps (sleep, NTP) are acceptable: the deadline is a safety limit, not a schedule.

## 10. Bench scenario spec: `orchestrator-kill` v2

Same harness as today: K stub ACP sessions through fleet, `bench/acp_client.py` as the host (it must implement the host contract first), stub agent with turn ids. All kills in the bench go through the verified-signal helper; `_alive()` must count EPERM as alive. The bench must not clean up agents itself: whatever survives at the end is a finding.

Stub changes: record per session `prompts` as a list of `{turn_id, attempt, started_at, ended_at, stop}`, replay prompts and chunks as `session/update` on `session/load`, and accept `_meta.turn_id`.

Variants (K = 3, `STUB_TURN_MS` = 20000 unless stated, `FLEET_LEASE_S` = 4, daemon downtime 10s so every lease expires while down):

| Variant | Action | Gates |
|---|---|---|
| `daemon-kill9` | kill -9 the daemon group mid-turn, restart after 10s | `duplicate_turns` = 0, `continuation_turns` = 0, `adopted` = K, `attempts` = 1 per job, `all_done` |
| `daemon-kill9-finish-while-down` | one job with `STUB_TURN_MS` = 5000, same kill and downtime | that job is `done` from its journal `result`, `duplicate_turns` = 0 |
| `daemon-sigterm` | SIGTERM instead of kill -9 | same gates as `daemon-kill9`; agents alive after the stop = K |
| `host-kill9` | verified kill -9 of one host mid-turn, daemon keeps running | `continuation_turns` = 1 with the original `turn_id`, `duplicate_turns` = 0, `interruptions` = 1, `attempts` = 1 |
| `reboot-sim` | stop daemon, verified kill of all hosts and agents, set `FLEET_BOOT_ID_OVERRIDE` to a new value, restart | zero signals sent to recorded pids (decoy below survives), `continuation_turns` = K, `all_done` |
| `pid-reuse-decoy` | write the pid of an unrelated bench-owned sleeper into one job's `host_pid` and `agent_pid` with a wrong start time, then kill -9 the daemon and restart | the decoy is alive at the end; that job is handled as a continuation |
| `deadline-while-down` | one job with `deadline_at` = now + 8s, daemon killed at +2s and restarted at +15s | job `failed` with `exit_reason='deadline'`, agent gone by deadline + grace + 1s, no continuation started |
| `cancel-while-down` | `fleet cancel` on one job while the daemon is down | after restart the host gets a verified SIGTERM, the stub records `stop='cancelled'`, agent gone within the grace period |

Metrics reported per variant: `duplicate_turns` (a `session/prompt` for a `turn_id` whose earlier prompt was still running or had ended with `end_turn`), `continuation_turns`, `adopted`, `resumed_via_session_load`, `recovery_s`, `leases_leaked`, `orphan_hosts`, `orphan_agents`, `max_live_agents` (sampled every 200ms across the whole scenario), `decoy_alive`.

Global gates for every variant: `leases_leaked` = 0 (at the end, no `concurrency_slots` row whose job is not `running`, and no `running` job whose host lock is free), `orphan_hosts` = 0 and `orphan_agents` = 0 (no process carrying the scenario's `FLEET_JOB_ID` set alive after all jobs are terminal), `max_live_agents` <= cap at every sample (no overshoot from expired slots), `decoy_alive` = true where a decoy exists. Repeat `daemon-kill9` 10 times under `noise-floor` so `recovery_s` gets a stdev; the boolean and count gates must hold in 10 of 10.

## 11. Implementation slices

Each slice is at most three items, lands on its own, and leaves the bench green.

Slice 1, safety first:
1. Verified-signal helper (boot id, start time, pidfd on Linux) used by `kill_orphans`, the reaper and the bench; `_alive()` treats EPERM as alive.
2. `daemon_meta` table with `epoch` and `boot_id`; record boot id and host start time at spawn.
3. Single-instance `flock` on `daemon.lock`; SIGTERM handler that exits without killing children; remove the kill-all `finally`.

Slice 2, host contract in the bench client:
1. `bench/acp_client.py` detaches (double fork), writes the run directory, journal records and `host.lock`, never writes to stdout.
2. Graceful SIGTERM (`session/cancel`, grace, stop agent, `result`), and `FLEET_DEADLINE_AT` enforcement.
3. Inject `FLEET_JOB_ID`, `FLEET_RUN_TOKEN`, `FLEET_DEADLINE_AT`.

Slice 3, daemon adoption:
1. Schema migration (section 5 columns), `run_token` fencing in `heartbeat` and `finish`, `interruptions` counter.
2. Adopt phase before the first reap and claim, with the five cases of section 4.
3. Run handle that replaces `Popen.poll()` with lock probe plus journal `result`.

Slice 4, bench proof:
1. Stub agent: per-turn records, `_meta.turn_id`, replay on `session/load`.
2. `orchestrator-kill` v2 variants `daemon-kill9`, `daemon-kill9-finish-while-down`, `daemon-sigterm`, with `leases_leaked`, orphan and overshoot gates.
3. Variants `host-kill9`, `reboot-sim`, `pid-reuse-decoy`, `deadline-while-down`, `cancel-while-down`.

Slice 5, the real client:
1. Port the host contract to `fleet-acp` (`src/run.js`, `bin/fleet-acp.js`), including the EPIPE fix by construction (no stdout contract).
2. Turn markers and the continuation prompt of section 6.
3. Measure `fleet-acp` RSS per live session in `live-density`; decide Node host versus compiled or Python host.

Slice 6, later:
1. Unix socket per host (`~/.fleet/run/<job>.sock`, short path because of the 104 byte `sun_path` limit on macOS, K) with replay from a journal offset plus live tail, for the control panel.
2. Pending permission requests held by the host and relayed as a human await.
3. Optional `systemd-run --user --scope` wrapper on Linux for per-agent memory accounting, behind a flag, with spawn latency measured.

## 12. Open questions

- Does `claude-code-acp` and each other adapter replay history on `session/load` in a form that exposes the turn marker? Needed for section 6, untested.
- Does an agent survive its client's death long enough to matter? If the host dies, the agent sees stdin EOF; most adapters exit, some may finish the current tool call first. The adopt phase kills it either way, but the window affects I1.
- Journal size for long turns with large tool outputs: pick a cap and rotation policy after measuring a real Claude Code turn.
- Whether the hub needs accurate per-device live counts while a device's daemon is down; if yes, hosts heartbeating their own leases becomes worth its writer cost.
