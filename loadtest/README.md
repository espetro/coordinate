# loadtest

Reusable load test for the fleet queue. It answers two questions: how many agent sessions does this machine handle, and does the queue manage overload (2x and 3x the cap) correctly.

Stdlib only, macOS and Linux, run through uv. No pytest.

## Cost warning

The acp scenarios (`overload` acp mix, `failure`, `cancel`, `park`) call a real LLM through the agent you pick. Every acp job is a few real tool-using turns.

- Prefer a free or haiku model: `--model <id>` is written into a registry copy (for claude use a haiku id, for opencode a free model id).
- Never run with more than `cap * 3` jobs. The script refuses `--mult` above 3 unless you pass `--allow-big`.
- For a first look run `--skip-acp` (no LLM at all) or `--fake-acp` (zero-token stub, see below).
- A full run at cap 2 and mult 3 makes about 6 (overload) + 2 (failure) + 1 (cancel) + 1 (park, plus one resume) acp jobs.

## Run

```sh
# cmd-only smoke, no LLM calls
flock /tmp/tsc.lock uv run python loadtest/run.py --cap 2 --mult 3 --skip-acp --out /tmp/lt

# everything, real agent
flock /tmp/tsc.lock uv run python loadtest/run.py --cap 2 --mult 3 --agent opencode --model <cheap-model> --out /tmp/lt

# one scenario
uv run python loadtest/run.py --cap 3 --only cancel --agent opencode --out /tmp/lt
```

Use the machine's real cap: 2 on the MacBook, 3 on the laptop, 6 on the VPS. `--cap` sets `FLEET_CAP` for the private daemon only.

| Flag | Meaning |
|---|---|
| `--cap N` | machine cap under test |
| `--mult M` | queue `M * cap` jobs in the overload and chaos scenarios (max 3) |
| `--agent NAME` | agent in the fleet-acp registry (default `opencode`) |
| `--model ID` | model id written into the registry copy |
| `--only a,b` | scenarios: `overload,contention,priority,failure,cancel,park,chaos` |
| `--skip-acp` | cmd-only smoke, acp scenarios are reported as skipped |
| `--fake-acp` | acp scenarios run against `fake_acp.py`, a stub that mimics fleet-acp with no LLM |
| `--timeout S` | global safety timeout, default 1800. Everything is cleaned up when it fires |
| `--job-timeout S` | per-wave wait for acp jobs, default 240 |
| `--sleep S` | seconds the cmd jobs sleep, default 10 |
| `--acp-dir DIR` | fleet-acp checkout, default `../fleet-acp` or `FLEET_ACP_DIR`. `FLEET_ACP_CMD` also works |
| `--out DIR` | where `results.json`, `results.md` and the daemon logs go |

Exit code is 1 when a scenario fails a hard check or errors.

## Isolation

- Temp dir under `$TMPDIR` with its own `FLEET_DB`, `FLEET_ACP_HOME`, pid files and git repos. Nothing under `~/Documents`, nothing in `~/.fleet`.
- One daemon subprocess per scenario (`python -m fleet daemon`, `FLEET_MACHINE=loadtest`). The real service and its queue are never touched.
- The agent itself still uses the real `$HOME` for its own state and credentials (opencode needs its auth), so opencode session files accumulate in its data dir. Claude gets an isolated config dir under the temp `FLEET_ACP_HOME`.
- Temp dirs, daemons, job process groups and agent process groups are killed and removed after each scenario, on failure, on `--timeout`, and on Ctrl-C.

## Scenarios

| Scenario | What it does | Hard checks |
|---|---|---|
| `overload` | `mult*cap` jobs on distinct repos, once as `sleep` cmd jobs and once as real acp jobs (2-step file task plus commit). Samples queue DB every 0.2s, ps and memory every 1s | live leased running rows never exceed cap, all jobs done |
| `contention` | 4 jobs on one repo plus other repos | at most 1 running on the shared repo, others run in parallel |
| `priority` | jobs with mixed priorities enqueued before the daemon starts | start order equals (priority desc, FIFO) |
| `failure` | acp job with a nonexistent agent binary, acp job with a bad model id, plus healthy cmd jobs | both end failed, healthy jobs finish, slots released |
| `cancel` | cancel a running acp job, wait 2 heartbeats, list processes still alive for it | no orphan agent processes (the fleet-acp group is killed, the detached agent may not be) |
| `park` | cap 1: `wait-on` a running acp job, a queued job takes the slot, then `release` | same sessionId resumed with `--session`, job finishes, resume timed |
| `chaos` | `mult*cap` cmd jobs, `kill -9` the daemon, restart it, lease 5s | all jobs done, cap never exceeded |

Orphan cleanup: processes found alive after `cancel` and `park` are reported, then killed.

## Reading the output

`results.md` has a scenario table, the check list (`ok`, `WARN`, `FAIL`) and a capacity table. `results.json` has everything, including per-job queue-to-start latency, per-job peak RSS and the 1s time series.

- Live leased running rows are `status='running'` with an unexpired lease. That is what the cap is defined on, and the check must never fail.
- `max_actual_job_procs` counts real job processes alive. It can exceed the cap briefly after a daemon crash if slots expire before the reaper kills the old attempt. It is a WARN, not a failure.
- Peak RSS is the daemon plus all descendants (found by `ps` ppid walking, so it works the same on macOS and Linux). RSS double counts shared pages. CPU is `ps %cpu`, a decayed average.
- Safe cap by memory is `floor(0.7 * free memory before the run / peak per-agent RSS)`. Free memory is `vm_stat` free+inactive+speculative on macOS and `MemAvailable` on Linux. Use the acp mix for it, the cmd mix only measures queue behaviour.
- Queue-to-start latency uses the claim time (lease expiry minus lease length), so it is exact, not limited by sampling.
- The idle daemon polls with backoff up to 2s, so cmd makespan can exceed the ideal by about 2s per wave. That shows up as the gap between `makespan_s` and `ideal_makespan_s`.

## Self-test without tokens

`--fake-acp` swaps `fleet-acp` for `loadtest/fake_acp.py`. It prints a session id, starts a detached `sleep` as the "agent", writes the pid file, does the file task and commits. It exits 1 for the broken-binary and bad-model registries. It is killed with SIGKILL on cancel like the real wrapper, so it leaves the detached agent behind. That makes `cancel` and `park` report an orphan, which is how the harness proves it can detect one. Do not read the fake numbers (RSS, latency of acp jobs) as real.
