# Agent instructions for `coordinate`

- Read `ARCHITECTURE.md` first. Reference docs, spikes and research live in `.agents/docs/`; new research goes in `.agents/docs/research/`, new designs in `.agents/docs/`.
- Python with `uv` only (never pip). Tests: `flock /tmp/tsc.lock uv run pytest -q`. Bench: `uv run python bench/bench.py --help`; gate with `bench/compare.py`.
- Worktrees in `$HOME/.worktrees/coordinate/<keywords>`, never inside the repo. Conventional, atomic commits, no co-author trailers. Do not push, tag or release unless asked.
- Mark numbers in docs as measured (M) or claimed (C), and record host state next to benchmark results.
- Markdown: one paragraph per line, no hard wrap, no em dashes.
- Process safety: only signal PIDs you started and verified via `/proc/<pid>/cmdline` (or `ps` on macOS). Never `pkill -f`, `killall` or `tmux kill-server`. Wrap client and server calls in spikes with `timeout`.
- Telemetry must never send from tests or CI: tests use a fake sink.
