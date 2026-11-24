# TypeScript port regression audit

Date: 2026-11-23. Branch `audit/ts-port-regressions`, cut from local `main` (1845496). Compares the retired Python implementation (`legacy/python`, 4e371ef, read-only worktree) with the TypeScript port (`src/queue.ts`, `src/daemon.ts`, `src/main.ts`, `src/env.ts`, `src/forwarder.ts`). Product code was not changed in this task. Reproducer tests are in `test/regressions.test.mjs` (see `ts-port-test-gap.md` for the pytest coverage map).

## How this was measured

- Every runtime result below is (M) measured on one host: macOS arm64, Node 26.13.1, Python 3.14.10 for the legacy CLI. TypeScript was run as `node bin/coordinate.mjs ...`, which is the path `pnpm test` exercises. The scriptc binary could not be built here (`clang` link error: `libsqlite3-shim.a` is not a Mach-O archive on this host), so nothing below was observed on the compiled binary. Behavior that depends on Node semantics (the unhandled `error` event in D2, the signal handling in D4) needs a re-run on the real binary before a fix is scoped.
- Python side: `PYTHONPATH=<legacy>/src python3 -m coordinate ...`. The legacy suite (`uv run pytest`, pilot tests excluded because they need real agents) passed 95 of 95 (M), so Python behavior is the oracle.
- Each experiment used its own `COORDINATE_DB`, `COORDINATE_CONFIG`, `COORDINATE_MACHINE=audit`, so nothing touched the user's real queue. Daemons were started and stopped by exact PID. A real `coordinate daemon` was already running on this host in tmux; it was not touched.
- Reviewer file paths and line numbers were stale. Line numbers below are for this branch (TypeScript) and for 4e371ef (Python).

## Verdicts on the reviewer findings

| ID | Verdict | Class | One line |
|---|---|---|---|
| A1 | FIXED (cdea415) | REGRESSION | `--slot` keys get lease rows but `claim()` never checks their limit |
| A2 | PARTIAL | DRIFT | The `--cwd` fallback is Python behavior and was documented there; the empty `--repo` handling is new |
| A3 | PARTIAL | REGRESSION (string form), not a regression (`cmd /c`, quoting) | `sh -c 'vitest run'` as a string is missed in TS and matched in Python; `cmd /c` was never in Python |
| A4 | PARTIAL | not a regression | Behavior is identical (matched spawns only); the over-claiming comments are in the Python code, TS has none |
| B5 | CONFIRMED | INTENTIONAL | `--acp` is not ported; documented in `python-retirement.md` and `ARCHITECTURE.md` |
| B6 | REFUTED | INTENTIONAL | The events bridge was merged and the forwarder was ported (`src/forwarder.ts`, `coordinate forward --exec`) |
| B7 | CONFIRMED | INTENTIONAL | `coordinate plugins` is not ported; documented |
| B8 | FIXED (3a60c42) | REGRESSION (silent failure mode), parser limits INTENTIONAL | Hand-rolled TOML handles 4 of the 10 spellings tried (single-quoted keys only); a miss turns heavy jobs into `failed` |
| C9 | CONFIRMED | doc bug in both | Only lease expiry retries; exit != 0 goes straight to `failed` |
| C10 | CONFIRMED | doc bug in both | Only `tool:` slot keys are released by a finishing job |
| C11 | FIXED (TS) | feature gap in both, closed in TypeScript | `run_at` had no CLI flag in either implementation; the TypeScript CLI now takes `--run-at DUR\|ISO` |
| C12 | CONFIRMED | latent bug in both | `attempts` counts claims, so park and release cycles burn the retry budget |
| S1 | FIXED (4aee3c8) | DRIFT | Schema default `attempts DEFAULT 3` vs Python `DEFAULT 0`; the schema test compares names only |
| S2 | FIXED (d7fbf80) | doc bug in both | `SKILL.md` said lower priority first; both implementations claim `priority DESC` (higher first) |

Disagreements with the reviewer are collected in the last section of this file.

### A1: explicit `--slot` keys are never limit-checked (CONFIRMED, REGRESSION)

- TypeScript: `src/queue.ts:204-209` only tests keys that start with `repo:`. `slotKeys()` (`src/queue.ts:130-142`) appends the explicit slots, `claim()` inserts a lease row for each (`src/queue.ts:236-240`), but nothing ever compares them against `slotLimit`.
- Python: `queue.py:317-319` skips a job when `q_used_cost(c, k) + 1 > slot_limit(k)` for every key that is not `machine:` or `repo:`.
- Reproduction (queue module, `COORDINATE_CAP=3`, two jobs with `slots: ["tool:vitest:x"]`, no cwd so no repo key):

```
TS claim1 1 claim2 2
PY claim1 (1, 'cmd', {...}) claim2 None
```

- Python's own `test_slots.py` (4 tests) depends on this and has no TypeScript equivalent. The `tool:<class>:<project>` keys that the spawn interception creates itself are unaffected, so the bench's toolpark scenario cannot see the gap.

### A2: `repo:` falls back to `--cwd` (PARTIAL, DRIFT)

