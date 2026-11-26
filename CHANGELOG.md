# Changelog

All notable changes to coordinate are documented here. This file is generated and maintained by [changesets](https://github.com/changesets/changesets); entries before 0.3.0 were reconstructed retroactively from the release history.

## 0.3.0

### Minor changes

- Tool concurrency surfaces: weighted-semaphore leases (`coordinate lease acquire/release/refresh/cancel/list/waits`) with durable FIFO wait queues, deadlines and cancellation, working daemonlessly through SQLite.
- `coordinate run` enforcement adapter: classifies heavy tool runs (vitest, tsc, cargo, docker, package installs), acquires the lease, babysits long runs and releases at exit. Jobs and external sessions share one accounting space.
- Entity mailbox: `coordinate send`/`inbox` with dedupe keys, future-deliver alarms, dead-lettering for dead owners and wake-carries-data for parked jobs. Agent registry verbs (`coordinate agent register/heartbeat/list/unregister`).
- Observability: per-job output capture with `coordinate logs`, per-attempt files under the state directory.
- Daemon handoff replaces the self-updater: `coordinate daemon restart` (explicit) and binary-change auto-swap (implicit — `mise upgrade` alone now upgrades the daemon). Binary acquisition belongs to package managers; coordinate never self-downloads.
- Graceful daemon shutdown releases the daemon row, so replacements take over near-instantly.

## 0.2.1

### Patch changes

- ACP registry fixes, TUI, read model, surface test phases (see PRs #26-#30).

## 0.2.0

### Minor changes

- TypeScript/scriptc port ships as the primary implementation; surfaces design phases 1-2.
