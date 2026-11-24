# Shift-left type safety and validation

Date: 2026-11-24. Follow-up to the Effect v4 migration (`effect-migration.md`). Goal: catch breakage at author time instead of at daemon runtime, without fighting scriptc static compilation.

## Current state (M)

- `tsconfig.json`: `strict: true` only. No `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noImplicitReturns`, `verbatimModuleSyntax`.
- CI (`.github/workflows/ci.yml`) runs `pnpm test` only. The build is `tsc -p tsconfig.json` with `noEmit: true`, so tests do exercise the type checker, but there is no distinct, greppable `tsc --noEmit` step, and stronger flags are not on.
- Unsafe parse sites (casts of unvalidated data), from a repo grep:
  - `src/queue.ts` — `JSON.parse(row.payload) as Payload` (daemon claim path), row casts from `prepareRaw(...)` (`DaemonRow`, `AttemptRow`, `KeyCostRow`).
  - `src/daemon.ts:525` — same `JSON.parse(row.payload) as q.Payload`; rows at lines 192, 207.
  - `src/acp.ts` — `JSON.parse(text) as Record<string, {command, args?}>` (agent config, line 44), `JSON.parse(s) as Record<string, unknown>` (wire frames, line 78), and downstream `msg["id"] as number` style casts (88-97, 361-365).
  - `src/main.ts:256`, `src/forwarder.ts:133` — smaller event-data casts.
- Effect v4 ships `effect/Schema` and it is available in the dependency tree. Not yet proven to compile statically under scriptc; `effect-migration.md` lists Schema as unverified.

## Plan

Ordered so each step is small, merges independently, and never risks the static build.

1. Harden tsconfig. Turn on `noUncheckedIndexedAccess`, `noFallthroughCasesInSwitch`, `noImplicitReturns`, `noImplicitOverride`, `verbatimModuleSyntax`. Leave `exactOptionalPropertyTypes` for a later pass (it tends to fan out). Fix whatever falls out; expected to be modest, mostly row-index access.
2. Explicit CI typecheck step. Add a `typecheck` script (`tsc -p tsconfig.json`) and a separate CI job or step so a red typecheck is visible as such, independent of test failures. Cheap, no behavior change.
3. Validate the job payload boundary. The queue DB is the trust boundary everything else reads from. Add a runtime validator for the `Payload` shape at the `JSON.parse` sites in `queue.ts` and `daemon.ts` (a small hand-rolled guard is fine to start; it must be scriptc-static, which hand-rolled guards are). Fail the claim with a clear event kind instead of running a malformed job.
4. Validate ACP wire frames. Same treatment for the JSON-RPC parse in `acp.ts`: validate `id`/`method`/`params` shape on parse, reject malformed frames with a JSON-RPC error object rather than casting. This is the seam most exposed to third-party agent output.
5. Decide on `effect/Schema` for new code. Probe `effect/Schema` under `scriptc coverage` / `scriptc build` first; if it is static-safe, prefer it for new boundary validation and consider migrating the hand-rolled guards. If it is not static-safe, keep the hand-rolled guards and record the finding in `effect-migration.md`.
6. Property/type-level tests for the queue state machine. The port regressions doc already tracks parity gaps; add table-driven tests for lease/takeover/priority edges and, where cheap, type-level tests (e.g. `expectTypeOf` or a `.test-d.ts` with `tsd`) for the public queue API.

## Non-goals

- No rewrite of `queue.ts`/`config.ts` to Effect; they stay plain TS by design.
- No new runtime dependency; hand-rolled guards or `effect/Schema` only.
- No change to the DB schema or wire format.