- The fallback is not new. Python `queue.py:273` is `payload.get("repo") or payload.get("cwd")`, TypeScript `src/queue.ts:132` is the same rule, and Python's `--help` documented it (`cli.py:40`, "per-repo cap key (default: cwd)"). The TypeScript CLI has no per-flag help at all, so the default is now undocumented. Launcher jobs that spawn worktrees serialize on the launcher's key in both.
- Reproduction (queue module; claims for two jobs per row):

```
                                     TS            PY
same cwd, no --repo                  [1, null]     [1, None]
same cwd, distinct --repo            [3, 4]        [3, 4]
payload.repo = "" (stored by TS CLI) [5, 6]        [5, None]
```

- Empty `--repo ""` does differ. Python's CLI drops the empty value (`cli.py:125`), so the job falls back to cwd. The TypeScript CLI stores `repo: ""` (`src/main.ts:106-108`), and `slotKeys` treats an empty string as "no repo key" (`src/queue.ts:132-135`). It is now the only way to opt out of repo serialization. That is a useful accident, not a documented feature. Classified DRIFT.

### A3: `argv0Of` parsing (PARTIAL)

- `cmd /c`: never in Python (`daemon.py:57` only knows `sh|bash|zsh`). The TypeScript port added a Windows spawn path (`src/daemon.ts:15`, `:285-287`) without teaching `argv0Of` about it. Not a regression, but the Windows path has no tool-class matching for `cmd /c vitest`.
- Split on a single space: REGRESSION for the string form. Python uses `shlex.split` at both levels (`daemon.py:50`, `:60`). TypeScript uses `split(" ")` (`src/daemon.ts:236`, `:246`), so the inner token keeps its quote.
- Reproduction (fake `vitest` on PATH, `[slots] 'tool:vitest:*' = 2`, two jobs with different `--repo`, same cwd; the second job should park):

```
variant                                   TS               PY
vitest run (array)                        2 waiting        2 waiting
--shell "vitest run"                      2 waiting        2 waiting
--shell "sh -c 'vitest run'"              2 running  <--   2 waiting
-- sh -c "vitest run" (array)             2 waiting        2 waiting
--shell "'/path/my vitest' run"           2 running        2 running   (both miss)
```

  With the `<--` case TypeScript writes no `spawn_audit` row and applies no tool lease: heavy tools run unthrottled. `sh -c 'cd x && vitest'` is missed by both (inner argv0 is `cd`), and a quoted path with a space is missed by both, so the reviewer's other two examples are not regressions.

### A4: spawn audit scope (PARTIAL, not a regression)

- Both implementations audit only a matched class: Python `daemon.py:97-98` (the audit row is written after `m is None` returns early), TypeScript `src/daemon.ts:262-266`.
- The over-claiming text is in Python: `daemon.py:87` ("Every spawn of a matched binary (heavy or unmatched) is audited") and `queue.py:159` ("every heavy match and every unmatched spawn of a heavy-class binary"). `grep -n audit src/*.ts` finds no such comment in the TypeScript code.
- The real gap is against the design: `toolcaps-design.md` D9 promises an audit of unregistered heavy-binary spawns seen in a job's process tree. Neither implementation does that. The Python test `test_unmatched_tool_audited_never_blocked` asserts `audit == []` for an unmatched tool, which contradicts its own name.

### B5, B6, B7: Python-only surfaces

- B5 `--acp`: CONFIRMED, INTENTIONAL. The TypeScript CLI answers `enqueue: unknown option --acp` (exit 1) instead of silently ignoring it. Python accepted it. Documented: `python-retirement.md`, `ARCHITECTURE.md` status paragraph.
- B6 forwarder: REFUTED. `merge/events-bridge` is an ancestor of `main`. `src/coordinate_t3_forwarder.py` (still present on `legacy/python`) was replaced by `src/forwarder.ts` and the `coordinate forward --exec` verb (commits `cac634d`, `036b577`), with the T3 sink deliberately made generic. INTENTIONAL. One bug survived the port, see X14.
- B7 `plugins`: CONFIRMED, INTENTIONAL (`python-retirement.md`, "Portable now" item 2). The TypeScript CLI answers `unknown verb: plugins`.

### B8: hand-parsed `[slots]` (CONFIRMED, REGRESSION in its failure mode)

- `src/daemon.ts:32-59` reads `[slots]` line by line. `ts-port-spike.md` documents this ("a line matcher that honors the bench's `'tool:vitest:*' = 2` form, not a TOML parser"), so the limitation is INTENTIONAL. What was not documented is the failure mode: a key spelled any other valid way gets limit 1, and a heavy class costs 2, so `cost > slotLimit` marks the job `failed` (`src/daemon.ts:268-272`) with no outcome and no message.
- Reproduction (`slotLimit("tool:vitest:/p")` with the config body in the first column; `config.toml` is read by `tomllib` in Python):

```
config body                              TS   PY
'tool:vitest:*' = 2                      2    2
"tool:vitest:*" = 2  (double quotes)     1    2
'tool:vitest:*' = 2 # two                1    2
[slots] # limits (header comment)        1    2
'tool:vitest:*' = 2_0                    1    20
slots = { 'tool:vitest:*' = 2 }          1    2
slots.'tool:vitest:*' = 2                1    2
```

