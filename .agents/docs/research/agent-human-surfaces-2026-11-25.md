# Agent and human consumption surfaces

Date: 2026-11-25 (ran `date`). Scope: how easy it is for agents, the first-class consumers, and humans, the second-class consumers, to consume coordinate state and output today; whether the JSON and NDJSON surfaces compose with Unix pipes and `jq`; whether a minimal hookable TUI is feasible and whether it should be interactive; and what common query surface should sit underneath both audiences.

Method: read `src/main.ts`, `src/queue.ts`, `src/daemon.ts`, `src/forwarder.ts`, `src/doctor.ts`, the public docs and the two agent skills; ran the installed coordinate 0.1.4 against a temporary `COORDINATE_DB` and piped real output to `jq`; checked the scriptc terminal surface with a small coverage probe. Evidence tags: (M) verified from code or by an experiment in this pass, (C) assessment or design recommendation.

## Verdict

| Surface | Ease today | Short verdict |
| --- | --- | --- |
| Agent reading state transitions | Easy for simple consumers | `events` is real NDJSON and works with `jq`; `forward --exec` is a good process boundary. Filtering and schema stability are thin. |
| Agent reading job state | Mixed | `status <id>`, `stats` and `cap show` are JSON, but the job list is TSV with embedded JSON text, payloads are double-encoded, and there is no query contract. |
| Agent reading job output | Not really possible | stdout and stderr are inherited by the daemon, so output exists only as an undifferentiated daemon stream, not as a per-job or per-attempt surface. |
| Human inspecting the queue | Hard | The list output is raw tab-separated rows with untruncated payload JSON; events are raw JSONL; there is no watch mode, table renderer, `why` view or TUI. |
| Human controlling jobs | Moderate | The verbs are simple and composable, but the human has to copy ids out of poor list output and cannot inspect output or the reason a job is blocked. |
| Built-in interactive TUI | Feasible, with narrow scope | scriptc can statically compile raw-mode key input and terminal cursor output (M). A hand-rolled ANSI TUI is realistic; Ink, React, blessed or ratatui are poor fits for this codebase. |

The main gap is not a lack of a TUI. The main gap is that coordinate does not yet have one complete, normalized, versioned read model. Events are close; job state is half structured; job output is missing. A TUI built now would mostly expose those gaps more attractively (C).

## What agents can consume today

### The good parts

`coordinate events` writes one compact JSON object per line, with `data` decoded as an object rather than left as a string (M, `src/main.ts:332-359`). This is the strongest surface in the product. It is naturally compatible with Unix pipes, line-oriented consumers, `jq`, `while read` loops and long-running forwarders.

Measured against a temporary database in this pass (M):

```sh
$ coordinate events
{"id":1,"ts":1795642821.614,"job_id":1,"kind":"enqueued","data":{"kind":"cmd"}}
{"id":2,"ts":1795642821.649,"job_id":2,"kind":"enqueued","data":{"kind":"cmd"}}

$ coordinate events | jq -c '[.id,.kind,.job_id]'
[1,"enqueued",1]
[2,"enqueued",2]
```

`coordinate events --follow` keeps the same shape while polling, so a consumer does not need a special streaming parser (M, `src/main.ts:353-358`). The monotonic event id is a usable resume cursor, and `forward --exec` sends one complete event JSON document on the child process stdin (M, `src/forwarder.ts:72-89`). The extension model is therefore already Unix-shaped: no in-process plugins, no shared library ABI, just newline-delimited JSON and subprocesses.

`stats` and `cap show` are compact one-line JSON documents (M, `src/main.ts:410-417` and the stats branch later in the same file). `enqueue`, `release` and `dead retry` print bare ids, which is also pipe-friendly. `status <id>` is valid JSON and includes useful derived fields such as `runtime_remaining_s` and `deadline_in_s` (M, `src/main.ts:37-53`).

### Where the agent surface stops being easy

The job list is not machine-readable in practice. With no id, `status` prints tab-separated cells in fixed source order: id, status, attempts, max attempts, waiting_on, payload (M, `src/main.ts:309-315`). `jq` receives each line as a string, not as an object. The embedded payload is JSON text inside the row, so even a TSV-aware consumer still has a nested decode step.

Single-job JSON is parseable, but `payload` is double-encoded. This works, and it was verified in this pass (M), but it is needlessly indirect:

```sh
coordinate status 1 | jq -r '.payload | fromjson | .cmd'
```

`stats` is sparse: states with zero jobs are absent rather than zero-filled (M, `src/queue.ts:681-688`). That is fine for a human but means every machine consumer must default missing keys. `cap show` has a fixed shape; `stats` does not.

There is no consistent `--json` or `--ndjson` convention. Some commands are always JSON, one command is TSV, `doctor` is always human text, mutating commands print bare ids or nothing, and errors are human strings on stderr with undifferentiated exit failure (M, `src/main.ts:32-35`, `src/doctor.ts:130-139`). This is not yet a published schema. The observability design already says the target should be tables by default and JSON Lines with `--json`, with a published schema (design intent in `.agents/docs/research/observability.md:200-209`); the implementation is not there.

