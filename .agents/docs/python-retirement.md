# Python retirement: inventory and plan

Status as of 2026-11-23 (branch `feat/ts-forwarder`). The TS port under `ts/`
is scriptc-compiled into single static binaries and already covers the shipped
CLI surface: enqueue, status, wait-on, release, cancel, stats, events,
`forward` (events sink), dead retry, daemon (cmd lane only).

## What still requires Python (~4.6k lines under `src/`, ~3.4k more in `bench/`)

### Runtime (shipped package)

| File | LOC | Role | TS status |
|---|---|---|---|
| `src/coordinate/queue.py` | 564 | Full queue: tool-class slot matching, config slots, ACP pid-file bookkeeping, lease/deadline edge cases | **Partial port** (`src/queue.ts` ~420 lines): cmd lane core, slots wildcard-only, no config TOML slots, no ACP fields |
| `src/coordinate/daemon.py` | 315 | Claim loop, spawn, park/wake, reaper, timecap; **ACP lane** (`spawn_acp`, stdout drain, session cancel, pid-file group kill) | cmd lane ported (`src/daemon.ts`); ACP lane absent |
| `src/coordinate/cli.py` | 180 | argparse CLI incl. `--acp/--prompt/--registry/--model` enqueue lane | cmd verbs ported (`src/main.ts`); `--acp` flags not ported |
| `src/coordinate/service.py` | 106 | systemd user-unit install/boot (daemon lifecycle) | Not ported. Portable now (shelling out to `systemctl`, no Python stdlib dependency) |
| `src/coordinate/plugins.py` | 150 | Plugin loader discovery/hooks | Not ported. Portable now; needs a decision on plugin contract (exec-based plugins keep it language-neutral) |
| `src/coordinate/paths.py` | 107 | XDG paths, config bounds | Ported as `src/env.ts` (subset) |
| `src/coordinate/events.py` | 44 | events tail helpers | Ported inline in `src/main.ts` (`events` verb) + `forwarder.ts` |
| `__init__/__main__/daemon_cli` | 16 | Entry shims | Replaced by the single binary |

### Ops/bench (not shipped)

- `bench/bench.py` (1369) + `compare.py`, `park_filler.py`, `fakeworker.py`,
  `wal_holder.py`: measurement harness. Low priority to port; can drive the TS
  binary via subprocess for as long as it exists.
- `bench/acp_client.py` (243), `stub_acp_agent.py` (177), `term_fallback.py`
  (628): ACP-lane test scaffolding. Tied to the ACP port (below).

## Portable now (no protocol work)

1. **service.py → `coordinate daemon install/boot`** — the TS binary can emit
   and enable a systemd user unit itself (write unit file, `systemctl --user
   enable --now`). ~1 day incl. tests.
2. **plugins.py → exec-based plugin loader in TS** — discovery + hook
   invocation is just directory scanning and `spawnSync`. Keep the existing
   plugin contract; plugins stay executables so this is protocol-free. ~1–2 days.
3. **queue.py config slots** — needs a small TOML reader in TS (no parser yet
   in the binary). ~2–3 days for `tool:<class>:*` exact-slot semantics parity
   plus tests against the Python implementation's fixtures.
4. **bench harness** — optional; drive TS binary from the existing Python bench
   during transition, port last or never.

## Needs a fleet-acp protocol port (the big one)

The `--acp` lane (cli.py flags + daemon.py `spawn_acp`/drain/cancel + queue.py
pid-file fields) speaks **ACP (Agent Client Protocol) JSON-RPC over the agent's
stdio**: `initialize`, `session/new`, `session/prompt`, `session/set_model`,
`session/cancel`, and reads the `sessionId` from line 1 of `fleet-acp` stdout.

Porting to TS requires:

- a stdio JSON-RPC client (`node:child_process` + newline-framed JSON; no new
  native deps),
- the session lifecycle state machine: persist sessionId immediately, drain
  stdout to the events table, map `session/cancel` onto the daemon's
  timecap/cancel paths, and the detached-process-group kill via the agent pid
  file (TS `spawn` with `detached` + `process.kill(-pid)` covers it),
- parity fixtures: reuse `bench/stub_acp_agent.py` and `acp_client.py` as the
  test oracle before retiring the Python daemon.

Estimate: **5–8 focused days**. It is the only genuinely protocol-shaped piece;
everything else is mechanical.

## Suggested order

1. `service.py` port (small, unblocks packaging the TS binary as *the* daemon).
2. plugins.py port (small, keeps extensibility story intact).
3. queue.py config slots + daemon parity gaps (medium; makes TS the full cmd-lane replacement).
4. **fleet-acp protocol port** (large; the retirement gate for `src/coordinate/daemon.py` and cli.py `--acp`).
5. Retire `src/` (keep `bench/` until the ACP port's test scaffolding is ported or the bench drives the TS binary).

Total: roughly **2 weeks** of focused work, of which ~1 week is the ACP lane.
Steps 1–3 are independent; step 4 can start as soon as step 3 lands because
the shared claim/lease/park code paths are the seams the ACP lane plugs into.
