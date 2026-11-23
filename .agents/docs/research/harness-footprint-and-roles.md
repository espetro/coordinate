# Harness footprint and roles

Date: 2026-11-22 (`date`: Sun Nov 22 12:26:29 PST 2026). Context: `.agents/docs/orchestrator-framing.md`. Research only, nothing implemented.

Evidence tags: M = measured by us, R = read in the project's own docs or source, B = blog, issue or third-party write-up, K = from memory, unverified.

## 1. Footprint

### Method (M)

All measurements on kinosmac (macOS, Darwin 27.2.0, arm64). No prompt was sent to any model, so no quota was used.

- Startup: `/usr/bin/time -l sh -c 'exec "$@" >/dev/null 2>&1 </dev/null' _ <bin> --version` (and `--help`), reading "maximum resident set size". This is the cheapest code path and is a floor, not a session cost.
- Idle server: start the harness in its server mode (ACP where it exists), send one ACP `initialize` request, wait 5 to 8 seconds, then sum `ps -o rss=` over the process tree. No `session/new`, no prompt. Script: `/tmp/hfp/acp_idle.sh` (scratch, not committed).
- Live: `ps -axo rss=,comm=,args=` on Claude Code processes already running turns on this machine.
- Runtime: `strings` on the binary (`Bun v1.4.4`, `NODE_SEA_BLOB`, `rustc/<hash>`, `go1.26`), the npm/pnpm shim targets, and `package.json` where the tool is not installed.

Caveats: summing RSS across a tree double counts shared pages, so tree numbers are an upper bound. Idle numbers are a lower bound for a real session: MCP servers, LSPs, repo indexing and transcript growth come later. Devin and Claude also spawned the user's MCP servers (`chrome-devtools-mcp` 183MB, a `node` MCP 58MB) at startup, which is config dependent and not the harness itself.

### Table