The event schema is sparse and partly out of sync with its own documentation. The extension skill says `claimed` and `requeued` carry `attempt` (`skills/coordinate-extensions/SKILL.md:16`), but the implementation emits `claimed` with only `owner` and `done` or `failed` with only `status` (M, `src/queue.ts:524` and `src/queue.ts:562`). There is no machine, attempt, exit code, repo key, session id, blocker key, log path or duration in the standard transition events. A consumer that wants context must join back to `jobs` and `concurrency_slots` itself.

The skill file given to agents is materially stale: it says the TypeScript binary is cmd-only and ACP enqueue is unavailable (`skills/coordinate/SKILL.md:59-62`), while the command reference and `src/main.ts` document and implement `enqueue --acp` (M, `docs/cli.md:18-19`, `src/main.ts:15`). For a human this is confusing; for an agent it is worse, because the skill is the behavior contract it will follow.

## Job output is the largest missing surface

For cmd jobs the daemon uses `stdio: ["ignore", "inherit", "inherit"]` (M, `src/daemon.ts:373-384`). stdout and stderr therefore go wherever the daemon's stdout and stderr go. Under launchd they land in the shared `daemon.log` because the service plist points both streams there (M, `src/service.ts:123-124`). Under a manual daemon they interleave in that terminal. Either way there is no per-job identity, no attempt boundary, no seekable file contract and no CLI verb for reading output.

This means coordinate currently exposes state transitions but not work product. An agent can know that job 7 failed, but not what the compiler said. A human can inspect the daemon log only if they know where the service manager put it, and then must manually correlate interleaved lines. The durable queue is useful, but the observability loop stops at the exit status (C).

The fix should not be to paste raw output into events. Output can be large and can contain secrets. The right shape is per-job and per-attempt files in the state directory, with only paths, byte counts, exit classification and perhaps a bounded stderr tail in structured metadata (C). This matches the privacy constraint already recorded in the observability research: events should carry classified errors and pointers, not prompt text or tool output (`.agents/docs/research/observability.md:132`).

## The missing common surface

Today there is no shared query model underneath agent and human consumption. The important missing operations are not exotic:

| Operation | Current state | Needed for |
| --- | --- | --- |
| List jobs as objects | Not available | Agents, TUI, dashboards |
| Filter by state or kind | Not available | Triage, watchdogs |
| Search job metadata | Not available | Humans and agents looking for a repo, command or session |
| Sort by age, priority, state or runtime | Not available except fixed id order in `status` | Triage |
| Filter events by job or kind | Not available except post-processing with `jq` | Timelines, `why`, targeted consumers |
| Inspect one job with decoded payload | Partially available through double-encoded `status <id>` | Agents and details panes |
| Inspect job output | Not available | Debugging |
| Explain why queued or waiting | Not available | Human triage and agent self-correction |
| Versioned output schema | Not available | Stable automation |

Advanced filtering does not need to be reimplemented if the output is good NDJSON: `jq` already does selection, sorting and aggregation. The built-in surface only needs common, cheap operations whose semantics the TUI and CLI can share. Search should mean case-insensitive substring search over metadata such as id, command summary, cwd, repo key, waiting_on, outcome and agent name. It should not mean full-text log search; once logs exist as files, `rg` is already the right tool for that (C).

The right architectural seam is a read model, not a formatter glued onto SQL in `main.ts` (C):

```text
src/readmodel.ts    queryJobs(db, JobQuery), queryEvents(db, EventQuery), jobSummary(), whyJob()
src/format-json.ts  stable v1 machine records
src/format-table.ts human table rendering, truncation, relative times
src/tui.ts          input, repaint loop, selection and actions over the same read model
```

That gives one semantic surface with three renderers. `coordinate jobs --json`, a human table and the TUI should all be answers to the same `JobQuery`, not three slightly different SQL statements (C).

## Recommended machine contract

