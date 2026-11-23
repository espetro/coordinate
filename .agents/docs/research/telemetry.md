# Telemetry: prior art and design for coordinate

Date: 2026-11-22 (ran `date`). Scope: how established CLIs run opt-out telemetry, what PostHog needs for a small Python CLI and daemon, and a privacy contract, event catalog, dashboards and implementation sketch for `coordinate`. Read with `.agents/docs/orchestrator-framing.md` (requirements, memory budget) and `.agents/docs/research/observability.md` (local `events` table, Layer 0). `ARCHITECTURE.md` already lists a Telemetry module with interface `record`, `flush`, `status` and slots it into P2.

Evidence tags: M = measured by us, R = read in the project's own docs or source, B = blog or marketing claim, K = from memory, unverified. Sources were fetched on 2026-11-22. No event was sent to PostHog or any other analytics service while writing this.

## 0. Answers up front

- The PostHog key `phc_...` is a project token. PostHog's own privacy FAQ: "It is ok for your project token (starts with `phc_`) to be public. It is used to initialize PostHog, capture events, evaluate feature flags, and more, but doesn't have access to your private data" (R, `posthog.com/docs/privacy`). Capture endpoints are "public POST-only endpoints" that "do not return any sensitive data" (R, `docs/api/capture`). GitHub secret scanning rotates `phx_`, `phs_`, `pha_` and `phr_` keys, not `phc_` (R, `docs/api`). Safe to embed. The one cost: anyone can read it from the wheel and send fake events into the project, so dashboards must tolerate junk (filter on `$lib = coordinate` and known versions).
- US or EU: it cannot be told from the key, and a test send is not allowed. It also cannot be told from a send: capture returns `200` with `ok` for every event when a well-formed token does not match a project on that host, "but nothing is stored" (R, `docs/api/capture-v1`). So a wrong host fails silently. The author must open the project in the PostHog UI and check whether the URL is `us.posthog.com` or `eu.posthog.com` before the first release. Default in code: `https://us.i.posthog.com`, overridable.
- Use a raw HTTP call with the standard library, not `posthog-python`. Importing `posthog` 8.1.0 cost about 26MB max RSS and 130ms; `urllib.request` plus `ssl` cost about 9.5MB and 31ms (M, section 5.1). `posthog` also pulls in `requests`, `urllib3`, `idna`, `certifi`, `charset-normalizer` and `distro`, none of which coordinate has today (R, PyPI metadata and `uv.lock`).
- Send aggregated daily summaries plus a handful of rare lifecycle events, from the daemon only, never from the CLI path. This keeps volume around 2 to 5 events per device per day, well inside PostHog's free tier of 1,000,000 events per month (R, `posthog.com/pricing`), and it is the main privacy control: per-job events would leak a work timeline.
- The weakest point is not the code, it is the audience. With about 10 colleagues, "anonymous" data about agent-hours per install is close to per-person productivity data, and for EU colleagues ePrivacy Article 5(3) most likely requires consent for this kind of access regardless of whether the data is personal (section 6). Default-on is defensible only with the safeguards below, and the design keeps an opt-in switch ready.

## 1. Prior art

### 1.1 Table

