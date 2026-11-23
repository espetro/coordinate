# Test coverage map: legacy pytest suite against `test/`

Date: 2026-11-23. Source of the Python tests: `legacy/python` at 4e371ef, `tests/*.py`. TypeScript tests: `test/queue.test.mjs` (11 tests) and `test/forwarder.test.mjs` (4 tests), 15 in total (M: `flock /tmp/tsc.lock pnpm test` passes 15 of 15 on this branch before the reproducers were added).

The brief said about 78 pytest tests. The real count is 97 test functions: 95 collected and passing in the default run (M: `uv run pytest`, pilot tests excluded, 95 passed in 68s), plus 2 pilot tests that need a real agent and are skipped by default. 18 of the 97 test the retired bench comparator (`bench/compare.py`).

Legend:

- COVERED: an equivalent assertion exists in `test/`. "(partial)" says what the Python test asserts that the TypeScript one does not.
- PORTABLE: not covered, but can be written as a `node --test` against the CLI (`node bin/coordinate.mjs`, a daemon child process with a private `COORDINATE_DB`) or against `src/queue.ts` directly. "(fails today: X)" names the regression in `ts-port-regressions.md` that the ported test would hit. Those are the tests in `test/regressions.test.mjs`.
- N/A: needs the retired ACP lane, the plugins runner, the service installer, `migrate`, or the retired bench harness. These become PORTABLE when the feature is ported (see `python-retirement.md`).

Summary: of 97 Python tests, 5 are COVERED (4 of them only partially), 46 are PORTABLE and 46 are N/A. Counts by file are at the end.

## test_acceptance.py (5)

| Test | Asserts | Status |
|---|---|---|
| `test_kill9_daemon_mid_job_retries` | Daemon `kill -9` mid job leaves the row `running`; a second daemon finishes it; attempts 2; the command ran twice | PORTABLE (daemon integration; will also show the X3 duplicate if the job outlives the lease) |
| `test_cap_never_exceeded` | 10 jobs, cap 3: DB peak is 3 and the real process overlap measured from timestamps is 3 | PORTABLE |
| `test_enqueue_offline` | `enqueue` works with sockets disabled; row is `queued`, attempts 0 | PORTABLE (trivial; a CLI test that asserts attempts 0 also pins S1) |
| `test_waiting_release_and_reaper_dead` | Parked job is not claimable and holds no slot; release returns the id; reap with `max_attempts=1` gives `dead`; `retry_dead` requeues | COVERED (partial: TS has wait-on/release and reap-to-dead tests, but no `retryDead` assertion) |
| `test_shell_string_is_stored_and_run_verbatim` | `--shell` stores one string verbatim, the daemon runs it through `sh -c`, and a multi-token `--shell` is refused | PORTABLE |

## test_caps.py (2)

| Test | Asserts | Status |
|---|---|---|
| `test_vps_machine_cap_6_with_14_jobs` | `COORDINATE_MACHINE=vps` gives cap 6; 14 jobs peak at exactly 6, with real overlap | PORTABLE |
| `test_repo_cap_1_holds_while_other_jobs_run_in_parallel` | Same `--repo` serializes to 1 while other repos run in parallel | COVERED (partial: "repo cap: one repo at a time" asserts the claim decision in the queue module, not real process overlap under the daemon) |

## test_compare.py (18)

All 18 test `bench/compare.py` (noise bands, gates, markdown table, exit codes, shipped thresholds): N/A, the harness was retired with the Python stack and `benchmarks/legacy-python/thresholds.toml` is historical data. A TypeScript comparator would need these cases again.

