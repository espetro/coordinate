# Rivet adapter shim

Implements the M4 scheduler adapter contract (`docs/tool-search-rubric.md` section 3) on Rivet 3.1.1 with a single coordinator actor.

- `daemon`: spawns `src/qserver.ts` (a rivetkit runner with the local Rust engine, filesystem storage) on a free port recorded in `rivet-fill-port` inside the run's data dir, waits until the actor answers, replays the enqueue spool, then stays in the foreground until killed. The engine puts itself in its own session, so the shim stops it by exact pid on exit and also clears an engine left behind by a crashed run of the same data dir.
- `enqueue --cwd DIR [--priority N] --shell -- CMD`: appends the job to a JSONL spool first (durable even with the engine down), then calls the coordinator's `submit` action and drops the spool record once the engine has journalled it. Prints the job id and exits 0.
- `stats`: prints the coordinator's JSON state.

Deadlines: the rivetkit client retries metadata lookups forever when the engine is down, so every call is raced against a hard deadline (default 5 s, `RIVET_FILL_DEADLINE_MS`) and the process exits non-zero with a clear error. The 30-minute hangs the first attempt at this shim produced cannot recur.

Coordinator: `src/queue.ts` holds the queue, the machine cap (`FLEET_CAP`), the per-repo cap (`FLEET_REPO_CAP`), weighted tool leases (from the `[slots]` table of `FLEET_CONFIG`) and the global priority order in one actor. rivetkit 3.x deprecated queues ("use actions and store pending work in SQLite (`c.db`)"), so this one-actor coordinator is the idiomatic replacement.

Setup: the `rivetkit` dependency and the local engine binary come from `node_modules/` (already vendored in this worktree); nothing to install.

Run: `bench/adapters/rivet/bin/rivet-fill daemon|enqueue|stats` with the `FLEET_*` environment from the contract.

Bench: `python bench/bench.py --tree . --cli "$PWD/bench/adapters/rivet/bin/rivet-fill" --backend custom --only cli,idle,throughput,cap,repo,priority,toolpark --out bench/results-rivet-fill-vps.json`. Results and the method are in `docs/rivet-spike.md`.