- End to end with the double-quoted form and two `vitest` jobs: TypeScript `status: 1:failed 2:failed`, Python `1:running 2:waiting` (the expected park). A user who writes standard TOML loses both jobs.
- Related and undocumented: the `[tools]` overlay (`queue.py:75-82`, used by `test_spawn_shim.py` for a custom `sqlload` class) is gone (`toolClasses()` returns the constant, `src/daemon.ts:86-88`), and `[defaults] max_runtime` is gone (X6).

### C9: retries (CONFIRMED, doc bug in both)

- `README.md:34` ("`--max-attempts` retries a failed job and sends it to a dead-letter state after the last attempt") and `skills/coordinate/SKILL.md:46` ("retries to `--max-attempts`, then `dead`"). Only `reap()` requeues (`src/queue.ts:296-304`, `queue.py:472-479`), and only on lease expiry. A non-zero exit goes to `failed` and stays there (`src/daemon.ts:333`, `daemon.py:282`). `dead retry` revives both `failed` and `dead` (`src/queue.ts:352`, `queue.py:555`).
- Reproduction: `enqueue --max-attempts 3 -- false`, run the daemon. Both: `1|failed|1|3`.

### C10: `--wait-on` and job completion (CONFIRMED, doc bug in both)

- `README.md:33` says `--wait-on <event>` holds a job "until `release <event>` or until a dependency finishes". `finish()` returns only a `tool:` key and the daemon releases only that (`src/queue.ts:271-279`, `src/daemon.ts:332-337`; `queue.py:443-451`, `daemon.py:282-288`). There is no dependency edge.
- Reproduction: job 1 fails, jobs parked on `1` and `done:1` stay `waiting` with no `released` event, in both implementations.

### C11: `run_at` has no flag (FIXED in TypeScript, gap in Python)

- Honored at claim (`src/queue.ts:197`, `queue.py:309`) and accepted by `enqueue()` (`src/queue.ts:158`, `queue.py:280`), but neither CLI exposed it when the audit was written (`coordinate --help` in Python lists no such flag; `src/main.ts:70-97` had none). The TypeScript CLI now takes `--run-at <delay|ISO timestamp>`, e.g. `--run-at 15m` or `--run-at 2026-11-23T18:00:00Z`, and stores it in `run_at`; the value is rejected loudly when malformed. Python keeps the gap, since it is retired. Tests: "C11: --run-at stores a future epoch second (duration form)", "C11: --run-at accepts an ISO timestamp", "C11: a malformed --run-at fails loudly" in `test/regressions.test.mjs`.

### C12: `attempts` inflates on park and release (CONFIRMED, latent bug in both)

- `claim()` does `attempts=attempts+1` on every claim (`src/queue.ts:229`, `queue.py:331`) and `waitOn`/`release` never give it back.
- Reproduction (`max_attempts=2`, three claim, wait-on, release cycles, then one lease expiry):

```
TS attempts after 3 park/release cycles: 3 max_attempts 2 -> status after lease expiry: dead
PY attempts after 3 park/release cycles: (3, 2)          -> status after lease expiry: dead
```

- A job that parks on a busy tool slot (D7) spends an attempt each time it is woken, so a heavy job can reach `dead` on its first real lease loss. The park path is the hot path for tool slots, so this is not a rare cycle.

### S1: schema default drift (CONFIRMED, latent)

- `src/queue.ts:38` has `attempts INTEGER NOT NULL DEFAULT 3`; `queue.py:195` has `DEFAULT 0`. `enqueue()` writes `attempts` explicitly (`src/queue.ts:163`), so the TypeScript CLI is unaffected. A row inserted without `attempts` (an older script, a bench fixture, a test that INSERTs directly) would start at 3 and be `dead` after its first lease expiry in TypeScript. `CREATE TABLE IF NOT EXISTS` means an existing database keeps whichever default it was created with, so two databases created by the two implementations now disagree silently.
- The test "schema matches the Python queue.py tables" (`test/queue.test.mjs:132-142`) selects `name` from `pragma_table_info('jobs')` and compares a sorted list of names. It cannot see types, NOT NULL, defaults or the status CHECK. Fix: select `name, type, "notnull", dflt_value` and compare to a literal table, and assert `sqlite_master.sql` for `jobs` contains `'timed_out'`. A tightened version is part of the fix list. It is a one-test change, and it would fail today on `attempts`.

### S2: priority direction (FIXED, doc bug in both)

