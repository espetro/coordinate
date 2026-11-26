# Implementation plan: agent and human surfaces

Date: 2026-11-26. Host running the implementation: vps-ef376962 as own-agents. Source research: `.agents/docs/research/agent-human-surfaces-2026-11-25.md` in the worktree.

Branch: `feat/agent-human-surfaces`. Worktree: `/home/own-agents/.worktrees/coordinate/agent-human-surfaces`. Base: `origin/main` at `80c0ccac6abbfa2e22dfc90372079379705f73c9`.

## Product goal

Make coordinate state and output easy for agents to consume first, then make the human inspection surface useful. The implementation must follow the research report's build order. Agents are the primary audience. Humans are secondary and get a small triage surface, not a dashboard.

## Hard constraints

- TypeScript plus scriptc only. Follow the existing flat `src/` style and the scriptc subset already used in the repo.
- No JavaScript plugin loader. Hooks are external commands only.
- No telemetry work, no service-install work, no migration work, no unrelated refactors.
- Do not push, tag, release or open a PR.
- Conventional, atomic commits. No co-author trailers.
- Commit at least every 20 minutes while working.
- Keep all edits in the worktree and branch named above.
- Tests use the repo's package manager and scripts. Inspect `package.json`; currently `pnpm install`, `flock /tmp/tsc.lock pnpm run build`, and `flock /tmp/tsc.lock pnpm test` are the expected verification commands on the VPS.
- Do not use `pkill`, `killall`, `tmux kill-server`, or pattern-based process cleanup.
- Update the progress file named in each phase prompt after each commit or completed milestone.

## Shared design contract

Build one shared read model rather than separate SQL and formatting logic per surface. The target seam from the report is:

```text
src/readmodel.ts    queryJobs(db, JobQuery), queryEvents(db, EventQuery), jobSummary(), whyJob()
src/format-json.ts  stable v1 machine records
src/format-table.ts human table rendering, truncation, relative times
src/tui.ts          terminal input, repaint, selection and actions over the same read model
```

The exact file split may change if the existing codebase suggests a better one, but the semantic rule does not: CLI JSON, human tables and the TUI must render the same query results.

Machine output rules:

1. Collection queries emit one object per line in machine mode. Single-object queries emit one JSON document.
2. Nested JSON is decoded once. In particular, job `payload` is an object in machine output, not a string containing JSON.
3. Machine records carry a version field or are governed by a published schema document. Additive fields are allowed within a version.
4. stdout in machine mode contains data only. Warnings and progress go to stderr.
5. Keep epoch-second numeric timestamps in machine records.
6. Event records may gain machine, attempt when known, outcome or error class when known, session id when present, and log paths once logs exist. They must not gain raw prompts or raw output.
7. Direct SQLite remains unsupported as a public API.

Target CLI shape:

```text
coordinate jobs [--status queued,running,...] [--kind cmd,acp]
                [--search TEXT] [--sort id|created|priority|status|runtime]
                [--asc|--desc] [--limit N] [--json]
coordinate status ID [--json]
coordinate events [--job ID] [--kind done,failed,...] [--since-id ID]
                  [--search TEXT] [--follow]
coordinate logs ID [--attempt N] [--follow]
coordinate why ID [--json]
coordinate health [--json]
coordinate tui
```

Compatibility rule: keep existing verbs and output working where practical. It is acceptable to add a canonical `jobs` verb instead of further overloading no-id `status`.

## Phase 1: contract and read model

Deliverables, at most these three:

1. Fix the stale agent-facing documentation: `skills/coordinate/SKILL.md` must stop saying ACP enqueue is unavailable, and `skills/coordinate-extensions/SKILL.md` must match the event fields the implementation actually emits or the implementation must be brought into documented alignment.
2. Add the shared read model and normalized v1 machine output for jobs, including canonical `coordinate jobs`, decoded payloads, basic filters, search, sort and limit semantics, plus schema documentation.
3. Add focused tests and documentation for the contract.

Commit the copied research report and this plan as an initial docs commit if they are still untracked. Then implement. Time box: 90 minutes.

## Phase 2: output capture, logs, why and health

Deliverables, at most these three:

1. Capture stdout and stderr per job and per attempt into files under the coordinate state directory, with durable metadata linking job, attempt and log paths. Do not put raw output into events.
2. Add `coordinate logs ID [--attempt N] [--follow]`, `coordinate why ID [--json]`, and `coordinate health [--json]` using the shared read model.
3. Add focused tests and documentation, including event metadata pointers to log paths where appropriate.

Time box: 2 hours.

## Phase 3: human table and watch surface

Deliverables, at most these three:

1. Implement the human table renderer over the shared read model: truncation, readable state and age columns, sorted and filtered output.
2. Add a non-interactive watch mode if it fits cleanly, such as `coordinate jobs --watch`, without making watch mode the scripting surface.
3. Add focused tests and documentation for table, search, sort and watch behavior.

Time box: 90 minutes.

## Phase 4: minimal interactive TUI

Deliverables, at most these three:

1. Implement `coordinate tui` as a hand-rolled ANSI, single-screen, keyboard-only triage UI over the shared read model. If stdout is not a TTY, fail clearly.
2. Support the small key set from the report: move, filter, cycle sort, cycle state filter, details toggle, refresh, confirmed cancel, confirmed retry, prompt-release event, quit. Keep mutations routed through the same queue operations as the CLI.
3. Add external-command hooks only, with selected job JSON on stdin or safe substitutions, plus focused tests or smoke coverage and documentation.

No mouse, tabs, dashboard builder, editable forms, plugin loader or multi-device federation. Time box: 2 hours.

## Final acceptance criteria

- `pnpm run build` and `pnpm test` pass in the worktree.
- Machine output composes with `jq` for the canonical job and event surfaces.
- Job payloads are decoded once in machine output.
- A failing job leaves inspectable per-job output and a useful `why` explanation.
- Human inspection no longer requires copying ids out of raw TSV.
- The TUI is small, interactive, keyboard-only and built over the same read model.
- `docs/cli.md`, `ARCHITECTURE.md` and relevant skills reflect the shipped behavior.
- The branch contains atomic commits and is not pushed.
