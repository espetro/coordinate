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

## Quality gates

CI runs three gates on every PR: `pnpm test` (node --test suites), `pnpm lint` (oxlint) and `pnpm typecheck` (TypeScript 7 `tsc --noEmit`). Run all three locally before pushing. oxlint warnings do not fail the gate; errors do — suppress only with an inline comment stating why, as the existing `oxlint-disable-next-line` sites do.

## Release process

Releases use [changesets](https://github.com/changesets/changesets). The rules:

1. Every user-visible change gets a changeset file in the same PR: `pnpm changeset`, pick minor/patch, write one or two lines in the voice of the changelog. Chore-only PRs (CI, docs typo, test-only) can skip it.
2. The `version-packages` workflow keeps a "chore: version packages" PR open on main, rolling up all pending changesets into a version bump and `CHANGELOG.md` entries.
3. Merging that PR runs the publish step, which tags `vX.Y.Z` and pushes the tag. `release.yml` builds the binaries for the tag. coordinate is not npm-published; the tag is the entire release trigger.

Never edit `CHANGELOG.md` sections for unreleased versions by hand once the flow is live; write a changeset instead. The 0.3.0-and-earlier entries were written retroactively when the process was introduced.

Versioning intent: minor for new surfaces and behavior changes, patch for fixes. Pre-1.0, breaking changes ride in minor bumps but must be called out in the changeset text.