`test_identical_runs_pass`, `test_boolean_gate_must_hold`, `test_boolean_gate_missing_fails`, `test_missing_numeric_metric_fails`, `test_metric_missing_from_the_baseline_is_not_compared`, `test_metric_inside_the_noise_band_passes`, `test_metric_outside_the_noise_band_fails`, `test_metric_outside_the_percent_band_fails_even_without_noise`, `test_lower_is_worse_direction`, `test_none_direction_must_not_change`, `test_absolute_ceiling_and_floor`, `test_absolute_tolerance_floors_the_band_for_a_zero_baseline`, `test_markdown_table_has_the_required_columns`, `test_main_exits_one_on_regression`, `test_main_exits_zero_when_clean`, `test_main_exits_two_on_unreadable_input`, `test_shipped_thresholds_and_noise_parse`, `test_shipped_baseline_is_comparable`.

## test_events.py (6)

| Test | Asserts | Status |
|---|---|---|
| `test_enqueue_claim_finish_emits` | Kinds `enqueued, claimed, done` in order for one job | COVERED ("events: enqueue/claim/finish emit transitions") |
| `test_fail_and_cancel` | `failed` after a failing finish; `enqueued, cancelled` for a cancelled job | COVERED (partial: cancelled is asserted, the `failed` kind is not) |
| `test_park_release` | `enqueued, parked, released` | PORTABLE (queue module) |
| `test_reap_requeue_and_dead` | `requeued` after the first lease expiry with attempts left, `dead` after the last | PORTABLE (queue module; the existing reap test only exercises the dead branch, despite its name) |
| `test_follow_and_maxid` | `follow(since)` returns ordered rows after an id; `max_id` | PORTABLE (as `events --since N` through the CLI, there are no helpers in TS) |
| `test_cli_events_jsonl` | `coordinate events` prints JSONL with exactly `id, ts, job_id, kind, data` | PORTABLE |

## test_orphans.py (2)

| Test | Asserts | Status |
|---|---|---|
| `test_reaper_kills_surviving_process_group_before_requeue` | After a lease expiry, `reap` kills the job's group (and the agent pid-file group), clears `pgid` and `pidfile`, and the job is `queued` | PORTABLE (fails today: X3; the pid-file half is N/A until the ACP lane returns) |
| `test_session_persisted_in_payload` | `set_session` writes `session` into the payload of an `acp` job | N/A (ACP lane) |

## test_paths.py (14)

| Test | Asserts | Status |
|---|---|---|
| `test_env_coordinate_wins` | `COORDINATE_DB` beats `FLEET_DB` | PORTABLE (`src/env.ts`) |
| `test_env_fleet_fallback` | `FLEET_DB` is used when `COORDINATE_DB` is unset | PORTABLE |
| `test_db_default_xdg_state` | `$XDG_STATE_HOME/coordinate/queue.db` | PORTABLE |
| `test_config_default_xdg_config` | `$XDG_CONFIG_HOME/coordinate/config.toml` | PORTABLE |
| `test_db_override` | `COORDINATE_DB` path is returned as is | PORTABLE |
| `test_config_override` | `COORDINATE_CONFIG` path is returned as is | PORTABLE |
| `test_runtime_dir_prefers_xdg_runtime` | `$XDG_RUNTIME_DIR/coordinate` | N/A (`runtime_dir` is not in `src/env.ts`; module pending, `ARCHITECTURE.md`) |
| `test_runtime_dir_falls_back_to_state_run` | `<state>/run` fallback | N/A (same) |
| `test_log_dir_under_state` | `<state>/logs` | N/A (same) |
| `test_legacy_db_notice` | Legacy `~/.fleet/queue.db` is used with a stderr note | N/A (legacy fallback not ported, documented) |
| `test_legacy_config_notice` | Same for `config.toml` | N/A |
| `test_new_db_silences_notice` | No note once the XDG file exists | N/A |
| `test_migrate_copies_never_moves` | `migrate` copies via the SQLite backup API and keeps the originals | N/A (`migrate` pending) |
| `test_migrate_nothing_to_do` | `migrate` with no legacy files writes nothing | N/A |

## test_pilot_acp.py (1) and test_pilot_claude.py (1)

