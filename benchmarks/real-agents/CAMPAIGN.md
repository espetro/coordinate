# Real-agent ACP benchmark campaign

Date: 2026-11-23/24. Branch `bench/acp-campaign`. Evidence tags: M = measured by us, C = claimed or designed, not yet measured. Host: kinosmac (darwin arm64, 24GB), load average 7-9 during runs (other coordinate daemons and sessions active), so all timings are upper bounds.

## Harness state (M)

`benchmarks/real-agents/` is functional end to end as of commit `6ecb198`: `bench-real.ts` drives `setup | daemon | seed | resume | killtest | work | report | run` against an isolated `COORDINATE_DB` per run dir; `acp-client.ts` speaks full ACP including `session/load`; `run-acp.sh` pulls `BIFROST_API_KEY` from the macOS keychain at job start. Verified again this session: two fresh runs completed without harness changes.

Known gaps observed (M):

- The driver never stops the bench daemon it spawns; each run dir leaves a `coordinate daemon` process behind. Kill it by the recorded `daemon.pid` after `report`.
- Bifrost rate limits show up as a job `failed` with `rate limited, try again in a moment` in `client.err`, not as a retry. Density n=5 cap 3 on glm-4.5-air lost 1 of 5 resume jobs this way under host load ~8.5. Treat a failed cell as quota signal, not a correctness signal.
- Duplicate counting only inspects `resumed N` markers. Session s0004 in `runs/d5-glm` wrote `ok 4` twice during seed inside one turn, which the marker check cannot see; a stricter artifact diff would catch model-side double writes.

## Campaign matrix (C)

Real model turns cost Bifrost quota. Keep N <= 10 per cell and codex-free cap <= 1 (free routes rate-limit hard). Invariants each cell must prove:

- density: parked jobs hold zero processes (check `ps` before release), all resume jobs reach `done` via `session/load`, zero duplicate `resumed` markers.
- kill: SIGKILL mid-wave, retried jobs resume the same session id via `session/load`, duplicate markers quantify at-least-once replay cost, all jobs reach `done`.
- work: job `done` plus artifact truth (pytest green), one daemon kill mid-run.

| Cell | Scenario | Agent | n | cap | Proves |
|---|---|---|---|---|---|
| done | density | maki-glm45air | 5 | 3 | parked=zero procs, resume correctness at small scale |
| done | kill | maki-glm45air | 3 | 2 | session/load resume after SIGKILL, duplicate replay count |
| next | density | maki-m2 | 5 | 3 | same invariants, second model |
| next | kill | maki-m2 | 3 | 2 | duplicate cost is model-agnostic |
| next | work | maki-glm45air | 3 | 2 | artifact truth under interruption |
| next | density | opencode-glm45air | 3 | 2 | second harness, do not compare timings 1:1 |
| stretch | density | maki-glm45air | 10 | 3 | first two-digit parked set |
| stretch | kill | maki-codexfree | 3 | 1 | free-pool resume fidelity, expect rate limits |
| deferred | density | maki-glm45air | 100 | 4 | the "hundreds parked" scale claim; tens of minutes of quota, run on VPS or idle host |

Run order: fill every cell at small n on the cheapest model first, then repeat the matrix on m2, then opencode, then scale n. Codex-free last and always cap 1.

## Batch results (M, 2026-11-24 UTC, kinosmac, load ~7-9)

`runs/d5-glm` density n=5 cap 3 maki-glm45air: 5/5 sessions seeded, 4/5 resume jobs `done` (job 7 `failed` on a Bifrost rate limit), 0 duplicate `resumed` markers, 1 missing marker (the failed job). Claim-to-finish p50 12.7s, max 26.3s across 10 jobs.

`runs/kill3-glm` kill n=3 cap 2 maki-glm45air: daemon SIGKILLed mid-wave, 2 of 3 resume jobs retried (`attempts: 2`), all 3 reached `done`. 2 duplicate `resumed` markers, one per retried job, matching `runs/smoke-kill2` exactly: a turn killed mid-write replays its side effect on resume. Claim-to-finish p50 9.2s, max 42.7s.

The duplicate-marker result now reproduces across two independent kill runs (2 duplicates each time, equal to the number of retried jobs), so "SIGKILL mid-turn costs exactly one replayed side effect per killed claim" is measured twice, not once.

## Next steps

- Fill the matrix cells marked `next` on this host, one cell per invocation, checking `daemon.pid` cleanup after each.
- Before the n=100 scale run, fix or script the bench-daemon teardown; 100 turns at ~10-25s each is tens of minutes of quota.
- VPS runs: the harness is portable, but `run-acp.sh` reads `BIFROST_API_KEY` from the macOS keychain only. A VPS needs either its own Bifrost gateway with a key in whatever secret store the script is pointed at, or a reachable Bifrost endpoint; do not put the key in queue payloads or committed files. Also never share one `COORDINATE_DB` between machines; each host gets its own run dir and queue.
- Consider tightening `countResumedMarkers` to also flag repeated `ok N` seed lines, since a double seed write was already observed once.