- `skills/coordinate/SKILL.md:44` used to say "Lower `--priority` claims first". Both implementations claim `ORDER BY priority DESC, run_at, id` (`src/queue.ts:197`, `queue.py:309`; Python's README said "FIFO by priority desc, run_at, id"). Higher numbers run first. The Python skill file carried the same wrong sentence, so this was a documentation bug that predated the port. Fixed in d7fbf80 for `skills/coordinate/SKILL.md`, `docs/cli.md` and `docs/concepts.md`. The test "enqueue + claim respects priority" asserts 9, 5, 0 order, and "S2: docs and skill say higher priority claims first" in `test/regressions.test.mjs` now fails if the wording flips back. The claim order itself is unchanged in every implementation.

## Differences found by walking the Python modules

Classes: REGRESSION (worse than Python, not chosen), DRIFT (different but neutral), INTENTIONAL (documented in `python-retirement.md`, `ts-port-spike.md` or `ARCHITECTURE.md`), IMPROVEMENT. Regressions are listed first, ranked by user impact; each regression quotes its measurement. The D table is code reading unless a measurement is quoted.

### Regressions, ranked

| Rank | ID | Module | Difference | Impact |
|---|---|---|---|---|
| 1 | X1 | daemon | `projectKey` breaks on every real git worktree | The repo-keyed tool caps, the stated reason for `project_key`, do not hold across T3/Orca worktrees |
| 2 | X2 | daemon | A missing binary or missing `cwd` crashes the whole daemon | One bad job takes down every running job's supervisor |
| 3 | X3 | queue | `reap()` no longer kills surviving process groups before requeue | Duplicate concurrent runs of the same job after any daemon crash |
| 4 | X4 | daemon | SIGTERM freezes the daemon instead of stopping it | `systemctl stop` hangs; jobs lose heartbeats and get re-run |
| 5 | A1 | queue | `--slot` limits are not enforced | Advertised tool-level serialization does nothing |
| 6 | B8 | daemon | `[slots]` hand parser, `[tools]` overlay dropped | Standard TOML silently fails heavy jobs |
| 7 | X5 | queue | FIXED (dad1bd3) — schema migration with a timestamped backup | A pre-existing `queue.db` makes every verb throw |
| 8 | X6 | FIXED (4aee3c8) | cli | `[defaults] max_runtime` dropped; bad durations accepted | Jobs are unbounded by default; `--max-runtime xs` stores NULL |
| 9 | A3 | daemon | FIXED (2a95440) — shlex-style splitter in `argv0Of` | Heavy tools escape throttling |
| 10 | X7 | daemon | FIXED (8380db9) — stdout and stderr inherited | Job output vanishes (Python inherited the daemon's streams) |
| 11 | X8 | cli | FIXED (6c9d7b3) — derived fields restored on `status <id>` and `--self` | The agent contract's self-inspection is poorer |
| 12 | X9 | cli | FIXED (bbeeb7a) — `--opt=value`, REMAINDER, typed ints; X14 fixed in the same commit (forwarder cursor advances only after a successful send) | Scripts written for Python fail with `unknown option` or a stack trace |

#### X1: git worktree project key (REGRESSION, highest impact)

- `src/daemon.ts:146` does `path.join(d, gitdirLine)` and `:160` does `path.join(d, out)`. Python uses `os.path.join`, which discards the first argument when the second is absolute (`queue.py:133-134`, `:148`); `path.join` concatenates. `git worktree add` always writes an absolute `gitdir:` line, so the `commondir` read at `:151` fails, the catch falls to the `git rev-parse` probe, and the probe's absolute answer is concatenated the same way.
- Reproduction (main repo `/private/tmp/audit/pk/main`, `git worktree add ../wt`, `.git` file reads `gitdir: /private/tmp/audit/pk/main/.git/worktrees/wt`; two `vitest` jobs, `[slots] 'tool:vitest:*' = 2`, distinct `--repo`):

```
== ts   1:running 2:running   spawn_audit projects: /private/tmp/audit/pk/main ; /private/tmp/audit/pk/wt/private/tmp/audit/pk/main
== py   1:running 2:waiting   spawn_audit projects: /private/tmp/audit/pk/main ; /private/tmp/audit/pk/main
```

- The worktree gets a garbage key, so each worktree has its own `tool:<class>:<key>` slots. `ARCHITECTURE.md` ("every worktree of one repo shares the repo key") describes the Python behavior. The plain-repo and non-repo cases work. Python's six `test_project_key.py` tests have no TypeScript counterpart.

#### X2: spawn errors crash the daemon (REGRESSION, FIXED in 6e88a4d)

- `spawnRaw` (`src/daemon.ts:280-292`) uses `cp.spawn`, which reports ENOENT asynchronously as an `error` event. No listener is attached, so Node throws. The comment at `:369` ("a missing binary exits with code 127 via sh") is true only for the string form. Python's `Popen` raised `OSError` synchronously and the loop recorded `failed` (`daemon.py:307-309`).
- Reproduction (array form is the default for `enqueue -- cmd args`):

```
enqueue -- /nonexistent/binary-xyz arg      TS: daemon dies, job stays running   PY: failed
enqueue --cwd /nonexistent/dir -- true      TS: daemon dies, job stays running   PY: failed
enqueue --shell -- '/nonexistent/b arg'     TS: failed (sh exits 127)            PY: failed
TS log: Error: spawn /nonexistent/binary-xyz ENOENT ... Unhandled 'error' event
```

- The job row is left `running` with no heartbeat, so after the lease it is requeued, crashes the next daemon, and so on until `attempts` reaches `max_attempts`. Every other running job loses its supervisor each time.

#### X3: `reap()` leaves orphans (REGRESSION, FIXED in 42f9df5)

- Python kills the old process group and any agent pid-file group before requeueing (`queue.py:386-408` `kill_orphans`, called at `:463-465`). `src/queue.ts:282-311` never signals anything, and `setProc` no longer records a pid file. Python's `test_orphans.py` and `test_acceptance.py::test_kill9_daemon_mid_job_retries` cover it.
- Reproduction (`LEASE_S=2`, job `sleep 311`, `kill -9` the daemon, wait for lease expiry, start a second daemon):

```
== ts   first attempt pid 42270 -> after reap: 42270 sleep 311 and 43089 sleep 311  (two copies), events: enqueued claimed requeued claimed
== py   first attempt pid 78253 -> after reap: 80019 sleep 311 only (old group killed), same events
```

#### X4: SIGTERM freezes the daemon (REGRESSION, FIXED in 265f362)

- `src/daemon.ts:325-331` sets `stopping`, but `stopping` is only acted on at the top of `loop()` (`:340-345`), and the idle pump (`:416-425`) returns without rescheduling `loop` when `stopping` is set. The kill-children and `db.close()` branch is therefore unreachable in practice. The process stays alive while a child handle is open, never heartbeats again, and never finishes the job.
- Reproduction (`LEASE_S=3`, job `sleep 313`, `kill <daemon pid>`, 4s later):

```
ts: daemon alive [5293], sleep 313 alive, lease_expires_at - now = -0.70s (heartbeat stopped)
py: daemon gone, sleep 313 alive (documented "agents survive" behavior)
```

- `ARCHITECTURE.md` says daemon stop leaves agents alive, which was true for Python. The `ts-port-spike.md` note about `Atomics.wait` explains the pump shape but the spike only stopped idle daemons. With no running child the process does exit (about 2s, the idle timer).

#### X5: no database upgrade path (REGRESSION)

- `connect()` runs `CREATE TABLE IF NOT EXISTS` only (`src/queue.ts:117-128`). Python also runs `_migrate_jobs` (rebuild for the `timed_out` CHECK, `queue.py:245-268`) and `ALTER TABLE ADD COLUMN` for `pgid, pidfile, max_runtime_s, runtime_used_s, deadline_at, claim_at, outcome` (`:236-241`), tested by `test_old_database_is_migrated_and_keeps_rows`.
- Reproduction (DB created with the pre-timecap `jobs` schema, then `enqueue --max-runtime 5s -- true`): TS `SqliteError: table jobs has no column named max_runtime_s`; PY enqueues and keeps the existing row. The author's own `~/.local/state/coordinate/queue.db` from the Python era is the likely victim.

#### X6: `[defaults] max_runtime` and duration validation (REGRESSION)

- Python resolves a default cap from config (`queue.py:177-180`, `cli.py:12-21`) so "no job is unbounded unless capped at 0". TypeScript has no config reader in the CLI. Reproduction with `[defaults] max_runtime = "15m"`: TS stores `max_runtime_s=` (NULL), PY stores `900.0`.
- `parseDuration` (`src/main.ts:18-30`) validates only the no-suffix path. `--max-runtime xs` yields `NaN`, stored as NULL: the job is silently unbounded (PY: `bad duration 'xs'`, exit 1). `--priority abc` escapes as an uncaught `SqliteError` stack trace (PY: argparse error).

#### X7: job stdio (REGRESSION, arguable)

- `spawnRaw` passes `stdio: "ignore"` (`src/daemon.ts:282`). Python used the default (inherit), so a job's output reached the daemon's stdout and from there the service log. Reproduction: `sh -c 'echo OUT-FROM-JOB; echo ERR-FROM-JOB >&2'`: PY daemon log has both lines, TS daemon log is empty. Stderr of `/bin/sh` failures (`No such file or directory`) is lost the same way.

#### X8: `status` derived fields (REGRESSION)

- Python adds `runtime_remaining_s` and `deadline_in_s` (`cli.py:24-31`, asserted by `test_status_prints_deadline_runtime_and_remaining`). TypeScript prints the raw row (`src/main.ts:137`). `ts-port-spike.md` says `status` output matches Python's; it does not (the payload JSON also differs, see D8). Python also selected a column subset; TypeScript prints every column including `created_at`, `claim_at` and `pidfile`.

#### X9: CLI parsing parity (REGRESSION, low)

- Hand-rolled parser (`src/main.ts:67-97`). `--cwd=/tmp` gives `enqueue: unknown option --cwd=/tmp`; `enqueue --priority 1 echo hi` (no `--`) gives `unknown option echo`; PY accepts both. A missing value (`--cwd` as the last token) stores `undefined`. Also no per-verb `--help`.

### Differences that are not regressions

| ID | Class | Difference |
|---|---|---|
| D1 | DRIFT | Claim loop sets `busy = true` after any claim (`src/daemon.ts:398`), Python only on park or failure (`daemon.py:305-309`), so TypeScript polls at 50ms for longer after claiming. Neutral to slightly better latency, slightly more CPU while busy |
| D2 | DRIFT | `jobEnv` strips every inherited `COORDINATE_*` and `FLEET_*` variable before setting its own (`src/daemon.ts:212-227`); Python copied the environment and overrode four names (`daemon.py:129-142`). A job that runs `coordinate` loses `COORDINATE_CONFIG`, `COORDINATE_CAP` and similar |
| D3 | INTENTIONAL | `COORDINATE_DEADLINE_AT` is not exported to jobs (`ARCHITECTURE.md`, "not ported yet"); Python asserts it in two tests |
| D4 | DRIFT | Timecap kill is `SIGTERM` to the group only (`src/daemon.ts:353-361`); Python sends TERM, waits `COORDINATE_TIMECAP_TERM_S` (10s), then KILL (`daemon.py:207-242`). A job that ignores TERM was still killed in the experiment, but only because the heartbeat of a timed-out job fails and `killGroup` sends KILL one `LEASE_S/3` later (M: `trap "" TERM` job gone within 12s at `LEASE_S=3`). Works by accident of the heartbeat path, and `COORDINATE_TIMECAP_GRACE_S` and `COORDINATE_TIMECAP_TERM_S` have no effect |
| D5 | DRIFT | Timecap outcome text is `max runtime exceeded` (`src/daemon.ts:352`); Python writes `max runtime exceeded (cap 2.0s)` (`daemon.py:260`) |
| D6 | DRIFT | `COORDINATE_BACKOFF_MIN` and `COORDINATE_BACKOFF_MAX` are ignored (`src/daemon.ts:13-14`, constants). The bench used them to measure wake latency |
| D7 | DRIFT | `release` and `dead retry` print one id per line and nothing when empty (`src/main.ts:151-155`, `:210-216`); Python prints ids space-separated on one line, and an empty line when none (`cli.py:154`, `:175`). Breaks scripts that `read` the line |
| D8 | DRIFT | Stored payload gains `"repo":null,"slots":null,"session":null` (`src/main.ts:105`); intentional for scriptc key order (`ts-port-spike.md`, SC6014) |
| D9 | DRIFT | Forwarder default cursor file is `forward-cursor`, was `t3-forwarder-cursor` (`src/forwarder.ts:19`); an old cursor is ignored and history is replayed on first run |
| D10 | DRIFT | `COORDINATE_CAP=abc` is `NaN` in TypeScript (`src/queue.ts:16`), so the daemon never claims; Python `int()` raised at startup |
| D11 | INTENTIONAL | ACP lane: `kind='acp'`, `spawn_acp`, `set_session`, pid-file bookkeeping, session cancel, `--acp/--prompt/--registry/--model` |
| D12 | INTENTIONAL | `coordinate migrate`, `~/.fleet` legacy fallback and notice, runtime dir and log dir resolution (`paths.py:41-60`, `:62-107`); `ARCHITECTURE.md` says "the TypeScript port does not do this yet" |
| D13 | INTENTIONAL | `coordinate service install/uninstall/status`, `plugins`, and the `coordinated` entry point (`grep coordinated install.sh scripts .github README.md` finds nothing: the daemon is `coordinate daemon`, although `ARCHITECTURE.md` still names a `coordinated` binary) |
| D14 | INTENTIONAL | Forwarder sink is generic `--exec` instead of `t3 thread send` (`cac634d`) |
| D15 | IMPROVEMENT | Windows paths and spawn (`src/env.ts:15-39`, `src/daemon.ts:15`, `:283-287`, `:299-308`) |
| D16 | IMPROVEMENT | Forwarder persists the cursor for filtered-out events (`src/forwarder.ts:105-108`), so a restart does not rescan them |
| D17 | IMPROVEMENT | Unsupported flags fail loudly (`unknown option`), and measured speed and memory (`ts-port-spike.md`, M: 4.9ms enqueue, 5.9MB idle RSS) |

### Defects present in both implementations (found while walking, not regressions)

- X14 forwarder retry: on sink failure the cursor file does not advance but the in-memory cursor does (`cur = r.id` before the send, `src/forwarder.ts:106`; Python `cur = ev["id"]` before `t3_send`). The `break` then leaves the failed event behind for the rest of the process lifetime. The "retried on the next poll" comment and `events-bridge.md` are only true across a restart. Reproduction (TypeScript; sink fails its first call, interval 0.3s, events 2 and 3): sink calls 2, delivered ids `2 3`, event 2 was sent once and never retried; the cursor file ends at 3.
- Python's `test_unmatched_tool_audited_never_blocked` asserts an empty audit for an unmatched tool while its docstring says unmatched tools are audited.
- Python daemon `finally` kills children on `KeyboardInterrupt` only; SIGTERM leaves them (this is the "agents survive" behavior the docs describe).

## Reproducer results

`test/regressions.test.mjs` has 16 tests, all marked `{ todo: ... }`, so they run but do not fail CI. Result of `flock /tmp/tsc.lock pnpm test` (M): `tests 31, pass 15, fail 0, todo 16`, exit 0. All 16 todo tests fail today for the reason in their message (TAP shows `not ok N - ... # TODO`).

| Test | Finding | Fails today because |
|---|---|---|
| A1 | A1 | second `--slot` job on a limit-1 key is claimed |
| B8 | B8 | 5 of 5 other TOML spellings give limit 1 |
| S1 | S1 | `attempts` default is `3`, expected `0` |
| X5 | X5 | `SqliteError: table jobs has no column named max_runtime_s` |
| X6 default | X6 | `max_runtime_s` is NULL, expected 900 |
| X6 malformed | X6 | `--max-runtime xs` exits 0 |
| X8 | X8 | `runtime_remaining_s` missing |
| X9 `--opt=value` | X9 | `unknown option --cwd=...` |
| X9 no `--` | X9 | `unknown option echo` |
| X1 | X1 | two project keys, the worktree one is `<wt>/<abs main path>` |
| A3 | A3 | second `sh -c 'vitest run'` job runs instead of parking |
| X2 missing binary | X2 | daemon exits on `spawn ... ENOENT` |
| X2 bad cwd | X2 | daemon exits |
| X3 | X3 | old process group still alive after the retry claimed |
| X4 | X4 | daemon alive 6s after SIGTERM |
| X7 | X7 | daemon log has no job output |

The assertions were checked against the oracle: `REGRESS_PYTHON_SRC=<legacy>/src node --test test/regressions.test.mjs` runs the CLI and daemon tests against `python3 -m coordinate` instead of the TypeScript CLI. 13 of 13 CLI and daemon tests pass there (M), so each assertion describes behavior Python really had. The three in-process tests (A1, B8, S1) import TypeScript modules and only make sense for TypeScript; their Python behavior is shown in the A1, B8 and S1 sections above.

Not covered by a reproducer, on purpose: C9, C10, C11, C12, S2 and A4 (bugs or gaps in both implementations, not regressions; they need a decision, then a fix and a test), D3 (documented as unported), X14 (present in both). Daemon tests take about 18s in total because they wait on real leases (`COORDINATE_LEASE_S=2` or `3`).

## Ranked fix list

Sizes are rough (lines changed including tests; risk is the chance of breaking existing behavior). Order assumes one person, safest and most damaging first.

| # | Fix | Size | Risk | Notes |
|---|---|---|---|---|
| 1 | X2: attach `proc.on("error")` in `spawnRaw`; on error call `finish(..., "failed")` and drop the entry | 15-25 | low | Add a `spawned` check for `proc.pid === undefined`. Verify on the scriptc binary, not only Node |
| 2 | X1: use `path.resolve(d, x)` for the two joins in `projectKey` | 3-6 | low | Add worktree tests; the plain and non-repo paths are unchanged |
| 3 | X3: record the pgid at claim and kill it in `reap()` before the requeue UPDATE | 25-40 | medium | Signal only pgids recorded by this DB, guard `pid > 1`; same caveat about PID reuse as Python's docstring. Needs a PID start-time check ideally |
| 4 | A1: add the `slotLimit` check to `claim()` for non-machine, non-repo keys | 15-25 | medium | `slotLimit` lives in `daemon.ts`; move the config reader into `queue.ts` or a new `config.ts` first (shared with 5 and 8) |
| 5 | B8: parse `[slots]`, `[tools]`, `[defaults]` with a real TOML subset (or a small vendored parser), fail loudly on unreadable config | 120-200 | medium | Also fixes X6 default cap; fail the enqueue or daemon start on parse errors rather than defaulting |
| 6 | X4: act on `stopping` inside the pump, and decide the stop contract (leave agents running, as `ARCHITECTURE.md` says, or kill them) | 15-30 | medium | Decide first, then make the docs and code agree; unref child handles if agents must survive |
| 7 | X5: port `_migrate_jobs` and the `ALTER TABLE` column adds | 40-60 | medium | Backup first; test with the Python test's old DDL |
| 8 | A3: replace `split(" ")` with a shlex-style splitter | 25-40 | low | Keep `sh -c` unwrapping; add `cmd /c` for the Windows path only if the Windows lane stays |
| 9 | X7: inherit stdio (or append to `logs/`), X8: restore the two derived `status` fields, X9: `--opt=value` and no-`--` parsing, `parseDuration` NaN | 60-100 total | low | Mechanical; can go in one commit each |
| 10 | S1: make the schema default `0`, and tighten the schema test to compare type, notnull, default and the CHECK clause | 10 | low | The test will fail on the default until fixed |
| 11 | Docs: C9, C10, S2, A2 flag help, A4 comments; D7 decide a canonical output format | 20 | none | Python and TypeScript docs both wrong on C9, C10, S2 |
| 12 | C12: stop counting park and release cycles against `max_attempts` (decrement on `waitOn`, or count only reaped leases) | 5-10 | medium | Behavior change shared with Python; decide intent first |
| 13 | X14: advance the in-memory cursor only after a successful send | 3 | low | Bug exists in both |
| 14 | C11: a `--run-at DUR\|ISO` flag so scheduled jobs are possible from the CLI (`run_at` is honored at claim in both implementations, only the flag is missing) | 20-30 | low | DONE in TypeScript: `--run-at` accepts a delay or an ISO timestamp (`src/main.ts`), tests in `test/regressions.test.mjs` |

Recommended order: 1, 2, 3 (data and process safety), then 5 with 4 (one config module, one PR), then 6, 7, 8, 9, 10, 11. Items 12 and 13 are cheap and can ride along. Total for 1 to 10 is about 350 to 550 lines.

## Where this audit disagrees with the reviewer

- A2 is not a regression and the "launcher serialization" is Python's design; the only new behavior is the empty `--repo`, which is arguably useful. Fix the documentation, not the code.
- A3: two of the three examples (`sh -c 'cd x && vitest'`, quoted first argument) fail identically in Python (shlex does not rescue them either), and `cmd /c` was never in Python. Only the string-form `sh -c 'vitest run'` is a regression.
- A4: the comment claim is about the Python code. TypeScript has no such comment; behavior is identical. The real gap is D9 in the design, in both.
- B6 is wrong: the bridge is merged and ported. The reviewer missed `src/forwarder.ts`.
- B5 and B7 are real but already documented; they should not be counted as regressions.
- B8 understates the problem: the parser is documented as limited, but the failure mode (heavy jobs silently `failed`) is not, and the double-quoted spelling is the most common one.
- C9, C10, C12 are real but are bugs in both implementations (docs and counting), not port regressions. They should be filed separately from the port audit.
- The reviewer's list omitted the four most damaging items: X1 (worktree project key), X2 (daemon crash on spawn error), X3 (orphan reap), X4 (SIGTERM freeze). All four were found by walking the Python modules against the TypeScript ones, and all four have Python tests with no TypeScript counterpart.
- The reviewer implied heavy-tool matching is the main hole. In fact A1 plus X1 together mean the TypeScript port enforces tool caps in fewer situations than any of the reviewer's findings suggest.

## Fixes on fix/daemon-process-safety (2026-11-23)

X2, X3 and X4 are fixed and enforced on this branch. X2 (6e88a4d) attaches the child `error` handler in `spawnRaw` before the pid check (Linux reports ENOENT with pid already undefined and the event arrives on the next tick), treats `proc.pid === undefined` as a failed spawn, finishes the job as `failed` with an outcome naming the error, releases its tool slot event, and keeps the claim loop running. X3 (42f9df5) ports Python's `kill_orphans`: `reap()` now SIGKILLs the recorded process group before the requeue UPDATE commits, guarding pid <= 1, signalling the group (negative pgid), and ignoring ESRCH, with the PID-reuse caveat in a comment. X4 (265f362) makes SIGTERM and SIGINT unref the running child handles, close the database and exit without killing children, per the stop contract ARCHITECTURE.md already stated (agents keep working when the orchestrator stops); the durability paragraph now describes this exactly. The three todo reproducers in `test/regressions.test.mjs` are enforced; `pnpm test` is 31 tests, 19 pass, 0 fail, 12 todo (M, Node 24.22.1, Linux x64). The fixes were also exercised on the scriptc binary (dist/coordinate-0.1.0-linux-x64-gnu): the daemon survives a missing-binary spawn with the job `failed` / `spawn failed`, SIGTERM exits the daemon while the sleeper survives, and a kill -9 of the daemon mid-job leaves the old process group dead after the retry is claimed (M).

## Fixes on fix/cli-and-migration (2026-11-23)

X5 (dad1bd3) ports `_migrate_jobs` and the `ALTER TABLE` column adds into `connect()`: a jobs table whose CHECK predates `timed_out` is rebuilt in one transaction with every shared column preserved, missing columns are added, and the database file is copied to `queue.db.backup-<timestamp>` before the rebuild. The migration is idempotent and a fresh database is not backed up. X7 (8380db9) inherits job stdout and stderr so a daemon under a service manager logs job output, keeping the X4 detach and unref behavior. X8 (6c9d7b3) restores `runtime_remaining_s` and `deadline_in_s` on `status <id>` and `status --self`, matching cli.py:24-31. X9 (bbeeb7a) accepts `--opt=value`, stops at the first non-option token like argparse REMAINDER (`coordinate enqueue --priority 1 echo hi` works), and rejects a non-integer `--priority` or `--max-attempts` with a one-line error; X14 rides in the same commit: the forwarder's in-memory cursor only advances after a successful send, so a failed event is retried on the next poll (a `sinkFn`/`maxPolls` hook was added for tests). A3 (2a95440) replaces `split(" ")` with a shlex-style splitter (single and double quotes, backslash escapes, null on unterminated quotes) keeping the `sh -c`/`bash -c`/`zsh -c` unwrapping; `cmd /c` was deliberately not added. Docs (d7fbf80) fix C9, C10, S2 and A2 in `skills/coordinate/SKILL.md` and `docs/*.md`, document the enqueue flags in `coordinate --help`, and add the missing `--run-at` flag to the open fix list instead of inventing it. The five todo reproducers are enforced; `pnpm test` is 34 tests, 33 pass, 0 fail, 1 todo (M, Node 24, Linux x64, this worktree).
