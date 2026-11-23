# Presence-aware concurrency: prior art and policy options

Date: 2026-11-22 (`date` run at session start). Research only, nothing implemented. Context: `.agents/docs/orchestrator-framing.md` (soft caps 3+5+5, live vs parked sessions, one orchestrator per device).

Evidence tags: M = measured by us on kinosmac (command given), R = read in the project's own docs or source (URL or path at a commit), B = blog or marketing claim, K = from memory, unverified.

Source clones used for R claims (shallow, read-only, in `/tmp/pac-clones`): `pingdotgg/t3code@c00f1172`, `stablyai/orca@e695e405`, `BloopAI/vibe-kanban@3f095f0`, `smtg-ai/claude-squad@070eb93`, `FoldingAtHome/fah-client-bastet@7c4363a`, `BOINC/boinc.wiki` (HEAD on 2026-11-22).

## TL;DR

- No agent orchestrator surveyed ties agent concurrency to user presence. The ones with presence signals use them for other things: T3 Code gates its own background polling on foreground clients and host state, Orca keeps the machine awake while agents run. Claude Squad has a hard cap of 10 and no presence logic (R).
- The closest prior art is volunteer computing. BOINC has two explicit profiles, "in use" and "not in use", each with its own CPU %, CPU time and memory % (50% in use, 90% idle by default), plus the choice to keep suspended tasks in memory or restart from checkpoint (R). Folding@home has `on_idle`, `on_battery`, and on macOS treats "idle" as display off, screensaver, login window or screen locked, with a debounce, then interrupts the core and resumes from checkpoint (R).
- macOS itself has the right primitives: `NSBackgroundActivityScheduler` and XPC activities with `shouldDefer` ("finish what it's currently doing" and defer), maintenance priority blocked when thermal state is above nominal or battery under 20%, `REQUIRE_SCREEN_SLEEP`, and a dispatch memory pressure source with normal/warn/critical (R, SDK headers). `taskpolicy -b -p <pid>` demotes a running process without root and `-B` restores it (M).
- Linux has better control variables than macOS: PSI (`/proc/pressure/{cpu,memory,io}`, pollable triggers with built-in anti-flap), cgroup v2 `cpu.weight` and `cpu.idle`, `memory.high` throttling, and the freezer via `systemctl freeze` (R).
- Recommendation: discrete presence levels for the cap (BOINC shape), with memory pressure as an override that can only lower the cap, and QoS demotion as the fast first response before parking. Park only at a turn boundary. Never kill a live turn for presence reasons.

## 1. Agent orchestrators and agent IDEs

| Tool | Presence or load signal | What it controls | Policy shape | Evidence |
|---|---|---|---|---|
| T3 Code, load balancing | Per-host CPU utilization and available memory, samples older than 15 s ignored | Which machine gets a new thread, at creation only | Score = `weight * cpuCount * (1 - cpuUtil) * memAvailFrac`; host skipped if CPU >= 95% or free memory <= 5%; weights Prefer 100, Normal 50, Less often 25, Manual only 0 | R, `packages/client-runtime/src/load-balancing.ts`, `apps/web/src/components/settings/LoadBalancingSettings.tsx`, `.agents/docs/user/remote-access.md` "Balance new threads across machines" |
| T3 Code, background policy | Host power snapshot: idle, idleSeconds, locked, suspended, onBattery, lowPowerMode, thermalState (nominal/fair/serious/critical), plus client activity leases (visible, focused, recentlyInteracted, TTL 45 s default, 120 s max) | Opportunistic background work (provider status, VCS status, PR polling, port scanning), not agent turns | `shouldRunOpportunisticWork` = some foreground client lease AND host not constrained. Constrained = suspended, or locked (if `pauseWhenHostLocked`), or thermal serious/critical, or low power / battery if enabled. Profiles `balanced`, `performance`, `battery-saver` | R, `packages/contracts/src/background.ts`, `apps/server/src/background/BackgroundPolicy.ts`, `packages/contracts/src/settings.ts` lines ~1106-1131 |
| T3 Code desktop | Electron `powerMonitor`: `getSystemIdleTime`, `getSystemIdleState`, lock-screen, unlock-screen, on-ac, on-battery, suspend, resume, thermal-state-change, speed-limit-change | Feeds the host power snapshot | Event driven | R, `apps/desktop/src/electron/ElectronPowerMonitor.ts` |
| Orca | `powerMonitor` lock-screen, unlock-screen, on-battery, suspend, resume, shutdown, user-did-become-active | Keeping the computer awake while agents run; resume broadcast | Mode `on`, `off`, `auto` (`keepComputerAwakeWhileAgentsRun`) | R, `src/main/power/agent-awake-service.ts`, `src/shared/app-lifecycle/computer-awake-mode.ts` |
| Orca cloud relay | Active count | Assignment admission in the hosted relay | Fixed `maxConcurrent` per queue | R, `cloud/apps/relay/src/assignment/public-admission/public-assignment-admission.ts` |
| Claude Squad | None | Number of instances | Hard `GlobalInstanceLimit = 10`, creation refused above it | R, `app/app.go:24` |
| Vibe Kanban | None found | No agent concurrency cap found; "parallel" in the code refers to setup scripts running alongside the agent | n/a | R (negative result of `grep -rIi "concurren\|semaphore\|max_concurren" crates/`) |
| Conductor | Unknown | Unknown | Unknown | Closed source, not checked |

