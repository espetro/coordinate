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
| `COORDINATE_MACHINE` | The machine name |
| `COORDINATE_DB` | The database file |

A job can read its own row with `coordinate status --self` and the queue with `coordinate stats`.

## Following the queue from outside

`coordinate forward --exec '<command>'` runs a command for each event. Use it to send a notification, post to a chat or update a dashboard. A cursor file under `$XDG_STATE_HOME/coordinate/` lets it resume after a restart without replaying events.
