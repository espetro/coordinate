# Windows spike: can the TypeScript port ship a Windows binary for v0.1.0?

Date: 2026-11-23. Worktree `~/.worktrees/coordinate/windows-spike`, branch `spike/windows-spike`. Time box 2 hours. Compiler: scriptc 0.4.16 in the standard PATH. No Windows host or wine was available on this VPS, so every claim about the built binary below is about the artifact, not its run-time behavior; runtime verification on a Windows machine is the one item this spike could not do.

## Verdict: conditional go

The Windows x64 binary builds on this Linux host and the port needed only three small Windows-awareness fixes (M). Go for shipping a Windows x64 exe in the v0.1.0 release matrix, on the condition that one Windows machine (or CI windows-latest runner) runs the smoke pass (enqueue, status, daemon claim loop) before the release is cut, because nothing here executed the exe (M). The queue core, CLI parsing and daemon loop compile untouched apart from those fixes; `@cutils/cli` was never exercised at run time (the CLI seam is hand-rolled, see `ts-port-spike.md`), so it only had to compile, and it did (M).

## Q1: targets and cross-compilation (all measured M)

`scriptc build --help` has no per-target flag. Cross-compilation is selected with the `SCRIPTC_TARGET` environment variable, documented at scriptc.dev/docs/platforms and reproduced here: `SCRIPTC_TARGET=x86_64-windows-gnu scriptc build fib.ts -o fib.exe` produces a PE32+ console executable (C for the doc example, M for our build). The target requires (C, docs; M, reproduced):

1. `zig` as the linker for cross targets. The mise-installed zig is 0.16.0, and zig 0.15+ removed the `zig cc` driver that scriptc invokes (`error: unknown command: -target`). zig 0.14.1 still has it and works. Linux-to-Windows does NOT need a Windows host or MSVC; zig supplies the Windows sysroot.
2. The `@scriptc/runtime-win32-x64-msvc` runtime pack in the project, at the compiler's version (0.4.16). The docs' example name `@scriptc/runtime-x86_64-windows-gnu` does not exist on npm (M, 404); the actual pack is `runtime-win32-x64-msvc` (M, npm search). Installed as a devDependency, one line in `package.json`.
3. FFI inputs prebuilt for the target (C, docs "cross-target limits"; M, hit directly): `@cutils/sqlite`'s `--ffi` manifest points at `build/libsqlite3-shim.a`, which the package ships as an ELF archive. lld-link rejects it with `unknown file type: sqlite_shim.o`.

Exact build command that works, run from `ts/` (M):

```
SCRIPTC_TARGET=x86_64-windows-gnu SCRIPTC_LINKER=<path>/ts/zigcc-wrap \
  scriptc build main-elf.ts --npm-static @cutils/sqlite,@cutils/cli \
  --ffi node_modules/@cutils/sqlite/ffi.json -o ../win-spike/coordinate.exe
```

where `zigcc-wrap` is a one-line shim running `zig 0.14.1 cc "$@"` (SCRIPTC_LINKER is executed as a single program, so it cannot be plain zig). `scripts/build-win.sh` and `scripts/build-win-shim.sh` encode the whole recipe and reproduce the artifact (M).

