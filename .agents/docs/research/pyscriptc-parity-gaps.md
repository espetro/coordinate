# pyscriptc parity gaps: what it needs to score like scriptc

Date: 2026-11-23. Question from the author: what is missing in pyscriptc for it to reach the score scriptc got on the daemon probe, and is each gap already tracked in sigilco/pyscriptc issues? Checked on `master` `8f0eaf45` (27 commits past the `bb923e63` the earlier assessment ran on), against `src/coordinate/{daemon,queue,cli}.py` call sites. (M) = verified in source or issue tracker, (C) = inferred.

## Scorecard against the scriptc probe

The scriptc probe checks that passed on macOS (`language-choice.md`), mapped to pyscriptc's native surface on master:

| scriptc probe check | pyscriptc native state on master | Tracked |
|---|---|---|
| spawn child with `cwd`, `env`, `detached`, stdout pipe | `asyncio.create_subprocess_exec(*argv, stdout=PIPE, stderr=PIPE)` lowers (#1266), but `env=`, `cwd=`, `shell=` fence PS2003 and there is no `start_new_session`. `subprocess.run` has `cwd=`/`timeout=` but blocks. `Popen` is PS2001. | no |
| exit event with code, and with signal | `await proc.wait()` returns the exit code; `proc.returncode` reads it. No signal-death information, no non-await `poll()`. | no |
| `process.on("SIGTERM")` handler | `signal.signal` fenced PS2001 ("a native binary has no handler table"). Constants plus `os.kill`/`os.killpg` lower (#1244). | no |
| non-ASCII JSON round trip | `json.dumps(ensure_ascii=False)` landed (db49c022); `json.loads` of non-ASCII still fails at run time ("non-ASCII JSON string is not lowered", `ps_json.c`). | yes: #477 (v0.11.0) covers the reader; #478 (v0.11.0) covers UTF-8 stdio/argv/env |
| timers | `time.sleep`, `asyncio.sleep` native | ok |
| SQLite: bound params, typed values, `lastInsertRowid`, `changes`, transactions | `pyscriptc_sqlite` FFI adapter only: `connect`, `execute`, `query`, `commit`, `close`. No `?` params, all values `str`, NULL as `""`, no `rowcount`/`lastrowid`/`description`. | no |
| CLI subcommands (`@cutils/cli`) | `argparse.add_subparsers` fenced PS2003 | no |
| `fetch` (unverified for scriptc on macOS) | `urllib.request.urlopen`/`Request` native; `https://` links system libcurl at build time | yes, loosely: #219 (Future) |
| binary 558KB, RSS 2.6MB | hello 752KB/1.7MB, sqlite read path 2.1MB/2.8MB, startup 4-5ms (M, earlier probe). Comparable or better. | ok |

## Gaps the daemon needs beyond the probe

The probe is a floor; `daemon.py` needs more than it checks:

- `Popen(..., shell=, executable=, cwd=, env=, start_new_session=True, stdin=PIPE, stdout=PIPE, text=True)` (daemon.py:101-102, 153-154).
- `proc.pid` (daemon.py:103, 155, 162). The runtime stores `pid` in the `PsAProc` record but exports no accessor, so a child cannot even be signalled through `os.kill`.
- `proc.poll()` (daemon.py:258), `proc.wait(timeout=)` (daemon.py:207, `TimeoutExpired` exists via #1223).
- Incremental `for line in proc.stdout` (daemon.py:127) and `proc.stdin.write/flush` (daemon.py:177-179). `await proc.communicate()` drains both pipes to EOF; there is no interactive pipe I/O.
- `os.killpg` (daemon.py:162, 202, 213) already lowers, and the daemon never calls `signal.signal` (children run in their own session so a daemon SIGTERM death is safe: leases expire and jobs re-claim). A SIGTERM-handler issue is probe parity, not a real requirement.

## Tracking state, per gap

Update 2026-11-23: the five untracked gaps were filed and prioritized into v0.11.0, and #1226 was pulled forward. All six are on the board (project 6) with Horizon=Current, Track=V2 compiler, Status=Todo, Release class=minor.

| Gap | Issue | State |
|---|---|---|
| sqlite3 params, typed rows, `rowcount`, `lastrowid`, `description`, NULL as `None`, `executemany`, `isolation_level=None`, `PRAGMA` | #1343 (filed, v0.11.0, Effort L). Only other-DB adapters were planned before: #90 ONNX, #91 DuckDB, #1209 Arrow (all Future). The pilot #66/#221 closed at 5 functions. | tracked |
| non-blocking spawn with `env=`, `cwd=`, `start_new_session`, `stdin=PIPE` | #1344 (filed, v0.11.0, Effort M). #503 and #877 asked for basic `Popen` and closed without the surface landing; #1224 and #1266 delivered the asyncio exec+pipes subset. | tracked |
| `.pid`, `kill`/`terminate`/`send_signal`, `poll()`, `wait(timeout=)` | #1345 (filed, v0.11.0, Effort M) | tracked |
| incremental pipe I/O (iterate stdout, write stdin) | #1345, same issue | tracked |
| `argparse.add_subparsers` | #1346 (filed, v0.11.0, Effort M). #510 closed with `type=`/`default=`/`store_true` only. | tracked |
| `signal.signal` handler | #1347 (filed, v0.11.0, Effort M). #1244 closed at constants + `os.kill`. Not needed by coordinate; probe parity only. | tracked |
| `json.loads` non-ASCII, `json.dumps` escaping parity | #477 (S5, v0.11.0) | tracked, open |
| UTF-8 stdin/stdout/files/argv/env | #478 (S6, v0.11.0) | tracked, open |
| heterogeneous JSON `dict[str, object]` (arbitrary ACP payloads) | #1226 (moved to v0.11.0, Effort L) | tracked, open |
| HTTP client | #219 (Future) | tracked, open |

Every gap is now tracked, eight of them inside v0.11.0 (which holds 57 open issues after these additions).

## What changed on master since the earlier assessment

- `asyncio.create_subprocess_exec` with `stdout=`/`stderr=` pipes and `communicate`/`wait`/`returncode` landed (#1224, #1245, #1266, #1271). Spawn exists now, but only fire-and-collect: no `env=`, `cwd=`, `stdin=`, `start_new_session`, `pid`, `kill`, `poll`, or interactive reads.
- `json.dumps(ensure_ascii=False)` and `json.loads(bytes)` landed (db49c022). The reader still refuses non-ASCII text; that is #477's job.
- `subprocess.run(timeout=)` landed (#1223) with `TimeoutExpired`.
- Recent commits otherwise went to the inference engine, island routing and `asyncio.start_server`, not to these gaps.

## Issues filed 2026-11-23

1. #1343 `stdlib: sqlite3 surface for a job queue (params, typed rows, rowcount, lastrowid)` (compat-gap)
2. #1344 `subprocess: non-blocking spawn environment (env=, cwd=, stdin=PIPE, start_new_session)` (compat-gap)
3. #1345 `subprocess: child-handle surface (pid, poll, wait(timeout=), kill/terminate, incremental pipe I/O)` (compat-gap)
4. #1346 `argparse: add_subparsers(dest=, required=) with per-subcommand add_argument` (enhancement)
5. #1347 `signal: install a SIGTERM/SIGINT handler that calls a compiled function` (compat-gap)

## Bottom line

For pyscriptc to match scriptc's score it needs the five filed issues plus the three already tracked (#477, #478, #1226); all now sit in v0.11.0. scriptc needs none of this work; its only open question is `@cutils/sqlite` on macOS. Scheduling does not follow from filing: the maintainer owns the milestone, and v0.11.0 already carried 52 open issues before these six.