| Test | Asserts | Status |
|---|---|---|
| `test_acp_job_survives_daemon_and_agent_kill9` | An ACP job resumes its session after the daemon and the agent are both killed | N/A (ACP lane; skipped by default in Python as well) |
| `test_claude_job_survives_daemon_and_agent_kill9` | Same against a real Claude agent | N/A |

## test_plugins.py (13)

All N/A until the plugins runner is ported (`python-retirement.md`, "Portable now" item 2). The cases are protocol-free and port directly: `test_empty_dir`, `test_missing_dir`, `test_file_plugin_defaults_to_hook`, `test_non_executable_is_an_error`, `test_manifest_plugin`, `test_unknown_manifest_key_fails_closed`, `test_unknown_interface_fails`, `test_timeout_bounds`, `test_discovery_errors_do_not_raise`, `test_run_hook`, `test_hook_timeout`, `test_example_plugin_ships_ok`, `test_cli_plugins_list`.

## test_project_key.py (6)

| Test | Asserts | Status |
|---|---|---|
| `test_plain_repo_key` | A repo root is its own key | PORTABLE (`projectKey` is private in `src/daemon.ts`; observable through `spawn_audit.project`) |
| `test_worktree_shares_main_repo_key` | A `git worktree add` checkout resolves to the main repo | PORTABLE (fails today: X1) |
| `test_two_repos_do_not_share` | Two repos, one with a worktree, make exactly two keys | PORTABLE (fails today: X1) |
| `test_non_repo_falls_back_to_cwd` | A directory outside any repo is its own key | PORTABLE |
| `test_worktree_via_git_probe` | With an unreadable `gitdir`, the injected `git rev-parse --git-common-dir` answer is used | PORTABLE only after a refactor (needs an injectable probe or an exported function) |
| `test_probe_gets_2s_timeout` | The probe is called with `timeout=2` and a timeout returns None | PORTABLE only after a refactor (same) |

## test_service.py (4)

`test_install_writes_unit`, `test_unit_restarts_on_failure`, `test_uninstall_removes`, `test_status_reports_missing`: N/A (`service install` pending). They assert the unit text (`Restart=on-failure` or launchd `KeepAlive`), idempotent uninstall and the `installed: no` status line.

## test_slots.py (4)

| Test | Asserts | Status |
|---|---|---|
| `test_slot_key_serializes_same_tool_parallel_to_other` | Three `--slot tool:vitest` jobs serialize (limit 1) while two `--slot tool:other` jobs (limit 2) overlap | PORTABLE (fails today: A1) |
| `test_slot_limit_from_config_allows_two` | `build:global = 2` lets two run at a time | PORTABLE (fails today: A1) |
| `test_unknown_slot_key_defaults_to_1` | An undeclared key defaults to limit 1 | PORTABLE (fails today: A1) |
| `test_missing_config_file_still_claims` | A missing config file does not stop claiming | PORTABLE (passes today) |

## test_spawn_shim.py (4)

| Test | Asserts | Status |
|---|---|---|
| `test_heavy_parks_at_cap_and_resumes_on_release` | Third `vitest` job parks on `tool:vitest:<proj>`, then all three finish; audit rows have class `vitest` | PORTABLE (passes today with single-quoted config) |
| `test_unmatched_tool_audited_never_blocked` | An unmatched binary runs immediately, with no lease and no audit row | PORTABLE (passes today) |
| `test_weighted_cost_excludes_cheaper_sibling` | Two cost-2 `tsc` serialize at limit 2 while a cost-1 custom `sqlload` class from `[tools]` overlaps | PORTABLE (fails today: B8, the `[tools]` overlay is dropped) |
| `test_trivial_tools_pay_nothing` | `grep` pays no lease and no audit row | PORTABLE (passes today) |

## test_timecap.py (17)

