# Ship plan: Agent Orchestration Architecture ("fleet")

Date: 2026-11-19
Status: agreed direction, pre-implementation
Thread: T3 Code `ef7fc9c6-6406-4366-8ae8-bf6dfcaf20ce`
Research artifacts: `/tmp/research-t3docs.md`, `/tmp/research-tools.md`, `/tmp/research-acp.md`, `/tmp/research-sqlite.md`, `/tmp/research-environments.md`

Target state: T3 Code as control plane + dispatch, per-machine SQLite durable queue with lease-based concurrency caps, ACP-first transport with tmux fallback lane, `harness` CLI sunset. Ships as one repo, deployed to three machines (laptop, VPS, legacy MacBook Pro).

## Architecture recap

```
Human ─→ T3 Code (laptop UI) ─→ threads / delegate_task (envId → VPS)
                    │
        dispatcher daemon (one per machine, sole River client)
                    │ claims jobs under lease caps
          ┌─────────┴──────────┐
     ACP lane               tmux lane
  (session/resume,      (awslabs cli-agent-orchestrator,
   structured events)    freebuff + attach-and-type debug)

State: one SQLite file per machine (~/.fleet/queue.db, WAL).
Never shared across machines. Task .agents/docs/handoffs live in repo/git.
```

Decisions embedded (see `.agents/decisions.md`):

- Drop `harness` entirely; tmux PTY management becomes a separate lane, dispatch moves to T3.
- Durable layer: OSS River (riverqueue/river, 5.9k★, MPL-2.0) on SQLite; one client process per machine so local `MaxWorkers` limits equal machine caps. Fallback: litequeue (237★, MIT) + ~150-line lease/reaper/limit shim.
- ACP-first: 50+ agents, official SDKs, protocol-native durability via `session/load`/`session/resume`. Steering mid-turn is agent-defined (v2) — treat as best-effort, queue-next-turn as default.
- Caps are semaphores checked at dequeue (`BEGIN IMMEDIATE` claim against `concurrency_slots`); the jobs table is the queue. Waiting jobs park on `waiting_on` external events without consuming slots.
- Cross-machine: never share the SQLite file; per-machine queues; git carries durable task docs.

## Phase 0 — Foundations (day 1, ~1h)

- [ ] `t3 update` on laptop and VPS (fixes live version-mismatch blocker).
- [ ] Verify `t3_environment_links`: both environments reachable, VPS `full-access`.
- [ ] VPS: `t3 service install` (systemd user unit + lingering) for headless always-on; `t3 serve --tailscale-serve` as second route.
- [ ] Accept: `delegate_task` with `target.environmentId: <vps>` completes a trivial task end-to-end from the laptop.

## Phase 1 — Durable queue core (week 1) — the only new tool

New repo `_own/fleet/`.

- [ ] Choose queue engine: OSS River (Go daemon) vs litequeue + shim (preferred language). Decision rule: if the dispatcher can be a single small Go process, River; else shim.
- [ ] One SQLite file per machine: `~/.fleet/queue.db`, WAL mode, `busy_timeout=5s`.
- [ ] Schema (the API contract — stable; everything else is glue):

```
jobs(id, kind, payload, status[queued|running|waiting|done|failed|dead],
     priority, run_at, lease_owner, lease_expires_at, waiting_on, attempts,
     max_attempts, created_at)
concurrency_slots(key, lease_expires_at)   -- caps: laptop:3, vps:6, per-repo:1
```

- [ ] Claim protocol: single `BEGIN IMMEDIATE` transaction — count active leases vs cap for the job's partition; if a slot is free, flip oldest `queued` → `running` + write lease. No free slot → row stays `queued` (FIFO by priority,run_at).
- [ ] Waiting jobs: `status=waiting`, `waiting_on=<event id>`; released by an external-event writer; do not consume slots while parked.
- [ ] Reaper: expired lease → requeue if `attempts < max_attempts`, else `dead`.
- [ ] Dispatcher daemon: claim loop, lease heartbeat, reaper, wake-on-event (fs events or bounded polling backoff 2s max).
- [ ] CLI verbs (`fleet`): `enqueue`, `status`, `wait-on`, `cancel`, `stats`, `dead retry` — replaces harness status/watch bookkeeping.
- [ ] Accept:
  - `kill -9` daemon mid-job → reaper requeues, job completes on retry.
  - Enqueue 10 jobs with cap 3 → exactly 3 `running` at all times.
  - Laptop fully offline (no network) → enqueue still works (file write only).

## Phase 2 — Transport lanes (week 2)

