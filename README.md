<h1 align="center">coordinate</h1>

<p align="center">A durable job queue for your machines and your coding agents. Jobs are SQLite rows, so a crash or a reboot loses nothing.</p>

<p align="center">
  <a href="https://github.com/espetro/coordinate/releases"><img src="https://img.shields.io/github/v/release/espetro/coordinate" alt="latest release" /></a>
  <a href="https://github.com/espetro/coordinate/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="license: Apache-2.0" /></a>
</p>

## Try it now

```sh
# install script (macOS and Linux)
curl -fsSL https://raw.githubusercontent.com/espetro/coordinate/main/install.sh | sh

# or mise
mise use -g github:espetro/coordinate
```

Start the daemon, enqueue something long, and watch it drain:

```sh
coordinate daemon &                                  # one per machine
coordinate enqueue --shell -- 'pnpm test && pnpm build'
coordinate status                                    # watch it drain
coordinate events --follow                           # or stream every transition
```

## What it does

- Admission control that survives crashes. A job is a SQLite row in WAL mode, not a process you hope stays up. A daemon crash, a reboot or a dead agent only expires a lease, and the job runs again.
- Concurrency caps per machine and per repo, plus named resources with `--slot` (for example `tool:vitest` or `repo:foo`) and priorities. The queue drains at the speed your hardware allows, whatever the rate of enqueueing.
- Park and wake. `--wait-on <event>` holds a job until `release <event>` or until a dependency finishes. A parked job costs about 300 bytes in the database and no process.
- Retries, deadlines and an event log. `--max-attempts` retries a failed job and sends it to a dead-letter state after the last attempt. `--max-runtime` sets a deadline, and a job that stalls past it ends as `timed_out`. Every transition lands in an append-only events table that you can tail, replay with `--since` or pipe elsewhere with `forward --exec`.
- One static binary. The TypeScript source is compiled by [scriptc](https://github.com/vercel-labs/scriptc) for macOS arm64 and x64, Linux x64 (glibc and musl) and Windows x64. There is nothing to install besides the file, and no cloud service.
- Built for agents and scripts. Every verb is a one-line command, every transition is an event, and each queue belongs to one device and is never shared.

## When to use it

| You want | You use |
| --- | --- |
| A job that survives reboots and agent crashes | `coordinate enqueue` |
| Bounded parallelism per machine or repo | `--slot`, `--repo`, caps in config |
| Ordered or dependent work | `--wait-on` and `release` |
| Visibility into what is running | `events --follow`, `forward --exec` |
| Interactive work you watch live | Your threads or TUI. coordinate handles the queue, not the chat |

Each device keeps its own database under `$XDG_STATE_HOME/coordinate/queue.db`. For agents and scripts, copy [`skills/coordinate/SKILL.md`](skills/coordinate/SKILL.md) into your agent's skills directory and it learns the verbs.

## Platforms

| Target | Artifact | Status |
| --- | --- | --- |
| macOS arm64 | `coordinate-*-darwin-arm64` | verified end to end |
| Linux x64 glibc | `coordinate-*-linux-x64-gnu` | verified and benchmarked |
| Linux x64 musl | `coordinate-*-linux-x64-musl` | static, runs on any distribution |
| macOS x64 | `coordinate-*-darwin-x64` | cross-compiled |
| Windows x64 | `coordinate-*-windows-x64.exe` | best-effort smoke test per release |

To build from source you need [scriptc](https://github.com/vercel-labs/scriptc) 0.4.16, pnpm and zig 0.14.1. Run `mise install` in a checkout to get all three, as pinned in `mise.toml`, then see [`scripts/build-bin.sh`](scripts/build-bin.sh).

## Docs

- [ARCHITECTURE.md](ARCHITECTURE.md) is the place to start.
- Research, spikes and design notes live in [`.agents/docs/`](.agents/docs/).
- [T3 thread integration](.agents/docs/t3-integration.md)
- [Extensibility: plugins, config bounds and self-update](.agents/docs/extensibility.md)
- Measured performance (enqueue latency, memory, park density): [`.agents/docs/ts-port-spike.md`](.agents/docs/ts-port-spike.md) and `bench/results-*.json`

## License

[Apache-2.0](LICENSE). Copyright 2026 Joaquin Terrasa & contributors.
