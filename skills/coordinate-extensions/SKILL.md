---
name: coordinate-extensions
description: "Extend coordinate without forking it: pipe job events into external tools. Use when building notifications, dashboards, aggregators, auto-release rules or any reaction to queue events (done, failed, parked, released, dead). Two shapes: stateless per-event commands via `forward --exec`, or a stateful consumer tailing `events --follow`."
---

# Extending coordinate

Coordinate has exactly two extension points, both event-driven. There is no plugin API, no hooks config and no in-process loading — every extension is an ordinary external program that reads the event stream. Pick the shape by whether your consumer needs memory between events.

## The event stream

Every state transition writes one row to the `events` table. Kinds emitted today:

`enqueued`, `claimed`, `done`, `failed`, `timed_out`, `cancelled`, `dead`, `requeued`, `parked`, `released`

Each event is `{id, ts, job_id, kind, data}` where `data` is a kind-specific JSON object. The exact fields emitted today:

| Kind | `data` fields |
| --- | --- |
| `enqueued` | `kind` (the job kind, `cmd` or `acp`) |
| `claimed` | `owner`, `attempt` (the attempt number just started, 1-based) |
| `done`, `failed` | `status`; `outcome` when the exit carried one; `exit_code` when the attempt exited with a code; `logs` (the stdout/stderr paths of the attempt) when the attempt was captured |
| `timed_out` | `outcome` (why the budget or deadline ended the job) |
| `cancelled` | `recorded_as` (always `"failed"`) |
| `dead`, `requeued` | `reason` (e.g. `"lease expired"`, `"dead retry"`), `attempt` when known |
| `parked` | `waiting_on` (the event id the job waits for) |
| `released` | `event` (the released event id) |

Event `id` is a monotonic integer — it is the resume cursor.

Event `data` never carries raw output. The captured stdout and stderr of a cmd attempt live in files under the state directory; the terminal event points at them through `data.logs.stdout` and `data.logs.stderr`, and `coordinate logs <job>` reads them.

## Shape 1: stateless — `forward --exec`

Use when each event can be handled independently: notifications, webhooks, logging, chat posts.

```
coordinate forward --exec '<cmd>' [--kinds k1,k2] [--interval S] [--once] [--cursor PATH] [--since ID] [-v]
```

Contract:

- The command runs once per matching event via `sh -c`.
- The full event JSON is on **stdin**.
- `{message}` inside the command is replaced by a one-line summary like `[laptop] coordinate[done] job 42 — ok`.
- Cursor file (`$XDG_STATE_HOME/coordinate/forward-cursor` by default) advances only after a successful send; a failed event is retried on the next poll. Filtered-out kinds advance the cursor without sending.
- Default kinds: `done,failed,timed_out,cancelled,dead,requeued`. Pass `--kinds` to change; an empty set means all.

Example — ntfy push (see `examples/ntfy-forward.sh`):

```
coordinate forward --exec 'curl -s -m 3 -d "{message}" "https://ntfy.sh/$NTFY_TOPIC"'
```

Example — append every event to an audit log:

```
coordinate forward --kinds enqueued,claimed,done,failed,dead --exec 'cat >> ~/coord-audit.jsonl'
```

Limitation: the command is spawned fresh per event. No state survives between events — no dedup, no "3 failures in 10 min", no counters. If you need that, use shape 2.

## Shape 2: stateful — tail `events --follow`

Use when the consumer must remember things: rate limiting, aggregation, correlation across jobs, dashboards, auto-`release` on patterns.

```
coordinate events --follow [--since ID]
```

Contract:

- Emits one JSON object per line (`{id, ts, job_id, kind, data}`), then polls the DB every 500 ms for new rows.
- `--since ID` replays from a point; without it, starts at the oldest event.
- The consumer owns its own cursor (usually the last `id` it processed) and persists it wherever it likes.
- Read-only with respect to the queue. To act back on the queue (`release`, `cancel`, `dead retry`), call the normal verbs from your program.

Skeleton (any language):

```
coordinate events --follow --since <last_id> | while read -r ev; do
  # parse $ev, update state, act
  last_id=$(echo "$ev" | jq -r .id)
done
```

Example — auto-release a parked job when its dependency finishes:

```
coordinate events --follow | jq -c 'select(.kind=="done")' |
while read -r ev; do
  jid=$(echo "$ev" | jq -r .job_id)
  coordinate status "$jid"   # inspect, then: coordinate release <event>
done
```

Example — failure alerter with dedup (what `forward` cannot do): keep a small state file, count `failed`/`dead` per repo in a sliding window, notify only past a threshold.

## Choosing

| Need | Shape |
| --- | --- |
| Notify/log/webhook per event | `forward --exec` |
| Anything needing memory across events | `events --follow` consumer |
| Act on the queue from an event | `events --follow` + normal verbs |
| Long-lived dashboard | `events --follow` + `stats` polling |

## Operational notes

- One DB per device; a forwarder or consumer sees only its local queue. To watch several machines, run one consumer per device (or point each at its own `COORDINATE_DB`).
- `forward` polls every `--interval` seconds (default 2); `events --follow` polls every 500 ms. Neither is a push API — expect seconds-scale latency.
- Run long-lived consumers under your own supervisor (tmux, launchd, systemd). Coordinate does not manage them.
- A `forward` command that exits non-zero stalls that event's cursor until it succeeds; make sink commands idempotent or tolerant of retries. A sink that can *never* succeed freezes the forwarder at that event forever — verify reachability once before leaving it running (e.g. `t3 thread send` only reaches threads on its own T3 environment; a forwarder on a remote VPS cannot page threads elsewhere — use a pull-side watchdog there instead).

## What does not exist

The old Python plugin runner (manifest + `~/.config/coordinate/plugins/`, `frontend`/`resume`/`hook` interfaces) was retired before the TypeScript port. `forward --exec` and `events --follow` cover its use cases; the design rationale is in `.agents/docs/archive/extensibility.md`. If a real second consumer appears (e.g. non-ACP resume providers), revisit then — do not rebuild the loader speculatively.

## External scheduler policies

The claim order inside the daemon is `priority DESC, run_at, id` and the built-in knob for starvation is `[scheduler] aging` in `config.toml` (off by default; a linear boost for waiting jobs up to `aging_ceiling`). Policies that aging cannot express (deadline-aware, cost-aware, fair-share per agent) are still possible without touching the daemon: run a shape-2 consumer that rewrites priorities, because the claim query picks up priority changes from the jobs table on its next tick.

This is the only supported way to influence ordering from outside. The binary is static and cannot load user JS in-process, so there is no claim-time hook, and the design is deliberate: a policy bug then costs a wrong row update, not a crashed scheduler.

```
coordinate events --follow | while read -r ev; do
  # every few minutes: find starved jobs and rewrite them
  sqlite3 "$COORDINATE_DB" "UPDATE jobs SET priority = 9
    WHERE status='queued' AND priority = 0
      AND created_at < (strftime('%s','now') - 3600)"
done
```

Properties worth knowing:

- Rewrites are idempotent, so a crashed consumer resumes safely; the worst case is a stale order for one tick.
- Keep the policy out of the hot path: read `status`/`stats` for state, write only the `priority` column, and batch updates. The daemon reads the row it already claimed regardless of what you write mid-claim.
- Start with `[scheduler] aging` before writing a consumer; it covers the common "low priorities starve" case with zero moving parts. Graduate to an external policy when you need a formula aging cannot express.