| Tool | Default | Notice style | Opt-out mechanisms | What they collect | What they say they never collect |
|---|---|---|---|---|---|
| Next.js | On | Printed once per machine on first run: "Attention: Next.js now collects completely anonymous telemetry regarding usage. This information is used to shape Next.js' roadmap and prioritize features. You can learn more, including how to opt-out if you'd not like to participate in this anonymous program, by visiting the following URL: https://nextjs.org/telemetry". Records `telemetry.notifiedAt`; "We will re-inform users about the telemetry if significant changes are ever made" (R, `telemetry/storage.ts`) | `next telemetry disable|enable|status`, `NEXT_TELEMETRY_DISABLED=1`; `NEXT_TELEMETRY_DEBUG=1` prints to stderr prefixed `[telemetry]` and does not send (R) | Command, version, CPUs, OS, CI flag, plugins present, build duration, page count, MCP tool names and counts, opt-in error feedback (error code only) (R, `nextjs.org/telemetry`) | Env vars, file paths, file contents, logs, serialized errors (R) |
| Next.js ids | | | | `anonymousId` = 32 random bytes; `sessionId` per process; `projectId` = SHA-256 of a local random 16-byte salt plus `git config --get remote.origin.url` (fallback `REPOSITORY_URL`, then cwd). "This salt value is never sent to us" (R, `storage.ts`, `project-id.ts`). In CI or Docker the store lives in the build cache. Delivery: 5s abort timeout, flush in a detached child process at exit (R) | | | |
| Vercel CLI | On | Not stated on the docs page | `vercel telemetry disable|enable|status` (global config), `VERCEL_TELEMETRY_DISABLED=1` (per run, does not change stored status), `VERCEL_TELEMETRY_DEBUG=1` prints after `['telemetry']: Flushing Events` and does not send (R) | Command, CLI version, CPUs, OS, CI flag, "identifiers associated with your account" (R) | Env vars, file paths, file contents, logs, serialized errors (R). Not anonymous: tied to the account |
| Turborepo | On | First-run notice (K) | `turbo telemetry disable|enable|status`, `TURBO_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`; `TURBO_TELEMETRY_DEBUG=1`; every possible event is a file in `crates/turborepo-telemetry/src/events` (R) | Command, version, CPUs, OS, CI flag, workspace count, "random identifiers" (R) | Task names, package names, sensitive argument or flag values, env vars, file paths, file contents (R) |
| vercel-labs `skills` | On | README section only (R) | `DISABLE_TELEMETRY=1` or `DO_NOT_TRACK=1`, which also disable security-audit requests (R, `docs/troubleshooting.md`) | Anonymous usage; repo and skill identifiers only for repos GitHub confirms are public; other source types "may include source and skill identifiers" (R) | "No personal information" (R) |
| Homebrew | On | Notice shown "before analytics are enabled so a user can opt out before sending an event" (R) | `brew analytics off|state`, `HOMEBREW_NO_ANALYTICS=1`. `HOMEBREW_ANALYTICS_DEBUG=1` prints and still sends: "Debug mode is not an opt-out mechanism" (R) | Package and public tap names, install options, CI and developer mode flags, arch, OS major, version, default prefix or `custom-prefix`, command and option names with values stripped, a randomly sampled config variable name and whether it is unset, default or non-default (R) | "The analytics payload does not contain a user identifier or an IP-address field"; no build logs or exception details. Retention 365 days, public aggregates at formulae.brew.sh. Sent from a detached background process with a short timeout, failures silent (R, `docs.brew.sh/Analytics`) |
| Astro | On | Notice once per machine, skipped in CI and when disabled; re-shown when the stored notice date is older than `VALID_TELEMETRY_NOTICE_DATE` (R, `packages/telemetry/src/index.ts`) | `astro telemetry disable|enable` (machine-wide), `ASTRO_TELEMETRY_DISABLED=1`, also the generic `TELEMETRY_DISABLED`; `DEBUG=astro:telemetry` logs only (R) | Command, version, CPUs, OS, CI, which AI coding agent invoked the CLI, integrations and adapters, sanitized errors, toolbar usage. All CI runs share one id `CI.<ciName>` "because every CI session also creates a new user, which blows up telemetry" (R) | Env vars, PII, file paths, file contents, logs, stack traces, git remote, unsanitized errors; never sold (R) |
| Nuxt | Asks | "You will be asked on first time to get permission" (R, `nuxt/telemetry`) | `telemetry: false` in config, `NUXT_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, `@nuxt/telemetry status|enable|disable [-g]`; `NUXT_TELEMETRY_DEBUG=1` (R) | Command, Nuxt and Node versions, OS, CI name, build duration and size, public Nuxt modules; ids "using hash+seed" (R) | Env vars, file paths, file contents, logs, serialized errors (R) |
| Gatsby | On | Notified at install and at first run (R) | `gatsby telemetry --disable`, `GATSBY_TELEMETRY_DISABLED=1`; `GATSBY_TELEMETRY_DEBUG=1` prints instead of sending (R) | Timestamp, command, machine id (UUID in `~/.config/gatsby/config.json`), session id per run, one-way hash of cwd or git remote, OS, arch, CI, version, errors after stripping (R) | Secrets in env, logs and errors are stripped (R) |
| Go toolchain | Local only | None needed for the default; gopls may prompt to opt in (R) | `go telemetry off|local|on`. `local` (default) collects counters on disk and never uploads; `on` uploads weekly reports (R, `go.dev/doc/telemetry`) | Counters approved by a public review, randomly sampled once enough users opt in, published at telemetry.go.dev (R) | Anything not in the reviewed upload config (R) |
| Deno | No usage telemetry found | n/a | `DENO_NO_UPDATE_CHECK` for the update check; OTel export is user-configured (R, env var reference lists no telemetry switch) | Update check only | n/a |
| Bun | On | None found | `telemetry = false` in `bunfig.toml`, "equivalent to the `DO_NOT_TRACK` environment variable" (R); source checks `DO_NOT_TRACK` in analytics and in the crash handler (R, `src/analytics/lib.rs`, `src/crash_handler/lib.rs`) | "We do not currently collect telemetry; this setting only controls anonymous crash reports" (R) | Not stated |
| Claude Code | Metrics on (Claude API), off on Bedrock, Vertex, Foundry | Not stated | `DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`; `DO_NOT_TRACK` documented as disabling the session survey (R, `code.claude.com/docs/en/data-usage`) | Metrics: latency, reliability, usage patterns. Error reports (Pro, Max, Ultra, v2.1.198+): messages and stack traces of Claude Code internals with secrets, paths and emails redacted (R) | "Metrics never include your code, prompts, or file paths" (R) |
| Codex | Client default (not stated in docs) | Not stated | `analytics.enabled = false` disables the built-in Statsig metrics exporter; `otel.metrics_exporter = none`; telemetry keys cannot be set by project-local config; prompt text in OTel logs only with `otel.log_user_prompt` (R, `developers.openai.com/codex/config-reference`) | Statsig metrics (content not documented on that page) | Prompts unless opted in (R) |
| OpenCode | No product telemetry switch found | n/a | Config docs list none (R); OTel logs and traces only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (R, `packages/cli-rs/parity/deviations/G11-telemetry.md`) | User-directed OTel only | n/a |
| `DO_NOT_TRACK` | Convention | n/a | `DO_NOT_TRACK=1` should disable ad tracking, usage reporting "anonymous or not", telemetry, crash reporting and non-essential requests; it asks authors to "consider making telemetry opt-in" (R, `donottrack.sh`; the original consoledonottrack.com text, archived 2024, also covered update phone-home and warned that "an IP address is a physical location") | n/a | n/a |

Note on the convention: `consoledonottrack.com` now serves an unrelated page about dogs (M, fetched 2026-11-22). Link to `donottrack.sh` or the archived copy, not the original domain.

### 1.2 Patterns worth copying

- A single `telemetry status|enable|disable` subcommand that writes a machine-wide setting, plus a tool-specific env var that disables per run without changing the stored setting (Vercel, Turborepo, Astro, Next.js).
- A debug mode that prints the exact payload and does not send (Next.js, Vercel, Gatsby, Turborepo). Homebrew's debug mode sends anyway; avoid that trap.
- The event list lives in the repo as code that reviewers can diff (Turborepo's events directory, Go's reviewed upload config).
- Nothing is sent before the notice has been shown (Homebrew).
- Re-show the notice when the collected data changes materially (Next.js comment, Astro's notice date).
- Collapse or disable CI (Astro collapses, most others treat CI as a property). For coordinate, CI is the bench and test suite, so disable outright.
- Hash anything project-shaped with a local salt that never leaves the machine (Next.js). For coordinate the better answer is to not send project identity at all.
- Detached or bounded delivery with silent failure (Homebrew, Next.js 5s abort).
- Go's local-first model: collect locally by default, upload only when allowed. coordinate already has the local half (the events table), which makes this model cheap to adopt if default-on is rejected.

## 2. PostHog for a Python CLI and daemon

### 2.1 Endpoint and payload

- Capture v1 is the current API: `POST https://us.i.posthog.com/i/v1/analytics/events` (EU: `https://eu.i.posthog.com`), token in `Authorization: Bearer <phc_...>`, required headers `Content-Type`, `User-Agent`, `PostHog-Sdk-Info: coordinate/<version>`, `PostHog-Request-Id` (same UUID on every retry), `PostHog-Attempt`, `PostHog-Request-Timestamp` (R, `docs/api/capture-v1`). The legacy `/batch` and `/i/v0/e` endpoints still work but PostHog plans to retire them (R). The Python SDK moved to v1 in 8.0.0 (R, `docs/libraries`).
- Body: `created_at`, `batch[]`; each event needs `event` (up to 200 bytes), `uuid` (UUIDv7 recommended, keep it on retry; duplicates in one request are dropped), `distinct_id` (up to 200 bytes, string), `timestamp` (RFC 3339 with milliseconds), optional `options` and `properties` (R).
- Anonymous events: `options: {"process_person_profile": false}` (legacy property `$process_person_profile: false`) with a random distinct id. Anonymous events "can be up to 4x cheaper". They support trends, funnels and SQL; they do not support person properties, cohorts, Lifecycle insights or group analytics (R, `docs/data/anonymous-vs-identified-events`). Retention is not listed either way; check it works on the real project before relying on it (K).
- GeoIP: the Python SDK defaults `disable_geoip=True` (R); a raw call must set `"$geoip_disable": true` itself. PostHog still sees the client IP. Turn on project setting "Discard client IP data" so `$ip` is not stored; GeoIP transformations can still use the IP before it is discarded, so also leave the GeoIP transformation off (R, `docs/privacy/data-storage`).
- Limits: 10MB per request as sent on the analytics endpoint, about 1MB per event, no request-level rate limit on public capture endpoints (R).
- Responses and retries: `200` with per-event results (retry only events marked `retry`); `400`, `401`, `402`, `413`, `415` are not retryable; `404`, `408`, `429` (honor `Retry-After`), `5xx` are retryable (R). `402` means the project is over its billing quota and nothing was stored (R).
- Clock: PostHog corrects client clock skew from `PostHog-Request-Timestamp`; `options.disable_skew_correction` keeps timestamps as sent unless more than 23h in the future (R). Daily summaries are backdated by design, which skew correction handles correctly because it uses the request timestamp, not the event age (K, verify on first real batch).