Keep the existing verbs working, but add a canonical read verb rather than further overloading `status` (C). The compatibility cost is low now, and the current no-id `status` output is neither a good human table nor a good machine format.

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
```

Output rules worth fixing once, while the consumer base is small (C):

1. Collection queries emit one object per line in machine mode. Single-object queries emit one JSON document. `--json` means machine output; the exact stream shape follows from the collection-versus-single distinction and is documented.
2. Nested JSON is decoded once. A job's `payload` should be an object in machine output, not a string containing JSON.
3. Machine records carry a version field or are governed by a published schema document. Additive fields are allowed within a version; renames and type changes require a new version.
4. stdout in machine mode contains data only. Progress, warnings and deprecation notes go to stderr.
5. Keep epoch-second numeric timestamps for machine records. Human renderers can derive relative or ISO timestamps. Duplicating both forms in every record is not worth it.
6. Event records should gain machine, attempt when known, outcome or error class when known, session id when present, and log paths once logs exist. They should not gain raw prompts or raw output.
7. Direct SQLite remains an unsupported escape hatch, not the public API. The store schema is core-owned and should not become a plugin contract.

## Human surface and the TUI question

### Interactive or not

A purely non-interactive `watch` view is useful but insufficient as the end state. Queue triage is intrinsically selective: find a job, inspect it, read recent events or logs, then cancel, retry or release it. A static live table still forces the human to copy ids into separate commands. Since humans are second-class here, the answer should not be a large dashboard application; it should be a small interactive triage UI with a hard scope (C).

A minimal interactive TUI is technically feasible inside the current TypeScript and scriptc stack. In this pass a probe using `readline.emitKeypressEvents`, `process.stdin.setRawMode`, terminal `columns` and `rows`, `cursorTo` and `clearScreenDown` passed `scriptc coverage --fail-on blockers` with all analyzed statements compiling statically (M). The same probe also showed that typings matter: the key object must be typed as `readline.Key`; a structural object type hit an unlowered keypress signature (M). This is a real constraint but not a blocker.

The practical implementation should be hand-rolled ANSI rendering over the read model. Ink or React would add a large dependency graph with no existing scriptc shim and a high static-compilation risk. blessed is old and dynamic. ratatui would introduce Rust, contrary to the repo's TypeScript plus scriptc direction. A small hand-rolled renderer is more code than `watch`, but it is the only option that matches the single-binary constraint and the interaction requirement (C).

### Scope that stays minimal

The TUI should be one screen with a header, a jobs table and a details pane. The header shows machine caps, daemon freshness and counts. The table shows id, state, age or time in state, attempts, priority, wait target and a truncated command or agent summary. The details pane shows decoded metadata, the computed `why`, recent events and the end of the log once logs exist. No mouse, no tabs, no dashboard builder, no editable forms, no multi-device federation in v1 (C).

Keys can stay small: arrows or Ctrl-N/Ctrl-P move, `/` filters metadata, `s` cycles sort, `f` cycles state filters, enter toggles details, `r` refreshes, `x` asks before cancel, `R` asks before retry, `e` prompts for an event name and releases it, `q` exits. Mutating keys require confirmation and call the same queue operations as the CLI, so events remain accurate (C).

If stdout is not a TTY, `coordinate tui` should fail with a clear message rather than emitting escape sequences into pipes. A separate non-interactive table can be produced by `coordinate jobs` or by `coordinate jobs --watch` if that proves useful. The TUI itself should not be the scripting surface (C).

### Hookable means external commands

The plugin architecture decision already points away from in-process extensibility. A hookable TUI should therefore use the same process-boundary style as `forward --exec`: user-configured external commands receive selected job JSON on stdin or receive safe substitutions such as `{id}`, `{cwd}` and `{repo}` (C). This is enough for actions like opening the worktree, copying the session id, attaching to a harness-specific UI or sending a custom notification.

Do not build a JavaScript plugin loader. The binary is static, and the archived extensibility design's strongest rule still applies: foreign code stays outside the core process. Hooks are user-invoked actions, not automatic event sinks, so they can be simpler than the forwarder and do not need cursor management.

## Recommended build order

1. Fix the agent contract documentation first. The ACP stale section in `skills/coordinate/SKILL.md` and the incorrect event-field claim in `skills/coordinate-extensions/SKILL.md` are small documentation bugs with outsized agent impact (M).
2. Add the read model and normalized machine output: canonical `jobs`, decoded payload, schema documentation, basic filter, search and sort semantics. This is the prerequisite for both agents and humans (C).
3. Add per-job and per-attempt output capture with `logs`. Without this, the TUI details pane and agent failure analysis remain shallow (C).
4. Add `why` and `health --json`. `why` computes current blockers from live rows rather than inferring them from history; `health` gives scripts and panels one fixed summary object (C, already aligned with `.agents/docs/research/observability.md:204-208`).
5. Improve the human table output. This delivers most human value before any input handling exists and exercises the same table renderer the TUI will use (C).
6. Build `coordinate tui` as a hand-rolled interactive terminal UI over the read model, with external-command hooks only. Treat this as the final consumer of the common surface, not as a shortcut around it (C).

## Bottom line

For agents, coordinate is already pleasant exactly where it embraces Unix: NDJSON events, stdin event forwarding, compact JSON for singleton stats and bare ids for mutations. It is unpleasant where structure stops: the job list, double-encoded payloads, missing filters, sparse events, undocumented schema drift and absent per-job output. For humans, the CLI verbs are acceptable but inspection is currently raw output rather than a product surface.

The correct next investment is a shared read model and output contract. After that, a minimal interactive TUI is both feasible and justified, provided it stays hand-rolled, single-screen, keyboard-only and externally hookable. Building the TUI before the read model and logs would produce polish without substance (C).
