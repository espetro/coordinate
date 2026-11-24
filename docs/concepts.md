---
title: Concepts
---

# Concepts

## Jobs and states

A job is one row in SQLite. It moves through these states.

| State | Meaning |
| --- | --- |
| `queued` | Waiting for a free slot |
| `running` | Claimed by the daemon and holding a lease |
| `waiting` | Parked until an event is released. It holds no process and no slot |
| `done` | Finished with exit code 0 |
| `failed` | Finished with a non-zero exit code |
| `dead` | Ran out of attempts after its lease expired each time |
| `timed_out` | Passed its `--max-runtime` deadline |

## Caps

A daemon never runs more than `COORDINATE_CAP` jobs at once, and never more than `COORDINATE_REPO_CAP` jobs for the same repo key. Jobs beyond the cap wait in the queue, and nothing is dropped. Among queued jobs, a higher `--priority` goes first, then the older job.

## Ordering

The daemon claims jobs in `priority DESC, run_at, id` order. Within one priority class, jobs run FIFO in submission order. `--run-at` holds a job back until its time; it does not raise the job ahead of others once it is due. By default a priority-9 job submitted later still claims before a priority-0 job that has waited for hours, so a busy queue can starve low priorities; `[scheduler] aging = "linear"` in `config.toml` (off by default) boosts the priority of waiting jobs by up to `aging_ceiling`, one step per `aging_period` of age. A job whose repo key or tool slot is at cap is skipped, not blocking: the daemon moves on to the next eligible job in priority order.

## Park and wake

`--wait-on <event>` parks a job, and `release <event>` queues it again. A parked job holds no process, so thousands of them cost only their rows. A finishing job releases only the waiters on its `tool:` slot keys, so a job parked with `--wait-on` always needs an explicit `release`; it is never woken because another job finished.

```sh
coordinate enqueue --wait-on deploy-ready -- ./smoke-test.sh
coordinate release deploy-ready
```

## Crashes and retries

A running job keeps a lease alive while it works. If the daemon crashes or the machine reboots, the lease expires and the job runs again, up to `--max-attempts` starts. After that it is `dead`, and `dead retry` brings it back. A job that exits non-zero is `failed` instead, and only an expired lease is retried automatically; `dead retry` revives `failed` and `dead` jobs alike.

## Events

Every state change is appended to an event log. `events --follow` streams it, `events --since <id>` replays it, and `forward --exec <command>` runs a command for each event with the event as JSON on stdin.