### 2.2 SDK or raw call

| | `posthog-python` 8.1.0 | stdlib `urllib.request` |
|---|---|---|
| Dependencies added | `requests` (and `urllib3`, `idna`, `certifi`, `charset-normalizer`), `distro`, `typing-extensions` (R, PyPI) | none |
| Import cost | +26MB max RSS, about 130ms (M) | +9.5MB, about 31ms, mostly `ssl` (M) |
| Process model | Background consumer thread(s), `flush_interval` 5s, `flush_at` 100, `max_queue_size` 10,000, `timeout` 15s, `shutdown()` needed before exit (R) | Whatever we write: one call per flush |
| Offline | In-memory queue, lost on exit | Our SQLite outbox survives restarts |
| Wire format kept current | Yes | Ours to maintain (one endpoint, about 60 lines) |

Decision: raw call. The daemon already has a durable store and a tick; the SDK's in-memory queue and threads duplicate it and lose events on kill -9. The only thing the SDK buys is tracking wire-format changes, which a payload snapshot test plus a release checklist item covers.

TLS: with uv-managed Python on macOS, `ssl.get_default_verify_paths()` points at `/private/etc/ssl/cert.pem` and an HTTPS request verified fine (M, cpython 3.12.16 standalone and mise 3.14.10). Linux distributions differ; check on the VPS in the release checklist. A TLS failure must count as a send failure, never fall back to unverified TLS.

## 3. Privacy contract for coordinate

This is the text the public `TELEMETRY.md` and the code both follow. Anything not listed here is not sent.

### 3.1 Identity

- `install_id`: a random UUIDv4 generated with `uuid.uuid4()` the first time telemetry is allowed to record, stored in `~/.coordinate/telemetry.json`. Never derived from hardware, MAC address, hostname, username, serial number or the machine-id file. Used as PostHog `distinct_id`.
- `fleet_id`: optional, a random UUIDv4 minted by the hub device when multi-device is configured and copied to spokes over the connector. Sent as an event property only, so "devices per user" is countable without a person profile. Never sent on a standalone install.
- `telemetry disable` deletes `install_id` and empties the outbox. A later `enable` creates a new id. Opting out therefore also unlinks past data from future data.
- No person profiles (`process_person_profile: false`), no `$identify`, no aliasing, no GitHub login, email or account id, ever.

### 3.2 Never collected

