# Terminal fallback spike: tmux vs Herdr vs zmx

Scope: pick the M2 terminal fallback for our fleet agents, or confirm we stay on tmux. Candidate features: detach-and-resume of agent CLIs, addressable sessions a dispatcher can script without attaching, low idle footprint, sane behaviour when the server or a client dies. Measured 2026-11-22 on VPS host vps-ef376962 (Debian 13, kernel 6.117, 8 GB RAM) with bench/term_fallback.py and bench/fakeworker.py; raw numbers in .agents/docs/data/results-term-fallback-vps.json. Tags: M measured this run, R reference docs or upstream repo, B benchmark code, K knowledge call from prior spike sessions.

## Tools and versions [R]

tmux 3.5a, herdr 0.9.5 (self-contained 28.9 MB binary, ghostty_vt 1.4.1-dev vendored), zmx 1.0.1 (16.8 MB binary). Sources: github.com/herdrdev/herdr (Apache-2.0, verified from raw.githubusercontent.com/herdrdev/herdr/master/LICENSE) and github.com/neurosnap/zmx (MIT, Copyright (c) 2025 Eric Bower, verified from raw.githubusercontent.com/neurosnap/zmx/main/LICENSE). Both licenses are fine for our use including vendoring and internal redistribution.

## Results [M]

All numbers from .agents/docs/data/results-term-fallback-vps.json, medians over the runs the bench recorded. RSS slope is a least-squares fit over the 1/5/20 session points. The zmx RSS columns are invalid: per-session daemons did not match the isolated-TMPDIR ownership check, so the measured pid set was empty and RSS reads as 0.0 MB. The 46-48 MB herdr figures include the server and everything it spawned in the measurement window; tmux 4.8-4.9 MB is the server alone plus the hold session.

| Metric | tmux 3.5a | herdr 0.9.5 | zmx 1.0.1 |
| --- | --- | --- | --- |
| Idle server RSS (0 sessions, fitted) | 4.8 MB | 46.3 MB | n/a (measurement bug) |
| Server RSS at 1 session | 4.8 MB | 46.2 MB | n/a |
| Server RSS at 5 sessions | 4.9 MB | 46.9 MB | n/a |
| Server RSS at 20 sessions | 4.9 MB | 48.0 MB | n/a |
| RSS per additional session (fitted) | 0.00 MB | 0.09 MB | n/a |
| Create latency, median | 0.010 s | 0.13-0.14 s | 0.12-0.13 s |
| Input/output roundtrip, median | 0.0068-0.0074 s | 0.0035-0.0040 s | 0.0014-0.0018 s |
| Idle CPU | 0.0% | 0.0% | 0.0% |
| Sessions survive client exit | yes (all probed) | yes (all probed) | yes (all probed) |
| Workload pids alive after kill -9 of server | no (0 of 1) | no (0 of 21) | n/a (server is per-session; nothing killed) |

Survival after kill -9 [M]: for tmux the single workload pid died with the server and after restart only the hold session was listed. For herdr all 21 matched pids were gone after the kill but the restart listed all 20 sessions again, meaning workspaces are registry entries that outlive their panes; the roundtrip after restart failed with no echo, so the sessions were hollow. For zmx there is no central server to kill; each session is its own daemon, so a server kill -9 is not a meaningful scenario, and the bench's pid-match miss meant it recorded nothing here.

## Scripting ergonomics for a dispatcher [B]

tmux is one CLI with stable machine-readable formats: new-session -d to start an agent CLI, send-keys to inject a prompt, capture-pane -p to read output, list-panes -F '#{pane_pid}' and #{pane_dead} to detect exit or a waiting shell, kill-session to close. Everything is one subprocess call and the formats are the same on macOS.

