# Python or TypeScript for coordinate

Date: 2026-11-23. Question from the author: is there any hard dependency that fixes the language, and if we pick one, can we ship it compiled (pyscriptc for Python, scriptc for TypeScript)? Numbers marked (M) were measured on the laptop (macOS arm64), (C) are claimed by the project.

## Hard dependencies: none on our side

- `fleet-acp` is a design choice, not a dependency. It is 236 lines of JavaScript (`src/run.js` 132, `bin/fleet-acp.js` 43, credentials and registry 61) over the official TypeScript ACP SDK. ACP is JSON-RPC over stdio, and the bench already has a stdlib Python ACP client (`bench/acp_client.py`, 219 lines) that does initialize, new session, `session/load`, prompt and cancel.
- An official Python ACP SDK exists: `agent-client-protocol` 1.0.0 on PyPI, repository `agentclientprotocol/python-sdk`, 354 stars, last push 2026-11-19 (M). It depends on pydantic, which costs startup time and memory, so the stdlib client remains the lighter option for us.
- Node shows up on the machine because of the agents, not because of coordinate: Claude runs over ACP through `@zed-industries/claude-code-acp`, an npm package that runs as the agent process. OpenCode speaks ACP natively. Whatever runtime an agent needs, it brings with it; our orchestrator only spawns it.
- Why the code is Python today: `fleet` started as a dependency-free spike (sqlite3 and subprocess are in the standard library), and the ACP lane was added later in Node because the SDK was TypeScript. Nobody compared the two languages for the whole tool.

## Runtimes, plain (M, laptop, open SQLite in memory, one query, print JSON)

| Runtime | Startup | Peak RSS |
|---|---|---|
| Python 3.14 + `sqlite3` | 30ms | 20MB |
| Node 26 + `node:sqlite` | 40 to 50ms | 51MB |
| Bun 1.3 (`bun:sqlite`; Bun does not provide `node:sqlite`) | 10ms | 22MB |

## Compilers

### pyscriptc (Python)

Details: `pyscriptc.md`. Native coverage of our code today is 2 of 55 functions. SQLite support is the `pyscriptc-sqlite` FFI pilot: five functions (`connect`, `execute`, `query`, `commit`, `close`), no bound parameters, every value returned as a string, unchanged since the adapters moved to `packaging/` (M, read on `master` 8f0eaf45). `subprocess.Popen(env=, start_new_session=)`, `argparse` subcommands and signal handlers are not implemented and not tracked; non-ASCII I/O is an open epic (#477, #478). The compiled read path is fast (5.0ms, 2.8MB) but the daemon cannot compile.

### scriptc (TypeScript)

vercel-labs/scriptc, Apache-2.0, 6,617 stars, v0.4.16 released 2026-11-21, labelled experimental (M). It builds macOS (arm64, x64), Linux (arm64, x64, glibc or musl, static with musl) and Windows executables, and cross-compiles from macOS to Linux with zig (C). The compiler archive is 527MB unpacked (M).

A probe of the daemon-critical surface, compiled on the laptop with the release archive (`/tmp/scriptc-probe/probe.ts`), passed every check (M):

| Check | Result |
|---|---|
| Output | Mach-O arm64, 558KB |
| Peak RSS | 2.6MB |
| `child_process.spawn` with `cwd`, `env`, `detached`, stdout pipe | works |
| `exit` event with code, and with signal after `process.kill(pid, "SIGTERM")` | `0 null`, then `null SIGTERM` |
| `process.on("SIGTERM")` handler | runs |
| Non-ASCII JSON round trip through a file (`migración ✓ 日本`) | identical |
| Timers | work |

Not yet verified: SQLite. `@cutils/sqlite` 0.8.0 (vendored amalgamation, FFI shim, `Database`/`Stmt`/`Transaction`, `lastInsertRowid`, `changes`, bound parameters) is built and tested for Linux ELF only; a macOS build of its static shim is untested. Also unverified: `fetch` on macOS (the docs list it for Linux and Windows), and the documented exit-listener TypeError for signal deaths in some spawn paths (our probe did not hit it). `@cutils/cli` covers typed subcommands and help; `chttp` covers an HTTP surface if a local API is ever needed.

## Verdict

TypeScript compiled with scriptc is the stronger path, and it also removes the language split with the ACP host. pyscriptc cannot compile the daemon today and its gaps are untracked; scriptc compiles the daemon-critical surface already, with a 558KB, 2.6MB binary that needs no runtime on the colleague's machine. The same TypeScript source also runs under Node or Bun, so development and tests do not depend on the compiler, and the compiler is the release step, not a lock-in. Python stays as the bench harness: the bench drives the tool only through its CLI (`--cli`), which makes it the oracle for the port.

Risks: scriptc is an experiment that ships daily, so pin the version and gate upgrades with the bench; the subset constrains code style (no dynamic module graph, some class features); SQLite on macOS through `@cutils/sqlite` is the one open technical question; Windows is out of scope.

## Spike that decides it

Port the queue core (schema, enqueue, claim with caps and global priority, leases, `wait-on`/`release`, time caps), the CLI (`enqueue`, `status [--self]`, `stats`, `wait-on`, `release`, `cancel`, `daemon`) and the daemon claim loop to TypeScript inside the scriptc subset, using `@cutils/sqlite` and `@cutils/cli`. Build for darwin-arm64 and linux-x64. Run the existing bench through `--cli` and gate with `bench/compare.py` against the Python baseline.

Go if: every boolean gate holds; enqueue median at most half of Python's 97ms; daemon idle RSS at most Python's 18.5MB; `state-loss` and `timecap` results equal; the macOS build of `@cutils/sqlite` works. No-go on any gate failure that needs a compiler fix we cannot get within a week.
