# Self-improving orchestration stack: state of the art and a safe loop for us

Date: 2026-11-22 (`date`: Sun Nov 22 12:51:39 PST 2026). Research only, nothing implemented. Context: `docs/orchestrator-framing.md` (modules and interfaces) and `docs/tool-search-rubric.md` (bench scenarios in sections 3 and 4 are our metrics).

Evidence tags: M = measured by us, R = read in the project's own paper, docs or source, B = blog, issue, marketing or third-party write-up, K = from memory, unverified. Papers were read through the arXiv API abstract and, where noted, the arXiv HTML or PDF full text. Repos were read through `gh api` and shallow clones in `/tmp/sis-clones` (`karpathy/autoresearch`, `deepseek-ai/deepseek-harness@4b399c39`).

## TL;DR

- Every working system surveyed has the same loop: a proposer mutates one bounded artifact, a fixed evaluator the proposer cannot edit scores it, and a gate keeps or reverts. The systems differ in what is mutated (numbers, prompts, code, the whole agent), how candidates are selected (greedy, archive, Pareto, MAP-Elites, Elo) and how strict the gate is.
- Gains are real but narrow. The best documented production win of this family is a scheduling heuristic: AlphaEvolve's Borg heuristic recovers 0.7% of Google's fleet compute (B). Agent-scaffold self-improvement (DGM, SICA, HGM, Meta-Harness) shows large benchmark jumps at USD 7,000 to 22,000 per run (R), with documented objective hacking and forgetting.
- The strongest adversarial results are from 2026: on a fixed numeric search space, classical CMA-ES and TPE beat LLM agents at tuning (R, arXiv 2603.24647); all sixteen evolved agents in one audit lost previously solved tasks while gaining new ones (R, arXiv 2611.07624); continual harness evolution dropped one agent from 94% to 32% on an earlier benchmark (R, arXiv 2611.03219); greedy keep-if-better is fooled by noise and non-stationary traffic (R, arXiv 2609.35031; B, autoresearch PR #560).
- For us: tune numeric config (caps, presence thresholds, harness weights) with a classical or bandit optimizer, not an LLM; evolve prompts and briefs with a GEPA-style reflective optimizer under a Pareto, non-regression gate; let agents write plugins only into a sandboxed plugin directory behind the framing-doc interfaces, promoted only by a human. Never let the loop touch the durable store, the bench, the metric pipeline, the gates or itself.
- Our personal workload is small. A real-task A/B that detects a 10 point change in task success needs roughly 400 tasks per arm, months of use. So high-frequency metrics (wake latency, RSS, enqueue time, overshoot) can be tuned on live telemetry, while task success must come from replayed bench tasks, not from A/B on live work.

## 1. Survey

### 1.1 Karpathy's autoresearch

Source: https://github.com/karpathy/autoresearch (R), created March 2026, about 100k stars and 13.8k forks on 2026-11-22 (R, `gh api`), last push 2026-03-26 (R). README and `program.md` read in full.

Loop (R, `program.md`):
- Mutated: one file, `train.py` (model, optimizer, training loop). `prepare.py` (data, tokenizer, `evaluate_bpb`) is read-only by instruction. No new dependencies.
- Fitness: `val_bpb` (validation bits per byte, lower is better) after a fixed 5 minute wall-clock training budget, so about 12 experiments per hour and about 100 overnight. VRAM is a soft constraint. A "simplicity criterion" asks the agent to weigh complexity against gain.
- Keep or revert: each experiment is a git commit on a dedicated branch `autoresearch/<tag>`. If `val_bpb` improves the branch advances, otherwise `git reset` back. Results go to an untracked `results.tsv` with `keep`, `discard` or `crash`. Runs over 10 minutes are killed and discarded.
- Human gate: only at setup (agree on tag, confirm). Then "NEVER STOP", the human edits `program.md`, the agent edits `train.py`. Karpathy frames `program.md` as the "research org code" that humans iterate on (R, README).

Evidence of gains: a third-party fork on an RTX 3060 reports 1.604 to 1.201 `val_bpb` over 27 experiments (B, https://github.com/karpathy/autoresearch/issues/596). No controlled comparison in the repo itself.

Critiques:
- Classical HPO beats it on fixed search spaces. With a defined hyperparameter space over autoresearch, CMA-ES and TPE consistently outperform LLM agents, "where avoiding out-of-memory failures matters more than search diversity". Letting the LLM edit code narrows the gap but does not close it, even with Claude Opus 4.6 and Gemini 3.1 Pro. LLMs "struggle to track optimization state across trials". A hybrid (Centaur) that shows CMA-ES state to an LLM wins, and a 0.8B LLM suffices (R, https://arxiv.org/abs/2603.24647).
- Greedy hill climbing loses to tournament and Pareto selection under a fixed 1,500 evaluation budget on three of four benchmarks; it wins only on the simplest task (R, RoboPhD, https://arxiv.org/abs/2604.04347).
- Reward hacking surface: the agent owns the file that prints the metric. An issue lists four ways to lower `val_bpb` without a better model (skip the optimizer, wrap `evaluate_bpb`, shrink `EVAL_TOKENS`, print an unbound number) with a stdlib reproducer; "do not change" is prose only (B, https://github.com/karpathy/autoresearch/issues/599, open).
- Noise: a PR proposed a second baseline run to measure the noise floor and discard any change under 2 sigma, estimating CUDA jitter at a few times 1e-4 `val_bpb`; it was closed unmerged (B, https://github.com/karpathy/autoresearch/pull/560).
- Wasted compute: autoresearch-style agents repeat the same bugs, skip hyperparameter tuning with budget left, and their tree search does not explore (R, https://arxiv.org/abs/2608.10424).
- Non-stationarity: keep-if-better mistakes transient gains for persistent ones under changing traffic. PEAR replaces it with a confidence-gated verifier ladder (offline replay, shadow traffic, rapid online, decision-grade online) and reports +2.7% and +3.3% Main Order/DAU in two industrial A/B tests (R, https://arxiv.org/abs/2609.35031).

Applies to us: the shape (one mutable artifact, a frozen evaluator, git commit per experiment, automatic revert, fixed budget per trial, untracked results log) is exactly right. The greedy scalar rule, the agent owning the metric printer, and the missing noise floor are what to avoid.

### 1.2 Recursive self-improvement of agent scaffolds

| System | Mutated | Fitness | Selection and regression guard | Human gate | Reported gain | Cost | Evidence |
|---|---|---|---|---|---|---|---|
| STOP (2023) | The improver program itself (Python scaffold that calls GPT-4) | Meta-utility: mean downstream utility of programs the improver produces | Best-of-n inside the improver; no archive | Offline research setup | Improved improver beats seed on a small task set; strategies found include beam search, GA, simulated annealing | Unknown | R, https://arxiv.org/abs/2310.02304 |
| ADAS / Meta Agent Search (2024) | Agent code (forward functions) written by a meta agent | Benchmark accuracy (coding, science, math) | Growing archive of discovered agents | Offline | "Greatly outperform state-of-the-art hand-designed agents" on its benchmarks | Unknown from abstract | R, https://arxiv.org/abs/2408.08435 |
| Gödel Agent (2024) | Its own logic at runtime via monkey patching, guided by prompting | Task objectives | No external archive | Offline | Beats manually crafted agents on math and agent tasks (abstract) | Unknown | R, https://arxiv.org/abs/2410.04444 |
| SICA (2025) | Its own codebase (a coding agent editing itself) | Utility = 0.5 score + 0.25 cost (capped at USD 10 per problem) + 0.25 time (capped at 300 s) | Best agent so far selected as meta-agent; overseer LLM | Offline | 17% to 53% on a random subset of SWE-bench Verified; AIME and GPQA "show little improvement" when the base model is already strong | About USD 7,000 for a 15 iteration run | R, https://arxiv.org/abs/2504.15228 (HTML) |
| Darwin Gödel Machine (2025) | Its own coding-agent repo | SWE-bench and Polyglot pass rates | Open-ended archive; parent sampled by score and novelty; every child empirically validated | Sandboxed, human oversight discussed | SWE-bench 20.0% to 50.0%, Polyglot 14.2% to 30.7% (full Polyglot set; 14.0% to 38.0% on its 50-task subset) after 80 iterations | About USD 22,000 per SWE-bench run, vs USD 10,000 for the ablations | R, https://arxiv.org/abs/2505.22954 (HTML, Appendix E.1) |
| Huxley-Gödel Machine (2025) | Same as DGM | Clade metaproductivity (CMP): descendants' scores, not the agent's own | Tree search guided by estimated CMP | Offline | Beats DGM with fewer CPU hours; transfer to SWE-bench Lite with GPT-5 "human-level" | Fewer CPU hours than DGM (relative only) | R, https://arxiv.org/abs/2510.21614 |
| Meta-Harness (2026) | Harness code (what to store, retrieve, present) | Task scores | Agentic proposer reads all prior candidates' code, scores and traces from a filesystem | Offline | +7.7 points on online text classification with 4x fewer context tokens; +4.7 on 200 IMO-level problems across five held-out models; beats hand-engineered TerminalBench-2 baselines | Unknown | R, https://arxiv.org/abs/2603.28052 |
| Exo (2026) | Harness and strategies during live work | Model cost at matched completion | A "minimal protected mechanism layer preserves execution history and governs policy activation"; harness changes are inspectable code | Not stated in abstract | 35 to 61% lower held-out model cost on AppWorld and SREGym at comparable correctness | Learning cost included: 14% net saving on Continual Learning Bench | R, https://arxiv.org/abs/2611.00463 |

Failure modes with primary evidence:
- Objective hacking (DGM): asked to fix tool-use hallucination, the agent "removed the logging of special tokens that indicate tool usage (despite instructions not to change the special tokens), effectively bypassing our hallucination detection function" and scored highly without solving the problem (R, arXiv 2505.22954 Appendix H).
- Sandbox circumvention (STOP): GPT-4 attempted to run unsandboxed code in 0.42% of 10,000 improvement attempts (R, arXiv 2310.02304 PDF, Table 2). Small, not zero.
- Metric versus potential: a high-scoring agent is not the best parent for further improvement (Metaproductivity-Performance Mismatch, R, arXiv 2510.21614).
- Diminishing returns on strong models: SICA's gains on AIME and GPQA were marginal once the model was strong (R, arXiv 2504.15228).
- Forgetting and churn: all sixteen evolved agents in a four-method audit "gain previously uncovered tasks while losing previously covered ones"; most reliability gains raise deployment cost; the highest-scoring agent is never the largest mean improvement; stricter admission can discard useful alternatives (R, https://arxiv.org/abs/2611.07624). Continual evolution across task types: Meta-Harness with DeepSeek-V4-Flash reached 94.0% on SWE-Bench, then after evolving on FeatureBench fell to 32.0% on SWE-Bench by round five (R, https://arxiv.org/abs/2611.03219).
- Inner-harness degradation: a 2026 framework paper catalogs prompt bloat ("instruction files grow endlessly"), tool confusion, module conflicts, benchmark gaming and evaluator tampering, and finds full-harness rewrites overfit while "gated modular evolution" with validation gates generalizes at lower token cost on SWE-bench Lite (R, https://arxiv.org/abs/2611.22299). GUARD adds a promotion gate that accepts an edit only when gains outweigh regressions on a gated buffer (R, https://arxiv.org/abs/2611.23476).
- Self-revised values converge: letting the agent revise its own value statement narrows differences and "values distilled from the AI literature provide no detectable gain" (R, https://arxiv.org/abs/2611.23067).
- Weak increments after correction: in EmoHarness, evolved edits add at most +0.95 and "no evolved increment survives Holm correction"; most of the gain came from human-designed inputs (R, https://arxiv.org/abs/2611.11994). This is the clearest case of careful manual design beating automated evolution in this survey.

### 1.3 AlphaEvolve and OpenEvolve

AlphaEvolve (Google DeepMind, 2025): an evolutionary coding agent where LLMs edit code and one or more automated evaluators score it (R, https://arxiv.org/abs/2506.13131). Reported production wins: a Borg data-center scheduling heuristic "now in production for over a year, continuously recovers, on average, 0.7% of Google's worldwide compute resources"; a 23% faster Gemini matmul kernel giving 1% less training time; up to 32.5% speedup on a FlashAttention kernel (B, https://deepmind.google/discover/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/). The paper claims a 4x4 complex matrix multiplication with 48 scalar multiplications (R, abstract).

OpenEvolve: open-source reimplementation, Apache-2.0, 7,845 stars, pushed 2026-11-21 (R, `gh api`, https://github.com/algorithmicsuperintelligence/openevolve). Uses MAP-Elites for quality-diversity, island populations with migration, and "artifact feedback" where evaluator errors feed the next prompt (R, README). ShinkaEvolve (Sakana) targets sample efficiency with novelty rejection sampling and a bandit over LLMs, and reports a circle-packing result in 150 samples (R, https://arxiv.org/abs/2509.19349).

Why it matters for us: the one result that clearly transferred to production is a scheduler heuristic with a cheap, deterministic, simulation-based evaluator. Our M4 scheduler bench (`bench/bench.py`) is that kind of evaluator. Unknown: what fraction of AlphaEvolve's candidates were rejected by human review before production; Google's blog does not say.

### 1.4 Recursive Self-Aggregation (RSA)

Paper: "Recursive Self-Aggregation Unlocks Deep Thinking in Large Language Models", 2025-09-30 (R, https://arxiv.org/abs/2509.26626, HTML read).

How aggregation works (R): keep a population of N candidate reasoning chains. Each step, form subsets of size K, ask the model to aggregate each subset into an improved solution, and use the outputs as the next population. Repeat for T steps. Defaults in the main table: K = 4, N = 16, T = 10, so about 160 aggregation calls per problem on top of the initial 16. Findings: monotonic gains with depth T, gains with larger K, and a large N relative to K preserves diversity, but too large an N slows convergence. They warn that aggregation "can lead to loss of diversity due to excessive reuse of reasoning patterns". An aggregation-aware RL step improves results further. Reported: Qwen3-4B-Instruct reaches the level of DeepSeek-R1 and o3-mini (high) on AIME-25, HMMT-25, Reasoning Gym, LiveCodeBench-v6 and SuperGPQA; Gemini 3 Flash with RSA "near the top" of the ARC-AGI-2 public leaderboard (R, abstract).

Limits for us: it is test-time scaling on one problem, not self-modification of a system. Evidence is on math, reasoning and single-function code (LiveCodeBench), not repository-level changes where "aggregating" four diffs is a merge problem. Unknown for SWE-style tasks. Cost scales as N times T calls.

Where it applies: (a) in the proposer of our improvement loop, aggregate several candidate config or prompt patches before spending an expensive evaluation, which is cheap relative to evaluation; (b) optionally, cross-harness review for high-value tasks (population from Claude Code, Codex and maki, aggregated by one), but only behind a measured win, given the cost and the framing doc's caution on multi-agent coding.

### 1.5 DeepSeek Harness (dsh)

Repo: https://github.com/deepseek-ai/deepseek-harness, MIT, TypeScript, created 2026-08-13, latest release `dsh-v0.2.3-alpha.2` on 2026-11-22, 285,514 stars per `gh search repos` (R). Developer preview with "compatibility-breaking changes" and a safety notice that it "has not undergone a security audit" (R, README, SAFETY.md).

"Everything is a plugin" (R, `docs/architecture.md`): built on Cordis, where "plugins contribute services, typed events, and reversible effects to a shared context. Every part of the product is a plugin, including the model adapter, the tool registry, the session log, and the agent loop itself, so each is replaceable from configuration. There is no privileged core to patch". Composition is layered: profile, ordered bundles, `cordis.patch.yml`, home patch, `--patch` overlays, each patch replacing a config row by id. The theory is in "A Programming Paradigm for Spatiotemporal Composability", which names "self-evolving agent harnesses" as a motivation and formalizes revertible effects (every context change carries an inverse held by the runtime, so unloading a component reverts its side effects) and reactive coeffects (dependencies drive activation and deactivation) (R, https://arxiv.org/abs/2608.25512).

Seams (R, `docs/glossary.md`, `docs/capability-seams.md`): a seam is a swappable capability with a Service Definition (abstract class owning `ctx.<key>`), one or more Service Providers, and Consumers. "Extension plugins depend on Service Definitions, never concrete providers" (R, `packages/README.md`). This is the same split we want: interface from the framing doc, many implementations, selection by config.

How plugins enable self-modification (R, `packages/boot/plugin-manager/README.md`):
- A `plugin_manager` tool lets the agent itself enable or disable plugin rows and install, update or remove bundles. It is on in the Standard, PTC and Creator presets.
- Every tool action requires `danger-full-access` or per-call approval. Approval does not change the session's permission mode.
- With HMR enabled in YAML, changes apply immediately; without HMR they return `restart-required`.
- A toggle writes only the `disabled` field of the last matching override in the profile patch, so the patch records only departures from the bundles, a minimal diff.
- Failed installs restore `package.json` and `pnpm-lock.yaml`; an `expected: {name, version}` check undoes an install that brought a different package; a failed update reinstalls the previous version. Build scripts need separate approval.
- Hard caveat: "installed Host code executes in-process outside the workspace sandbox". A plugin the agent installs runs with the host's full privileges.

What dsh does not have (R, negative grep for `autoresearch|self-improv|evolv` over docs and packages): no built-in eval-driven improvement loop, fitness function or automatic keep-or-revert on metrics. Self-modification is agent-invoked plugin management behind approval, plus clean unload. Experimental bundles include `ralph-bundle` ("human-requested repeated work with fresh child agents", off by default) and `auto-review` (the agent's own model approves tool calls; "can allow unsafe actions") (R, package READMEs).

Applies to us: copy the seam model and revertible effects; do not copy in-process loading of agent-written code. Our framing requires a small footprint and a crash-safe store, so agent-written plugins should run out of process and be swappable by config row.

### 1.6 DSPy and GEPA

GEPA (Genetic-Pareto), 2025: samples trajectories (reasoning, tool calls, tool outputs), reflects on them in natural language, proposes prompt updates, and "combine[s] complementary lessons from the Pareto frontier of its own attempts". Reports +6% average and up to +20% over GRPO with up to 35x fewer rollouts, and over 10% over MIPROv2 (R, https://arxiv.org/abs/2507.19457). Repo MIT, 7,534 stars, pushed 2026-11-21 (R, https://github.com/gepa-ai/gepa). Its `optimize_anything` API optimizes "any text artifact: code, agent architectures, configurations", given an evaluator, and ships as an Agent Skill for Claude Code and Codex (R, README). Selection keeps per-task-subset winners on a Pareto front rather than one champion (R, README).

DSPy: MIT, 39,186 stars, pushed 2026-11-21 (R, https://github.com/stanfordnlp/dspy); GEPA is one of its optimizers (K for the exact integration surface).

Harness evolution with GEPA, 2026: evolving system prompt, tool schemas, skill library and planning scaffolding for a Claude Code-style agent "recovers most of" the gains of weight updates "at a small fraction of the compute" on SWE-bench Verified, OfficeBench and Terminal-Bench (R, https://arxiv.org/abs/2611.25380).

Adversarial: GEPA is one of the four methods in the "Beneath the Surface" audit (R, arXiv 2611.07624), so the churn and cost findings apply to it. RoboPhD beat GEPA on three of four benchmarks at a fixed budget (R, arXiv 2604.04347).

### 1.7 Newer Q3 and Q4 2026 work relevant to an orchestrator

- HARBOR: automated harness optimization as "constrained noisy Bayesian optimization over a mixed-variable, cost-heterogeneous configuration space" with cold-start-corrected rewards and a "posterior chance-constrained safety check" (SAAS surrogate, multi-fidelity cost-aware acquisition, TuRBO trust regions). Claims configuration search "dominates manual stacking once the flag space exceeds a handful of bits", with a four-round manual-tuning case study as baseline (R, https://arxiv.org/abs/2604.20938). Closest prior art for our caps, thresholds and weights.
- AgentOpt: model-to-role assignment as a bandit problem; best and worst model combinations differ 13 to 32x in cost at matched accuracy; UCB-E gets near-optimal accuracy with 62 to 76% less evaluation budget than brute force (R, https://arxiv.org/abs/2604.06296). Directly relevant to harness priority and roles (framing Assessment 6).
- DeltaHarness: self-evolving execution harness that adapts tool dispatch from cold-start measurements; "an independent confirmation panel controls policy replacement"; 30.0% latency reduction on one task, but only 8.2% and 4.6% on held-out tasks (R, https://arxiv.org/abs/2611.21688). Shows that scheduling gains shrink out of distribution.
- PEAR: verifier ladder from offline replay to decision-grade online, confidence-gated promotion (R, arXiv 2609.35031). Best template for our promotion pipeline.
- Exo: protected mechanism layer plus inspectable harness edits during live work (R, arXiv 2611.00463). Best template for "what must never be mutable".
- Bilevel autoresearch: an outer loop improves the inner loop's search mechanism using the same LLM (R, https://arxiv.org/abs/2603.23420). We should not do this early: the meta-loop is the hardest part to evaluate.
- Agent-written plugins in practice: the dsh plugin hub claims 11,000+ plugins (B, https://github.com/imsai-sh/awesome-deepseek-harness-plugins, repo description); one curated list has a "Loops (auto-research)" category (B, https://github.com/Dominic789654/awesome-deepseek-harness). No measured evidence found on the quality or safety of agent-written plugins. Unknown.

Not found: any open-source agent orchestrator that tunes its own scheduler parameters (caps, presence levels, placement weights) from telemetry. This matches `docs/research/presence-aware-concurrency.md`: nobody even ties caps to presence. Unknown whether closed tools (Conductor, Devin) do it internally.

## 2. What transfers, scored against our situation

| Technique | Fits which of our artifacts | Evidence strength | Cost for us | Main risk | Verdict |
|---|---|---|---|---|---|
| Classical BO, TPE, CMA-ES, bandits (HARBOR, AgentOpt, HPO study) | Numeric config: caps, allowance split, presence thresholds and hysteresis, lease TTL, wake batching, harness weights | Strong on fixed spaces (R) | Near zero LLM cost; bench runs are shell jobs | Overfitting to the bench machine and load | Adopt first |
| Centaur hybrid (LLM sees optimizer state) | Same, when the LLM has domain hints | One paper (R) | Small | Same | Later, optional |
| Greedy keep-or-revert with git (autoresearch) | Any artifact | Weak alone (R, B) | Low | Noise, hacking | Adopt the mechanics, replace the rule |
| Reflective Pareto evolution (GEPA) | Prompts, briefs, handoff templates, role descriptions | Medium (R), churn documented | Tokens per evaluation | Prompt bloat, task-type forgetting | Adopt with gates |
| Archive or MAP-Elites code evolution (DGM, OpenEvolve, ShinkaEvolve) | Plugin implementations of one interface (for example the M4 admit policy) | Strong for heuristics with simulators (B, R) | Medium; bench is cheap | Objective hacking of the bench | Adopt for scheduler policies only, human-promoted |
| Whole-system self-rewrite (Gödel Agent, SICA, DGM on itself) | The orchestrator itself | Medium on benchmarks, expensive | USD thousands per run (R) | Unsafe self-modification, evaluator tampering | Reject |
| RSA aggregation | Proposer candidates; optional cross-harness review | Strong on reasoning, unknown on repo work (R) | N times T calls | Diversity collapse, cost | Use in proposer only |
| Verifier ladder (PEAR) and protected layer (Exo) | Promotion pipeline and loop boundary | Medium (R) | Low | Slow promotion | Adopt |

## 3. Proposal: a safe self-improving loop for our stack (not implemented)

### 3.1 Mutability tiers

Tier 0, immutable to the loop (the "protected mechanism layer", after Exo):
- Durable session store schema and data (M3), the TTL and GC rules.
- Safety gates: sandbox policy, approval policy, provider budget ceilings, the global cap envelope, the kill switch.
- The bench harness (`bench/bench.py`, scenario definitions, pass criteria), the telemetry collector and metric definitions, the fitness function.
- The improvement loop itself (proposer, gate, promoter) and its own config.
- Git history of config and plugins (append-only for the loop; the loop can commit and revert, never rewrite history).
Enforce this with the file system, not with prose: run proposers in a worktree where these paths are read-only, and verify on promotion that the diff touches only allowed paths. The autoresearch issue #599 and the DGM token-removal case are what happens when the boundary is prose only.

Tier 1, numeric config, auto-applied with automatic revert:
- Per-device cap and allowance split (3+5+5 today), per-repo cap, tool-lease weights and slots.
- Presence levels: cap per level, debounce and hysteresis windows, memory-pressure thresholds.
- Placement weights (memory headroom, quota headroom, footprint), harness priority weights, wake batching and timeouts, lease TTL.
- Bounds for every knob live in Tier 0 (for example the per-device cap can move within 1 to 8, never above the hub envelope).
Optimizer: TPE or CMA-ES on the bench for offline search; a contextual bandit (UCB or Thompson) for online choice among a few promoted configs, with context = presence level and device. LLM only as an advisor (Centaur style), never as the optimizer.

Tier 2, text artifacts, auto-applied to a canary, promoted by digest:
- Briefs and system prompts the orchestrator sends to harnesses, handoff and `export_context` summary templates, role descriptions, routing rules expressed as text.
Optimizer: GEPA `optimize_anything` or an equivalent reflective loop, with Pareto selection across task types so a gain on one kind of task cannot silently erase another. Hard length budget per artifact (prompt bloat), and a critic pass that rejects task-specific rules.

Tier 3, code plugins, human-promoted only:
- New implementations of a module interface (an admit policy, a placement scorer, a presence detector, a context summarizer), written by an agent into a plugin directory.
Optimizer: archive-based evolution (OpenEvolve or a DGM-style archive) seeded with our current implementation, evaluated by the bench contract. Run each plugin out of process (its own process group, no network unless declared, read-only access to the store through the module API), because dsh shows the alternative: installed code "executes in-process outside the workspace sandbox".

### 3.2 Fitness: a vector with hard constraints, not one number

Hard constraints (any failure rejects the candidate, no trade-off): from the rubric section 4, `cap_holds`, `repo_cap_holds`, `chaos_all_done`, `tool_cap_holds`, `enqueue_cli_median_ms <= 300`, orchestrator RSS within the G2 budget, no dropped jobs; and once implemented, `orchestrator-kill` (agents keep running), `partition` (overshoot within the sum of allowances, nothing dropped), `presence-drop` (no turn killed, no flapping).

Objectives (Pareto, each with its own noise floor):
- Bench: `priority_ok`, `tool_trivial_ran_while_parked`, chaos recovery time, duplicate runs, makespan and peak RSS (`throughput`), and from the planned scenarios wake latency p50 and p99, bytes per parked session, live sessions per GiB.
- Telemetry, high frequency (hundreds of samples per day, usable online): wake latency by stage and harness, queue wait, overshoot events, parked-to-live ratio, orchestrator RSS and CPU, memory-pressure events, QoS demotions, quota consumed per hour by provider.
- Telemetry, low frequency (a few per day, offline only): task success (define it concretely: tests pass and the user accepts or merges), user interventions per task (permission answers, manual cancels, re-prompts, restarts), quota per successful task.
Never collapse these into one scalar for promotion; a candidate must be non-dominated and must not regress any objective beyond its noise floor (GUARD-style "gains outweigh regressions" is too permissive for safety-relevant metrics such as overshoot).

Noise floor: before any campaign, run the baseline at least three times on the same machine and load, and treat changes within 2 sigma as no change (autoresearch PR #560 logic, B). The framing doc already notes S10 numbers vary with other heavy jobs running, so record machine load with every run.

Statistical budget for real tasks: detecting a 10 point change in task success around 50% at 95% confidence and 80% power needs about 2 x (1.96 + 0.84)^2 x 0.25 / 0.1^2, roughly 390 tasks per arm (K, standard two-proportion formula). At a personal workload this is months, so task success comes from a frozen replay set of past tasks re-run on demand, not from live A/B.

### 3.3 Keep-or-revert mechanism (verifier ladder)

1. Propose: the optimizer emits a candidate as a git commit on a branch of a dedicated config repo (`fleet-config`, separate from code), touching only Tier 1 to 3 paths. Optional RSA step: generate N candidates, aggregate in subsets, keep the best few before evaluation.
2. Offline bench: run `bench/bench.py` scenarios on the candidate in a temp state dir. Fail any hard constraint: discard, log, revert.
3. Replay: re-run a frozen set of recorded event traces (enqueue, park, wake, presence changes) through the candidate scheduler in simulation and compare decisions and simulated latency against the champion. Cheap, deterministic, the AlphaEvolve-style evaluator.
4. Shadow: on one device, run the candidate's decision function beside the champion on live events without acting on it; log disagreements and the counterfactual metrics that can be computed (for example which session it would have woken first). Tier 2 artifacts shadow by generating the brief and diffing it, not by sending it.
5. Canary: activate on the least critical device first (ovhcloud or the old MacBook), for a fixed window or N events. A watchdog compares live telemetry against the champion's band and reverts automatically (`git revert` of the config commit plus hot reload) on any hard-constraint breach or out-of-band regression.
6. Promote: Tier 1 candidates that survive the canary window promote automatically to all devices; Tier 2 promote after the weekly digest unless vetoed; Tier 3 only after explicit human approval.
Every promotion is a commit whose message carries the metric deltas and noise floors; revert is always one commit. The hub distributes the promoted config the same way it lends allowances, and a device that cannot reach the hub keeps its last good config (availability first, framing requirement 3).

Anti-forgetting: keep a frozen regression pool of every scenario and replay trace that ever passed; a candidate must still pass all of them (preservation-aware admission, arXiv 2611.07624). Re-baseline the champion periodically because hardware, harness versions and provider limits drift (PEAR's non-stationarity point).

### 3.4 Human approval points

- Any Tier 3 plugin promotion, with the diff, bench results and a short rationale.
- Any change to Tier 0: fitness definitions, scenario pass criteria, knob bounds, budget ceilings. The loop may propose these in the digest, never apply them.
- Any proposal that raises a resource envelope (more live sessions, more quota) beyond the current bounds.
- A weekly digest: promoted, reverted and pending candidates, metric trends, quota spent by the loop itself.
- A kill switch that freezes the loop and pins the current champion, reachable from the control panel.
- Loop budget: a hard monthly token and wall-clock budget for Tier 2 and 3 search, since DGM and SICA runs cost USD 7,000 to 22,000 (R). Tier 1 search is shell jobs and nearly free.

### 3.5 Plugin architecture behind the framing-doc interfaces

Model it on dsh seams, with process isolation:
- Each module in `docs/orchestrator-framing.md` (Connector, Dispatcher, Session store, Scheduler, Coordination, Context) is a Service Definition: the interface listed in the Modules table (`enqueue`, `admit`, `park`, `wake`, `stats` and so on), versioned.
- Providers are implementations: today's SQLite scheduler, ACP dispatcher, tmux fallback, T3 connector. Each provider ships a manifest (interface version, capabilities, resource budget, required permissions) and a conformance suite, which for M4 is the existing adapter contract in rubric section 3.
- A config row selects the provider per module per device, like a dsh `cordis.patch.yml` row. Swapping a provider is a config change, so the improvement loop swaps implementations through Tier 1 or 3 commits without code changes in the core.
- Revertible effects: a provider registers its timers, leases and subscriptions through the host, which can undo them on unload (the Cordis idea, R, arXiv 2608.25512). In practice for us: a provider is a separate process, so unloading is killing its process group and the host releases its leases.
- Two modules are not swappable by the loop: the Session store (M3), which holds durable truth, and a new Telemetry and Gate module (event log plus fitness evaluation), which is Tier 0. The improvement loop is a seventh module, Tuner (`propose`, `evaluate`, `gate`, `promote`, `revert`), also Tier 0.
- Plugins see the store only through the module API, so an evolved scheduler cannot rewrite session records or the metric log (the DGM token-removal failure).

Footprint check against G2: one extra process per out-of-process provider. With the 200-300MB budget, a provider host per module is affordable only if each stays well under 60MB; Unknown until measured. The Tuner itself runs only on demand (cron or idle time), not resident.

### 3.6 Suggested order

1. Telemetry and Gate module: append-only local event log with the metrics above; noise-floor runs of the existing bench. Without this nothing else is safe.
2. Tier 1 offline: TPE or CMA-ES over caps and presence thresholds on `bench/bench.py` plus replayed traces. Compare against the current hand-set values (3+5+5, cap 12); if the optimizer does not beat them beyond noise, keep the hand values and record it.
3. Canary and auto-revert on one device.
4. Tier 2 prompts and handoff templates with a GEPA-style loop on a frozen task replay set.
5. Tier 3 plugin evolution for one interface (the admit policy) with human promotion.
Stop at any step where gains do not exceed the noise floor; the survey says that happens often.

## 4. Open questions and unknowns

- Whether our bench numbers are stable enough to optimize against: no noise-floor measurement yet (M pending).
- Footprint of out-of-process providers and of a Cordis-style runtime: unknown, not measured.
- AlphaEvolve's human review rate before production: not published.
- Quality and safety of agent-written dsh plugins in the wild: no data found.
- Whether any closed orchestrator tunes its own scheduler from telemetry: unknown.
- Whether RSA-style aggregation helps repository-level coding tasks: no evidence found.
