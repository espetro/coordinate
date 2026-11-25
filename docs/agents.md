---
title: Using coordinate with coding agents
---

# Using coordinate with coding agents

Coding agents work well with a queue because most of their jobs are long, parallel and likely to be interrupted. Give the agent the skill file and it learns the commands.

Copy `skills/coordinate/SKILL.md` into your agent's skills directory.

## What a running job can see

The daemon sets these variables for every job it starts.

| Variable | Value |
| --- | --- |
| `COORDINATE_JOB_ID` | The id of this job |
| `COORDINATE_MACHINE` | The machine name. The daemon records it in the queue DB on claim, and the forwarder resolves the same value, so the daemon, `cap show` and the forwarder prefixes always agree |
| `COORDINATE_DB` | The database file |
| `COORDINATE_DEADLINE_AT` | Epoch-second deadline of this attempt, empty when uncapped |
| `COORDINATE_ATTEMPT` | 1-based attempt number of this run |
| `COORDINATE_MAX_ATTEMPTS` | Maximum attempts before the job goes dead |

The `FLEET_*` names are accepted spellings for the first four.

A job can read its own row with `coordinate status --self` and the queue with `coordinate stats`.

Execution is at-least-once: a retried or resumed job can replay side effects from a killed attempt. Jobs that write files, send messages or call paid APIs should check `COORDINATE_ATTEMPT` (greater than 1 means replay is possible) and use a marker file or idempotency key.

## Following the queue from outside

`coordinate forward --exec '<command>'` runs a command for each event. Use it to send a notification, post to a chat or update a dashboard. A cursor file under `$XDG_STATE_HOME/coordinate/` lets it resume after a restart without replaying events.

For stateful consumers (aggregation, dedup, auto-release), tail `coordinate events --follow` instead — it emits one JSON event per line and polls for new rows. `skills/coordinate-extensions/SKILL.md` documents both patterns.
