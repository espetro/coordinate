<h1 align="center">coordinate</h1>

<p align="center">A durable job queue for your machines and your agents. One SQLite row, one process, zero babysitting.</p>

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

Then give it work that should outlive your attention span:

```sh
coordinate daemon &                                  # one per machine
coordinate enqueue --shell -- 'pnpm test && pnpm build'
coordinate status                                    # watch it drain
coordinate events --follow                           # or stream every transition
```

## What it does

- **Durable admission control** — jobs are SQLite rows (WAL), not processes you hope survive. Daemon crashes, reboots and agent deaths are just lease expirations.
- **Caps that mean something** — per-machine and per-repo concurrency limits, named `--slot` resources (`tool:vitest`, `repo:foo`), priority ordering. The queue drains at the speed your hardware allows, not the speed you enqueue.
- **Park and wake** — `--wait-on <event>` freezes a job until `release <event>` (or a dependency finishes). Thousands of parked jobs cost ~300 bytes each, not a process each.
- **Retries with receipts** — `--max-attempts`, `--max-runtime`, dead-letter state, and an append-only events table you can tail, replay (`--since`) or pipe anywhere (`forward --exec`).
- **One binary** — TypeScript compiled by [scriptc](https://github.com/vercel-labs/scriptc) to a static executable. macOS arm64, Linux x64 (glibc + musl), Windows x64. No runtime, no daemon framework, no cloud.
- **Agent-native** — designed to be driven by coding agents and orchestrators: every verb is a one-liner, every state transition is an event, every queue is per-device and never shared.

## When to use it

| You want | You use |
| --- | --- |
| A job that survives reboots and agent crashes | `coordinate enqueue` |
| Bounded parallelism per machine or repo | `--slot`, `--repo`, caps in config |
| Ordered/dependent work | `--wait-on` + `release` |
| Visibility into what's running | `events --follow`, `forward --exec` |
| Interactive work you watch live | your threads/TUI — coordinate is for the queue, not the chat |

Per-device databases under `$XDG_STATE_HOME/coordinate/queue.db`. Agents and scripts: see [`skills/coordinate/SKILL.md`](skills/coordinate/SKILL.md) — drop it into your agent's skills directory and it knows the verbs.

## Platforms

| Target | Artifact | Status |
| --- | --- | --- |
| macOS arm64 | `coordinate-*-darwin-arm64` | verified end-to-end |
| Linux x64 glibc | `coordinate-*-linux-x64-gnu` | verified, benchmarked |
| Linux x64 musl | `coordinate-*-linux-x64-musl` | static, runs everywhere |
| macOS x64 | `coordinate-*-darwin-x64` | cross-compiled |
| Windows x64 | `coordinate-*-windows-x64.exe` | best-effort smoke per release |

Building from source needs [scriptc](https://github.com/vercel-labs/scriptc) 0.4.16, pnpm and zig 0.14.1 — `mise install` in a checkout pins all three (`mise.toml`). See [`ts/build-bin.sh`](ts/build-bin.sh).

## Docs

- Architecture and design spikes: [`.agents/docs/`](.agents/docs/) — start with `ARCHITECTURE.md`
- T3 thread integration: [`.agents/docs/t3-integration.md`](.agents/docs/t3-integration.md)
- Extensibility (plugins, config bounds, self-update): [`.agents/docs/extensibility.md`](.agents/docs/extensibility.md)
- Measured performance (enqueue latency, RSS, park density): [`.agents/docs/ts-port-spike.md`](.agents/docs/ts-port-spike.md), `bench/results-*.json`

## License

[Apache-2.0](LICENSE) — © 2026 Joaquin Terrasa