Diagnostics observed on the way, in order (M): mise shim without a default zig version fails with `mise ERROR No version is set for shim: zig`; zig 0.16.0 and 0.15.2 both fail with `unknown command: -target`; ELF shim archive fails with `lld-link: error: unknown file type: sqlite_shim.o`; after the COFF repack, `lld-link: error: undefined symbol: stat64i32` (zig's mingw CRT does not export that ucrt alias); all resolved as above. Final artifact: `PE32+ executable for MS Windows 6.00 (console), x86-64, 6 sections`, 3.4 MB (M), essentially the same size as the Linux gnu ELF (3.94 MB per `benchmarks/results/results-ts-0.4.16-linux-vps.json`). The only compiler diagnostic is the known SC6014 payload-key-order warning from `daemon.ts`, identical to the Linux build (M).

## Q2: @cutils/sqlite and @cutils/cli on the Windows target

`@cutils/sqlite` compiles for the Windows target via `--npm-static` (M), but its static shim must be rebuilt as COFF: `scripts/build-win-shim.sh` cross-compiles the vendored shim and the sqlite amalgamation with `zig cc -target x86_64-windows-gnu` and repacks the archive, plus a bridge object for `stat64i32`. With that in place the link succeeds (M). What was NOT possible here: running the exe, so WAL recovery, checkpointing and file-locking behavior under NTFS are claimed-works (C: SQLite supports Windows natively and the pragma set in `queue.ts` is plain WAL + busy_timeout, no Linux-specific VFS), to be confirmed by the pre-release smoke pass. No VFS or locking code change was needed in the port; `PRAGMA busy_timeout=5000` / `journal_mode=WAL` / `synchronous=NORMAL` are cross-platform (M, code inspection).

`@cutils/cli` compiles in the same build (M). It is not on the runtime path (hand-rolled argv parsing in `src/main.ts`), so its Windows behavior is irrelevant for v0.1.0.

Windows-specific fixes made on this branch (all M, `node --test` 10/10 after each):

- `src/daemon.ts`: `/bin/sh` hardcoded for string-form jobs; now `cmd.exe /c` on `process.platform === "win32"`. Note this changes the shell grammar accepted on Windows (no POSIX pipes in a single string job); argv-array jobs are shell-free and unaffected.
- `src/daemon.ts`: `killGroup` and the lease-expiry path used `process.kill(-pid, ...)` process-group kills, which are meaningless on Windows; on win32 they now kill the recorded pid directly. Residual risk (C): a shell that spawns grandchildren does not take them down on Windows, accepted for v0.1.0 because the shim runs one command.
- `src/env.ts`: XDG default paths under `~/.local/state` and `~/.config` do not exist on Windows; dbPath/configPath now use `LOCALAPPDATA`/`APPDATA` on win32, `COORDINATE_DB`/`COORDINATE_CONFIG` overrides unchanged.

## Q3: daemon on Windows for v0.1.0

Recommendation: foreground only (M recommendation, minimal change). The daemon already runs as a plain foreground process with a setImmediate/setTimeout pump and graceful SIGTERM/SIGINT stop; on Windows, Ctrl+C in a console delivers SIGINT through the same handler path, and the binary needs no installation step. Reasoning: a scheduled task adds a task-XML surface and silent-failure modes we cannot test from this host; a Windows service wrapper (NSSM or `sc.exe` + a service shim) adds a service-control-handler integration that the scriptc runtime would need to prove out separately; both are deferral-able to v0.1.x without blocking anything in the queue's semantics, because the claim loop tolerates daemon absence (jobs are claimed with leases, and a dead daemon only delays execution, it does not lose queued work). Document `coordinate daemon` as a foreground command on Windows in the README; keep `service` unported as it already is.

## Release-matrix change (spec only, no workflow edits)

Spec for the owner of `.github/workflows/release.yml`:

- Add a `windows-x64` job to the release matrix, `runs-on: windows-latest`, gated on the v* tag push like the existing job.
- Steps: checkout; install zig 0.14.1 (0.15+ lacks `zig cc`; pin the exact version); setup Node 24 and pnpm; `pnpm install --frozen-lockfile` in `ts/`; run `scripts/build-win-shim.sh` (needs a POSIX shell on the runner: run it under bash, it only calls zig and ar); run `scripts/build-win.sh` with `SCRIPTC_TARGET`/`SCRIPTC_LINKER` set inside the script; attach `win-spike/coordinate.exe` to the release as `coordinate-v<tag>-windows-x64.exe`.
- Alternatively the build can stay on ubuntu-latest: zig + the runtime pack cross-compile fine from Linux (that is exactly what this spike did), which keeps one build job for all three OSes. Recommended: build Linux gnu, Linux musl and Windows x64 in one ubuntu job; add macos builds later per the existing plan. The only runner requirement is zig 0.14.1 in PATH and pnpm.
- Keep the Python wheel/sdist job unchanged.

## Not done / open

- Runtime execution of `coordinate.exe` (no Windows host or wine here): smoke pass on a Windows machine is the go-condition above (M blocker, C behavior).
- `child_process` spawn of real jobs on Windows (detached flag semantics, PATH resolution for argv-array jobs) is unverified (C).
- Zig 0.14.1 is EOL upstream; if the scriptc docs ever name a minimum zig for the Windows target, revisit. The pin in the build script makes this explicit (M).
- `@cutils/sqlite` on Windows under concurrent multi-process access (WAL on NTFS): needs the smoke pass or a small stress script run on Windows (C).
