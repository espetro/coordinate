# Bench CI

Date: 2026-11-23. Evidence tags: M = measured by us, R = read in the project's own docs, B = blog or marketing claim, K = from memory, unverified.

The bench suite runs in GitHub Actions on every pull request and on every push to `main`. The job runs the quick scenario set, compares the result against a checked-in baseline and fails when something regressed. The point is to catch a performance or durability regression on the pull request that introduced it, not after it merged.

## What the job does

| Step | What it does |
|---|---|
| `Install uv` | `astral-sh/setup-uv@v5` with the uv cache keyed on `uv.lock` |
| `Install the project` | `uv sync --all-groups --frozen`, which creates the `.venv` the bench drives |
| `Run the benchmark` | `bench/bench.py` over the quick scenario set, writing `bench/results/results-ci.json` |
| `Compare against the baseline` | `bench/compare.py` against `bench/baseline-linux.json`, with `bench/thresholds.toml` and `bench/noise-linux.json`; the markdown table goes to `$GITHUB_STEP_SUMMARY` and the exit code fails the job |
| `Upload the results` | `bench/results/` as a workflow artifact, 14 days of retention |

The quick scenario set is `cli,idle,throughput,cap,repo,priority,chaos,toolpark,orchestrator-kill,state-loss`. It took 3m4s on the VPS (M), so the job fits comfortably in the 10 minute target and inside the 45 minute job timeout.

The `workflow_dispatch` event adds two inputs. `scenario_set` picks `quick` or `long`; `long` adds the `park-density` scenario, which opens 1,000 and then 10,000 more parked sessions and reports the orchestrator RSS and the bytes per parked session. `park_density_steps` overrides the step sizes, comma separated.

## Why the runner needs thresholds, not a fixed number

A GitHub runner is a shared, virtualized, two-core machine whose neighbours are not ours. The same code produces different latencies on every run, so an absolute number like "enqueue must be under 300ms" is either so loose it catches nothing or so tight it fails on noise. The comparison therefore works in two bands, and a metric has to escape both to fail.

The first band is the metric's own noise, measured on an idle host. `bench/noise-linux.json` holds 10 repeats of `cli`, `cap`, `chaos` and `throughput` with a load average of 0.00 at the start of the run (M, branch `spike/noise-idle`). The stdev of each metric in that file is the metric's noise on a quiet machine, and the band is twice that stdev. For `enqueue_cli_median_ms` the stdev is 6.4ms, so the band is about 13ms; for `chaos_recovery_to_all_done_s` the stdev is 0.003s, so the band is 0.006s.

The second band is a per-metric percent tolerance in `bench/thresholds.toml`, because the noise file only covers the four scenarios it measured. The tolerance is wide where the metric is noisy by nature and tight where the number is supposed to be stable. `enqueue_cli_p95_ms` gets 35 percent because it is a second order statistic over ten samples and had a coefficient of variation of 8.9 percent (M); `idle_rss_mb` gets 20 percent; the recovery times get 40 percent because they include a lease expiry wait.

A metric fails only when it is worse than both bands, so a noisy metric cannot fail the job for a change inside its own noise, and a stable metric cannot drift just because its stdev happens to be small. Metrics whose baseline is near zero get an `absolute_tolerance`, which is the floor of the band: `idle_cpu_pct` has a baseline of 0 percent, so a percent tolerance would be zero and any wobble would fail the job.

Metrics that describe semantics rather than speed use `direction = "none"`, which means the value must not change at all. `cap_max_concurrency` must stay at 3, `repo_shared_max_concurrency` at 1, `chaos_duplicated_jobs` at 3. The durability counts get the same treatment plus a ceiling: `stateloss_jobs_lost` and `stateloss_leases_leaked` must stay at 0, because losing a job or leaking a lease is a regression no amount of noise excuses.