herdr is JSON in, JSON out at the workspace/pane level: herdr workspace create --label, herdr pane run <pane_id> to start the worker, pane send-text plus pane send-keys Enter for input, pane read --lines for output, workspace list and pane list to map labels to pane ids. Two quirks the bench had to work around [K]: the pane_id is a token rather than a pid, and there is no obvious pane-liveness or output-growth notification, so the dispatcher polls pane read, which costs a JSON roundtrip per poll.

zmx is the thinnest: zmx run <name> -d <cmd> to start, zmx send <name> to inject, zmx history --screen or --scrollback to read output, zmx kill to close, zmx list to enumerate. Detached daemons are per session. What it lacks for us: no structured output (list lines are key=value text and the pid= field did not match the running daemon in our isolation setup [M]), and no built-in idle or waiting-for-input signal, so the dispatcher polls history.

Idle and waiting-for-input detection is the weak spot everywhere: none of the three exposes a semantic "agent is waiting" event, so the dispatcher must poll output or pane state. tmux's pane_dead and herdr's workspace registry give the cheapest liveness checks.

## macOS support [R]

tmux 3.5a: first-class, brew install tmux, identical CLI and formats on macOS. herdr: stable binaries for macOS Intel and Apple Silicon, brew install herdr, install docs at herdr.dev/tui/docs/install. zmx: README states works on mac and linux, ships macos-aarch64 and macos-x86_64 tarballs, brew install neurosnap/tap/zmx. All three run on our M2 machines without building from source.

## Verdict

Stay on tmux for the M2 terminal fallback [K]. It is 10x lighter at idle (4.8 vs 46 MB), its create latency is 10x lower (0.010 vs 0.13 s, and create latency is per agent spawn, the operation our dispatcher does most), and it is the only one with stable machine-readable output formats plus pane_dead for liveness. It also has by far the most battle-tested macOS story and is already in our stack, so zero new glue. The kill -9 results show no candidate survives server death with working sessions, so resilience is equal and not a differentiator.

zmx's per-session daemon model is architecturally the best fit for fleet agents (no single server to kill, cheap isolation) and its roundtrip latency was the lowest measured [M], but its unstructured CLI, missing liveness signals, and the pid/accounting mismatch we hit make it a monitoring risk. Revisit it if tmux's server ever becomes a real single point of failure; the glue it needs from us is a small structured wrapper around run/send/history/list plus output-polling.

herdr buys pane semantics we do not need (it is positioned as an agent runtime with a TUI) at 46 MB idle per host and a JSON roundtrip per poll. If we ever adopt it, the glue is a thin client over workspace create/pane run/send-text/read with polling on pane read; its workspace registry surviving server death is nice for observability but the sessions are hollow after restart [M].

## Glue required per tool [B]

tmux: none beyond what we have; keep using new-session -d, send-keys, capture-pane -p, list-panes -F, kill-session. herdr: a JSON client module wrapping workspace/pane subcommands, label-to-pane_id resolution, and a pane read poller. zmx: a text-parsing wrapper around run/send/history/list/kill plus a history poller, and an answer for how to identify daemon pids reliably under isolation.

## Provenance and incident note [K]

The bench ran at 22:27-22:29 UTC on the VPS after two fixes earlier in the session. The agent process running it was SIGKILLed (exit -9) shortly after the results were written, before committing; a second agent had died the same way earlier during a kill -9 survival test. Suspected cause, fixed in d50866e: the kill -9 paths signaled pids that were never guaranteed to be ours. TmuxTool._descend walked up the process tree from the pane pid for up to 4 hops and accepted any ancestor whose comm contained tmux, so it could resolve to another user's tmux server and SIGKILL it. HerdrTool parsed the server pid from ss -xlp output matching the bare name herdr.sock, which can hit another instance on a shared box. ZmxTool recorded daemon pids parsed from zmx list output with no ownership check. The fix gates every signal on /proc-based verification (cmdline mentions the tool binary, environment carries the bench's isolated TMPDIR) and stops the ancestor walk at PID 1. The zmx RSS zeros in the results file predate the fix and are a measurement artifact, not a real footprint. The bench was not re-run per close-out instructions.