Prompts, model outputs, transcripts, tool calls and their arguments, file paths (including cwd and worktree paths), repo names, remote URLs, branch names, hashed or salted versions of any of these, hostnames, device names from config (`kinosmac` and the like), usernames, environment variable names or values, command lines and arguments of enqueued jobs, job ids, session ids, ACP session ids, exception messages, stack frames outside the `coordinate` package, IP address (discarded at the project, see 2.1), timezone, locale.

### 3.3 Collected, and in what shape

- Versions and platform: coordinate version, Python minor version, OS family (`darwin`, `linux`), OS major version, CPU arch, service manager (`launchd`, `systemd`, `none`).
- Enumerations from fixed allowlists in code: harness (`claude-code`, `codex`, `opencode`, `cursor`, `devin`, `kimi`, `maki`, `gemini`, `other`), dispatcher (`acp`, `tmux`), provider (`anthropic`, `openai`, `google`, `other`), await kind (`human`, `agent`, `resource`, `external`), job source (`cli`, `t3`, `agent`, `hub`), CLI command names, feature names, component names. Any value not in the list is sent as `other`.
- Numbers only as buckets. Counts: `0`, `1`, `2-3`, `4-7`, `8-15`, `16-31`, `32-63`, `64-127`, `128-255`, `256+`. Durations: `<1s`, `1-5s`, `5-30s`, `30s-2m`, `2-10m`, `10-30m`, `30m-2h`, `2-8h`, `8h+`. Memory: powers of two in MB (`<16`, `16-31`, ..., `1024+`). Configured cap values are small integers and are sent as is, clamped to `16+`.
- Time: daily summaries carry the UTC date they describe with the timestamp set to 00:00 UTC of that date. Lifecycle events are rounded down to the hour. No time-of-day pattern of work leaves the machine.
- Errors: exception class name, and the location as `module:function` inside the `coordinate` package only, without line numbers (line numbers change every release and add nothing for grouping across versions); frames outside the package collapse to `<external>`. No message text.

### 3.4 Switches and precedence

Evaluated in this order; the first match wins:

1. `DO_NOT_TRACK` set to anything other than empty, `0` or `false`: off.
2. `COORDINATE_TELEMETRY_DISABLED` set (same truthiness): off for this process, stored setting unchanged.
3. CI detected (`CI`, `GITHUB_ACTIONS`, `BUILDKITE`, `GITLAB_CI`, `CIRCLECI`, `JENKINS_URL`, `TF_BUILD`): off.
4. Test runs (`PYTEST_CURRENT_TEST` set, or `COORDINATE_TELEMETRY_SINK=fake`): never reaches the network sink.
5. `[telemetry] enabled = false` in `~/.coordinate/config.toml` (for people who manage config by hand) or `telemetry disable` stored in `telemetry.json`: off.
6. Notice not yet shown to a human: nothing is recorded or sent (3.5).
7. Otherwise on.

Commands:

- `coordinate telemetry status`: prints on or off and the reason (which rule above decided), install id, host, notice date, outbox size, last successful send.
- `coordinate telemetry enable` and `disable`: write the stored setting; `disable` deletes the id and the outbox.
- `coordinate telemetry preview`: prints the next batch exactly as it would be sent, as JSON, and sends nothing.
- `coordinate --debug <command>` and `COORDINATE_TELEMETRY_DEBUG=1` (for the daemon under launchd or systemd): print each event to stderr prefixed `[telemetry]` as it is recorded, and replace the network sink with a print sink, so nothing is sent while debugging.
- Config: `COORDINATE_TELEMETRY_HOST` or `[telemetry] host` to switch region or point at a self-hosted PostHog; default `https://us.i.posthog.com`.

### 3.5 First-run notice

Shown once, to stderr, only when stdin and stderr are both TTYs, `COORDINATE_JOB_ID` (and `FLEET_JOB_ID`) is not set, and no switch above has turned telemetry off. Always shown by `coordinate service install`, which is the one command a human is certain to run interactively. Recording it writes `notice_shown_at` and `notice_version` into `telemetry.json`. Nothing is sent on the run that shows the notice. When `notice_version` in code is bumped (the data collected changed materially), the notice is shown again and sending pauses until it has been.

Why the gating matters: most coordinate invocations come from agents (`status --self`), T3 and launchd. A notice printed into an agent's tool output is not a notice to a person. If the only invocations are non-interactive, telemetry stays silent forever, which is the safe failure.

Draft text:

```
coordinate sends pseudonymous usage statistics to its author, to decide what to fix and build next.

Sent: coordinate version, OS, which harnesses you use, counts and durations rounded into ranges,
error types with the location in coordinate's own code, and a random ID created on this machine.
Never sent: prompts, model output, file paths, repo or branch names, hostnames, usernames,
environment variables, or the commands your jobs run.

Nothing has been sent yet. See exactly what would be sent:  coordinate telemetry preview
Turn it off:                                                coordinate telemetry disable
Or set DO_NOT_TRACK=1. Details: https://github.com/<owner>/coordinate/blob/main/TELEMETRY.md
```

The word "pseudonymous" is deliberate. A stable random id plus a request IP is not anonymous in the GDPR sense (section 6), and colleagues who know that will distrust a notice that says "completely anonymous".

## 4. Event catalog

Design rule: one daily summary per device carries almost everything; discrete events exist only for things that happen rarely and matter on their own (lifecycle, first use, errors, recovery). Every event has `version`, `os`, `os_major`, `arch`, `py`, `$lib = coordinate`, `$lib_version`, `$geoip_disable = true`, and `fleet_id` when present. "Ops" means it serves operational decisions (what to fix, what to build, reliability); "Biz" means it serves business-style questions (adoption, retention, workload, ROI proxies).

### 4.1 Lifecycle and activation