- [ ] ACP lane: thin wrapper on the official ACP SDK. `fleet run-acp <agent> <session>` spawns the ACP agent, persists sessionId + resume handle in job payload; wake = **`session/load`** (SPIKE-VALIDATED 2/2: claude-code-acp 0.16.2, opencode 2.3.2 — both protocol v1, neither advertises v2 `session/resume`; treat v2 as future optimization).
  - Agents via ACP: Claude Code, Codex, OpenCode, Kimi (registry or Local ACP commands in T3 providers).
  - Gotchas from Spike C: headless Claude Code over ACP needs isolated `CLAUDE_CONFIG_DIR` + `bypassPermissions` set_mode (host `auto` silently denies tools with no ACP permission request); resume prompts must state the prior process died (opencode waits on ghost background shells otherwise).
- [ ] tmux lane: deploy awslabs/cli-agent-orchestrator (Apache-2.0, active). Job kinds `tmux:*` route here; completion via its callback API.
  - Covers: freebuff, any non-ACP agent, attach-and-type debugging.
- [ ] Steering policy table: per-agent note of steer-vs-queue behavior; orchestrator treats steering as best-effort.
- [ ] Accept: same job kind survives agent-process kill via ACP resume; a freebuff job completes via tmux lane.

## Phase 3 — Dispatch migration (week 2-3)

- [ ] All delegation through T3: interactive = threads; background = `delegate_task` (worktree isolation default-on); long-running = T3 thread enqueues into `fleet` on the target machine, monitor reads queue status.
- [ ] Update `~/rules/delegation.md`: scoped-goal/monitor/time-box discipline stays; the transport becomes T3 + fleet verbs. Handoff-doc conventions unchanged (repo files).
- [ ] Keep tailscale ssh for raw terminal work only.
- [ ] Accept: one real implementation task ships to the VPS via T3 dispatch + fleet queue, PR opened, laptop never holds the work.

## Phase 4 — Packaging & deployment (week 3)

Single repo `_own/fleet/`:

```
fleet/
  cmd/fleetd/        dispatcher daemon (Go) or shim entrypoint
  cmd/fleet/         CLI verbs
  internal/queue/    engine adapter (river | litequeue) behind the contract
  internal/acplane/  ACP session wrapper (resume handles)
  internal/tmuxlane/ cao adapter
  deploy/
    launchd/io.josoc.fleetd.plist     laptop + legacy MBP
    systemd/fleetd.service            VPS (user unit, lingering)
    install.sh                        idempotent installer (mise/brew/uv per rules)
```

Deployment matrix:

| Machine | Role | Runs | Caps |
|---|---|---|---|
| Laptop | control plane, research lane | T3 app, fleetd, tailscale ssh | 3 active |
| VPS | implementation lane | fleetd (systemd), t3 headless service | 6 active |
| Legacy MBP | overflow/research | fleetd (launchd), ACP + tmux lane + resume plugins | 4 active (lived 4-8 band; loadtest RSS formula over-conservative due to shared pages) |

- [ ] `fleet` binary via language-native release (single static binary where possible); configs in `~/.fleet/config.toml` (caps, lanes, agent map).
- [ ] install.sh: creates `~/.fleet`, installs service, enables on boot, health check `fleet stats`.
- [x] ~~Legacy MBP guard~~ revised: RSS-derived safe cap (1) rejected; cap set to 4 per lived evidence. RSS figures remain a VPS planning input.
- [x] MacBook load test complete (2026-11-20): 13/14 scenarios PASS at 2x and 3x overload, cap held, zero orphans, park/resume works (same session id), chaos recovery clean. Sole FAIL = fleet-acp model plumbing (model never applied; runs used opencode default). Artifacts on MBP at `~/.local/share/fleet-loadtest/run-{2x,3x}/`.
- [ ] Tool-level slot keys: extend `concurrency_slots` beyond device caps to content leases (`tool:vitest`, `tool:tsc`, `repo:<name>`, `build:*`), superseding ad-hoc global flock locks (`/tmp/tsc.lock` etc.). Device caps govern queue admission; tool leases govern contention. (Agreed 2026-11-20 after MBP loadtest: user runs 4-8 agents on the MBP fine — contention, not RAM, is the real constraint.)
- [ ] fleet-acp model plumbing fix (loadtest finding): apply `set_model` when `--model` is given even if agent advertises no models; fail fast on unknown ids. Blocks the failure-scenario check and fallback error attribution.
- [ ] Accept: fresh VPS reprovision → `install.sh` → fleetd healthy under systemd; laptop reboot → launchd restarts fleetd, reaper recovers in-flight jobs.

## Phase 5 — `harness` sunset (week 3-4)