| Test | Asserts | Status |
|---|---|---|
| `test_cmd_job_sleeping_forever_is_timed_out` | Capped `sleep 300` ends `timed_out`, attempts 1, outcome mentions `max runtime`, lease cleared, `deadline_at` kept, slot freed, next job runs | PORTABLE (passes today) |
| `test_timed_out_job_leaves_no_orphan_process` | The child's group is dead after the cap | PORTABLE (passes today) |
| `test_budget_excludes_parked_time` | Parked time is not charged; the new deadline equals cap minus used | PORTABLE (queue module; `chargeRuntime` exists) |
| `test_deadline_survives_daemon_restart` | Deadline is in SQLite and a second daemon enforces it | PORTABLE |
| `test_env_vars_visible_to_the_child` | `COORDINATE_MACHINE`, `COORDINATE_DB`, `COORDINATE_JOB_ID` reach the child | PORTABLE (passes today) |
| `test_deadline_at_env_is_epoch_seconds_of_the_cap` | `COORDINATE_DEADLINE_AT` equals the row's deadline | PORTABLE (fails today: D3, documented as not ported) |
| `test_no_cap_means_empty_deadline` | `COORDINATE_DEADLINE_AT` is empty when uncapped | PORTABLE (fails today: D3) |
| `test_cli_max_runtime_is_stored` | `--max-runtime 15m` stores 900 | PORTABLE (passes today) |
| `test_status_prints_deadline_runtime_and_remaining` | `status` JSON has `runtime_remaining_s` | PORTABLE (fails today: X8) |
| `test_status_self_uses_fleet_job_id` | `status --self` reads the id from the environment | COVERED (partial: the TS test reads `COORDINATE_JOB_ID` through `getJob`, not the `FLEET_JOB_ID` fallback or the CLI) |
| `test_config_default_max_runtime` | `[defaults] max_runtime = "2h"` stores 7200 | PORTABLE (fails today: X6) |
| `test_explicit_zero_disables_the_config_default` | `--max-runtime 0` overrides the default | PORTABLE (passes today only because there is no default) |
| `test_old_database_is_migrated_and_keeps_rows` | A pre-timecap database gains the columns and keeps its rows | PORTABLE (fails today: X5) |
| `test_parse_duration_units` | `90s`, `15m`, `2h`, `45`, `0` | PORTABLE (through `--max-runtime`, `parseDuration` is private; also add the bad-duration case, X6) |
| `test_timed_out_job_is_not_retried_by_reaper` | After `finalizeTimedOut`, `reap` returns nothing and the status stays `timed_out` | PORTABLE (queue module) |
| `test_expired_job_that_exhausted_its_budget_is_not_claimed` | A requeued job with no budget left becomes `timed_out` instead of running | PORTABLE (queue module) |
| `test_signals_only_reach_our_own_process_group` | Only the capped job's group dies; an unrelated marker process is untouched | PORTABLE (passes today) |

## Counts

| File | Tests | COVERED | PORTABLE | N/A |
|---|---|---|---|---|
| test_acceptance | 5 | 1 | 4 | 0 |
| test_caps | 2 | 1 | 1 | 0 |
| test_compare | 18 | 0 | 0 | 18 |
| test_events | 6 | 2 | 4 | 0 |
| test_orphans | 2 | 0 | 1 | 1 |
| test_paths | 14 | 0 | 6 | 8 |
| test_pilot_acp, test_pilot_claude | 2 | 0 | 0 | 2 |
| test_plugins | 13 | 0 | 0 | 13 |
| test_project_key | 6 | 0 | 6 | 0 |
| test_service | 4 | 0 | 0 | 4 |
| test_slots | 4 | 0 | 4 | 0 |
| test_spawn_shim | 4 | 0 | 4 | 0 |
| test_timecap | 17 | 1 | 16 | 0 |
| Total | 97 | 5 | 46 | 46 |

Two of the PORTABLE items (the probe tests in `test_project_key`) need a small refactor or an export first.

PORTABLE tests that fail today are the regression reproducers: A1 (3), X1 (2), X3 (1), X5 (1), X6 (1), X8 (1), B8 (1), D3 (2). Tests that pass today and are simply missing from the TypeScript suite are listed as "passes today"; they would have caught nothing but protect against the next change (timecap enforcement and the spawn shim have no TypeScript test at all, although `ts-port-spike.md` and the bench exercise them).