| Event | Properties | Question it answers | Use |
|---|---|---|---|
| `install_created` | `install_method` (`uv-tool`, `other`), `service_manager` | How many devices installed coordinate this week, on which OS? Which OS versions must P1 support? | Biz (installs), Ops (platform support) |
| `daemon_started` | `previous_exit` (`clean`, `crash`, `unknown`), `previous_version` (only when different), `uptime_prev` (duration bucket), `recovered_jobs` (count bucket), `role` (`standalone`, `hub`, `spoke`) | How often does the daemon die uncleanly, per version? How fast do people upgrade? Do people run it as a service or by hand? | Ops (crash rate, release health), Biz (upgrade adoption) |
| `feature_first_used` | `feature`: `first_job_done`, `first_park_wake`, `first_ratelimit_park`, `first_timecap_override`, `toolcaps`, `wait_on`, `why`, `events_query`, `multi_device`, `presence_levels`, `t3_source` | Which features do people reach at all, and in what order? Where does the activation funnel drop? | Ops (what to build or document), Biz (activation) |

`feature_first_used` fires once per install per feature, tracked by a set in `telemetry.json`.

### 4.2 Daily summary

One `daily_summary` per device per UTC day in which the daemon ran, built from the local `events` table at the first tick after 00:00 UTC (the info retention of 14 days covers a device that was off for a while; a day older than that is skipped, not estimated).

| Property group | Properties | Question it answers | Use |
|---|---|---|---|
| Activity | `active` (bool: at least one job enqueued), `cli_commands` (map command to count bucket), `job_sources` (map source to count bucket) | MAU and WAU: unique installs with `active = true`. Which commands are used, which are dead weight? How much work comes from T3 versus agents versus the CLI? | Biz (MAU, WAU), Ops (command surface) |
| Workload | `jobs_enqueued`, `jobs_done`, `jobs_failed`, `jobs_dead`, `jobs_cancelled` (count buckets) | How big is a typical day? Is the failure or dead-letter rate rising in a version? | Biz (workload size), Ops (reliability) |
| Harness mix | `harness_jobs` (map harness to count bucket), `dispatcher_jobs` (map `acp`, `tmux` to count bucket) | Which harnesses must the dispatcher support first? Is the tmux fallback used in practice? | Ops (dispatcher priorities), Biz (harness mix) |
| Concurrency | `cap` (configured device cap), `live_peak` (count bucket), `parked_peak` (count bucket), `minutes_at_cap` (duration bucket, at or above 80% with jobs queued) | How many agents run per device? Is the default cap wrong (always at cap, or never near it)? | Biz (agents per device), Ops (default cap, cap pressure) |
| Waiting | `parks_by_kind` (map await kind to count bucket), `wake_latency_p50`, `wake_latency_p90` (duration bucket, event to first output), `queue_wait_p50`, `queue_wait_p90` (duration buckets) | Is parking used, and for what? Is wake latency acceptable in the field, not only on the bench? Are jobs stuck in the queue? | Ops (park and wake quality, P3 priorities) |
| Rate limits | `ratelimit_parks` (map provider to count bucket), `ratelimit_reset_unknown` (count bucket), `ratelimit_woke_late` (count bucket, woke more than 60s after reset) | Which providers throttle people, and does rate-limit parking wake on time? | Ops (quota-aware scheduling) |
| Time caps | `jobs_timed_out` (count bucket), `timeout_cap_sizes` (map max_runtime bucket to count bucket), `runtime_used_p90` (fraction bucket: `<25%`, `25-50%`, `50-75%`, `75-100%`) | Are default caps mis-sized? Do jobs time out at a specific cap size? | Ops (default `max_runtime`), Improver priors |
| Throughput proxies | `agent_hours` (duration bucket of summed live runtime), `parked_hours` (summed parked time, the slot time freed), `away_agent_hours` (live runtime while presence was `away` or `overnight`), `no_touch_jobs` (count bucket of jobs done with no human await) | How much agent work does coordinate run for someone, how much of it happens while they are away, and how much slot time does parking free? | Biz (time saved and throughput as ROI proxies) |
| Health | `daemon_rss_peak` (MB bucket), `events_db_mb` (MB bucket), `tick_slow_count` (count bucket), `telemetry_dropped` (count bucket) | Does the daemon stay inside the 200-300MB budget in the field? Does the events table GC keep up? Is the outbox losing data? | Ops (footprint, requirement 1) |
| Devices | `role`, `fleet_devices` (count, clamped `8+`, hub only) | How many devices per person (per `fleet_id`)? Is multi-device worth P4? | Biz (devices per user), Ops (P4 priority) |

The ROI proxies are proxies. `away_agent_hours` says work ran unattended, not that it was useful; `parked_hours` says slots were freed, not that they were reused. Present them as "agent-hours run" and "slot-hours freed", never as "hours saved".

### 4.3 Errors and recovery

| Event | Properties | Question it answers | Use |
|---|---|---|---|
| `error_raised` | `component` (`daemon_tick`, `dispatcher_acp`, `dispatcher_tmux`, `scheduler`, `connector`, `cli:<command>`, `telemetry`), `exc_class` (`ValueError`, `sqlite3.OperationalError`, our own class names), `location` (`coordinate.module:function` of the innermost frame in our package), `handled` (bool), `count` (count bucket of repeats that day) | Which bugs hit the most installs? Did a release introduce a new error fingerprint? | Ops (bug triage) |
| `job_quarantined` | `reason` (`crash_loop`), `harness`, `dispatcher` | How often does a job kill the daemon repeatedly, and with which harness? | Ops (poison job handling) |
| `readoption_outcome` | `previous_exit`, `adopted` (count bucket), `resumed_via_load` (count bucket), `orphan_killed` (count bucket), `lost` (count bucket), `duplicate_turns` (count bucket) | Does P3 re-adoption reach 0 duplicate turns in the field, as the bench says? | Ops (reliability, P3 validation) |

