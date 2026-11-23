> Note (2026-11-23): main is now TypeScript + scriptc only. Python paths and `uv`/`pytest` commands below refer to the retired Python implementation, preserved on the `legacy/python` branch.
# Extensibility in v0.1.0: plugins, config, self-update

Date: 2026-11-23 (`date`: Mon Nov 23 17:41 UTC 2026). Design for how users of the v0.1.0 binary release extend and improve coordinate without touching upstream code or opening PRs. This is the applied form of `.agents/docs/research/self-improving-stack.md`: the survey's conclusions, converted into a product surface. Inputs: `research/self-improving-stack.md` and `t3-integration.md`; code state per this worktree's `src/coordinate/`.

Evidence tags: M = verified from code or docs in this repo, C = design intent, not built unless a section says "built". A separate section at the end marks which items gate v0.1.0 versus post-1.0.

## 0. The problem shape

v0.1.0 ships scriptc-compiled binaries (M: `ts/` in this repo, scriptc 0.4.16 validation docs). Users cannot rebuild from source easily (C: scriptc toolchain requires the pin and re-validation ritual the port docs describe). So "improve without contributing upstream" must mean three runtime surfaces, not patches:

1. A plugin directory: executables discovered at startup, implementing a small set of interfaces.
2. A config/policy layer: numeric knobs tunable without code, with bounds kept outside the tunable surface.
3. A self-update channel: a way to obtain new released binaries without a build toolchain.

