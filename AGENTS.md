# Agent instructions for `coordinate`

- Read `ARCHITECTURE.md` first. Reference docs, spikes and research live in `.agents/docs/`; new research goes in `.agents/docs/research/`, new designs in `.agents/docs/`.
- TypeScript + scriptc only (the Python reference implementation lives on the `legacy/python` branch; never pip/uv/pytest on main). Tests: `pnpm install` once in `ts/`, then `node --test` inside `ts/`. Binaries: build with `ts/build-bin.sh` (toolchain: `mise install`, zig 0.14.1 + scriptc 0.4.16). The Python bench harness is retired; `bench/results-*.json` and `bench/thresholds.toml` are historical data only. Pending TS ports: ACP agent-session enqueue, plugins runner, service install, migrate verb.
- Worktrees in `$HOME/.worktrees/coordinate/<keywords>`, never inside the repo. Conventional, atomic commits, no co-author trailers. Do not push, tag or release unless asked.
- Mark numbers in docs as measured (M) or claimed (C), and record host state next to benchmark results.
- Markdown: one paragraph per line, no hard wrap, no em dashes.
- Process safety: only signal PIDs you started and verified via `/proc/<pid>/cmdline` (or `ps` on macOS). Never `pkill -f`, `killall` or `tmux kill-server`. Wrap client and server calls in spikes with `timeout`.
- Telemetry must never send from tests or CI: tests use a fake sink.