`error_raised` is deduplicated: at most one event per (`component`, `exc_class`, `location`) per day, with `count` carrying the repeats. PostHog's `$exception` event and Error Tracking product are an alternative with better grouping UI, but its schema expects stack frames and messages; a custom event keeps the allowlist simple.

### 4.4 Not collected, on purpose

Per-job events, per-CLI-invocation events, model names (users configure private or fine-tuned names), token counts and cost (they are a harness concern and close to spend data), cap changes in real time, presence transitions (a timeline of when someone is at their desk), opt-out events (sending an event when someone says "stop sending" is the wrong reflex).

## 5. Dashboards and how the data is used

### 5.1 Measurements behind section 2.2

macOS 27.2 on Apple M4, load average 1.6 to 2.0, three runs each with `uv run --no-project` and Python 3.14 (M): bare interpreter 16.6MB max RSS; `import urllib.request, json, gzip, uuid, ssl` plus `ssl.create_default_context()` 26.0 to 26.3MB, 31 to 42ms; `import posthog` plus constructing a disabled client 42.5MB in two runs and 54.9MB in one, 128 to 622ms. Max RSS on macOS is in bytes from `getrusage`; numbers are indicative, not a bench result.

### 5.2 PostHog insights

| Dashboard | Insight | Definition | Question |
|---|---|---|---|
| Adoption | WAU and MAU | Trends, unique `distinct_id` on `daily_summary` where `active = true`, weekly and monthly | Is anyone using it, and is that growing? |
| Adoption | New installs | Trends, count of `install_created` per week, broken down by `os` | Where is growth coming from, which OS to test first? |
| Adoption | Version spread | Trends, unique installs on `daily_summary` broken down by `version` | How long do old versions linger? When can a migration path be dropped? |
| Activation | Funnel | `install_created` then `feature_first_used(first_job_done)` within 7 days, then `feature_first_used(first_park_wake)` within 14 days, then `feature_first_used(multi_device)` within 30 days | Where do new installs stall? A drop at step 2 is an install or docs problem, at step 3 parking is not understood or not needed, at step 4 multi-device is not worth it yet |
| Retention | Weekly retention | Retention insight, start event `install_created`, return event `daily_summary` with `active = true` | Do people keep using it after week 1? (verify retention works on anonymous events, 2.1) |
| Reliability | Crash rate | `daemon_started` with `previous_exit = crash` divided by all `daemon_started`, by `version` | Is this release worse than the last one? |
| Reliability | Top errors | `error_raised` unique installs, broken down by `exc_class` and `location`, last 14 days | Which bug to fix first (by installs affected, not raw count) |
| Reliability | Recovery | `readoption_outcome` sum of `duplicate_turns` and `lost` buckets by version | Did P3 land in the field? |
| Scheduler | Cap pressure | Distribution of `minutes_at_cap` and `live_peak` versus `cap` | Is the default cap right? |
| Scheduler | Wake and queue | `wake_latency_p90` and `queue_wait_p90` distributions by version and dominant harness | Is wake latency a field problem or only a bench number? |
| Scheduler | Rate limits | `ratelimit_parks` by provider, `ratelimit_woke_late` | Is quota-aware scheduling worth more work, and for which provider? |
| Workload | Harness and dispatcher mix | Share of `harness_jobs` and `dispatcher_jobs` | Which dispatcher paths get the next round of work |
| Workload | ROI proxies | Sums of `agent_hours`, `away_agent_hours`, `parked_hours`, `no_touch_jobs` (bucket midpoints) per active install per week | What is the "agent-hours run unattended per person per week" number for a pitch, with its caveats |
| Workload | Devices per fleet | Unique `distinct_id` per `fleet_id` on `daily_summary` | Do people run more than one device? |

Bucket arithmetic: sums and medians of buckets use the bucket midpoint (the top bucket uses its lower bound) and are labelled as estimates. With 10 to 50 installs, show raw distributions rather than percentiles; percentiles over a dozen points mislead.

### 5.3 Feeding the bench and the Improver

- Bench realism: the field distributions of `harness_jobs`, park ratio (`parks_by_kind` against `jobs_done`), `live_peak`, `cap` and `jobs_enqueued` set the parameters of the bench's job mix (`bench/bench.py` scenarios), so the regression gate measures workloads people actually run instead of synthetic ones. Revisit quarterly.
- Field versus bench: `wake_latency_p90`, `daemon_rss_peak` and `duplicate_turns` per version are the field counterparts of bench metrics in `bench/baseline-linux.json`. A field regression that the bench did not catch means a missing bench scenario; add it before fixing the bug.
- Improver priors, not Improver inputs: the Improver (framing Assessment 8) tunes per device on the local `events` table, which has full fidelity and never leaves the machine. Telemetry only informs shipped defaults (default cap, default `max_runtime` per job kind, stall thresholds) and checks whether a default change helped across installs, by comparing version cohorts. The Improver must never read PostHog: it would make a remote, bucketed, junk-injectable dataset part of the immutable evaluator.
- Bug pipeline: an `error_raised` fingerprint seen on 2 or more installs becomes a GitHub issue with the fingerprint in the title; the local `coordinate events --kind error` on the author's device supplies the full detail, since telemetry never carries messages.

## 6. Implementation sketch

### 6.1 Module layout

