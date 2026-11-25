# Enforcing queue admission

The queue only bounds jobs it admits. Anything an agent spawns outside `coordinate enqueue` is invisible to caps. This doc ranks the enforcement layers from weakest to strongest and records what we run.

## Layer 0: instruction-level (soft)

A rule in the agent's global instructions ("must enqueue, never spawn ad hoc") plus the `coordinate` skill. Cheap, zero moving parts, but advisory — a misbehaving or uninstructed agent ignores it. This is what we shipped first (`~/.claude/CLAUDE.md`, `~/rules/delegation.md`, `~/HARNESSES.md`).

## Layer 1: hook-level (deterministic per agent CLI) — recommended now

Agent CLIs that support PreToolUse hooks (Claude Code, devin, others with a settings JSON) can intercept the shell tool call before it runs. `scripts/coordinate-guard` inspects the command; if it spawns an agent session and `COORDINATE_JOB_ID` is unset, the hook exits 2 and the call never happens.

- Deterministic for hook-supporting CLIs: the command is refused at the syscall boundary of the tool call, not "asked politely".
- Reproducible: one file, JSON-on-stdin contract, no daemon. `COORDINATE_GUARD=warn|block|off`.
- Gap: only covers CLIs with hooks, and only their shell-tool spawns. A provider that launches agents in-process (T3 `delegate_task`, ACP) never touches a shell command and is unaffected — which is correct, since T3 threads are the sanctioned interactive lane.
- Rollout: run `warn` for a soak period to catch false positives in telemetry, then flip the installed copy to `block`. Installed at `~/.config/devin/hooks/coordinate-guard` (warn mode) on kinosmac.

## Layer 2: PATH shims (deterministic, brittle)

Shadow `maki`/`claude`/... in PATH with a script that refuses or rewrites to `coordinate enqueue`. Blocks every caller including non-hook CLIs and manual shells, but breaks version managers, direct interactive use, and T3's own launches. Only worth it if layer 1 shows leaks; not shipped.

## Layer 3: OS sandbox (orthogonal, not queue-aware)

macOS `sandbox-exec` seatbelt profiles or Linux cgroups can bound a spawned agent's memory/CPU regardless of how it was launched. This prevents OOM but does not create queue admission, ordering, or events — complement, not replacement. A `coordinate run` job kind could apply a seatbelt profile to its children later.

## Layer 4: make the compliant path the easy one

- `coordinate enqueue --acp <agent>` (pending port from `legacy/python`): agent sessions are first-class jobs with durable `session/load` resume — enforcement plus a feature agents want.
- `coordinate forward --exec` + the events feed: queued work is *more* observable than ad-hoc spawns, which pulls agents toward the queue.

## What we run

| Device | Daemon | Cap | Guard |
|---|---|---|---|
| kinosmac | tmux `coordinate` | 10 (stored in the queue DB) | warn mode, devin hooks |
| ovhcloud VPS | systemd user unit `coordinate.service`, `COORDINATE_MACHINE=vps` | 8 (stored in the queue DB) | not installed |

The daemon records its machine name in the queue DB on claim, so `cap show` reports the daemon's identity even when the CLI process has no `COORDINATE_MACHINE` in its env (the common case over ssh). The forwarder resolves the same name from `queue.ts` `MACHINE`, so the daemon's events and the forwarder's message prefixes always agree.

False-positive log: check the hook's stderr in the agent's tool-output stream during the warn soak.
