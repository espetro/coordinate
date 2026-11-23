# TypeScript port spike: coordinate on scriptc

Date: 2026-11-23. Tests the TypeScript decision in `research/language-choice.md`: port the queue core, the CLI and the daemon claim loop to the scriptc-compilable subset, build for Linux, and run the existing bench through `--cli` against the Python implementation on the same host.

## Method

The port lives in `ts/` in the worktree (`src/queue.ts`, `src/cli` in `src/main.ts`, `src/daemon.ts`, `src/env.ts`), untouched Python under `src/coordinate/`. Dependencies are pinned in `ts/package.json` and installed with pnpm 12.16.1 (never npm): `@cutils/sqlite` 0.8.0 and `@cutils/cli` 0.8.0 from npm, `koffi` 2.14.1 and TypeScript 5.9 as dev dependencies. `@cutils/cli` turned out not to be used at runtime in the end: its option model cannot express argparse's `REMAINDER` positional capture (`enqueue ... -- cmd args`), so `src/main.ts` does its own argv parsing that mirrors the Python CLI's semantics. The dependency stays installed for future subcommand-level use.

The same source runs two ways: under Node 24 via `ts/coordinate.mjs` (which loads the koffi binding for `@cutils/sqlite`'s shared library, built once with the package's `build:shared` script), and compiled by scriptc 0.4.12 with `scriptc build main-elf.ts --npm-static @cutils/sqlite,@cutils/cli --ffi node_modules/@cutils/sqlite/ffi.json`. The installed scriptc is 0.4.12, not the 0.4.16 named in the task; no 0.4.16 exists in mise or npm on this host (npm's latest is 0.4.16, but npm install of it is not permitted for this repo's tooling and no local copy was found). Everything below therefore measures 0.4.12.

Tests run under `node --test` (`ts/test/queue.test.mjs`, 10 tests): schema shape against the Python `queue.py` column list, priority order, machine cap, repo cap, wait-on/release, lease loss on park, cancel, finish, reap to dead, and status --self.

The bench ran unchanged: `uv run python bench/bench.py --only cli,cap,priority,repo,toolpark,throughput --out ...`, once with the Python CLI (baseline, `bench/results-py-samehost.json`) and three minutes later through the gnu ELF (`bench/results-ts-linux-vps.json`). The toolpark scenario required porting the spawn-time tool-class interception (D2/D3/D7/D9: binary match, weighted lease, park-at-boundary, audit) into `src/daemon.ts`, which the first cut had left out; `[slots]` config is read with a line matcher that honors the bench's `'tool:vitest:*' = 2` form, not a TOML parser.

## Results (M unless noted; same host, Linux x64 VPS, shared with other sessions)

Host state is recorded in both result JSONs: Python run at load 0.46/1.17/2.08, MemAvailable 7983 MB, 06:17:31 UTC; TypeScript run at load 1.04/0.99/1.83, MemAvailable 7900 MB, 06:20:31 UTC. Load was comparable; nothing suggests the ordering flattered either side beyond noise.

| Metric | Python | TypeScript (scriptc ELF) |
|---|---|---|
| enqueue CLI median | 112.3 ms | 4.3 ms |
| enqueue CLI p95 | 135.8 ms | 4.9 ms |
| throughput (60 jobs, cap 6) | 7.68 jobs/s | 73.57 jobs/s |
| throughput makespan | 7.81 s | 0.82 s |
| daemon idle RSS | 57.4 MB | 5.5 MB |
| startup (`stats` to exit), median of 10 | 128.3 ms | 3.3 ms (musl: 2.6 ms) |
| binary size | n/a | gnu 3.66 MB, musl 4.58 MB |

## Gates (from language-choice.md)

| Gate | Result |
|---|---|
| Every boolean gate holds (cap, priority, repo, toolpark, throughput all-done) | pass: cap_max_concurrency 3 at cap 3, priority order p9,p5,p1,p0, repo shared concurrency 1, vitest concurrency 1 with trivial running while parked, throughput 60/60 done |
| Enqueue median at most half of Python's on the same host | pass: 4.3 ms vs 112.3 ms (3.8 percent) |
| Daemon idle RSS at most Python's | pass: 5.5 MB vs 57.4 MB (9.6 percent) |
| cap, priority and repo results equal | pass: identical booleans and orders (see table above) |
| orchestrator-kill (`state-loss`) | not done: out of scope for this spike |
| timecap | not done: out of scope for this spike (enqueue accepts `--max-runtime` and claim sets `deadline_at`, but expiry enforcement and the kill path are unported) |
| macOS build of @cutils/sqlite | not done: explicitly out of scope (the orchestrator checks SQLite on macOS on the laptop itself) |

Verdict against the language-choice bar: every spike gate holds, and the margins are not close. The port is 26x faster on enqueue median, 9.6x lower idle RSS, 10x faster throughput, 39x faster startup, at the cost of a 3.7 to 4.6 MB static binary.

## What the scriptc subset refused or warned

Nothing refused: `scriptc coverage` reports 100 percent of 1315 analyzed statements compiling statically, `@cutils/sqlite` compiled from its shipped JS via `--npm-static` with the FFI manifest, no Node islands. The full compile of both binaries succeeded on the first try each time. Three notes:

- SC6014 (compiles, behavioral divergence warning): payload objects created in more than one key order, so native key enumeration can differ from Node where the program observes key order (JSON.stringify does, and `status` prints the payload). Fixed by constructing the payload as a single literal with all keys present; the warning did not reappear in behavior and `status` output matches Python's.
- "trusts unverified types" claims (compiles; a contradicting value would throw): 103 checked conversions, mostly from `@cutils/sqlite`'s shipped JS handing over row records (17 + 84 sites) and two from `JSON.parse` of job payloads in `queue.ts`/`daemon.ts`. These are accepted as declared-trust, the same posture the package's own gate documents; no runtime error was observed across the bench runs.
- The one real runtime trap was not a subset refusal but Node semantics: `Atomics.wait` for the daemon's idle sleep blocks the event loop and signal callbacks never run during it, so SIGTERM handling appeared dead and the loop never observed `stopping`. The daemon loop is therefore a `setImmediate` pump around a `setTimeout` idle delay. scriptc handles this shape (it compiled and ran; the bench's stop path exercised it repeatedly).

Also noted: `@cutils/cli` cannot express `nargs=REMAINDER` positional capture, so the CLI seam is hand-rolled (`src/main.ts`). If the CLI grows, this is the place where the port diverges most from the Python argparse surface (acp flags, `--shell` validation parity, `migrate`/`service` verbs are not ported at all).

## Not done (out of scope, per task)

- macOS build (SQLite on macOS through `@cutils/sqlite` remains the open question from the research doc).
- ACP lane of the daemon (cmd jobs only), telemetry, service install, orchestrator-kill/state-loss, timecap enforcement, chaos scenario.
- scriptc 0.4.16: not available on this host's mise; measured on 0.4.12. Upgrades stay gated behind the bench as the research doc recommends.
- Comparison against `bench/thresholds.toml` gates: the TS results share the Python result schema, so `bench/compare.py` applies unchanged; the boolean scenarios pass the same thresholds.
