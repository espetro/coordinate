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

| Gap | Issue | State |
|---|---|---|
| sqlite3 params, typed rows, `rowcount`, `lastrowid`, `description`, NULL as `None`, `executemany`, `isolation_level=None`, `PRAGMA` | none. Only other-DB adapters are planned: #90 ONNX, #91 DuckDB, #1209 Arrow (all Future). The pilot #66/#221 closed at 5 functions. | untracked |
| non-blocking spawn with `env=`, `cwd=`, `start_new_session`, `stdin=PIPE` | none. #503 and #877 asked for basic `Popen` and closed without the surface landing; #1224 and #1266 delivered the asyncio exec+pipes subset. | untracked |
| `.pid`, `kill`/`terminate`/`send_signal`, `poll()` on the child | none | untracked |
| incremental pipe I/O (iterate stdout, write stdin) | none | untracked |
| `argparse.add_subparsers` | none. #510 closed with `type=`/`default=`/`store_true` only. | untracked |
| `signal.signal` handler | none. #1244 closed at constants + `os.kill`. | untracked, and not needed by coordinate |
| `json.loads` non-ASCII, `json.dumps` escaping parity | #477 (S5, v0.11.0) | tracked, open |
| UTF-8 stdin/stdout/files/argv/env | #478 (S6, v0.11.0) | tracked, open |
| heterogeneous JSON `dict[str, object]` (arbitrary ACP payloads) | #1226 (no milestone) | tracked, open |
| HTTP client | #219 (Future) | tracked, open |

Six gaps are untracked, of which five are real requirements for us (all but `signal.signal`). Three are tracked, all open; #477/#478 sit in v0.11.0 (52 open issues) and #1226 has no milestone.

## What changed on master since the earlier assessment

- `asyncio.create_subprocess_exec` with `stdout=`/`stderr=` pipes and `communicate`/`wait`/`returncode` landed (#1224, #1245, #1266, #1271). Spawn exists now, but only fire-and-collect: no `env=`, `cwd=`, `stdin=`, `start_new_session`, `pid`, `kill`, `poll`, or interactive reads.
- `json.dumps(ensure_ascii=False)` and `json.loads(bytes)` landed (db49c022). The reader still refuses non-ASCII text; that is #477's job.
- `subprocess.run(timeout=)` landed (#1223) with `TimeoutExpired`.
- Recent commits otherwise went to the inference engine, island routing and `asyncio.start_server`, not to these gaps.

## Draft issues for the untracked gaps (not filed; filing needs the author's approval)

1. `stdlib: sqlite3 surface for a job queue` or `pack: extend pyscriptc-sqlite with parameter binding and typed values`. Needs: `execute(sql, params)` with `?` binding, `executemany`, fetch returning typed `int`/`float`/`None`/`str`, `rowcount`, `lastrowid`, `description`, `isolation_level=None`, `PRAGMA` statements. Repro: `queue.py` binds params in ~40 statements; `cli.py:137` reads `cur.description`.
2. `subprocess: non-blocking spawn environment (Popen or asyncio exec with env=, cwd=, stdin=PIPE, start_new_session)`. Repro: a daemon that spawns agents in their own session with a job env block and pipes both ways.
3. `subprocess: child handle surface (pid, poll, wait(timeout=), kill/terminate/send_signal, incremental stdout iteration and stdin writes)`. Repro: reap a timed-out agent, SIGTERM then SIGKILL its process group, stream ACP lines.
4. `argparse: add_subparsers(dest=, required=) with per-subcommand add_argument`. Repro: `cli.py` has 7 subcommands (enqueue/status/wait-on/release/cancel/stats/daemon).
5. `signal: install a process-level SIGTERM/SIGINT handler that calls a compiled function` (optional for us; the probe checks it and a native binary can do it in C even without a Python handler table).

## Bottom line

For pyscriptc to match scriptc's score it needs five untracked features (sqlite params/typing, spawn env/session/stdin, the child-handle surface, subparsers, signal handlers) plus two tracked epics that are already open (#477, #478) and one unmilestoned issue worth pulling forward (#1226). scriptc needs none of this work; its only open question is `@cutils/sqlite` on macOS. The pyscriptc ask is roughly the size of one milestone; filing the five issues makes it visible, not scheduled.