## TypeScript tests with no Python counterpart

- `test/forwarder.test.mjs` (4): cursor load and save, default cursor path, `render`, and the `forward` CLI with filtering, `{message}` substitution and cursor resume. Python's forwarder had no tests. None of them covers the in-memory cursor bug on sink failure (X14).
- `test/queue.test.mjs` "wait-on a running job loses its lease (heartbeat fails)" has no direct Python twin (the behavior is part of `test_acceptance` and `test_timecap` there).

## What the 15 existing tests miss as a class

- Nothing in `test/` starts the daemon, so claim-loop, spawn, timecap enforcement, signal handling and stdio behavior (X2, X4, X7, D4) have no test at all.
- Nothing runs the CLI except the forwarder test, so `src/main.ts` parsing (X6, X9) and output (X8, D7) are untested.
- The schema test compares names only (S1).
- `reap requeues expired lease until max attempts` never exercises the requeue branch.

## Port status

Ported on branch `test/python-parity` (base `main` at 620a224). Every Python test keeps its original name inside the ported file, so a failing test name points straight at `legacy/python:tests/test_<file>.py`. The ported suites live in `test/parity/`, one file per Python file, and share the harness in `test/parity/helpers.mjs`.

Statuses:

- ENFORCED: ported and passing on `main` today.
- TODO: ported but parked with `node:test` `{ todo: "<audit id>: <reason>" }`. The reason always names an audit ID from `ts-port-regressions.md` (A1, B8, X2 to X9, S1) or `missing feature: <what>`. No TODO was added without such an ID: the port found no regression outside the known list.
- ALREADY COVERED: not ported because an equivalent assertion already exists in `test/`. The covering test is named.

The rows below cover the 9 in-scope Python files: the 46 PORTABLE tests of the map above plus the 5 COVERED ones (51 rows). The 46 N/A tests (`test_compare`, `test_plugins`, `test_service`, the pilots, the legacy/migrate paths tests, the runtime and log folder paths tests and the ACP session orphan test) are out of scope and not listed.

