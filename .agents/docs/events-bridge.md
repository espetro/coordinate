# Events bridge (bridge a): coordinate jobs visible in T3 threads

Date: 2026-11-23. Branch `feat/events-bridge`. Implements bridge (a) from
`t3-integration.md` section 2: an events table plus `coordinate events`/`--follow`, and a per-device forwarder that tails events and sends transitions into an orchestrator T3 thread.

## What was built

1. Events table and emission (Python, `src/coordinate/queue.py` + `src/coordinate/events.py`).
   Schema: `events(id INTEGER PRIMARY KEY, ts REAL, job_id INTEGER, kind TEXT, data TEXT default '{}')` plus `idx_events_job`. Created in `connect()` alongside the existing `SCHEMA` (M: same migration path as every table in that function, so an existing DB gains the table on first open).
   `emit()` is called inside the same transaction as each transition (M: `claimed` inside `claim`'s `BEGIN IMMEDIATE`, `done/failed` inside `finish`, `requeued`/`dead`/`timed_out` inside `reap`, `parked` inside `wait_on`, `released` inside `release`, `cancelled` inside `cancel`, `timed_out` inside `finalize_timed_out`, `enqueued` on the enqueue insert).
   Kinds emitted by the Python code: `enqueued`, `claimed`, `parked`, `released`, `done`, `failed`, `timed_out`, `cancelled`, `dead`, `requeued` (M).
   `follow(c, since_id)` returns ordered rows after `since_id`; `max_id()` gives the tail cursor. Readers are ordinary WAL read connections, so a follower never blocks the daemon writer (M: same WAL mode `connect()` already sets).
2. `coordinate events [--since ID] [--follow]` (Python CLI, `src/coordinate/cli.py`).
   JSONL, one object per line: `{"id", "ts", "job_id", "kind", "data"}`. `--follow` polls `MAX(id)` at 0.5s until Ctrl-C (M).
3. The same events table and emission in the TS port (`ts/src/queue.ts`).
   The TS daemon gets every transition it actually performs: `enqueued`, `claimed`, `done`/`failed` (`finish`), `timed_out` (reap deadline, `finalizeTimedOut`, budget exhausted at claim), `requeued`/`dead` (reap), `parked` (`waitOn`), `released`, `cancelled`, `requeued` (dead retry) (M). `coordinate events` exists in the TS CLI (`ts/src/main.ts`) with the same JSONL shape and `--follow`/`--since`.
   TS difference from Python, kept honest: the TS port has no tool-class slot logic and no acp kind, so it emits no events those paths would produce (M).
4. Forwarder: `src/coordinate_t3_forwarder.py` (Python ops tool, not shipped in the package).
   Reads the events table through the `coordinate` package (read-only WAL path), filters to terminal transitions by default (`done,failed,timed_out,cancelled,dead,requeued`, `--kinds` to change, empty string for all), and sends one `t3 thread send <thread> "[machine] coordinate[kind] job N ..."` message per transition.
   A cursor file (`--cursor`, default `$XDG_STATE_HOME/coordinate/t3-forwarder-cursor`) records the last forwarded event id, so a restart does not replay old events. On send failure the cursor does not advance and the same events are retried on the next poll (M: measured with a nonexistent thread id, `t3 thread send` rc=1, cursor stayed empty).

## The verified T3 channel

Measured (M) on this host (vps-ef376962, 2026-11-23, `t3 --version` 0.1.10):

- `t3` is installed at `~/.local/bin/t3`, the background service is installed (`t3 status` reports `Service installed · t3@0.1.10`).
- `t3 thread list --json` talks to the live server and returns threads.
- `t3 thread send <thread> <message>` exists; `t3 thread send <bad-id> x` fails with rc=1 and a clear "Thread ... was not found" error.
- `t3 thread start <project> <message> --title T --json` starts a thread and prints its id; use it once per device (or once globally) to create the orchestrator thread.
- Thread ids look like `mcp:<uuid>`; a thread belongs to one environment (the error text says a thread on a linked environment needs the right `environmentId`).

No ACP fallback env vars were needed and none were found or used (M: `env | grep -i acp` on this host shows nothing relevant). Forwarding runs directly on the device via the `t3` CLI; no ssh-side channel to the laptop is required for this host.

## How to run the forwarder per device

One-time per device (or once globally if you want one aggregate thread):

```
t3 thread start . "coordinate events forwarder" --title "coordinate: <machine>"
# note the printed thread id
```

Then, per device:

```
uv run python src/coordinate_t3_forwarder.py --thread <threadId> -v
# optional: --machine NAME --interval 2 --kinds done,failed,timed_out,cancelled,dead,requeued
```

Restart-safe: the cursor file is written atomically after each successful send; delete it (or pass `--since 0`) to replay the whole stream. Run it under a user service (systemd user unit or `t3 service`-style supervisor) for durability; it is a plain loop with no other state.

## Not in scope this session

Dispatcher backend (bridge c), Postgres store, per-job threads, `set_session_ref` generalization. The forwarder sends events; nothing yet consumes replies from the thread.

## Test evidence

Python: `uv run pytest -q` 82 passed, 2 skipped (M: includes 6 new `tests/test_events.py`; full suite re-run after the change). TS: `node --test test/*.mjs` 11 passed, 11/11 including the new events emission test (M).
