# Bench v2: noise floor, orchestrator kill and live density

Date: 2026-11-22. Branch `spike/bench-v2` in `~/.worktrees/fleet-spikes/bench2`. Evidence tags: M = measured by us, R = read in the project's own docs, B = blog or marketing claim, K = from memory, unverified.

## What was added

| Piece | File | Purpose |
|---|---|---|
| `noise-floor` scenario | `bench/bench.py` | repeats a chosen subset of the existing scenarios N times and reports mean, stdev, min, max and coefficient of variation (cv_pct) per metric |
| stub ACP agent | `bench/stub_acp_agent.py` | stdlib-only ACP agent: `initialize`, `session/new`, `session/load` (resume by id from a state file), `session/prompt` (a turn of configurable duration while streaming `session/update` notifications), `session/cancel`, configurable RSS ballast |
| stdlib ACP client | `bench/acp_client.py` | the client side of the same protocol, so the bench can drive fleet's ACP lane with no node dependency; same CLI and stdout contract as `fleet-acp` |
| `orchestrator-kill` scenario | `bench/bench.py` | K stub ACP sessions through fleet, `kill -9` the daemon group mid-turn, restart, every session must complete; counts duplicate turns and resumed-via-`session/load` versus restarted |
| `live-density` scenario | `bench/bench.py` | steps up concurrent stub sessions at a given ballast, reports orchestrator RSS separately from agent RSS, plus the fixed overhead |

Existing scenarios are unchanged in semantics. The adapter contract (section 3 of `docs/tool-search-rubric.md`) is unchanged: the bench selects the ACP command through the existing `FLEET_ACP_CMD` environment variable, so no hook was added to fleet itself.

## How to run

```sh
export PATH=$HOME/.local/bin:$HOME/.local/share/mise/shims:/opt/mise/shims:$PATH
cd ~/.worktrees/fleet-spikes/bench2
uv sync

# noise floor (10 repeats of a chosen subset)
.venv/bin/python bench/bench.py --tree . --backend sqlite \
  --only noise-floor --noise-scenarios cli,cap,chaos --repeats 10 \
  --out bench/results-noise-sqlite-vps.json

# the v2 scenario set
.venv/bin/python bench/bench.py --tree . --backend sqlite \
  --only cli,idle,throughput,cap,repo,priority,chaos,toolpark,orchestrator-kill,live-density \
  --out bench/results-v2-sqlite-vps.json
```

Useful flags: `--repeats N` (default 10) and `--noise-scenarios a,b,c` (default `cli,cap,chaos`). Every result file records the host state (load average, memory available, timestamp) next to the measurements, because the VPS is shared with other spike sessions.

The stub agent is configured through the environment the daemon passes down: `STUB_TURN_MS` (turn duration), `STUB_CHUNKS` (streamed updates per turn) and `STUB_BALLAST_MB` (RSS ballast, 60 for codex or maki-like, 240 for claude-like). The state file `.stub-acp-sessions.json` lives in the session's working directory and records `turns_started`, `turns_done` and `loads` per session id, which is how duplicate turns and `session/load` resumes are counted.

## Measured noise floor (M)

`bench/results-noise-sqlite-vps.json`, 10 repeats of `cli`, `cap` and `chaos` on the SQLite backend, VPS (Linux x86_64, 6 cores, 11GB, shared with three other spike sessions), 2026-11-22. Load average at the start of the run was 6.8 over 1 minute and 2.82 over 5 minutes, so the machine was busy and the numbers are upper bounds.

| Scenario | Metric | Mean | Stdev | Min | Max | cv % |
|---|---|---|---|---|---|---|
| `cli` | `enqueue_cli_median_ms` | 119.3 | 5.9 | 107.2 | 126.8 | 4.9 |
| `cli` | `enqueue_cli_p95_ms` | 137.6 | 11.8 | 127.6 | 165.3 | 8.6 |
| `cap` | `cap_makespan_s` | 6.43 | 0.06 | 6.35 | 6.52 | 1.0 |
| `cap` | `cap_max_concurrency` | 3.0 | 0.0 | 3.0 | 3.0 | 0.0 |
| `chaos` | `chaos_recovery_to_all_done_s` | 14.47 | 0.01 | 14.46 | 14.49 | 0.07 |
| `chaos` | `chaos_duplicated_jobs` | 3.0 | 0.0 | 3.0 | 3.0 | 0.0 |

All boolean gates (`cap_holds`, `cap_all_done`, `chaos_all_done`) held in 10 of 10 repeats, so the correctness gates are stable, and the timing metrics are the ones that move. A change is inside the noise when it is smaller than roughly twice the stdev of the metric: about 12ms for `enqueue_cli_median_ms`, about 0.13s for `cap_makespan_s` and about 0.02s for `chaos_recovery_to_all_done_s` on this machine. `enqueue_cli_p95_ms` is the noisiest metric (cv 8.6%) because it is a second order statistic over ten samples.

Consequence for the improvement loop: an enqueue latency change under 12ms and a crash recovery change under 0.02s are not evidence of anything on this machine, and the `cli` gate at 300ms has roughly 30 standard deviations of headroom, so the gate itself is never in doubt.

## Measured v2 results (M)