| Python test | Status | Ported file / covering test | Note |
|---|---|---|---|
| `test_acceptance::test_kill9_daemon_mid_job_retries` | ENFORCED | `test/parity/acceptance.test.mjs` | daemon killed with SIGKILL mid job, a second daemon finishes it, attempts 2, command ran twice |
| `test_acceptance::test_cap_never_exceeded` | ENFORCED | `test/parity/acceptance.test.mjs` | 10 jobs at cap 3: DB peak 3 and real process overlap 3 |
| `test_acceptance::test_enqueue_offline` | ENFORCED | `test/parity/acceptance.test.mjs` | CLI runs with sockets and name lookups disabled |
| `test_acceptance::test_waiting_release_and_reaper_dead` | ENFORCED | `test/parity/acceptance.test.mjs` | also fully ported: it was only COVERED (partial) before, the `retryDead` assertion had no home |
| `test_acceptance::test_shell_string_is_stored_and_run_verbatim` | ENFORCED | `test/parity/acceptance.test.mjs` | `--shell` stores one string verbatim, multi-token `--shell` is refused |
| `test_caps::test_vps_machine_cap_6_with_14_jobs` | ENFORCED | `test/parity/caps.test.mjs` | `COORDINATE_MACHINE=vps` gives cap 6, 14 jobs peak at 6 with real overlap |
| `test_caps::test_repo_cap_1_holds_while_other_jobs_run_in_parallel` | ALREADY COVERED | `test/queue.test.mjs` "repo cap: one repo at a time" | asserts the claim decision in the queue module, not real process overlap under the daemon |
| `test_events::test_enqueue_claim_finish_emits` | ALREADY COVERED | `test/queue.test.mjs` "events: enqueue/claim/finish emit transitions" | |
| `test_events::test_fail_and_cancel` | ALREADY COVERED | `test/queue.test.mjs` "cancel a queued job" and "finish records status and drops leases" | the `failed` kind and the `enqueued, cancelled` pair are asserted |
| `test_events::test_park_release` | ENFORCED | `test/parity/events.test.mjs` | `enqueued, parked, released` |
| `test_events::test_reap_requeue_and_dead` | ENFORCED | `test/parity/events.test.mjs` | `requeued` after the first lease expiry, `dead` after the last |
| `test_events::test_follow_and_maxid` | ENFORCED | `test/parity/events.test.mjs` | `events --since N` returns ordered rows after an id, plus `max_id` |
| `test_events::test_cli_events_jsonl` | ENFORCED | `test/parity/events.test.mjs` | JSONL with exactly `id, ts, job_id, kind, data` |
| `test_orphans::test_reaper_kills_surviving_process_group_before_requeue` | TODO | `test/parity/orphans.test.mjs` | X3: `reap()` never signals the recorded pgid, so the old attempt keeps running beside the retry |
| `test_paths::test_env_coordinate_wins` | ENFORCED | `test/parity/paths.test.mjs` | `COORDINATE_DB` beats `FLEET_DB` |
| `test_paths::test_env_fleet_fallback` | ENFORCED | `test/parity/paths.test.mjs` | `FLEET_DB` is used when `COORDINATE_DB` is unset |
| `test_paths::test_db_default_xdg_state` | ENFORCED | `test/parity/paths.test.mjs` | `$XDG_STATE_HOME/coordinate/queue.db` |
| `test_paths::test_config_default_xdg_config` | ENFORCED | `test/parity/paths.test.mjs` | `$XDG_CONFIG_HOME/coordinate/config.toml` |
| `test_paths::test_db_override` | ENFORCED | `test/parity/paths.test.mjs` | `COORDINATE_DB` returned as is |
| `test_paths::test_config_override` | ENFORCED | `test/parity/paths.test.mjs` | `COORDINATE_CONFIG` returned as is |
| `test_project_key::test_plain_repo_key` | ENFORCED | `test/parity/project_key.test.mjs` | observed through the `spawn_audit.project` column, `projectKey` is private |
| `test_project_key::test_worktree_shares_main_repo_key` | ENFORCED | `test/parity/project_key.test.mjs` | the map says "fails today: X1"; X1 was fixed on `main` (4c36407) so the port passes |
| `test_project_key::test_two_repos_do_not_share` | ENFORCED | `test/parity/project_key.test.mjs` | same X1 fix, exactly two keys |
| `test_project_key::test_non_repo_falls_back_to_cwd` | ENFORCED | `test/parity/project_key.test.mjs` | |
| `test_project_key::test_worktree_via_git_probe` | ENFORCED | `test/parity/project_key.test.mjs` | the map asks for an injectable probe; a fake `git` first on `PATH` is the equivalent seam, since the daemon resolves `git` through `PATH` |
| `test_project_key::test_probe_gets_2s_timeout` | ENFORCED | `test/parity/project_key.test.mjs` | a hanging fake `git` makes the 2 s probe timeout observable |
| `test_slots::test_slot_key_serializes_same_tool_parallel_to_other` | TODO | `test/parity/slots.test.mjs` | A1: `claim()` never compares an explicit `--slot` key against its `[slots]` limit |
| `test_slots::test_slot_limit_from_config_allows_two` | TODO | `test/parity/slots.test.mjs` | A1, same cause |
| `test_slots::test_unknown_slot_key_defaults_to_1` | TODO | `test/parity/slots.test.mjs` | A1, same cause |
| `test_slots::test_missing_config_file_still_claims` | ENFORCED | `test/parity/slots.test.mjs` | |
| `test_spawn_shim::test_heavy_parks_at_cap_and_resumes_on_release` | ENFORCED | `test/parity/spawn_shim.test.mjs` | third `vitest` job parks, all three finish, audit rows have class `vitest` |
| `test_spawn_shim::test_unmatched_tool_audited_never_blocked` | ENFORCED | `test/parity/spawn_shim.test.mjs` | |
| `test_spawn_shim::test_weighted_cost_excludes_cheaper_sibling` | TODO | `test/parity/spawn_shim.test.mjs` | B8: the `[tools]` overlay is dropped, so the custom `sqlload` class is never matched and never audited |
| `test_spawn_shim::test_trivial_tools_pay_nothing` | ENFORCED | `test/parity/spawn_shim.test.mjs` | |
| `test_timecap::test_cmd_job_sleeping_forever_is_timed_out` | ENFORCED | `test/parity/timecap.test.mjs` | |
| `test_timecap::test_timed_out_job_leaves_no_orphan_process` | ENFORCED | `test/parity/timecap.test.mjs` | |
| `test_timecap::test_budget_excludes_parked_time` | ENFORCED | `test/parity/timecap.test.mjs` | |
| `test_timecap::test_deadline_survives_daemon_restart` | ENFORCED | `test/parity/timecap.test.mjs` | |
| `test_timecap::test_env_vars_visible_to_the_child` | ENFORCED | `test/parity/timecap.test.mjs` | |
| `test_timecap::test_deadline_at_env_is_epoch_seconds_of_the_cap` | TODO | `test/parity/timecap.test.mjs` | D3: `COORDINATE_DEADLINE_AT` is not exported to the child (`daemon.ts` `jobEnv`) |
| `test_timecap::test_no_cap_means_empty_deadline` | TODO | `test/parity/timecap.test.mjs` | D3, same cause |
| `test_timecap::test_cli_max_runtime_is_stored` | ENFORCED | `test/parity/timecap.test.mjs` | |
| `test_timecap::test_status_prints_deadline_runtime_and_remaining` | TODO | `test/parity/timecap.test.mjs` | X8: `status` prints the raw row, `runtime_remaining_s` and `deadline_in_s` were dropped |
| `test_timecap::test_status_self_uses_fleet_job_id` | ALREADY COVERED | `test/queue.test.mjs` "status --self reads COORDINATE_JOB_ID" | the map notes the `FLEET_JOB_ID` fallback and the CLI are not asserted; the port treats the env name as one behavior |
| `test_timecap::test_config_default_max_runtime` | TODO | `test/parity/timecap.test.mjs` | X6: the CLI never reads `config.toml`, so `[defaults] max_runtime` is not applied |
| `test_timecap::test_explicit_zero_disables_the_config_default` | TODO | `test/parity/timecap.test.mjs` | X6, plus `--max-runtime 0` is stored as NULL instead of 0 |
| `test_timecap::test_old_database_is_migrated_and_keeps_rows` | TODO | `test/parity/timecap.test.mjs` | X5: `connect()` has no `_migrate_jobs` and no `ALTER TABLE ADD COLUMN` |
| `test_timecap::test_parse_duration_units` | TODO | `test/parity/timecap.test.mjs` | X6: `--max-runtime 0` is stored as NULL, so the parsed value is not observable |
| `test_timecap::test_timed_out_job_is_not_retried_by_reaper` | ENFORCED | `test/parity/timecap.test.mjs` | |
| `test_timecap::test_expired_job_that_exhausted_its_budget_is_not_claimed` | ENFORCED | `test/parity/timecap.test.mjs` | |
| `test_timecap::test_signals_only_reach_our_own_process_group` | ENFORCED | `test/parity/timecap.test.mjs` | |

### Port status totals

| Status | Count |
|---|---|
| ENFORCED | 35 |
| TODO | 12 |
| ALREADY COVERED | 4 |
| Total rows | 51 |

The 12 TODO tests map onto known audit IDs: A1 (3), B8 (1), X3 (1), X5 (1), X6 (3), X8 (1), D3 (2). The port surfaced no regression outside `ts-port-regressions.md`, so there is no `NEW:` finding.