- [ ] Freeze `harness`: no new features; README points to fleet + T3.
- [ ] Migrate any remaining `harness`-invoking skills/rules to fleet verbs.
- [ ] Keep tmux-resume-style plugins on all machines for crash/reboot durability of the tmux lane.
- [ ] Delete `harness` from PATH once Phase 3 acceptance has held for a week of real use.

## Risks & open questions

- **Go vs preferred language**: River is Go-first (Ruby/JS/Rust clients exist). If the dispatcher daemon in Go is unacceptable, the litequeue shim path is pre-approved.
- **ACP resume coverage**: verify `session/resume` per agent early in Phase 2 (v1 agents only get `session/load` replay semantics).
- **T3 linked-environments is beta**: gate dispatch on it but keep `fleet enqueue` over tailscale ssh as the degraded-mode path (queue is file-local, so ssh+CLI still works offline).
- **Reconnect churn bugs** (t3code #3734, #6045): don't depend on live steering over flaky links; dispatch self-contained jobs.
- **awslabs cao longevity**: AWS Labs project — pin a fork point; adapter isolation (`internal/tmuxlane/`) keeps swap cost low.
- **Single-writer SQLite**: fine at agent scale (claims are tiny/rare); revisit Postgres (pg-boss/River-PG) only if multi-machine shared queue ever becomes a real requirement.

## Sequencing summary

Week 1: Phase 0 + 1 (queue core, caps deterministic)
Week 2: Phase 2 + start 3 (lanes, first T3-dispatched migration)
Week 3: Phase 3 finish + 4 (packaging, services on all machines)
Week 4: Phase 5 (harness sunset) + soak

## Phase 1 and 2 build results (2026-11-19)

- `_own/fleet` (queue core, ~330 lines, 4 tests green) and `_own/fleet-acp` (ACP lane, kill -9 resume test green on opencode) exist as local repos, unpushed.
- Risk: after `kill -9` of the daemon, the job child keeps running in its own session and the retry runs the command twice. Job commands must be idempotent, or the daemon must reap the process group by recorded pid on restart.
- Risk: `fleet-acp` resume requires the same `--cwd`. Claude on the VPS needs an env token (`CLAUDE_CODE_OAUTH_TOKEN`), no Keychain there.
- Not yet verified: kill/resume on Claude (only a smoke run), the two repos wired together, anything on the VPS.

## Pilot follow-up (requested 2026-11-20)

- [ ] After the local pilot passes, run the same pilot on the remote environment (VPS): install `fleet` and `fleet-acp`, set the Claude env token, dispatch from the laptop via T3 linked environments, and repeat the kill -9 and resume test remotely.

## Status 2026-11-20

- Done: Phases 0 to 4 on laptop and VPS (permanent services verified under kill -9), T3 remote dispatch into the VPS queue, delegation.md updated, caps tests, Claude kill/resume on laptop.
- Open: Claude on the VPS (needs own-agents token), reboot persistence, legacy MacBook (linked env "Quino's MacBook Pro"), nira-fleet branch `feature/fleet-packaging` unmerged, harness sunset (after a week of real use).

## Status update 2026-11-20 (late)

- Done: Claude pilot on VPS (login credentials copied into isolated config), `--model` selection via session/set_model, `--shell` fix, VPS redeployed with latest code, nira-fleet `feature/t3code` carries the fleet component and a `legacy` deploy mode (git bundle + Taildrop + T3 task, no ssh), legacy MacBook runs fleetd under launchd from ~/.local/share/fleet (launchd cannot read ~/Documents).
- Open: opencode broken on the legacy MacBook (pnpm shim to missing binary) so crash recovery there is untested, claude agent untested there, VPS reboot test not run, legacy identity confirmation, harness sunset after a week of real use.

## Status update 2026-11-20 (final for this round)

- All three machines run fleetd under launchd/systemd: laptop (cap 3), VPS ovhcloud (cap 6), legacy MacBook `kinosmac-pro` (cap 2, checkouts in ~/.local/share/fleet).
- Verified: VPS reboot (fleetd, t3code and system services came back, lingering on), opencode and Claude kill -9 pilots on laptop, VPS and legacy MacBook, launchd restart after kill -9 on legacy, T3 remote dispatch into the VPS queue, legacy install over Taildrop plus T3 task with no ssh.
- Open: opencode on the legacy MacBook prints "Location plugins did not finish activating" from some directories (herdr-agent-state.js and opencode-rate-limit-fallback do not match the v2 plugin format), Claude resume of a half-finished tool call, harness sunset after a week of real use, uncommitted agent-config edits in nira-fleet untouched.