| Harness | Version | Runtime | `--version` / `--help` max RSS | Idle server RSS (mode) | Live / steady state | Evidence |
|---|---|---|---|---|---|---|
| Claude Code | 2.1.330 | Bun 1.4.4 compiled binary (`strings` shows `Bun v1.4.4`) | 26 / 101 MB | 237 MB (`-p --input-format stream-json`, empty MCP config); 508 MB tree with the user's MCP servers (claude 265 + MCP 241) | 297, 320, 351 MB on three live sessions; 366 MB in the framing doc | M |
| Codex CLI | 0.169.0 | Rust native binary behind a Node shim (`@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`) | 19 / 19 MB | 59 MB (`codex app-server`, which is Codex's own JSON-RPC protocol, not ACP) | Unknown for the CLI; issues report high memory in the desktop app and VS Code extension, not the CLI (openai/codex#11161, #51183, #56583) | M, B |
| maki | 0.7.2 | Rust (`rustc/0ef1bc38` in binary) | 11 / 12 MB | 57 MB (`maki acp`) | Unknown; no memory issue found in tontinton/maki issue search | M |
| OpenCode | v2.3.2 | Bun 1.4.4 compiled binary (`@opencode/cli/bin/opencode.exe`) | 85 / 86 MB | 288 MB tree (`opencode acp`, two processes 129 + 159 MB, client plus server) | Issue reports server RSS 1.5 to 1.8 GB within 30 minutes, tied to SQLite history and image attachments (https://github.com/anomalyco/opencode/issues/56058) | M, B |
| Kimi Code CLI | 2.6.3 | Node single executable application (`NODE_SEA_BLOB` in `~/.kimi-code/bin/kimi`) | 320 / 323 MB (even `--version`, 1.5 s) | 355 MB (`kimi acp`) | Unknown; one issue on session corruption under memory pressure (https://github.com/MoonshotAI/kimi-cli/issues/2336). Older kimi-cli releases were Python (K) | M |
| Devin CLI | 3000.14.30821 | Rust native (`rustc` strings) | 15 / 15 MB | 107 MB for `devin` itself; 349 MB tree with the user's MCP servers (`devin acp`) | Unknown. `devin daemon` is a shared background agent that ACP clients attach to (R, `devin --help`), so per-session cost may be lower than per-process | M, R |
| Antigravity CLI (`agy`) | 1.5.12 | Go (`go1.26` in binary) | 121 / 121 MB | Not measured: its stream-json mode reads turns from stdin and the probe could start a model turn | Unknown | M |
| Cursor Agent | 2026.11.17 | Node v26.12.1 bundled (`cursor-agent` is a bash wrapper around `./node index.js`) | 204 / 208 MB | 239 MB (`cursor-agent acp`) | Unknown | M |
| Crush (bonus) | 0.101.0 | Go | 55 / 57 MB | 72 MB (`crush server`) | Unknown | M |
| Pi | not installed | Node >= 22.19 (`@earendil-works/pi-coding-agent` 1.6.0, `bin: dist/bundle/cli.js`, repo `earendil-works/pi`, formerly `badlogic/pi-mono`) | Unknown | Unknown. ACP through the third-party `svkozak/pi-acp`, which spawns `pi --mode rpc`, so two Node processes per session | Unknown | R |
| Grok CLI | not installed | TypeScript, Node >= 18, optional `bun build --compile` (`superagent-ai/grok-cli` package.json, 3.5k stars, last push 2026-07-06) | Unknown | Unknown; no ACP mode found | Unknown. Whether xAI ships an official CLI is unknown to us. Orca lists `grok` as a worker agent with `--model` support (R, stablyai/orca `.agents/docs/site/content/docs/cli/orchestration.mdx`) | R |

### Reading the numbers

- The user's claim holds (M): Codex starts at 19 MB and idles at 59 MB as a server, maki at 11 MB and 57 MB. Both are Rust.
- Runtime predicts the floor (M): Rust and Go binaries start at 11 to 121 MB. Bun binaries start at 26 to 101 MB but idle at 237 to 288 MB once they serve. Node binaries (Kimi, Cursor) pay 200 to 320 MB before doing anything.
- Live cost is unknown for everyone except Claude Code. Measuring it needs a real turn, which costs quota. Recommendation: let the scheduler learn it (section 2) instead of hard coding it.
- MCP servers are a hidden multiplier. Claude and Devin each spawned 241 MB of the user's MCP servers per process (M). Per-session MCP configs, or one shared MCP gateway, matter more than the harness runtime for Claude and Devin.
- Tail risk differs from median. Claude Code has closed issues of a resumed session growing to 44 GB RSS (https://github.com/anthropics/claude-code/issues/24644) and OpenCode an open one at 1.5 to 1.8 GB (#56058). The scheduler needs an RSS ceiling per live session (kill or park above it), not only an admission estimate.

## 2. Ordered harness list: proposed config shape

Goals: the user writes an ordered list with priorities and optional roles, the scheduler stays predictable, and footprint is learned, not guessed.

```yaml
# fleet.yaml (proposal, not implemented)
defaults:
  memory_reserve_mb: 1024        # never admit below this free memory on a device
  rss_ceiling_factor: 3.0        # park or kill a live session above 3x its harness p95
  selection: lexicographic       # or "weighted"; see below

providers:                        # quota pools, shared by harnesses that use them
  anthropic-sub: { kind: subscription, window: 5h, soft_limit_pct: 85 }
  openai-sub:    { kind: subscription, window: 5h, soft_limit_pct: 85 }
  moonshot:      { kind: subscription, window: 5h }
  devin:         { kind: acu, monthly_budget: 250 }

harnesses:
  - id: codex
    priority: 90
    roles: [implement, review, debug]
    transport: acp                # via codex-acp adapter; app-server or tmux as fallback
    provider: openai-sub
    models: { default: gpt-6.2-sol, review: gpt-6.2-astra }
    devices: [kinosmac, kinosmac-pro, ovhcloud]
    footprint: { seed_idle_mb: 59, seed_live_mb: 150 }   # live seed is a guess until learned
    max_live: 4
  - id: claude
    priority: 80
    roles: [plan, implement, write, orchestrate]
    transport: acp
    provider: anthropic-sub
    models: { default: claude-opus-5-5, plan: claude-fable-5-2 }
    mcp_profile: minimal          # per-session MCP set; the measured default adds 241 MB
    footprint: { seed_idle_mb: 237, seed_live_mb: 366 }
    max_live: 2
  - id: maki
    priority: 70
    roles: [implement, explore]
    transport: acp
    provider: [anthropic-sub, openai-sub]   # maki is model agnostic; inherits the cheapest pool with headroom
    footprint: { seed_idle_mb: 57 }
  - id: kimi
    priority: 40
    roles: [explore, implement]
    transport: acp
    provider: moonshot
    footprint: { seed_idle_mb: 355 }
    devices: [ovhcloud]           # heavy runtime, keep it off the small laptop
  - id: devin
    priority: 30
    roles: [long-running, implement]
    transport: acp
    provider: devin
    footprint: { seed_idle_mb: 107, shared_daemon: true }
  - id: tmux-any                  # fallback for harnesses without ACP (agy, grok)
    priority: 10
    transport: tmux
    command: ["agy"]

roles:                            # role vocabulary, with a fallback order if no harness claims it
  plan:      { fallback: [implement] }
  review:    { requires_different_provider_from: implement }   # cross-family review
  explore:   { prefer_cheap: true }
```

Selection per task (task carries `role`, optional `harness` pin, optional `device` pin):

1. Pin wins. A task that names a harness or model skips ranking, like `--agent`/`--model` in Orca and pins in oh-my-openagent (R, sources in section 3).
2. Filter hard constraints: harness installed on a candidate device, transport reachable, role in `roles` (or in the role's `fallback`), provider not over `soft_limit_pct`, `free_mem - memory_reserve_mb >= footprint.live_p95` on that device, `live < max_live`.
3. Rank. Default `lexicographic`: role match (exact before fallback), then `priority`, then quota headroom, then smaller `live_p95`. Lexicographic keeps the user's ordering meaningful and explainable. `weighted` is an opt-in: `score = w_p*priority + w_r*role_fit + w_q*quota_headroom - w_m*live_p95/free_mem`, for users who want memory pressure to override priority.
4. No candidate: queue the task with the reason (memory, quota, cap), never drop it (framing requirement 3).
5. Learn: while a session is live, sample its process tree RSS (`ps` every 30 s, already cheap), keep a per harness p50/p95 and a per device rolling value, and replace the seeds. Use the p95 for admission and `rss_ceiling_factor * p95` for the kill or park ceiling.

Open questions for the user: whether `review` should force a different provider than the implementer by default; whether quota is read from the harness (`/usage` style output) or estimated by counting turns; whether `priority` should be per device.

## 3. Roles: who assigns them, how they route, and what backs the claims

| Tool | Roles defined | How routing works | Evidence behind the role claims |
|---|---|---|---|
| oh-my-openagent / OmO (formerly oh-my-opencode), `code-yeongyu/oh-my-openagent`, 71k stars | Main agent lanes (Daily Normal, Daily Heavy, Obsessive Normal, Obsessive Heavy); curated agents `explore`, `librarian`, `plan-consultant`, `plan-reviewer`; categories `architect`, `visual-engineering`, `ultrabrain`, `deep-low`, `deep-high`, `artistry`, `quick`, `unspecified-low`, `unspecified-high`, `writing` (R, `.agents/docs/guide/agent-model-matching.md`) | Main agent picks a category, not a model. Each category and curated agent has a hardcoded ordered fallback chain; first model your logged-in providers serve wins. Subscriptions outrank API keys. Categories with no servable model are hidden. User overrides in `omo.json` (R) | Maintainer judgment. The guide says Claude responds to "mechanics-driven" prompts and GPT to "principle-driven" prompts, and advises "Claude-family models fit the communicative roles ... GPT-family models fit `plan-reviewer`, `ultrabrain`, `deep-low` and `deep-high`" (R). No benchmark is cited in that guide; capability metadata comes from `models.dev` (R, `.agents/docs/model-capabilities-maintenance.md`). The README frames it as "I'm this project's most obsessive user" (R). Classify as vibes from heavy use. Note that its current defaults put Claude on the main agent and planning, GPT on deep execution and review, which matches the framing in the task brief |
| Orca, `stablyai/orca` | No role vocabulary. A coordinator starts workers with `worker-start --agent <id>` and optional `--model`/`--effort` (Claude, Codex, Cursor, Antigravity, Grok, Muse, Pi). Group addresses `@claude`, `@codex`, `@gemini`, `@grok` and others for messages (R, `.agents/docs/site/content/docs/cli/orchestration.mdx`) | Explicit. The orchestration skill tells the coordinator "Add `--model` only if the user named one" and treats "Have Codex review this" as a request for a worker of that agent (R, `skill-guides/orchestration.md`) | None claimed. Roles are whatever the human or coordinator prompt says |
| Claude Code subagents | Built-ins Explore, Plan, general-purpose, plus helpers (claude-code-guide and web-fetch on Haiku); user subagents with `model`, `tools`, `effort`, `isolation` frontmatter (R, https://code.claude.com/docs/en/sub-agents) | The parent model chooses a subagent by its `description`. Model is per subagent or inherited; Explore runs on the `opus` alias when the parent runs Fable on first-party auth; `CLAUDE_CODE_SUBAGENT_MODEL` forces one model (R) | Cost and context isolation, stated as goals ("Control costs by routing tasks to faster, lower-cost models like Haiku") (R). No published benchmark for the per-role model choice in the docs. Single vendor only, so no cross-family routing |
| Aider architect/editor | Architect (reasons about the change) and Editor (emits edit-format output) (R, https://aider.chat/2024/09/26/architect.html) | `--architect` chat mode; two models per request, set with `--model` and `--editor-model` (R) | Benchmark. Aider code editing benchmark: o1-preview architect + o1-mini or DeepSeek editor 85.0% vs o1-preview solo 79.7%; Sonnet + Sonnet 80.5% vs 77.4% solo; GPT-4o + GPT-4o 75.2% vs 71.4% (R). The strongest evidence in this survey, but dated (September 2024 models) and on an edit-format benchmark where the split fixes a formatting weakness of reasoning models |
| Anthropic multi-agent research system | Lead agent plus parallel subagents (R, https://www.anthropic.com/engineering/multi-agent-research-system) | Lead plans and spawns subagents with their own context windows | Internal eval: Opus 4 lead + Sonnet 4 subagents beat single-agent Opus 4 by 90.2% on research tasks, at about 15x the tokens of chat (R, vendor eval, not public) |

Other tools found but not read in depth (K, verify before relying on them): Cline and Roo Code plan/act modes with separate models per mode; Claude Code `opusplan` model alias (Opus in plan mode, Sonnet otherwise); Codex profiles; Kilo Code orchestrator/architect/code/debug modes.

### Adversarial points

- Roles are mostly vibes. Outside Aider's benchmark and Anthropic's internal research eval, no tool surveyed publishes an eval for "model X is better at role Y". oh-my-openagent's own guide says "A prompt cannot fix a model" and that off-ladder models "may look fine for a few turns and then fall apart", which is maintainer experience, not measurement (R).
- Role claims decay with each release. oh-my-openagent already retired profile ids (`capable`, `deep-work`, `simple-work`) and keeps one prompt preset per model version (R). A static "Claude plans, GPT codes" rule in our config would go stale within a quarter. Keep roles user owned and data driven.
- The evidence that exists is about splitting a task, not about which family. Aider's gains include same-model pairs (Sonnet + Sonnet, GPT-4o + GPT-4o), so the benefit is partly decomposition, not specialization (R).
- Multi-agent coding is fragile. Cognition argues for "a single-threaded linear agent" because decisions get dispersed and context is not shared well enough (B, https://cognition.ai/blog/dont-build-multi-agents). Anthropic says "most coding tasks involve fewer truly parallelizable tasks than research" (R, same research post). The MAST study of multi-agent failures found 14 failure modes in three clusters: system design, inter-agent misalignment, task verification (B, https://arxiv.org/abs/2503.13657).
- Cost: multi-agent systems used about 15x the tokens of chat in Anthropic's data (R). Role routing that adds a planner and a reviewer per task multiplies quota use, which is our scarcer resource next to memory.
- Where roles help us anyway: cross-provider review (an independent family catches different errors, plausible but unmeasured here, K), quota spreading across subscriptions, and cheap exploration on low-footprint harnesses. These are scheduling arguments, not capability arguments, and they are the ones the config in section 2 encodes.

## Unknowns

- Live and steady-state RSS for every harness except Claude Code.
- Antigravity idle server RSS; Pi and Grok anything (not installed).
- Whether `devin daemon` amortizes memory across ACP sessions.
- Codex ACP adapter footprint (`codex-acp` not installed here; only `app-server` measured).