`bench/results-v2-sqlite-vps.json`, same machine and date. Baseline gates all passed: `cap_holds`, `repo_cap_holds`, `chaos_all_done`, `tool_cap_holds`, `priority_ok` and `tool_trivial_ran_while_parked` are true, `enqueue_cli_median_ms` is 106.3 (gate 300), idle RSS 18.6MB with 0% CPU, 60 trivial jobs in 7.2s at cap 6 (8.33 jobs per second).

`orchestrator-kill` with K = 3 stub ACP sessions and a 20s turn: all 3 jobs completed (`orchkill_all_done` true), the 3 agent processes were still alive right after the daemon group was killed with `kill -9` (`orchkill_agents_alive_after_kill` = 3), so the agents outlive the orchestrator as G4 requires, and recovery to all done took 28.2s. Every job ran twice (`attempts` = 2) and every retry resumed the same session id through ACP `session/load` (`orchkill_resumed_via_session_load` = 3, `orchkill_restarted` = 0). Each killed mid-turn attempt counted as one duplicate turn, so `orchkill_duplicate_turns` = 3. The orchestrator cannot re-adopt a running agent process, it resumes the session instead, which is the S3 path. `orchkill_orphan_agents_surviving` = 0 after the scenario's cleanup, which kills the agents the bench started by exact pid and process group.

One caveat found while running this scenario (M): fleet's daemon does not unwind on SIGTERM, because the default SIGTERM handler kills the Python process without running the `finally` block in `daemon.run`, so the ACP agents of the killed jobs stay alive. They are only reaped when the lease expires, which the daemon does at claim time. The bench therefore kills its own agents explicitly after each ACP scenario. This is a real gap in the orchestrator, not a bench artefact, and it should be fixed before the orchestrator is used unattended.

`live-density` with a 60MB ballast per agent: the fixed orchestrator overhead was 18.5MB with no live session, and the orchestrator grew to 19.1MB at 1 session, 19.7MB at 2 and 20.3MB at 4, that is about 0.4MB per live session on top of the overhead. Agent RSS was 73.0MB per session at every step (60MB of ballast plus about 13MB of interpreter), so the agents scale linearly at about 14 live sessions per GiB of device memory for a 60MB-footprint harness. The orchestrator stays inside the 200-300MB budget with room to spare, because agent memory is the binding constraint, as the framing document already concluded (M).

## Caveats

- The stub agent is not a real harness. It streams updates on a timer and allocates ballast, so the numbers describe the orchestrator's cost and the harness footprint model, not the behaviour of Claude Code or Codex.
- The machine was shared during the run (load average 6.8 at the start), so the absolute latencies are upper bounds and the noise floor should be re-measured on an idle machine before it is used as a regression threshold.
- The density step-up used 1, 2 and 4 sessions. The linear fit of the orchestrator's per-session cost (about 0.4MB) is measured over that small range only; the park-density scenario is still needed for the thousands-of-parked-sessions figure.

## Bench CI: state loss and the regression gate (M, 2026-11-23)

Branch `feat/bench-ci`. Two new scenarios and a comparison gate, described in `docs/bench-ci.md`.

`state-loss` puts four kinds of in-flight state in the store at once, kills the daemon with `kill -9` and restarts it: 2 live shell jobs, 2 parked jobs waiting on an event, 1 job holding a weighted `tool:vitest` lease, and 1 ACP session mid-turn in the stub agent. The measured outcome on the VPS (load average 1.0 at the start of the run): 0 jobs lost, all 4 in-flight jobs ran twice, 1 duplicate turn, 0 leases leaked, and both parked jobs were still parked with their `waiting_on` intact.

The field diff over the job rows shows exactly which state the crash cost. Only the volatile fields changed: `attempts` went from 1 to 2, `lease_owner` and `pgid` went from a value to null, and `status` went from `running` to `done`. The `payload` did not change at all, which includes the durable ACP session id, so the retry resumed the same session through ACP `session/load` rather than starting a new one. The stub agent's own session state shows the other half: `turns_started` went from 1 to 2 and `loads` appeared, so the session's in-memory fields were lost with the process and the turn was repeated. The price of a `kill -9` is therefore a repeated turn, not a lost job.

`park-density` opens 1,000 and then 10,000 more parked sessions and measures the orchestrator's cost per parked session. 11,000 parked sessions measured (M) cost the orchestrator 0MB of extra RSS (18.4MB before and after) and 303 bytes each in the SQLite store. The bulk path is `bench/park_filler.py`, which calls fleet's own `queue.enqueue` and `queue.wait_on` in one process, because one CLI process per job would have taken about 16 minutes at the measured 95ms per enqueue.

The comparison gate is `bench/compare.py` with `bench/thresholds.toml`. A numeric metric fails only when it is worse than both the noise band (2 x stdev from the idle noise floor in `bench/noise-linux.json`) and the per-metric percent tolerance, and a metric that the run did not produce fails too, so a crashed scenario cannot pass silently. The committed Linux baseline is `bench/baseline-linux.json`, produced from the quick scenario set on this host: the run took 3m4s, enqueue median 93.5ms, idle RSS 18.4MB at 0 percent CPU, 8.72 jobs per second, and every gate held.