The research line is blunt about what must not be extensible: the durable store schema, the bench, the metric pipeline, the gates and the improvement loop are the protected layer (M: survey section 3.1 Tier 0; Exo's "protected mechanism layer" is the strongest template in the survey, R arXiv 2611.00463). Everything below is organized around that boundary.

## 1. Plugin directory

### 1.1 Location and discovery

Plugins live under `$XDG_CONFIG_HOME/coordinate/plugins/`, default `~/.config/coordinate/plugins/` (M: `paths.py:config_dir()` is the single source for config paths and already XDG-resolved; the P1 rename established this). A plugin is one executable file or one directory:

- `~/.config/coordinate/plugins/<name>` (a file): single-script plugin, executable bit set.
- `~/.config/coordinate/plugins/<name>/` (a directory): must contain `<name>.plugin.toml` (manifest) plus its payload; other files in the directory are ignored unless the manifest names them.

Discovery is a directory scan at daemon startup and at `coordinate plugins` invocation (C: built in this task, see section 4). A plugin is loaded only if: the entry exists, is executable by the current user (M check via `os.access(..., X_OK)`), and either its manifest parses or, for file plugins, its first line is a shebang. Load order is alphabetical by name; this is deliberate, so behavior is reproducible (C).

Why executables and not importable Python modules: dsh ships "every part of the product is a plugin" but documents the cost plainly, installed code "executes in-process outside the workspace sandbox" (R: dsh plugin-manager README, quoted in survey 1.5). Our survey rejects in-process loading of foreign code (M: survey 1.5 "Applies to us"). An executable plugin is a process boundary by construction: crash isolation is free, unloading is killing its process group (M: survey 3.5 adopt this), and it imposes no dependency-management burden on the core, which has zero runtime dependencies (M: `pyproject.toml` `dependencies = []`).

### 1.2 What a plugin may be

Each plugin implements at most one interface, declared in its manifest. v0.1.0 recognizes these interface kinds (C for the two marked, M for what exists):

- `frontend`: consumes the events stream. This matches the Frontend protocol designed in `t3-integration.md` section 2 (`name`, `session_ref`, `on_event`, `can_launch`, `launch`, `notify`) (M: design exists; the protocol is not yet extracted into `frontend.py`, M absent from `src/`). The runtime contract for a frontend plugin is process-shaped, not class-shaped: the daemon (or a `coordinate events --follow` helper, once P2 events exist) runs the plugin executable as a long-lived subprocess with one JSON event per line on stdin (C: the line protocol is chosen because it is trivially testable and matches how the tmux fallback already talks to processes). The plugin must never block the daemon: the daemon writes events best-effort and drops them if the plugin pipe is full (M: "cheap and lossy-tolerant, coordinate never blocks" is the protocol's own invariant, `t3-integration.md` section 2).
- `resume` / dispatcher adjunct: a plugin that can resume or start sessions in some way coordinate's built-in ACP dispatcher does not cover (for example a tmux pane driver). It is invoked with a JSON job description on argv-stdin and must print a JSON result with a session ref or an error (C). It participates in dispatch only if a config row selects it (section 2.2); the built-in ACP path remains the default (M: `daemon.py:161` `spawn_acp` is the only dispatch path today).
- `hook`: a metric or lifecycle hook. Invoked with one JSON event per call, short-lived, expected to exit quickly; the daemon never waits more than the hook's declared `timeout_s` (default 5, C). This is the seam a user would use for ntfy pushes, local log shipping, or a home-grown metrics side channel, without touching the metric pipeline itself (C; the pipeline stays core, section 3.4).

Interfaces NOT open to plugins in v0.1.0, and the reason each is excluded: the Session store (durable truth; a plugin-backed store would put crash-safety guarantees behind foreign code, M: survey 3.5 names the store as not swappable), the gate and fitness functions (Tier 0, survey 3.1), the bench (evaluator tampering is a documented failure mode, M: survey 1.1 autoresearch issue #599 and DGM Appendix H), and the improvement loop itself (self-reference is the loop-hacking surface the survey rejects outright, M: survey section 2 "whole-system self-rewrite: reject").

### 1.3 Manifest

`<name>.plugin.toml`, all keys except `interface` optional with defaults (C):

```toml
name = "tmux-frontend"
interface = "frontend"        # frontend | resume | hook
version = "0.1.0"
timeout_s = 5                 # per-invocation cap for hook/resume; ignored for frontend (long-lived)
sandbox = "no-network"        # declaration only in v0.1.0, see 1.4
```

Unknown manifest keys are errors, not warnings: a plugin that requests something the loader does not understand must fail loudly rather than silently get less than it asked for (C: fail-closed rule, the opposite of dsh's toggle-only-diff approach, which was designed for a trusted ecosystem we do not have).

### 1.4 Sandboxing expectations

Honest statement for v0.1.0: the loader applies no sandbox of its own. A plugin runs with the full privileges of the user who runs `coordinated` (M: subprocess spawn, no seccomp, no bwrap anywhere in `src/`). What v0.1.0 provides instead is containment-by-contract plus one filesystem rule:

- Plugins run out of process, in their own process group, so a runaway plugin is killable without touching the daemon (C).
- A frontend or hook plugin gets the store only through the events stream and documented read-only CLI output; it never receives a database path or connection (C, and M that nothing passes one today because the loader is new).
- The declared `sandbox` field is recorded and surfaced by `coordinate plugins list`, so a user can see what a plugin claims, but v0.1.0 does not enforce it (C; the honest enforcement path, a `bwrap`/`landlock` wrapper selected per declaration, is post-1.0, section 5).
- Plugins must not write anywhere under the state directory (`~/.local/state/coordinate/`) except through documented outputs (C: this is where the durable store lives, `paths.py:state_dir`). The loader does not verify this in v0.1.0; it is documented expectation, marked as such rather than claimed as a guarantee.

This is weaker than the survey's Tier 3 end state (filesystem-enforced read-only paths at proposal time, M: survey 3.1), and deliberately so: those mechanisms exist to contain an autonomous improvement loop, which v0.1.0 does not run at all. A user installing a plugin by hand is the same trust level as a user installing any CLI tool; the survey's strict containment targets agent-authored candidates (M: survey 3.4 makes every plugin promotion human-approved). Post-1.0 hardening is in section 5.

### 1.5 Loading, concretely

The loader (built in this task, M) is one module, `src/coordinate/plugins.py`, under 150 lines:

- `discover(plugin_dir: str) -> list[Plugin]`: scan, parse manifests, check exec bits, return typed records. Errors (bad manifest, non-executable) are collected and returned, never raised; the daemon logs and continues.
- `load_frontend(plugin, on_line)` and `spawn_hook(plugin, event_dict)`: the only two runtime entry points in v0.1.0. Frontend plugins are started by `coordinate plugins run --interface frontend`, which reads events from stdin and fans them to every frontend plugin's stdin; this keeps the daemon itself unchanged in v0.1.0 (C: the daemon-side wiring waits for P2 events, per `t3-integration.md` section 2's dependency analysis).
- No import of plugin code, no `sys.path` manipulation, no eval, ever (M: enforced by the module's imports).

## 2. Config and policy layer

### 2.1 Tunable without code

`~/.config/coordinate/config.toml` (M: `paths.py:config_path()` is the single resolved location) is the user's tuning surface. Knobs in v0.1.0, with defaults from code (M values; bounds are C policy):

| Knob | Default (M) | Bound (C) | Survey tier |
|---|---|---|---|
| per-machine live cap | 3 (`daemon.py` cap logic) | 1 to 8 | Tier 1 |
| per-repo cap | configured per repo | <= machine cap | Tier 1 |
| tool-lease slots/weights | tool slots built (M: ARCHITECTURE line 44) | sum <= machine cap | Tier 1 |
| daemon poll interval | `BACKOFF_MAX` 2s (M: `daemon.py:30-38`) | 0.5 to 10s | Tier 1 |
| job time cap grace | cap + grace + <0.3s measured (M: ARCHITECTURE line 112) | grace 0 to 60s | Tier 1 |
| frontend/hook plugin timeouts | manifest `timeout_s` (section 1.3) | 1 to 300s | Tier 1 |

This table is the v0.1.0 slice of what the survey calls Tier 1 numeric config (M: survey 3.1), and the survey's optimizer verdict applies verbatim: tune these with TPE, CMA-ES or a bandit, never with an LLM loop; classical optimizers beat LLM agents on fixed numeric spaces (R: arXiv 2603.24647), and the cap/threshold family is exactly HARBOR's configuration-space use case (R: arXiv 2604.20938). v0.1.0 ships no optimizer at all; it ships knobs whose bounds make a later optimizer safe to add (C). Every knob's bound lives in the loader's schema, which is core code, not config: a config value outside its bound is rejected at load with the offending line named (C, built in this task for the plugin/config knobs the loader owns). This implements the survey's rule that "bounds for every knob live in Tier 0" (M: survey 3.1 Tier 1, last sentence).

### 2.2 Provider selection rows

Selection-by-config is the dsh seam model adopted wholesale (M: survey 1.5 "interface from the framing doc, many implementations, selection by config"): a config table lists, per interface kind, which implementation is active. v0.1.0 rows:

```toml
[frontend]
active = ["tmux-frontend"]        # plugin names, in fan-out order

[resume]
provider = "acp"                  # built-in, only valid value in v0.1.0

[hooks]
active = ["ntfy-push"]
```

An active row naming a plugin that fails discovery is a startup warning, not an error (C: availability over consistency, ARCHITECTURE line 15; a broken plugin must not take down the queue). A `resume.provider` value that is not `acp` is a hard config error in v0.1.0 (C: nothing else exists; failing loudly beats a silently non-resuming queue, which would violate the durability model, M: ARCHITECTURE section Durability).

### 2.3 What is deliberately not a knob

The gate thresholds, bench pass criteria, fitness definitions and TTL/GC rules are not config: they are code (M: `bench/compare.py` + `bench/thresholds.toml` exist in-tree, and the survey puts all of these in Tier 0, survey 3.1). Rationale: autoresearch's evaluator-tampering issue is precisely "the agent owns the file that prints the metric" (M: survey 1.1, issue #599); making gates configurable re-creates that surface for anyone with write access to config, including a future improvement loop. The correct reading of the survey for a product: the protected layer is protected by not having a config surface at all, not by policy text next to one (C, design judgement; supported by the Exo template, R: arXiv 2611.00463).

## 3. Self-update

### 3.1 The decision

Users of scriptc binaries update through a `coordinate update` subcommand that downloads a released binary from GitHub Releases and atomically replaces itself. (C: this section is the recommendation; the release session owns the final channel choice. If that session picks direct hosting, only `--url` changes below; the mechanism is identical.)

GitHub Releases is the channel because the P1 release workflow already attaches artifacts to a GitHub Release (M: ARCHITECTURE P1 line 122), so the update command needs no new infrastructure. The alternative, direct hosting on the author's VPS, adds a serving component and an availability dependency for zero benefit at personal scale (C).

### 3.2 Mechanics

`coordinate update [--version X] [--check]` (C, spec):

1. Fetch the latest release tag from the GitHub API (or `--version`), over `https`.
2. Download the binary matching platform-arch, plus its checksum file; both from the release assets.
3. Verify: sha256 must match the checksum file, and the checksum file itself must be signed or fetched over the release's TLS chain (v0.1.0: sha256 check only, C; release signing with a pinned key is post-1.0, section 5).
4. Write the new binary next to the current one (`os.path.dirname(sys.executable)` or the known install prefix, M: scriptc ELF is a single file, M: `ts/` build outputs) as `<name>.new`, `chmod +x`, `os.replace` onto the target. `os.replace` is atomic on POSIX (M: POSIX rename semantics), so an interrupted update cannot leave a half-written binary.
5. Version check before replace: refuse to "update" to the same or older version unless `--force` (C; comparing semver-ish tags of this repo's own releases, M: tags are user-controlled in this repo's workflow).

`--check` prints the available version and exits, for scripting. `coordinate version` gains the ability to print its own build tag so update can compare (C: the scriptc build must embed a version string for this to work; that is a release-session dependency, flagged here).

Rollback: `coordinate update --rollback` keeps the previous binary as `<name>.prev` for exactly one version and restores it (C). This is the product-level echo of the survey's keep-or-revert rule: never leave the user without a known-good artifact (M: survey 1.1's git-commit-per-experiment mechanics, adopted at artifact level).

What update does not touch: the config directory, the plugins directory and the state directory are never written by update (C, hard rule; user improvements survive binary updates by construction, which is the entire point of splitting the surfaces). Plugins written against v0.1.0 interfaces carry an `interface` version in the manifest; a binary that does not recognize a plugin's interface version warns and skips it rather than misloading it (C: this is the compatibility contract that makes self-update and user plugins compose safely).

### 3.3 Anti-rollback and pinning

Users who want stability pin with `coordinate update --channel stable` vs `--channel pre` reading a `channel` field from a release metadata file (C: one JSON asset per release, `channel` in it). v0.1.0 may ship with a single implicit channel if the release session prefers; the flag exists in the spec so the channel concept does not have to be retrofitted (C).

## 4. Core versus plugin: the line, and hard rules

### 4.1 Core (never a plugin, never user-swappable in v0.1.0)

Scheduler and queue logic, SQLite store and schema, TTL and GC, cap enforcement, park/wake, lease machinery, ACP dispatch and session resume (M: these are `queue.py` + `daemon.py`, the whole runtime, M), bench and its thresholds, gates and fitness functions, the telemetry collector (M: ARCHITECTURE Telemetry section), and the CLI verbs that mutate state (M: `cli.py`). This is the survey's protected layer, mapped onto what v0.1.0 actually ships (M: survey 3.1 Tier 0; ARCHITECTURE Modules table for what exists).

### 4.2 Plugin-able (with the interface each implements)

Frontends/visibility (events consumers, `t3-integration.md` section 2), resume/dispatcher adjuncts (section 5 of the same doc), notification and metric hooks (section 1.2's `hook`). Also designed now, built later: Store and Dispatcher as full protocols with provider selection (C: `t3-integration.md` sections 4 to 5 and the build order in its section 6); those become plugin-able post-1.0 once the protocols are extracted from `queue.py`/`daemon.py`, not before (C: extracting an interface with one implementation and unstable call sites produces a fake seam; the t3 doc's own build order says the same, M).

### 4.3 Hard rules (the survey's protected-layer conclusion, as rules)

1. Plugins never touch the durable store schema or the store file. No plugin interface exposes a connection, path or SQL; the store stays core (section 4.1). The DGM failure mode, editing the instrumentation to improve the score, is unreachable because the instrumentation is not on any plugin surface (M: survey 1.2 DGM Appendix H as the motivating case).
2. Plugins never implement or wrap the bench, the metric pipeline or the gates. A hook may read emitted events, it may not become the evaluator (section 2.3).
3. Plugins never load in-process (section 1.1).
4. Config can move knobs only within bounds the core owns (section 2.1); no config key can re-route the store, gates or bench.
5. Binary updates never rewrite config, plugins or state (section 3.2).

Each rule is enforceable by construction (no interface exists that would violate it), which is the strongest form available to a v0.1.0 product and the correct reading of "enforce with the file system, not with prose" applied at product scale (M: survey 3.1 for the principle; C: the by-construction claim for the rules above).

## 5. What gates v0.1.0 versus post-1.0

Ships in v0.1.0 (M for what is built and passing tests in this worktree, C for the rest of the version's scope):

- Plugin directory convention, discovery and the tiny loader (`src/coordinate/plugins.py`, ~150 lines), plus the ntfy-push example plugin and 13 loader tests (M: built in this worktree, commit `feat(plugins)`; `uv run pytest tests/test_plugins.py` passes, full suite 89 passed, 2 skipped, M: `flock /tmp/tsc.lock uv run pytest -q`).
- Plugin manifest schema with fail-closed unknown-key handling and bounded `timeout_s` (M: built).
- `coordinate plugins list` / `coordinate plugins run [--interface X]` (M: built, minimal: stdin JSON-line fan-out, per-plugin timeout, failures to stderr, never fatal to the caller).
- The documented sandbox and hard-rule contract of sections 1.4 and 4.3 (C: documentation is the deliverable).
- `coordinate update` per section 3.2 (C: spec here; the release session decides the channel and the version-embedding, both flagged as dependencies of this command).
- Config knob table with bounds (C: the bounds schema lands with the config work it governs; the doc fixes the bound values now so later code and this doc cannot drift silently).

Post-1.0, in rough order (C, ordering follows the survey's suggested order, survey 3.6):

- Sandbox enforcement of the manifest `sandbox` field (landlock or bwrap wrapper) (C).
- Frontend protocol extraction and P2 events, which wire plugin frontends into the daemon (C: `t3-integration.md` section 6 step 1 is the prerequisite, M on its dependency analysis).
- Store and Dispatcher protocol extraction, making full providers plugin-able (C).
- Tier 1 numeric tuning with TPE/CMA-ES over the section 2.1 knobs, gated on bench noise-floor runs first (C: survey 3.6 step 2 and its gating rule, stop where gains do not beat noise).
- Release signing with a pinned key for update verification (C).
- Anything resembling an autonomous improvement loop: rejected for v0.1.0 and 0.x entirely, per the survey (M: survey section 2 rejects whole-system self-rewrite; personal workload cannot feed the statistical budget, M: survey TL;DR, ~400 tasks per arm).

Gating rationale in one paragraph: v0.1.0 gates exactly the surfaces that are usable with today's code (a frontend/hook/resume executable can be written and run now, M: the loader and fan-out exist) and the update path a binary-only user needs to stay current; everything gated post-1.0 requires an unbuilt prerequisite (P2 events for frontend wiring, protocol extraction for provider swap, noise-floor bench runs before any optimizer, M: `t3-integration.md` sections 2 and 6 for both dependency chains). The one thing that gates nothing and is excluded permanently: loop-driven mutation of the protected layer, which is not a version question (M: survey section 4.3 hard rules; this is the survey's protected-layer conclusion applied as policy, not a roadmap item).

## Claims summary

M: plugin/config/XDG path resolution (`paths.py`), zero-dependency runtime (`pyproject.toml`), single ACP dispatch path (`daemon.py`), bench artifacts in-tree, scriptc binaries and release-asset workflow (ARCHITECTURE P1), all survey quotations and arXiv references as read in `research/self-improving-stack.md`, the scaffold built in this task. C: everything in sections 1.2 to 1.5 beyond the built loader, the config bounds, the entire update command, the post-1.0 ordering, and the trust-level argument in 1.4.