Takeaways for us:
- T3's background policy is the inverse of what we want. It runs extra work only while someone is looking, because that work exists to refresh a UI. Agent work is the opposite: it should expand when nobody is looking. The signal plumbing (idle, locked, thermal, battery, client leases with TTL, `unknown` as a third value, a `stale` flag that disables constraints) is directly reusable as a design reference.
- T3's balancer is a good placement score but has no hysteresis and decides only once per thread. It also ignores presence. A hub that places work with this score plus a presence term would send new work away from the laptop while the user types.
- Orca shows the second half of "AFK mode": when we raise the cap because the user left, we also need a power assertion, or the laptop sleeps and the extra agents stall. We already see this on kinosmac: `pmset -g assertions` shows `caffeinate` and Amphetamine holding `PreventUserIdleSystemSleep` (M).

## 2. Build systems and schedulers

- GNU make `-l [load]`: "no new jobs (commands) should be started if there are others jobs running and the load average is at least load" (R, `man make`, GNU Make 3.81 on kinosmac). Admission only, running jobs untouched.
- Ninja `-l N`: "do not start new jobs if the load average is greater than N" (R, https://raw.githubusercontent.com/ninja-build/ninja/master/src/ninja.cc line 289). Load average is a 1/5/15 minute exponential average, so it lags bursts and overshoots, the usual complaint about `-l` (K).
- Bazel `--jobs` plus `--local_resources` (RAM in MB, CPU cores, accepts `HOST_RAM`/`HOST_CPUS` with `-` or `*` modifiers): the scheduler avoids running actions whose crude resource estimates exceed the budget (R, https://bazel.build/docs/user-manual). Bazel also had a Linux-only option to use `SCHED_BATCH` for its own work (R, https://bazel-docs-staging.netlify.app/versions/master/command-line-reference.html). This is a static resource budget with per-job weights, which is what our `toolcaps` weighted leases already are.
- Netflix `concurrency-limits`: concurrency limit treated as a TCP congestion window. Vegas (delay based, +1 or -1 per window by estimated queue), Gradient2 (divergence of short and long latency averages), AIMD (loss based). Partitioned enforcement such as live 90% and batch 10% of the limit (R, https://github.com/Netflix/concurrency-limits README).

Takeaway: build tools gate admission only and never touch running work. AIMD style limiters need a fast, frequent feedback signal (request latency, rejects). Our units are agent turns lasting minutes, so per-turn latency is too slow a signal to drive AIMD well (K, our reasoning). The partitioned idea maps well: reserve slots for interactive sessions the user is driving, let batch sessions use the rest.

## 3. Volunteer computing and background maintenance

BOINC (R, `boinc.wiki/Computing-preferences.md`, `PrefsReference.md`, `Prefs2.md`):
- "In use" means mouse or keyboard input in the last N minutes (a single idle threshold, 2 minutes suggested in the docs).
- Two profiles: "When computer is in use" and "When computer is not in use", each with "Use at most N % of the CPUs", "Use at most N % CPU time", and "Suspend when non-BOINC CPU usage is above N %". In-use can also suspend all computing, or GPU only.
- Memory: "When computer is in use, use no more than X% total memory" default 50%; "When computer is idle" default 90%.
- Other suspend conditions: on battery, outside a time window HH:MM to HH:MM, suspend after X minutes of no input (to let the machine sleep).
- What happens to running work: "Leave non-GPU tasks in memory while suspended: if checked, suspended tasks stay in memory, and resume with no work lost. If unchecked, suspended tasks are removed from memory, and resume from their last checkpoint."
- `Prefs2.md` proposes a generalized design: ordered clauses, each a condition (time, in use, etc.) plus settings like `ram_max_used_frac`.

Folding@home v8 client (R, `fah-client-bastet@7c4363a`):
- Per resource group options `on_idle` (default false), `on_battery` (default true), `keep_awake` (default true), `cpus` (`src/resources/group.json`).
- macOS idle = display power off OR login window active OR screensaver active OR screen locked (`src/fah/client/osx/OSXOSImpl.cpp:188-190`). It does not use HID idle time. Changes are debounced through `delayedUpdateSystemIdle` (1 s after some events, 20 s after the login window appears, lines 199-230 and 376).
- When idle ends, the unit's pause reason becomes "Waiting for idle system" (`Unit.cpp:202`), the running core is interrupted after a minimum run time, and work resumes from its last checkpoint (`Unit.cpp:455-476`, `855-899`). Cores run at `PRIORITY_IDLE` always (`CoreProcess.cpp:64`).

macOS background scheduling (R, SDK headers from `xcrun --show-sdk-path`, macOS SDK on kinosmac):
- `xpc/activity.h`: maintenance priority "not permitted to run if the device thermal condition exceeds a nominal level or if the battery level is lower than 20%", also blocked in Low Power Mode; `XPC_ACTIVITY_ALLOW_BATTERY` defaults false for maintenance; `XPC_ACTIVITY_REQUIRE_SCREEN_SLEEP` runs only while the device "appears to be asleep", which "may include states where the device is known to be idle despite the fact that the display itself is still powered". Long activities poll `xpc_activity_should_defer()` and acknowledge with `XPC_ACTIVITY_STATE_DEFER`.
- `NSBackgroundActivityScheduler.h`: when conditions change mid-activity (example given: unplugged to battery), `shouldDefer` returns true and the block "should finish what it's currently doing" and complete with `.deferred`. This is the "park at next boundary" policy, written by Apple.
- Time Machine and Spotlight run under this machinery (K). The global low-priority I/O throttle is visible as `sysctl debug.lowpri_throttle_enabled: 1` (M); disabling it is a known hack to speed up Time Machine backups (K).

Takeaway: the long-running prior art converges on (a) two or three named profiles keyed on presence, (b) memory limits that differ per profile, (c) a cooperative "defer at a safe point" for running work, with checkpoint restart as the fallback, and (d) always running at low priority regardless of profile.

## 4. OS controls: priority, QoS, cgroups

macOS:
- `taskpolicy` (R, `man taskpolicy`, man page dated December 4, 2025): `-b` runs with `PRIO_DARWIN_BG`, `-B` moves a process out of it, `-c utility|background|maintenance` sets a QoS clamp, `-t`/`-l` throughput and latency tiers, `-m` memory limit in MiB, `-P kill|throttle|suspend` process control action on resource exhaustion, `-p pid` applies to an already running process. Children inherit.
- `PRIO_DARWIN_BG` (R, `man setpriority`): lowest scheduling priority, disk I/O throttled, and "network IO is throttled for any sockets opened after going into background state. Any previously opened sockets are not affected."
- Measured: `taskpolicy -b -p <pid>` on a running `/usr/bin/yes` changed `ps` PRI from 31 to 4, and `taskpolicy -B -p <pid>` restored 31, no root needed (M, kinosmac, 2026-11-22).
- On Apple silicon, background QoS work is confined to the efficiency cores (K, widely reported by Howard Oakley at eclecticlight.co, not verified here).
- `QOS_CLASS_BACKGROUND`: "work should be run in the most energy and thermally-efficient manner" (R, `sys/qos.h`).

Linux (the VPS):
- cgroup v2 `cpu.weight` 1 to 10000, default 100, via systemd `CPUWeight=`; `CPUWeight=idle` sets `cpu.idle`, so the cgroup "will get CPU resources only when there are no processes not marked in this way" (R, https://github.com/systemd/systemd/blob/main/man/systemd.resource-control.xml).
- `MemoryHigh=`: "Memory usage may go above the limit if unavoidable, but the processes are heavily slowed down and memory is taken away aggressively", "the main mechanism to control memory usage of a unit" (R, same file). `ManagedOOMMemoryPressure=kill` with `ManagedOOMMemoryPressureLimit=` lets systemd-oomd kill a unit under sustained pressure (R, same file).
- `systemctl freeze` suspends all processes of a unit through the cgroup freezer until thawed (R, https://github.com/systemd/systemd/blob/main/man/systemctl.xml).
- All of these can be changed at runtime with `systemctl set-property --runtime` (K).

## 5. Signals: what to read and how (macOS first)

| Signal | How to read it | Notes | Evidence |
|---|---|---|---|
| HID idle time | `ioreg -c IOHIDSystem`, key `HIDIdleTime` in ns | Read 196 ms while typing (M). Misses passive use (video, reading, calls) | M |
| User active assertion | `pmset -g assertions`, `UserIsActive` with a 120 s timeout set by WindowServer on HID events | Same blind spot as HID idle | M |
| Screen locked | `ioreg -n Root -d1 -a`, `CGSessionCopyCurrentDictionary`; the key `CGSSessionScreenIsLocked` appears only while locked | Unlocked session showed `kCGSSessionOnConsoleKey = true` and no lock key (M). Presence of the lock key when locked is K | M, K |
| Display asleep | IOKit display power notifications | What Folding@home uses | R |
| Sleep preventers | `pmset -g assertions` | caffeinate and Amphetamine currently prevent idle sleep on kinosmac (M). These mean "user wants it awake", not "user is present" | M |
| Memory pressure | `sysctl kern.memorystatus_vm_pressure_level` (1 now), `kern.memorystatus_level` (73 = free %), `memory_pressure` tool, `DISPATCH_SOURCE_TYPE_MEMORYPRESSURE` with NORMAL/WARN/CRITICAL | `memory_pressure -S -l warn` simulates pressure, useful for tests (R, `man memory_pressure`). Apple: react by changing future memory use, do not mass-drop caches (R, `dispatch/source.h`) | M, R |
| Thermal | `pmset -g therm`, `NSProcessInfo.thermalState` nominal/fair/serious/critical, Electron `thermal-state-change` | `pmset -g therm` reported no warning (M). At serious, Apple says reduce CPU, GPU and I/O (R, `NSProcessInfo.h`) | M, R |
| Power source and Low Power Mode | `pmset -g batt` ("Battery Power", 72%, discharging), `NSProcessInfo.isLowPowerModeEnabled` | | M, K |
| Load | `sysctl vm.loadavg` ({3.09 2.23 2.27} on 10 CPUs) | Lagging, see make/ninja | M |
| Foreground app | `NSWorkspace.frontmostApplication` or `lsappinfo front` | Lets "Zoom or a browser is frontmost" count as presence. Not used by any tool surveyed | K |
| Linux pressure | `/proc/pressure/{cpu,memory,io}` some/full avg10/avg60/avg300, pollable triggers like `some 150000 1000000` | Triggers stay active at least one window and notify at most once per window, so they carry anti-flap logic (R, https://docs.kernel.org/accounting/psi.html). Unprivileged windows must be multiples of 2 s (R) | R |
| Client presence | T3-style activity leases (visible, focused, recently interacted, TTL) | The only way the VPS can know whether the user is at a laptop | R |

## 6. Policy shapes and hysteresis seen

- Discrete profiles: BOINC (in use, not in use), T3 background (balanced, performance, battery-saver), Orca awake (on, off, auto), Folding@home (on_idle boolean). This is the dominant shape (R).
- Continuous limits on admission: make and ninja `-l`, Bazel resource budgets, T3 placement score (R).
- Adaptive limits: Vegas, Gradient2, AIMD in Netflix concurrency-limits (R). Not found in any desktop or agent tool.
- Hysteresis and anti-flap: BOINC's "in use" window of N minutes; Folding@home debounce of 1 s to 20 s; T3 lease TTLs (45 s default) and a `stale` flag that turns constraints off instead of guessing; PSI triggers active at least one window; `UserIsActive` 120 s timeout (R, M). None of the tools uses asymmetric up and down thresholds, which is what we will want (fast down, slow up).
- Treatment of running work when the level drops:
  - Admission only, running work untouched: make, ninja, Bazel, T3 placement (R).
  - Deprioritize: Folding@home always idle priority, `taskpolicy -b`, `CPUWeight=idle`, `MemoryHigh` throttling (R, M).
  - Suspend in place: BOINC "leave in memory", `taskpolicy -P suspend`, `systemctl freeze` (R).
  - Cooperative defer at a safe point: `NSBackgroundActivityScheduler.shouldDefer`, `xpc_activity_should_defer` (R).
  - Stop and restart from checkpoint: BOINC default, Folding@home (R).
  - Kill: systemd-oomd `ManagedOOMMemoryPressure=kill`, macOS jetsam (R, K).

## 7. Adversarial points of view

1. "Memory, not agent count, is the right control variable." Strong on the laptop. A live harness is about 366 MB RSS (M, framing doc) and the laptop has 24 GB (M, `hw.memsize`). Browser and mail lag usually comes from compression and swap, not CPU, because agents spend most of a turn waiting on the network (K). Count is a proxy for memory that breaks when one agent runs `vitest` or a dev server. Counterpoint: memory pressure lags admission (an agent's RSS grows over its first minutes), and it does not capture provider rate limits or the human review bottleneck. Verdict: use memory pressure as a ceiling that can only lower the cap, keep count as the primary knob.
2. "Lowering QoS beats lowering concurrency." Strong for CPU: it is instant, reversible, needs no harness support, and loses no state (M for reversibility). Weak spots: it frees no memory; `PRIO_DARWIN_BG` throttles disk I/O and network on new sockets (R), so LLM streaming connections opened after demotion and `git` or package installs get slower; on Apple silicon E-core confinement may make heavy tool calls several times slower (K). Verdict: demote first, park second.
3. "Presence detection is unreliable, so do not tie policy to it." Partly true. HID idle misses video calls and reading (K). Screen lock and display sleep are reliable but late. Assertions such as Amphetamine are not presence (M). Folding@home avoids HID idle for this reason (R). Mitigation: combine lock or display sleep (strong AFK), HID idle (weak AFK), foreground app allowlist (presence), and a manual override.
4. "The cap barely matters, provider quotas bind first." Plausible. Raising the cap overnight may only burn the 5-hour quota faster (K). The framing doc already notes no tool throttles launches by provider quota. AFK levels should be bounded by the quota module, not only by device resources.
5. "Never interrupt agents; let them finish." Partly right. A turn is not idempotent (tool calls with side effects), so killing mid-turn is unsafe. But a turn can run for many minutes, so "finish" is not instant. The Apple `shouldDefer` contract (finish the current unit, then defer) is the fair middle ground.
6. "Load average is good enough." No: it is a lagging EMA on macOS and Linux and counts uninterruptible I/O on Linux (K). PSI on Linux and dispatch memory pressure on macOS are better.

## 8. Policy designs for us (not implemented)

Common parts for all three: the level is computed per device by its own orchestrator, published with device state, and the hub's placement uses it (no new work to a device in `focus` unless the user targets it). Interactive sessions the user is driving never count against the presence-reduced cap (Netflix-style partition: reserved "live" slots). Parking always means: let the current turn finish, then park (no new prompt), matching `shouldDefer`.

### Design A: three named levels with a pressure override (recommended)

- Levels per device, for example on kinosmac: `focus` 2 batch slots, `away` 5, `overnight` 8. kinosmac-pro and the VPS get their own tables (the VPS has no local presence, so it uses `away` or `overnight` by time, plus the laptop's published presence if we want to keep the user's quota for interactive work).
- Inputs: `focus` when HID idle < 5 min, or a foreground app from an allowlist (Zoom, Meet, browser in full screen), or a T3/Orca client lease is focused. `away` when HID idle >= 5 min, or screen locked, or display asleep. `overnight` when away for 30+ min inside a time window (BOINC "compute only between HH:MM and HH:MM"), on AC power.
- Override: memory pressure warn caps at current live count (no admission); critical lowers the effective cap by one per minute down to `focus`. Thermal serious or Low Power Mode clamps to `focus`. Battery under 20% clamps to `focus` (Apple maintenance rule).
- Hysteresis: go down immediately on user input (users notice lag in seconds), go up only after the condition has held for 2 min (`away`) or 30 min (`overnight`). Raising requires the memory pressure level to be normal.
- Running work when the level drops: first `taskpolicy -b -p` on batch harness process trees (instant relief), then park the surplus at the next turn boundary, newest or lowest priority first. Restore with `taskpolicy -B` when going up. Take a power assertion (`caffeinate -i -w <orchestrator pid>`) only while level >= `away` and live > 0, Orca style.
- Why: matches BOINC and Folding@home, easy to explain, three numbers to tune, and the override covers the "memory is the real variable" critique.

### Design B: memory headroom budget with presence-dependent reserve

- No levels for the cap itself. Admit a new batch session only if `free memory - reserve(presence) >= estimated RSS per harness` (per-harness estimate from our own measurements). Reserve is large when the user is present (for example 8 GB) and small when away (for example 2 GB), the BOINC 50% vs 90% memory rule in another form.
- Lowering: when pressure reaches warn, stop admission; at critical, park the newest batch session at its next boundary, one at a time with a 60 s gap (AIMD-like multiplicative decrease is too aggressive for minute-long units).
- Linux VPS: use PSI memory `some` triggers and run harnesses in a systemd slice with `MemoryHigh=` and `CPUWeight=idle` for batch sessions, so the kernel enforces most of this.
- Pros: tracks the real bottleneck, handles heavy tool calls. Cons: estimates lag RSS growth, harder to reason about, and does not by itself handle "browser feels slow" caused by CPU.

### Design C: QoS-first, count-second

- Keep a generous count cap all the time (the `overnight` number). Tie presence to priority instead: when the user is present, all batch harness trees run under `taskpolicy -b` (macOS) or `CPUWeight=idle` (Linux); when away, restore normal priority.
- Only memory pressure reduces count, by parking at turn boundaries.
- Pros: zero lost throughput when the CPU is free, no state transitions for presence, trivially reversible (M). Cons: no memory relief while present; network and disk throttling on demoted processes (R) can slow LLM streams and git; E-core confinement may make tool calls slow while present (K). Good as a component of Design A rather than alone.

Suggested next measurements before choosing: RSS growth curve per harness over a turn; p95 browser input latency (or a simple "time to open a new tab") at 2, 5 and 8 live agents with and without `taskpolicy -b`; whether `PRIO_DARWIN_BG` noticeably slows an ACP harness's model stream on new connections.

## Unknowns

- Conductor's concurrency or presence behavior (closed source, not checked).
- Whether Vibe Kanban limits concurrency outside `crates/` (only `crates/` was grepped).
- E-core confinement of `PRIO_DARWIN_BG` on current Apple silicon and macOS (K only).
- Exact lock key behavior of `CGSSessionScreenIsLocked` when locked (not tested; locking the screen would interrupt the user).
- Effect of `taskpolicy -b` on already-running harness child processes started before demotion (the man page says children inherit at spawn; inheritance for existing children is unknown).