- `coordinate/telemetry/__init__.py`: public interface `record(event, **props)`, `flush(now)`, `status() -> Status`, `enable()`, `disable()`, `preview() -> list[dict]`, `maybe_show_notice(stream)`.
- `coordinate/telemetry/settings.py`: precedence rules of 3.4, CI detection, `telemetry.json` read and atomic write (`os.replace`), notice version constant.
- `coordinate/telemetry/schema.py`: the allowlist. One dict maps each event name to its properties and their kind (`enum` with allowed values, `bucket` with a bucketing function, `bool`, `small_int`). `record` validates against it; unknown properties are dropped and counted, unknown enum values become `other`, any raw string that is not an allowed enum value is refused. This file is the reviewed contract, like Turborepo's events directory.
- `coordinate/telemetry/buckets.py`: `count_bucket`, `duration_bucket`, `mb_bucket`, `fraction_bucket`.
- `coordinate/telemetry/rollup.py`: builds `daily_summary` and `feature_first_used` from the `events` table with SQL over one UTC day.
- `coordinate/telemetry/sink.py`: `Sink` protocol with `send(batch) -> Result`; `HttpSink` (urllib, gzip, capture v1), `PrintSink` (debug), `FakeSink` (tests, keeps batches in a list), `NullSink`.

A single `telemetry.py` file is fine for the first slice; the split above is where it ends up once the schema grows.

### 6.2 Storage

A `telemetry_outbox` table in the existing `queue.db`: `id INTEGER PRIMARY KEY, uuid TEXT UNIQUE, event TEXT, ts TEXT, props TEXT, attempts INTEGER DEFAULT 0, next_try REAL`. Rows are written in the same transaction as the state change or by the rollup. Caps: 2,000 rows and 14 days, oldest dropped first, drops counted into the next `telemetry_dropped`. Nothing about telemetry is stored in daemon memory, so kill -9 loses nothing and resends nothing (UUIDs dedupe a batch that was sent but not acknowledged).

### 6.3 Send path

Chosen: daemon only. Each daemon tick calls `telemetry.flush(now)`, which returns immediately unless the outbox has 50 or more rows or the last attempt was more than an hour ago. When due, it hands one batch (at most 500 events) to a single long-lived worker thread so the tick never blocks on the network. The worker posts with `urllib.request.urlopen(req, timeout=3)`, gzip body, the capture v1 headers, and writes results back: `ok` deletes rows, `retry` and retryable statuses bump `attempts` and set `next_try` with exponential backoff from 1 hour to 24 hours, non-retryable statuses delete the batch and count it as dropped. `PostHog-Request-Id` and event UUIDs stay the same across retries.

Rejected: best-effort send on CLI exit with a 1s timeout. Agents call `coordinate status --self` and similar commands often, and up to 1s added to each of those calls is a direct cost to every running agent; the CLI also cannot retry. The CLI only writes counters into the `events` table (it already must, for `cli_commands`), and the daemon's rollup turns them into the daily summary. Without a daemon, nothing is sent, which is acceptable because coordinate without its daemon dispatches nothing. `coordinate telemetry flush` exists for the author to test against a self-hosted or throwaway project.

Not built: no remote configuration, feature flags or kill switch fetched from PostHog. Each would be another phone-home. A future version can stop sending by shipping code.

### 6.4 Failure behavior

- Every exception inside telemetry is caught at the module boundary, recorded locally as a debug-level `telemetry.send_failed` event (never sent), and never propagates to the scheduler or the CLI.
- Offline: rows wait in the outbox under the caps; nothing retries faster than the backoff.
- Wrong region or wrong project: indistinguishable from success (2.1). `telemetry status` prints the host so a colleague can see where data goes.
- `402` (quota): drop and back off 24 hours; do not keep the outbox growing for a project that will not store it.
- Memory: the worker thread and `ssl` cost about 10MB (M, 5.1) inside a daemon measured at 18.5MB fixed overhead (framing, Assessment 9). Import `ssl` lazily on first send so a daemon with telemetry off pays nothing.

### 6.5 Tests

- An autouse fixture in `tests/conftest.py` sets `COORDINATE_TELEMETRY_SINK=fake` and monkeypatches `urllib.request.urlopen` and `socket.create_connection` inside the telemetry module to raise, so any accidental network path fails the test instead of sending. `AGENTS.md` already requires this ("Telemetry must never send from tests or CI: tests use a fake sink").
- Precedence: a table test over `DO_NOT_TRACK` values (`1`, `true`, `0`, empty, unset), `COORDINATE_TELEMETRY_DISABLED`, each CI variable, config `enabled = false`, stored disable, notice not shown.
- Notice: shown only with both TTYs and no job id; shown once; re-shown after a `notice_version` bump; nothing recorded before it.
- Schema: property-based test (Hypothesis, or a loop over generated strings) that any string value not in an enum is refused; a test that feeds a path, a hostname and an env value into every string property and asserts none appears in the serialized batch.
- Buckets: boundaries for each bucket function.
- Outbox: caps, TTL, drop counting, kill between send and ack resends the same UUIDs.
- Sink results: per-event `retry` and `drop`, each status code class.
- Debug and preview: print the batch, `FakeSink` receives nothing.
- `disable` deletes the id and empties the outbox.
- Payload snapshot: a golden JSON of one `daily_summary` and one `error_raised` built from a fixture `events` table. Any change to what is sent shows up as a diff in review.

### 6.6 Release checklist item

Add to the release workflow and `RELEASING.md` (not written here):

- [ ] Payload snapshot diff reviewed; if the set of collected data changed, `notice_version` bumped and `TELEMETRY.md` updated in the same PR.
- [ ] PostHog region confirmed in the UI and matches the default host; project settings "Discard client IP data" on, GeoIP transformation off, data retention set (1 year on the free plan, R).
- [ ] Release CI runs with `DO_NOT_TRACK=1` and `COORDINATE_TELEMETRY_DISABLED=1` as belt and braces, and the test network guard passes.
- [ ] `uv tool install` of the wheel on clean macOS and on the Linux VPS: `coordinate telemetry status` shows the expected decision, the notice appears once on `service install`, and an HTTPS request with stdlib `ssl` verifies on both (2.2).
- [ ] Capture v1 still accepts the request shape (PostHog changelog checked for capture changes since the last release).

