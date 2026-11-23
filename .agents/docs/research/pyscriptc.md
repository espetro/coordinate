# pyscriptc for coordinate: distribution and footprint assessment

Date: 2026-11-23. Question: can `pyscriptc` (github.com/sigilco/pyscriptc, local clone at `_own/pyscriptc`, master `bb923e63`, version 0.10.0) make `coordinate` easier to distribute and lighter on resources? Numbers are marked measured (M) or claimed (C). Claimed numbers come from the pyscriptc docs or from general knowledge of the other tools, not from runs on our hosts.

Host for every (M) number: MacBook, macOS arm64 (Darwin 27.2), 10 cores, 24GB, load average 1.8 to 2.5 during the runs, CPython 3.14.10, pyscriptc 0.10.0 from the repo venv, driver zig 0.16.0, pyscriptc telemetry disabled (`PYSC_NO_TELEMETRY=1`, `DO_NOT_TRACK=1`). Builds ran under `flock /tmp/tsc.lock` on samples copied to `/tmp`; the `coordinate` and `pyscriptc` repos were not modified. Startup numbers are n=40 after 3 warmups; peak RSS is `getrusage(RUSAGE_CHILDREN).ru_maxrss` of one run. The architecture numbers (97ms enqueue, 18.5MB daemon) are the VPS (Linux x86_64) numbers from `ARCHITECTURE.md` and are not directly comparable with the laptop numbers here.

## Verdict