Boolean gates are a separate class and are checked first. `cap_holds`, `repo_cap_holds`, `chaos_all_done`, `tool_cap_holds`, `priority_ok`, `orchkill_all_done` and the rest must all be true. A gate that flips from true to false fails the job even when every number is inside its band.

## How to refresh the baseline

The baseline is a checked-in file, so it only helps if it is refreshed when the code legitimately changes. The procedure is the same on a laptop and on the runner.

```sh
export PATH=$HOME/.local/bin:$HOME/.local/share/mise/shims:/opt/mise/shims:$PATH
uv sync --all-groups

# on a quiet host, with the quick scenario set
.venv/bin/python bench/bench.py --tree . --backend sqlite \
  --only cli,idle,throughput,cap,repo,priority,chaos,toolpark,orchestrator-kill,state-loss \
  --out bench/baseline-linux.json

# the noise floor, on an idle host, with the same four scenarios the old one covers
.venv/bin/python bench/bench.py --tree . --backend sqlite \
  --only noise-floor --noise-scenarios cli,cap,chaos,throughput --repeats 10 \
  --out bench/noise-linux.json
```

Then check the new baseline against itself and commit it together with the change that caused the drift.

```sh
.venv/bin/python bench/compare.py --baseline bench/baseline-linux.json \
  --current bench/baseline-linux.json --thresholds bench/thresholds.toml \
  --noise bench/noise-linux.json
```

Two rules for a refresh. First, refresh the baseline from the same code the pull request changes, never from `main`, otherwise the baseline hides the regression it is supposed to catch. Second, refresh the noise floor only from an idle host and only when the metric's own noise has changed; a noise file taken on a busy machine makes every threshold meaningless, which is why the committed one was measured with a load average of 0.00 (M) rather than the 6.8 of the first run.

If the drift is real and wanted, raise the per-metric percent tolerance in `bench/thresholds.toml` instead of the baseline, so the record of how much the metric is allowed to move stays next to the decision. If the drift is not wanted, the job was right to fail.

## What the numbers said when this was set up

The committed baseline was measured on the VPS on 2026-11-23 with a load average of 0.60 at the start and 8.8GB of memory available (M): enqueue median 93.5ms and p95 107.4ms, idle RSS 18.4MB with 0 percent CPU, 60 trivial jobs in 6.88s at cap 6 which is 8.72 jobs per second, the cap held at 3 with no shared-repo overlap, the priority order came out `p9, p5, p1, p0`, chaos recovered to all done in 14.48s, and the orchestrator-kill scenario recovered in 25.91s with 3 duplicate turns and every retry resumed through `session/load` rather than restarting.

The `state-loss` scenario is the one that reports trade-offs rather than a single number (M): with 2 live jobs, 2 parked jobs, a tool lease and an ACP session mid-turn, a `kill -9` of the daemon lost 0 jobs, ran the 4 in-flight jobs twice, produced 1 duplicate turn, leaked 0 leases, left the 2 parked jobs parked with their `waiting_on` intact, and kept the durable ACP session id so the retry resumed the same session. The job rows that differ before and after are exactly the volatile ones: `attempts`, `lease_owner`, `pgid`, `pidfile` and `status`. The payload is untouched, which is the point: what is lost on `kill -9` is the in-memory state of a session, not its durable record, so the price of the crash is a repeated turn rather than a lost job.

## Caveats

- The baseline is measured on the VPS, not on the GitHub runner. The runner is slower and noisier, so the absolute numbers in the table will differ from the baseline column. The thresholds are what make the comparison meaningful across the two, and the runner may need wider percent tolerances than the VPS does. The first CI run is the measurement of how far off it is.
- The stub ACP agent is not a real harness. It streams updates on a timer, so the duplicate turn counts describe the orchestrator's behaviour, not Claude Code's.
- The scenarios kill processes with `kill -9` by exact pid and process group, and the bench verifies the pid through `/proc` before signalling it, so it never touches a process it did not start. On a shared runner this matters.
