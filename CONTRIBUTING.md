# Contributing

## Setup

You need [scriptc](https://github.com/vercel-labs/scriptc) 0.4.16, pnpm and zig 0.14.1. `mise install` installs all three from `mise.toml`. Newer zig releases removed the `zig cc` driver that scriptc calls, so keep 0.14.1.

```sh
pnpm install
pnpm test          # builds the SQLite shim for the Node test path on first run
pnpm build         # type check
pnpm build:bin     # scriptc binaries into dist/ (Linux x64 on Linux, macOS on macOS)
```

## Layout

| Path | What lives there |
| --- | --- |
| `src/` | The CLI, daemon, queue and event forwarder, plus the scriptc entry point `main-elf.ts` |
| `test/` | `node --test` suites |
| `bin/` | The Node entry point used by tests and development |
| `scripts/` | Build scripts for each target and the SQLite shim |
| `benchmarks/` | Measured results and how to reproduce them |
| `examples/` | Plugin examples |
| `skills/` | The agent skill shipped with the repo |
| `docs/` | User documentation, built into a site with [docmd](https://docmd.io) |
| `.agents/docs/` | Design notes, research and spike reports for contributors |

## Docs site

`docs/` is plain Markdown, and docmd is a pinned dev dependency. `pnpm docs:build` writes `site/` with the pages, `llms.txt` and `llms-full.txt`, and `pnpm docs:validate` checks the internal links. The `docs` workflow builds and checks links on every change, and deploys to Cloudflare Pages once the repo has the `CLOUDFLARE_PAGES_PROJECT` variable and the two Cloudflare secrets set.

## Conventions

- TypeScript compiled with scriptc is the only stack. The earlier Python version is on the `legacy/python` branch.
- Conventional commits, one change per commit, no co-author trailers.
- A number in the docs comes from a result file in `benchmarks/results/`, and the doc names the host it was measured on.
- Releases are tags named `v*`. The release workflow builds the binaries and attaches them to a draft release.
