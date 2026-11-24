# Real-agent benchmark

Like the rest of `benchmarks/` but the workload at the far end of the queue is a real ACP harness (maki, opencode) talking to a real model, not the stub agent from the Python-era bench. The numbers here measure what `bench-v2.md` explicitly could not: real `session/load` resume fidelity, real agent RSS, real turn latency and real duplicate-side-effect behaviour after an orchestrator kill.

## Layout

| File | Role |
| --- | --- |
| `acp-client.ts` | Minimal ACP client (node stdlib, `node >= 22.18` type stripping). Speaks `initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`; auto-accepts the first permission option; prints `{sessionId}` then `{stopReason}` on stdout. Spawns the agent detached in its own process group so it survives a daemon kill, then reaps the group on exit. |
| `agents.real.json` | Agent registry. `command`/`args` are spawned by the client; `class` (`plan` vs `free`) and `cap` are used by the driver to size the `[slots]` table it writes. |
| `agents-bin/` | Wrapper scripts for harnesses whose model is not an `acp` argv flag. `opencode-acp-*` set `OPENCODE_CONFIG` to a per-model file and force `--standalone` so each bench session gets a private server. |
| `opencode-configs/` | One config per bench model: `"model"` pinned, `"permission": {"*": "allow"}` (yolo), bench-irrelevant MCP servers disabled. |
| `run-acp.sh` | Job entry point. Sets PATH, pulls `BIFROST_API_KEY` from the macOS keychain at job start (never stored in the queue payload), runs `acp-client.ts`, appends the two contract lines to `<cwd>/client.jsonl` and stderr to `client.err`. |
| `bench-real.ts` | Driver: `setup`, `daemon`, `seed`, `resume`, `killtest`, `work`, `report`, `run`. |
| `runs/` | Gitignored. One directory per run; holds the isolated `queue.db`, `config.toml`, `sessions/`, `events.jsonl`, `daemon-rss.jsonl`, `results.json`. |

## Isolation

Every verb sets `COORDINATE_DB` and `COORDINATE_CONFIG` into the run dir, so the bench queue, daemon and slots never touch the real queue. `COORDINATE_CAP` bounds live agents machine-wide (default 3); per-agent caps come from the `[slots]` table the driver writes from `agents.real.json`. All bench jobs share repo key `bench-real` with `COORDINATE_REPO_CAP=1000`, so the caps that bind are the machine cap and the per-agent slot.

## Scenarios

- **density** (`run --scenario density --n N`): seed N sessions (`session/new` + a one-file turn), park N resume jobs on an event, release once, measure claim-to-finish distribution. N durable harness sessions hold zero processes while parked, so `--n 100` proves the "hundreds parked, K live" claim; `--n 1000` is the same shape, it just costs N model turns.
- **kill** (`--scenario kill`): same as density but SIGKILLs the bench daemon mid-wave and restarts it. Jobs must all reach `done`; retried jobs resume via `session/load`. Duplicate side effects are counted by markers in `ok.txt` (`resumed N` appearing more than once = a replayed turn).
- **work** (`--scenario work`): N sessions each build a small pytest module from scratch, run the tests and fix failures, while the daemon is killed once mid-run. Success = job `done` + `pytest` green.

## Models

All traffic goes through the local Bifrost gateway (`localhost:8317`); `run-acp.sh` pulls the key from the keychain service `bifrost` at job start. Registry entries ship with:

- `bifrost/zai-coding-plan/glm-4.5-air` — coding-plan quota
- `bifrost/minimax-coding-plan/MiniMax-M2` — coding-plan quota
- `bifrost/codex-free` — free OpenRouter pool, slot cap 1 (free routes rate-limit hard)

Add an agent by adding a registry entry (and an `agents-bin/` wrapper + `opencode-configs/` file if it is an opencode variant). Codex can join through `@zed-industries/codex-acp` once installed; freebuff cannot join at all (its CLI strips prompt args, interactive only, no ACP).

## Running

```sh
cd benchmarks/real-agents

# smoke: 3 sessions, cap 2 live agents
node bench-real.ts run --run-dir runs/smoke --agent maki-glm45air --n 3 --cap 2 --scenario density

# scale claim: 100 parked sessions, 4 live at a time, daemon killed mid-wave
node bench-real.ts run --run-dir runs/d100 --agent maki-glm45air --n 100 --cap 4 --scenario kill

# realistic: 4 sessions each ship a tested module under interruption
node bench-real.ts run --run-dir runs/work --agent maki-glm45air --n 4 --cap 2 --scenario work
```

`ACP_TRACE=1` in the daemon env writes a per-job `.acp-trace.jsonl` (spawn/initialize/session stages) into each session dir.

## First numbers (M)

`runs/smoke1` and `runs/smoke-kill2`, kinosmac (darwin arm64, 24GB, load ~3-5 while other sessions ran), 2026-11-24, `maki-glm45air`:

- seed + parked resume, n=3, cap 2: 3/3 sessions established, 3/3 resume jobs done via `session/load`, 0 duplicate markers. Claim-to-finish p50 11.3s, p95 18.3s.
- kill mid-wave: daemon SIGKILLed, 2/3 jobs retried (`attempts: 2`), all reached `done`, both retries resumed the same session. 2 duplicate markers measured: a turn killed mid-write replays its side effect on resume, matching what the stub predicted.

## Caveats

- Turn time is model-latency dominated (~10-18s for a trivial file write on glm-4.5-air), so density runs at n=100 take tens of minutes on coding plans. The scale claim is about parked-state cost and resume correctness, not wall-clock throughput.
- opencode `--standalone` spawns a private server per session, so its per-session overhead is higher than maki's; do not compare opencode and maki timings 1:1.
- Real models are not deterministic: a session that ignores the prompt is a data point, not a bench bug. Artifact checks (file markers, pytest green) are the ground truth.
