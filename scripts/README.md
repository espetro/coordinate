# Scripts

Run them from anywhere. Each script changes to the repo root first.

| Script | What it does |
| --- | --- |
| `build-bin.sh` | Builds the release binaries with scriptc into `dist/`. Linux x64 builds gnu and musl, and macOS builds both arm64 and x64 |
| `build-darwin-sqlite.sh` | Builds the SQLite archive for a macOS target with zig, for cross-compiling |
| `build-win-shim.sh` | Builds the SQLite archive for Windows with zig |
| `build-win.sh` | Cross-compiles the Windows binary from Linux |
| `build-sqlite-shared.sh` | Builds the shared SQLite library that the Node test path loads. `pnpm test` runs it when the library is missing |
| `zigcc-wrap` | A wrapper that restores the `zig cc` driver scriptc invokes |

The toolchain versions are pinned in `mise.toml`.