Not now as the distribution mechanism, and not for the daemon. pyscriptc compiles typed Python to small, fast native binaries (5ms startup and 2.8MB RSS for a `status --self` read path, against 57ms and 24MB for today's CLI, both M), but our code is 3.6% inside its native subset today (M), and the two modules that matter have no usable native equivalent: `sqlite3` is only reachable through a 5-function adapter with no parameter binding and string-only values, and `subprocess.Popen` is not lowered at all. Non-ASCII JSON, which every prompt payload can contain, fails at run time (M). The fallback that compiles everything (the CPython "island", bundled and onefile) is a PyInstaller-class artifact with CPython-class startup and RSS, from a 6-week-old, single-maintainer compiler. The only fit worth an experiment is a separate read-only `coordinate-status` binary for the hot agent path, and only if the 50ms per call turns out to matter; cheaper Python-side fixes recover about 40% of it first (M).

## 1. What pyscriptc is and how mature it is

pyscriptc compiles a typed subset of Python 3.14 through LLVM IR to a native executable with no interpreter inside. Every variable and parameter must be annotated; pyrefly type-checks first, then the compiler lowers. Anything outside the subset stops the build with a stable `PSxxxx` diagnostic naming the line, or, with `--island` / `--fallback=cpython`, runs on an embedded CPython (linked from the host, or bundled from a pinned python-build-standalone pack with `--embed-python bundle`, optionally as `--onefile`). Tooling that matters for an assessment: `pyscriptc imports`, `pyscriptc assess` (per-definition plane map), `pyscriptc coverage` (no toolchain needed) and `pyscriptc verify` (binary versus CPython output diff).

Maturity: repo created 2026-10-14, 1,056 commits, version 0.10.0, 16 stars, effectively one maintainer plus agent commits, self-described as experimental. User docs list 78 numbered divergences from CPython. Release builds send pseudonymous telemetry to PostHog EU by default (opt out with `PYSC_NO_TELEMETRY=1`), so any CI job must set it. The master branch is documented as ahead of the released wheel, and the sqlite adapter we would need lives in the repo (`packaging/adapters/pyscriptc-sqlite/`), not in the wheel, so a build would pin a git revision.

Stdlib coverage for what we use, from the docs, the lowering code (`src/pyscriptc/restlower/`) and probes run on this laptop:

| Module / feature | Native status | Source |
|---|---|---|
| `sqlite3` | Not in the closed import table (`PS2002` on import). Reachable only through the `extern` lane: the `pyscriptc_sqlite` FFI adapter with `connect`, `execute`, `query`, `commit`, `close`. No parameter binding, no cursor, no `rowcount`, no `lastrowid`, no `description`; `query` returns `list[dict[str, str]]`, so integers print as strings and NULL becomes `""`. Vendors SQLite 3.54.1 into the binary. | docs/guide/python-subset.md, adapter `.pyi` and C thunk, (M) run below |
| `subprocess` | `run` (with `capture_output`, `text`, `check`, `cwd`, `timeout` only; `shell=`, `input=`, `env=` and other Popen keywords refused), `call`, `check_call`, `check_output`. `subprocess.Popen` is not lowered: `PS2001` (M, coverage probe). `start_new_session` and `env=` are refused as keywords (M). Issue #877 asking for Popen is closed, but the native surface is not there on master. | divergence 40, 71; (M) |
| `signal` | Constants only (`SIGKILL`, `SIGTERM`, `SIGINT`, `SIGCONT`, `SIGUSR1`, `SIGUSR2`) plus `os.kill` / `os.killpg` with CPython's errno mapping. `signal.signal`, `getsignal`, `alarm`, `SIG_IGN`/`SIG_DFL` are fenced (`PS2001`): a native binary has no Python handler table. | python-subset.md, divergence 68 |
| `os.fork` / `os.setsid` | Not documented as lowered; we do not call them directly (we use `start_new_session=True`, which is refused). | divergences, (M) probe |
| `tomllib` | `tomllib.loads(text)` only, into an annotated type with json.loads shape rules; `tomllib.load(fp)` is fenced. | restlower/_tomllib.py |
| `urllib` / `ssl` | `urllib.request.urlopen` and `Request` with constant header dicts. `http://` is native; `https://` links the system libcurl at build time (a libcurl dev package is a build dependency). `ssl` and `http.client` imports are fenced. | divergences 18, 27, 29 |
| `threading` | `Thread`, `Lock`, `Condition`, `Semaphore`, `Event`, `queue.Queue` native (pthreads). A `Thread(target=..., args=..., daemon=True)` probe passed coverage (M). | divergence 26, (M) |
| `argparse` | Native subset, but `add_subparsers` is not lowered (`PS2003`, M). | assess on our code |
| `json` | Native, but no non-ASCII text: `json.dumps` of `"migración"` emits the raw character where CPython escapes it to `ó`, and `json.loads` of non-ASCII fails with `JSONDecodeError: non-ASCII JSON string is not lowered`, exit 1 (M). | divergence 5, (M) |
| `shlex` | `split`, `quote`, `join` native. | divergence 57 |

Output format: a native executable per entry point (`pyscriptc compile FILE --emit bin -o OUT`, or `pyscriptc build` for every `[project.scripts]` entry). The macOS binaries built here link only `libSystem` (M); the Linux cross-compiled one is a dynamically linked glibc ELF (M). Island builds are a directory (binary, `lib/` with libpython and a stdlib zip, licenses) or one `--onefile` executable that extracts itself to a cache directory on first run.

Platforms: Linux x86_64 and macOS arm64 are the main targets, with Windows cross-compilation marked experimental; the bundled CPython pack exists for macOS arm64 and Linux x86_64 (C). Cross-compiling goes through `--driver zig --target TRIPLE`.

Binary size and build time (M, warm runtime cache unless stated):

| Sample | Build wall time | Binary size | Startup median | Peak RSS |
|---|---|---|---|---|
| hello world | 0.59s | 752,008 B | 3.9ms | 1.7MB |
| `cli_nodb`: argparse + json + tomllib + os.environ | 0.66s | 752,088 B | not timed | 1.8MB |
| `cli_db`: typed `status --self` read path over `pyscriptc_sqlite` | 19.3s (compiles the SQLite amalgamation) | 2,101,496 B | 5.0ms (p95 6.1ms) | 2.8MB |
| `cli_nodb` cross-compiled to `x86_64-linux-gnu.2.35` from macOS | 19.0s (cold runtime objects for the target) | 2.9MB, unstripped, with debug info | not run (no Linux host used) | not run |
| island onefile (bundled CPython, stripped runtime, minimal stdlib) | not run: needs a 27MB runtime pack download | 14.5 to 18.8MB (C) | 0.46 to 0.61s warm, +0.4s first run, on yt-dlp (C) | 57MB on yt-dlp vs 49MB for a uv venv (C) |

## 2. Does our code fit the subset today?

`pyscriptc imports` and `pyscriptc assess` on a copy of `src/fleet/` (without `dbos_backend.py`, which P1 drops) (M):

- Imports: 12, 9 native, 3 fenced (`sqlite3`, `subprocess` for `Popen`, `os` for one call shape).
- Definitions: 55, 2 native (3.6%), 53 routed to the island, 0 blocked when fallback is allowed. Files: `__init__.py` lowers fully, `cli.py` refused, `daemon.py` and `queue.py` partly.
- Fences: 107 in total (cli.py 41, daemon.py 21, queue.py 45). By code: `PS2002` 51, `PS1001` 37, `PS1107` 7, `PS1106` 5, `PS2003` 3, `PS1004` 2, `PS1003` 1, plus the `sqlite3` import.

Most fences are cascades: one unannotated name (`PS1001`) makes every later read a `PS2002`. Separating real blockers from annotation work:

Hard blockers (need pyscriptc work or a redesign on our side):

- `sqlite3`, the store itself. `queue.py:8` (import outside the closed table), `queue.py:179` (`sqlite3.Connection` annotation, `PS1106`). Every statement binds parameters with `?` (`queue.py:114`, `236-239`, `245`, `252-287`, `306-315`, `325`, `331`, `364`, `372-375`, `388-397`, `407-423`, `438-441`, `447`, `459-463`, `471`, `480-483`, `489-491`; `cli.py:160`; `daemon.py:114`, `235`), which the adapter cannot do; we would build SQL by string concatenation, including prompt text in payloads. `cur.rowcount` (`queue.py:374`, `377`, `443`, `465`, `485`), `cur.lastrowid` (`queue.py:240`) and `cur.description` (`cli.py:164`) have no adapter equivalent. Typed REAL and INTEGER columns come back as strings and NULL as `""` (M: the compiled read path prints `"id": "1"` and `"deadline_at": ""` where CPython prints `1` and `null`), which changes the `status --self` JSON contract agents read.
- `subprocess.Popen`, the dispatcher itself. `daemon.py:101-102` and `daemon.py:151-152` (`PS2001`; `start_new_session`, `cwd`, `env`, `executable`, `stdin`/`stdout=PIPE`, `text=True` are all needed), `proc.poll()` (`daemon.py:256`), `proc.wait(timeout=)` (`daemon.py:205`), iterating `proc.stdout` (`daemon.py:125`), writing `proc.stdin` (`daemon.py:175-177`), and the `subprocess.Popen` annotations at `daemon.py:61`, `97`, `121`, `137`, `158`, `166`, `183` (`PS1106`). `subprocess.run` cannot replace a non-blocking dispatcher.
- Non-ASCII JSON. Payloads carry prompts (`cli.py:130`, `queue.py:239` via `json.dumps`; `daemon.py:128`, `253`, `queue.py:263` via `json.loads`; `daemon.py:175` for ACP cancel). A Spanish or emoji prompt fails at run time (M).
- `argparse` subcommands. `cli.py:38` (`add_subparsers`, `PS2003`) and every parser built on it, `cli.py:39-71`; `argparse.REMAINDER` at `cli.py:55` is untested. The CLI would need hand-rolled verb dispatch.
- Heterogeneous dicts. The job payload mixes `list[str] | str` for `cmd`, optional `cwd`, `list[str]` slots and an optional session id (`daemon.py:26-41`, `queue.py:224-230`), and the TOML config mixes ints, strings and nested tables (`queue.py:45`, `76-81`, `95-96`, `133-134`). The subset wants one closed shape per container (`PS1107`); this means a `@dataclass` payload with an explicit decoder and a typed config record.
- Signal handlers for the future daemon. Nothing registers handlers today (we rely on default SIGTERM and `KeyboardInterrupt` at `cli.py:113` and `cli.py:119`), but P3 (single-instance lock, graceful shutdown, re-adoption) will want a SIGTERM handler, which is fenced.

Mechanical fixes (annotation and idiom work, no design change):

- Missing parameter annotations, mostly the connection `c`: `cli.py:75`, `106`; `daemon.py:44`, `61`, `93`, `97`, `107`, `137`, `221`, `240`; `queue.py:112`, `198`, `233`, `243`, `249`, `299`, `323`, `329`, `360`, `368`, `380`, `402`, `427`, `432`, `446`, `452`, `468`, `476`, `488`, `494`.
- Unannotated locals: `cli.py:28-33` (`out`, `used`), `daemon.py:30` (`toks`), `queue.py:35` (`path`), `queue.py:76-77`, `queue.py:225-226`.
- Module-level non-constant assignments read from the environment at import: `cli.py:10` (`DBOS`), `queue.py:16-20`, `queue.py:31` (seen as `PS2002` at `queue.py:24`). Move them into functions.
- Paths that fall off the end: `cli.py:13` (`sys.exit` inside `except`), `queue.py:100` (`while True`).
- `int(...)` on untyped config values (`queue.py:51`, `58`), iteration over `list[int | None]` (`queue.py:352`), `os.environ.get` with a non-str default (`queue.py:28`).
- `dict(row)` and `dict(zip(...))` (`cli.py:29`, `164`).

Conclusion: the CLI read path could be rewritten into the subset in a day or two as a separate module; the queue and the daemon cannot be compiled natively without pyscriptc first gaining a real `sqlite3` binding (parameters, typed values, rowcount, lastrowid) and `Popen`.

## 3. Expected gains

Startup, `status --self` shape (M, laptop):

| Variant | Median | p95 | Peak RSS |
|---|---|---|---|
| pyscriptc native read path (`cli_db`) | 5.0ms | 6.1ms | 2.8MB |
| pyscriptc hello world | 3.9ms | 5.2ms | 1.7MB |
| today's CLI, `python -m fleet status --self` | 56.6ms | 67.8ms | 23.8MB |
| same logic, stdlib, argparse + sqlite3 + json | 52.1ms | 71.1ms | 23.3MB |
| same logic, no argparse, lazy imports | 34.1ms | not recorded | 19.5MB |
| same, plus `-S` | 32.9ms | not recorded | not measured |
| `python -I -c pass` (interpreter floor) | 21.8ms | 22.6ms | 16.4MB |

The native read path is about 11x faster and 8x smaller per call than today's CLI on this laptop (M). On the VPS the CLI costs 97ms (M, from `ARCHITECTURE.md`), so the absolute saving there is likely 80 to 90ms per call (C, extrapolated, not measured). In context: an agent that calls `status --self` 100 times in a session spends 5 to 10s of wall time on it, against LLM turns measured in seconds each, and the 24MB peak lives for about 50ms, so it only matters when many agents call at once. Agents can also read `FLEET_DEADLINE_AT` from their environment at zero cost, which covers the most common question.

Daemon RSS: a native daemon would likely sit at 2 to 4MB instead of 18.5MB (C, extrapolated from the native samples above), saving about 15MB against a 200 to 300MB budget. It is blocked by Popen and sqlite3 (section 2), and an island build keeps CPython's footprint, so this gain is not reachable today.

Single-binary distribution: a native binary needs no Python (M: only `libSystem` on macOS). But only the read path can be native today; the full CLI and the daemon would ship as an island onefile, which carries CPython (14.5 to 18.8MB, C), starts at CPython speed or slower, and extracts on first run. And the ACP lane needs Node anyway: `fleet-acp` is a Node package (`_own/fleet-acp`, pnpm, `@agentclientprotocol/sdk`), and the agent harnesses are Node or native tools. A colleague who runs coding agents already has a runtime manager; removing Python from the requirements removes one of several prerequisites, not the last one.

## 4. Costs and risks

- Build pipeline. Two native runners (macos-14 or later arm64, ubuntu-24.04 x86_64) are the safe choice; zig cross-compiling Linux from macOS worked here for a sqlite-free sample (M), but the result was not executed. Each job installs uv, pyscriptc from a pinned git revision (the adapter is not in the wheel), zig or clang and pyrefly, fetches and hash-checks the SQLite amalgamation, sets `PYSC_NO_TELEMETRY=1`, and builds (about 20s per binary with sqlite, M). Add a glibc floor in the target triple and a smoke run on both runners. Unsigned macOS binaries fetched by a browser get quarantined; `curl` or `gh release download` avoid that, notarization would need an Apple developer account.
- Two semantics. Tests run on CPython, the shipped binary runs pyscriptc semantics. The divergences we would hit (JSON non-ASCII, `RuntimeError` stand-ins for several exception types, string-typed sqlite rows) mean every release needs a differential run (`pyscriptc verify` or our bench against the binary). Code that imports `pyscriptc_sqlite` does not run on CPython without a shim we would have to write and keep in sync.
- Debugging. Failures in the native binary are C-level: `lldb` with DWARF, `--debug` and `--debug-dir` dumps of the IR, not Python tracebacks with locals.
- Contributors. Everyone touching the compiled path writes in the typed subset (annotate everything, no `Any` reads, no dynamic dicts, no `add_subparsers`), learns `PSxxxx` codes, and needs the pyscriptc toolchain to reproduce a build. That narrows a pure-stdlib codebase that today needs only `uv`.
- Lock-in and project risk. The source stays valid Python, so leaving is cheap for annotated code and expensive only for the adapter calls. The bigger risk is the compiler: about 6 weeks old, a bus factor of one, divergences that move between releases, master ahead of the wheel, and a release policy that ships irregularly by design. A compiler bug becomes our bug, in a binary agents call constantly.

## 5. Alternatives

| Option | No Python on host | CLI startup | RSS per CLI call | Artifact size | Notes |
|---|---|---|---|---|---|
| `uv tool install` wheel (today) | no, uv fetches one | 57ms laptop (M), 97ms VPS (M) | 24MB (M) | wheel of tens of KB, plus a managed Python of about 20 to 30MB if missing (C) | zero new tooling; matches the P1 plan |
| same, lazy imports, no argparse on the hot path | no | 33 to 34ms (M) | 19.5MB (M) | same | hours of work, no new tooling |
| pyscriptc native read path plus wheel for the rest | partly | 5ms for `status` (M) | 2.8MB (M) | 2.1MB per binary (M) | the experiment below |
| pyscriptc island onefile for everything | yes | CPython-class, 0.4s extra on first run (C) | CPython-class (C) | 14.5 to 18.8MB (C) | new and unproven |
| PyInstaller onefile | yes | extracts to a temp dir on every run; 1.43s for yt-dlp `--version` vs 0.29s in a venv (C, pyscriptc doc measurement) | CPython-class plus bootloader (C) | about 8 to 15MB for a stdlib app (C) | mature; onedir mode avoids the extraction |
| Nuitka standalone or onefile | yes | close to CPython, onefile can cache its extraction (C) | CPython-class (C) | about 10 to 25MB (C) | full compatibility; builds take minutes and need a C compiler (C) |
| PyOxidizer | yes | fast in-memory imports (C) | CPython-class | about 15 to 30MB (C) | effectively unmaintained since 2023 (C); its python-build-standalone is now maintained by Astral and powers uv (C); PyApp is the active launcher-style successor (C) |
| python-build-standalone plus zipapp, in a tarball | yes | CPython-class, about 50ms here (M for CPython) | CPython-class | about 27MB macOS, 35MB Linux compressed runtime (C) | simple and robust; a small shell launcher; we own the packaging |
| shiv or pex | no | CPython plus a small bootstrap; shiv extracts once to `~/.shiv` (C) | CPython-class | small | solves dependencies, not the interpreter; we have no dependencies |
| Rewrite `status`/`stats` (and maybe `enqueue`) in Go or Rust | yes for that path | 1 to 5ms (C, consistent with the 4 to 5ms native samples here) | 2 to 5MB (C) | 2 to 10MB with SQLite linked (C) | mature toolchains, real SQLite bindings with parameters; costs a second language and a schema contract between two codebases |

## 6. Recommendation and the smallest experiment

Recommendation: ship P1 as planned (wheel on GitHub Releases, `uv tool install`). Do not adopt pyscriptc for the daemon or as the distribution format. First take the free win on the hot path: keep `argparse` and the full module graph off `status --self` and `stats` (lazy imports, a tiny verb check before building the parser), which took the read path from 57ms to 34ms on this laptop (M). Revisit a compiled hot path only if a measurement shows CLI latency matters, for example a bench scenario where many agents poll at once.

Smallest experiment, if we want a number for the compiled path (half a day):

1. Write `coordinate_status.py`, a typed module that implements only `status --self` and `stats`: read `COORDINATE_JOB_ID` and `COORDINATE_DB`, `PRAGMA busy_timeout`, one `SELECT` with the id validated as an int, print JSON. Put the 5 `pyscriptc_sqlite` functions behind a 30-line CPython shim so the same file runs in pytest.
2. Build it with `pyscriptc compile coordinate_status.py --ffi <pinned adapter>/ffi.toml --emit bin` on macOS arm64 and, on the VPS or an ubuntu-24.04 runner, Linux x86_64.
3. Measure with our bench against the CPython path, during a running workload (daemon writing, WAL active): median and p95 latency, peak RSS, `SQLITE_BUSY` errors over 1,000 calls.
4. Diff the output against the CPython path on fixtures that include NULL columns, REAL deadlines and a non-ASCII prompt in the payload.

Go criteria: at least 5x lower median latency on the VPS, byte-identical JSON on every fixture (or a contract change we accept, such as numbers as strings), zero busy errors, and both platform builds under 5 minutes in CI. With today's adapter the non-ASCII fixture fails (M), so the realistic expected outcome is no-go until pyscriptc fixes JSON non-ASCII and the sqlite adapter gains typed columns and parameter binding. If the latency gain is wanted before that, a 100-line Go or Rust `coordinate-status` reader is the more predictable route to the same 5ms.