## 7. Adversarial points

### 7.1 What colleagues will object to

- "It sees my prompts and repos." It runs every agent session, so the trust bar is higher than for a build tool. Answer with the allowlist file, `telemetry preview`, and the payload snapshot test, not with adjectives.
- "Anonymous is not true." Correct: it is pseudonymous (stable random id, IP visible to PostHog in transit). The notice says pseudonymous for that reason.
- "With ten of us, you know who is who." This is the strongest objection. OS version, harness mix, device count and active days single out a person in a population of ten; k-anonymity is impossible at this size. Bucketing and daily rollups reduce detail but do not fix identifiability.
- "This is productivity monitoring." `agent_hours` and `away_agent_hours` per install, in a team where the author is a colleague (or a manager), read as a measure of how much each person delegates to agents and when. In Germany, a technical system suited to monitor employee behaviour or performance needs works council co-determination (BetrVG section 87(1) no. 6, K); similar rules exist elsewhere in the EU (K). If the author has any managerial role over the colleagues, or the company could ask for the data, drop the throughput properties or switch to opt-in.
- "Default-on in a tool I install for work may break company policy." Many companies forbid unapproved third-party data flows from work machines. The notice and `DO_NOT_TRACK` help, but the safe default inside a company is to ask.
- "Fake events." The embedded key lets anyone write into the project. Harmless for privacy, annoying for dashboards; filter on `$lib` and known versions.

### 7.2 Legal (not legal advice)

- Is a random install id personal data under the GDPR? Probably yes in this setting. Recital 26 counts information that can identify a person "directly or indirectly" with means reasonably likely to be used. The CJEU held in Breyer (C-582/14, K) that a dynamic IP address can be personal data, and PostHog receives the IP with every request even if it discards it. In EDPS v SRB (C-413/23 P, 4 September 2025) the Court held that pseudonymised data is not personal data "in all cases and for every person", because for a recipient without means to re-identify, the person may not be identifiable; but identifiability is assessed from the controller's point of view at collection (R, judgment paragraphs 86 and 111). The author is the controller, and in a ten-person colleague group the author has realistic means to re-identify. So treat the data as personal data, with the author as controller and PostHog as processor (PostHog offers a DPA, R, `docs/privacy/gdpr-compliance`).
- Lawful basis under the GDPR: legitimate interest (Article 6(1)(f)) is plausible for minimal, bucketed product analytics with a clear notice and an easy opt-out, after a written balancing test. Consent is not required by the GDPR for this.
- The ePrivacy Directive is the real constraint. Article 5(3) requires consent for storing or accessing information on a user's terminal equipment unless strictly necessary for the service the user asked for, and it applies "regardless of whether or not it is personal data" (R, EDPB Guidelines 2/2023 version 2.0, adopted 16 October 2024, paragraph 10, citing the CJEU). The EDPB names this exact pattern: access happens "when the accessing entity distributes software on the terminal equipment of the user that is stored and will then proactively call an Application Programming Interface ('API') endpoint over the network" (R, paragraph 33). Writing `install_id` to disk and sending usage data is not strictly necessary to orchestrate agents. Legitimate interest does not replace Article 5(3) consent. Some national regulators exempt narrow audience measurement from consent under strict conditions (CNIL, K); whether that stretches to a CLI is untested.
- Transfer: PostHog Cloud US means a transfer to the US for EU users; PostHog recommends EU Cloud for GDPR and anonymizing EU data on US Cloud (R). If any colleague is in the EU, prefer an EU Cloud project.
- Conclusion: for colleagues outside the EU, default-on with this contract is in line with Next.js, Turborepo and Astro. For colleagues in the EU, default-on with a notice is legally weak; the clean version is a one-question y/N prompt at `coordinate service install` (unchecked by default, since pre-ticked consent is invalid under Planet49, C-673/17, K), with the same contract otherwise.

### 7.3 What would make default-on unacceptable

Any of these and telemetry must switch to opt-in (or be removed):

- Any field that can carry free text, or any property outside the allowlist reaching the wire.
- Anything sent before a human saw the notice, or from CI, tests or the bench.
- Per-job or per-invocation events, or timestamps finer than the hour (a work timeline).
- Joining `install_id` or `fleet_id` to an identity (GitHub login, email, company directory), or using person profiles.
- Using the data to evaluate colleagues, or sharing per-install data with an employer.
- No way to see what is sent (`preview`, debug), or a debug mode that still sends (Homebrew's trap).
- Storing IPs or GeoIP, or keeping raw events indefinitely.
- EU colleagues without a consent step (7.2), or a works council or company policy that has not approved it.

### 7.4 Middle ground if default-on is rejected

Go's model fits coordinate well: telemetry mode `local` by default (the rollups are computed and kept in `queue.db`, visible through `coordinate telemetry preview` and useful to the user as a weekly summary), `on` uploads, `off` stops even local rollups. The prompt at `service install` asks to switch from `local` to `on`. The author gets less data but every byte of it is consented, and the code is the same apart from the default.

## 8. Open questions

- Which PostHog region the project is in (author to check in the UI).
- Whether PostHog retention insights work on events sent with `process_person_profile: false` (verify on the real project with the author's own install before building the dashboard).
- Whether any colleague is in the EU or covered by a works council; this decides default-on versus the `service install` prompt.
- Whether `fleet_id` is worth its linking cost before P4 ships; it can wait until multi-device exists.
