# Observability, error handling and audit: survey and design for fleet

Date: 2026-11-22 (ran `date`). Scope: how durable-execution engines, agent orchestrators, agent-trace standards and lightweight local tools record, query, alert on and retain what happens, and what fleet should build. Read with `docs/orchestrator-framing.md` (requirements, modules) and `docs/candidates-survey.md`.

Evidence tags (as in `orchestrator-framing.md`): M = measured by us, R = read in the project's own source or docs, B = blog or marketing claim, K = from memory, unverified. Method: shallow clones in `/tmp/obs-src` (docs repos for DBOS, Restate, Hatchet, Langfuse, Phoenix, OTel GenAI semconv; source for River, Absurd, OpenWorkflow, Gas City, Sandbox Agent, Claude Squad, ntfy, Rivet), live doc pages fetched as text, `gh api` for stars on 2026-11-22. Measurements on this laptop (Apple M4, macOS 27.2, load average about 3 during runs, so treat as indicative), except the Restate, Rivet and DBOS idle numbers which come from the earlier spikes.

## 1. Requirements as fleet sees them

The user's rule: full visibility into how the orchestrator works, so that every error, warning, bottleneck, stuck await, rate limit and hung agent is something the user can see, explain and act on. Translated into fleet terms, with the question each signal must answer:

| Signal | Question the user asks | What fleet must know | Where it lives today |
|---|---|---|---|
| Errors | What failed, on which attempt, why, and is it retrying or dead? | exit code, error class (transient, terminal, rate limit, needs human), attempt history, last stderr excerpt | `jobs.status`, `attempts`; no per-attempt error history, no reason |
| Warnings | What is about to go wrong? | caps near full, lease close to expiry, retries piling up, disk or memory pressure, orphan processes | nothing |
| Bottlenecks | Why is my work queued and what is it waiting behind? | which slot key denied the claim, who holds it and since when, queue wait time per key | computable from `concurrency_slots`, never recorded |
| Awaits | What is each parked session waiting on, since when, and when does it give up? | await kind (human, agent, resource, external), target, created, TTL, wake condition | `jobs.waiting_on` text only |
| Locks and leases | Who holds tool leases and file leases, are holders alive? | holder job and pid, cost, age, waiters | `concurrency_slots` rows, no history |
| Rate limits | Which provider limited us, when does it reset, what is parked on it? | provider, account, reset time, parked jobs | nothing; harness prints it to its own UI |
| Hung agents | Is a running agent making progress? | time since last ACP update or tmux output change, pending permission prompt, CPU | heartbeat proves the daemon is alive, not the agent |
| Timeouts | What timed out and was the timeout right? | turn timeout, await TTL, queued-too-long, lease expiry | lease expiry only, as a status change |
| Daemon health | Is fleetd itself up on each device? | last tick time, restarts, recovery actions | service manager logs only |
| Audit | Who or what did what, when? | enqueue source, cancel or retry by user, cap changes, presence level changes, unmatched heavy spawns | `spawn_audit` table only (toolcaps D9) |

Constraints carried over from the framing: no external long-running services, the whole orchestration stack under 200-300MB RSS per device, bounded storage with a TTL, per-device single writer, works with the hub unreachable. One user, so alert fatigue is a real failure mode and anything that needs a dashboard open to be useful is weak.

## 2. What the alternatives do

### 2.1 Durable-execution engines

Temporal (temporalio/temporal, 24.5k stars, MIT). The reference design. Every workflow has an append-only Event History that is both the recovery mechanism and "an audit log for debugging" (R, [docs](https://docs.temporal.io/workflow-execution/event)). Seven activity events per activity (scheduled, started, completed, failed, timed out, cancel requested, cancelled); the server warns after 10,240 events and terminates a workflow above 51,200 events, 2,000 updates or 10,000 signals (R). The Web UI lists executions within the retention period and shows per execution the history, workers polling the task queue (an error if none), pending activities with their attempt count, and a call stack captured through the `__stack_trace` query (R, [web-ui](https://docs.temporal.io/web-ui)). Hung work is detected with activity heartbeats plus a heartbeat timeout; the docs say the server does not detect a crashed worker without a start-to-close timeout (R). Failure model: retry policies with maximum attempts and non-retryable errors; reset to an earlier point in history; no dead-letter queue for workflows (K). Principal attribution stamps who signalled or cancelled on each event, opt in on self-hosted (R). Measured: `temporal server start-dev` 1.10.1 (server 1.32.2, UI 2.56.4) with a SQLite file idles at 147MB RSS on this laptop, and its default namespace retention is 24h (M). Fits the memory budget barely as a second resident service, and brings a worker model fleet does not use.

Restate (restatedev/restate, 4.7k stars, BSL-1.1). The best introspection surface in this survey: SQL over its own state through `restate sql` or HTTP, with tables `sys_invocation`, `sys_journal`, `sys_journal_events` ("such as failures"), `sys_inbox` (queue per key), `sys_locks` (locks held on keys), `sys_vqueues` and `sys_scheduler` (why an invocation waits for its turn), `sys_rules` and `sys_user_limits` (concurrency rules in use), `sys_promise` and `state` (R, [introspection](https://docs.restate.dev/services/introspection)). A built-in UI shows the same, and state can be edited with `restate state patch` (R). Errors: retries with exponential backoff; when `max-attempts` is exhausted the default action is `on-max-attempts = "pause"`, so the invocation waits for a human to resume it instead of being dropped, with `kill` as the alternative (R, [error handling](https://docs.restate.dev/guides/error-handling)). Hung handlers: an inactivity timeout (1 minute default) asks the handler to suspend, then an abort timeout (10 minutes default) aborts it (R). Retention: journal kept 24h after completion by default, separate idempotency and workflow retention (R, [configuration](https://docs.restate.dev/services/configuration)). OTel: traces per invocation exported live over OTLP, a span per attempt with failed attempts marked, a span event per journal command, and a file exporter in Jaeger JSON (R, [tracing](https://docs.restate.dev/server/monitoring/tracing)). Measured idle RSS 532MB in our spike (M), so the design is the lesson, not the binary.

DBOS (dbos-transact-py, 1.7k stars, MIT). Everything is rows in the system database: `workflow_status` (status, `recovery_attempts`, queue, priority, `rate_limited`, `suspend_key` for a workflow waiting in `recv`, timeouts, parent workflow), `operation_outputs` (one row per step with output, error, `started_at_epoch_ms`, `completed_at_epoch_ms`, child workflow), `notifications`, `workflow_events_history`, `streams` (R, [system tables](https://docs.dbos.dev/explanations/system-tables)). Query with `dbos workflow list/get/steps/cancel/resume/fork` and `dbos workflow queue list` (R). Errors: `max_recovery_attempts` (default 100) "acts as a dead letter queue": a workflow that keeps crashing its process moves to `MAX_RECOVERY_ATTEMPTS_EXCEEDED` and can be resumed by hand (R). OTel spans per workflow and step on the global tracer when `enable_otlp` is set, with `dbos.*` attribute names (R). Retention policies (time and row thresholds), the global timeout, alerts and the dashboard are features of Conductor, the hosted control plane, and some modes need a paid plan (R). Measured 82MB idle in our spike (M). Lesson: per-step start and end timestamps in a table make "where did the time go" a SQL query; retention needs to ship with the OSS library, not with the control plane.

Rivet (rivet-dev/rivet, 7.0k stars, Apache-2.0). Actor Inspector with State, Connections, Queue, Workflow and Database tabs, also exposed through Rivet's MCP server so an agent can inspect an actor (R, `docs/general/content/mcp.mdx`). Gateway endpoints per actor for health and metadata (R). Its agentOS docs define a limit contract worth copying verbatim: every bound is bounded by default, emits a structured warning at 80% of capacity "once per crossing and re-armed only after recovery", and fails with an error that names the limit and the config path to raise it (R, [limits and observability](https://rivet.dev/agentos/docs/architecture/limits-and-observability/)). Measured 128MB idle, 1.5GB at 10k parked actors (M, spike).

Absurd (earendil-works/absurd, 2.6k stars, Apache-2.0, Postgres). Each attempt is a run row with checkpoints; `absurdctl list-tasks`, `dump-task --task-id/--run-id` (task or run including checkpoints), `retry`, `emit-event`, `cleanup`, and a Go web UI called habitat (R, README, `docs/tools/absurdctl.md`). Retries are `fixed`, `exponential` or `none` with `maxAttempts`; cancellation policies `maxDuration` and `maxDelay`, the latter cancelling a task when no checkpoint was written for N seconds, a direct hung-work detector (R, `docs/concepts.md`). Per-queue `cleanup_ttl` defaults to 30 days, `cleanup_limit` 1000 rows per pass (R, `docs/storage.md`). Ships an agent skill (`absurdctl install-skill`) giving coding agents a debugging playbook (R, `docs/agents.md`). Postgres rules it out; the CLI shape and the skill do not.

River (riverqueue/river, 5.9k stars, MPL-2.0, Postgres or experimental SQLite). Every job row carries `errors`, an array of `AttemptError{at, attempt, error, trace}` so the full failure history of a job is on the job (R, `rivertype/river_type.go`). States include `discarded` (errored too many times) and `cancelled` (R). A job cleaner deletes completed and cancelled jobs after 24h and discarded jobs after 7 days by default (R, `riversharedmaintenance`). River UI (riverqueue/riverui, 240 stars) is a separate process, now with SQLite support in its Pro driver (R, CHANGELOG). Lesson: keep a short retention for successes and a long one for failures.

OpenWorkflow (openworkflowdev/openworkflow, 1.4k stars, Apache-2.0, Postgres or SQLite). `step_attempts` table with one row per attempt (R, ARCHITECTURE.md); a dashboard started on demand with `npx @openworkflow/cli dashboard` that also serves `GET /metrics` with run counts by status in Prometheus format, "to track failures, detect stuck backlogs" without another service (R, `apps/docs/docs/prometheus.mdx`). OTel spans `workflow_run.execute` and `step_attempt.execute`; when a run pauses its span records `step.kind` (`sleep`, `signal-wait`, `workflow`), `resume_at` and `timeout_at`, which is exactly the await metadata fleet needs (R, `opentelemetry.mdx`). Retention: not found in the docs (unknown).

Inngest (inngest/inngest, 6.1k stars, license not OSI per GitHub). Run traces show "step timing, queue delays, retry attempts, and input and output data", each retry as its own span; function list shows failure rate and volume; Insights adds SQL over events, runs, steps and spans in the cloud (R, [traces](https://www.inngest.com/docs/platform/monitor/traces), [metrics](https://www.inngest.com/docs/platform/monitor/observability-metrics)). Self-hosted `inngest start` defaults to SQLite plus an in-memory Redis with periodic snapshots (R, [self-hosting](https://www.inngest.com/docs/self-hosting)). Idle RSS not measured. Lesson: queue delay is a first-class span, separate from execution time.

Hatchet (hatchet-dev/hatchet, 8.3k stars, MIT, Postgres). Dashboard, OTel, Prometheus metrics, tenant alerting to Slack and email, Sentry for server errors (R, `self-hosting/configuration-options.mdx`). Default retention 720h per tenant (R). Scheduling timeout (default 5 minutes in queue before cancel) separate from execution timeout (R, `v1/timeouts.mdx`). Durable tasks can be evicted from worker slots after a TTL or by capacity-based eviction when the worker runs out of slots, with an eviction priority (R, `v1/task-eviction.mdx`). That is a park-on-cap-pressure feature, which `orchestrator-framing.md` Assessment 7 says nobody has; it holds for agent orchestrators, not for Hatchet. Embedded mode runs the engine with embedded Postgres as a sidecar (R).

### 2.2 Agent orchestrators

Gas City (gastownhall/gascity, 1.6k stars, MIT). The closest match to what fleet needs. Every city records events in `.gc/events.jsonl`; each event is immutable, carries a monotonically increasing `seq`, actor, subject, type and timestamp, so a watcher can replay from any point; types include `bead.created`, `bead.closed`, `session.woke`, `session.crashed`, `order.fired`, `order.completed` (R, `docs/getting-started/how-gas-city-works.md`). `gc events` prints JSON Lines, `--follow` and `--watch` stream, `--seq` gives a cursor, `--json-schema` publishes the line schema; the CLI is a projection of the supervisor's REST and SSE API (R, `docs/reference/events.md`). Events also drive automation: an event-triggered order reads the stream to decide when to run (R). A mirror copies the log outside `.gc` for an OTel Collector `filelog` receiver, rotating at 100MiB by default (R, `docs/runbooks/events-mirror.md`). Lesson: one event log that is the human feed, the automation trigger and the export source.

Orca (stablyai/orca, 133k stars, MIT). Heartbeats from workers every 1-60 minutes, `worker_done` exactly once with task and dispatch ids so stale retries cannot complete the wrong attempt, decision gates, provider usage limits and reset times shown in the panel (R, framing Assessment 4). Mutation receipts capped at 10,000 rows and 30 days (R, landscape-b). Open issue: the daemon never reaps detached PTYs, so idle sessions exhaust RAM (R, #40261), which is the kind of slow failure only a resource signal catches.

T3 Code (pingdotgg/t3code). Event-sourced: commands, events, projections and outbox effects in one SQLite transaction; event log kept about a day for replay, settled effects 7 days, after which projections are authoritative (R, landscape-b). `RestartContinuation` allows at most 3 continues per 5 minutes so a turn that keeps crashing the server cannot loop, a poison-message guard (R). `UsageLimitRecoveryWorker` re-arms a thread after a provider usage-limit window (R). Open issue: ACP background tasks stuck RUNNING after kill or timer expiry (R, #25599).

Sandbox Agent (rivet-dev/agents, 1.7k stars, Apache-2.0). Sessions live in memory only; every event has a `sequence`, and the client persists events and resumes with `offset` so nothing is duplicated (R, `manage-sessions.mdx`). Pi Durable, in the same repo, traces each run with OTel GenAI attributes (`invoke_agent`, `gen_ai.conversation.id`, token usage on `chat <model>` spans), keeps the trace id across retries, actor sleeps and restarts, names failures with an `error.type` taxonomy (`unanswered`, `run_error`, `task_faulted`, `task_orphaned`, `provider_error`), and never records prompt text, tool arguments, tool results or error messages, because error text can repeat what the caller sent (R, `docs/content/guides/agent-observability.mdx`). Note that sandbox-agent sends anonymous telemetry on startup and every 5 minutes, enabled by default in release builds (R, `telemetry.mdx`).

Claude Squad (smtg-ai/claude-squad, 8.9k stars, AGPL-3.0). No event log. Liveness is a tmux pane diff per tick (`HasUpdated`), and a pending permission prompt is detected by matching known prompt strings per harness, such as "Yes, allow once" (R, `session/tmux/tmux.go`). Errors go to a log file. Crude, but it is the only tool here that detects "agent is blocked on a permission prompt" from the outside, which fleet's tmux fallback needs.

Paperclip, Cloudroom, Multica (from landscape-a and -b). Paperclip's open issue #13631, "agent stuck running, wakeup stuck claimed, result and usage lost", is the failure mode of keeping usage only in the process (R). Cloudroom has a disk guard with hysteresis: warn at 5GB free, freeze agents under 2GB (R). Multica heartbeats every 15s with a 30s catch-up poll (R).

### 2.3 Agent-trace standards and backends

OpenTelemetry GenAI semantic conventions. Moved in 2026 to its own repo (open-telemetry/semantic-conventions-genai, 558 stars, created 2026-05-05), status Development (R, `docs/gen-ai/README.md`). Defines `create_agent`, `invoke_agent` (LLM drives control flow) and `invoke_workflow` (application drives control flow) spans, `execute_tool` spans, attributes `gen_ai.provider.name`, `gen_ai.agent.name`, `gen_ai.conversation.id`, `gen_ai.usage.input_tokens` and `output_tokens`, and metrics such as `gen_ai.invoke_agent.duration`, `gen_ai.execute_tool.duration`, `gen_ai.client.inference.usage.input_tokens` including cache read and write (R). Content capture is opt in (`OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT`) (R). Good as an export vocabulary; too unstable to be fleet's storage schema.

Harness-native telemetry. Claude Code exports OTel metrics and logs when `CLAUDE_CODE_ENABLE_TELEMETRY=1`: `claude_code.session.count`, `claude_code.token.usage`, `claude_code.cost.usage`, `claude_code.active_time.total`, plus events such as `claude_code.api_request`, `claude_code.api_error`, `claude_code.tool_result`; traces need an extra beta flag (R, [monitoring](https://code.claude.com/docs/en/monitoring-usage)). Codex exports OTel logs (API requests, SSE events, tool approvals and results) via `[otel]` in `config.toml`, off by default, prompts redacted unless `log_user_prompt` (R, [config](https://developers.openai.com/codex/config-advanced)). This is the cheapest route to tokens, cost and API errors per session, without parsing transcripts.

OpenInference and Phoenix (Arize-ai/openinference 1.3k stars Apache-2.0; Arize-ai/phoenix 12.4k stars, Elastic License 2.0 (R, LICENSE)). OpenInference adds an `openinference.span.kind` taxonomy (LLM, AGENT, TOOL, RETRIEVER, ...) and `llm.token_count.*` on top of OTLP (R, spec README). Phoenix stores in SQLite by default for single-user deployments, has per-project trace retention policies (R, `self-hosting/architecture.mdx`, llms.txt). Measured: `phoenix serve` 22.0.1 idles at 614MB RSS after startup, 627MB installed (M). Over budget as a resident service; acceptable on demand.

Langfuse (langfuse/langfuse, 37.7k stars). Self-hosting v3 needs Postgres, ClickHouse, Redis and S3-compatible storage; docker-compose recommendation "at least 4 cores and 16 GiB of memory" and about 100GiB storage (R, `self-hosting/deployment/docker-compose.mdx`, `self-hosting/index.mdx`). Fails the footprint gate by two orders of magnitude.

Logfire (pydantic/logfire, 4.6k stars). SDKs are MIT and export to any OTel backend; "the server application for recording and displaying data is closed source", self-hosting needs an enterprise license (R, README). SDK usable, backend not.

Local OTel viewers. otel-desktop-viewer (CtrlSpice, 1.3k stars, Apache-2.0) is one Go binary with OTLP gRPC and HTTP receivers, a browser UI, DuckDB storage with `--db-max-size` pruning (512MB in memory or 2GB on disk by default), and CLI subcommands for agents (`traces`, `trace`, `span`, `logs`, `query` with SQL, `export`) (R, `--help` of v0.8.0); it idles at 78MB RSS with a DuckDB file (M). otel-tui (1.1k stars) is a terminal equivalent (R, not measured). Jaeger (23.4k stars) is heavier and container-first (K).

### 2.4 Lightweight local options

SQLite events table in fleet's own database, measured with a 9-column table and three indexes, WAL, `synchronous=NORMAL` (M, `/tmp/obs-tools/evbench.py`): 278 bytes per event including indexes; insert p50 35us, p99 100-140us; lookup of all events for one job 0.1ms at 1M rows; a group-by over the last hour 4ms at 100k rows and 42ms at 1M rows; process max RSS 27MB at 100k and 67MB at 1M rows (the 1M figure is the bench process holding the run, not a resident cost). TTL deletion of half of 1M rows in 5,000-row batches took 20s in one go, so GC must run in small batches every tick. The file only shrinks when `auto_vacuum=INCREMENTAL` is set before the first write and `PRAGMA incremental_vacuum` is fully stepped: 27.7MB went to 15.6MB after deleting half of 100k rows (M). Orca uses the same pragmas (R).

Datasette (simonw/datasette, 11.6k stars, Apache-2.0) and sqlite-utils (2.2k stars). `uvx datasette serve queue.db` gives a browsable, filterable, SQL-capable view and a JSON API over the same file; 0.65.6 used 62MB RSS serving the events DB (M). Run on demand, never resident. sqlite-utils is the CLI equivalent for ad hoc queries and JSON output (K).

Structured JSONL. Gas City's choice (R). Append-only, trivially tailable, greppable and shippable to an OTel Collector `filelog` receiver. Weaker than a table for "why is job 42 stuck" joins and for atomic writes with state changes, and rotation is a separate concern.

journald and macOS unified log. Native, rotated by the OS (`SystemMaxUse` on Linux), structured fields with `journalctl -o json` (K). fleetd's stderr already lands there on the VPS through systemd; on macOS launchd only writes to `StandardErrorPath` files that nothing rotates (K). Good for the daemon's own crash traces, poor as the product's event model because the macOS and Linux surfaces differ.

ntfy (binwiederhier/ntfy, 35.7k stars, Apache-2.0). Publish with one HTTP POST (`curl -d ... ntfy.sh/topic`), priorities, tags, click and action buttons (open URL, HTTP request), Markdown, scheduled delivery, and updating, clearing or deleting a notification by sequence id (R, `docs/publish.md`). The docs describe a dead man's switch: schedule a message `In: 5m` with a fixed sequence id and keep replacing it every minute; if the publisher dies, the alert is delivered (R). Server cache defaults to 12h (R, `docs/config.md`). Self-hostable as one Go binary (R); idle RSS not measured.

## 3. Comparison table

Footprint column: resident cost to get the observability features, idle unless noted.

| System | What is recorded | Query surface | Error model | Alerting | Retention default | Footprint | Fits fleet |
|---|---|---|---|---|---|---|---|
| Temporal | Event History per workflow (all commands, activity attempts, signals), principal per event | Web UI, `temporal` CLI, gRPC API, visibility queries | Retry policy, non-retryable errors, heartbeat timeout, reset to event | None built in; metrics for Prometheus (K) | 24h dev namespace (M) | 147MB dev server with UI (M) | Design reference |
| Restate | Journal per invocation, journal events incl. failures, inbox, locks, vqueues, promises, state | `restate sql` (DataFusion), UI, admin API, OTLP traces | Retries then pause (default) or kill; inactivity 1m, abort 10m | None built in | Journal 24h (R) | 532MB (M, spike) | Design reference: SQL tables for locks and queues, pause on exhaustion |
| DBOS | `workflow_status`, per-step `operation_outputs` with start and end, messages, events | `dbos workflow` CLI, SQL, OTel spans | `max_recovery_attempts` 100 as DLQ, resume, fork | Conductor only | Conductor only | 82MB (M, spike) | Design reference: step timestamps as rows |
| Rivet | Actor state, connections, queue, workflow, DB | Actor Inspector UI and MCP, gateway endpoints | Per actor; limit contract warns at 80% | Structured warnings (agentOS) | n/a | 128MB (M, spike) | Copy the limit contract |
| Absurd | Tasks, runs per attempt, checkpoints, events | `absurdctl list-tasks/dump-task`, habitat UI, agent skill | Retry strategies, `maxDuration`, `maxDelay` no-checkpoint cancel | None | `cleanup_ttl` 30 days (R) | Postgres | Copy `dump-task` and the agent skill |
| River | Job row with `errors[]` per attempt incl. stack | River UI, SQL | Retries, `discarded`, snooze, cancel | None (K) | 24h done, 7d discarded (R) | Go + Postgres or SQLite | Copy short success, long failure retention |
| OpenWorkflow | Runs, `step_attempts` | Dashboard on demand, `/metrics`, OTel | Retries, deadlines | Via Prometheus | Unknown | Node on demand | Copy await attributes on spans |
| Inngest | Runs, steps, queue delay, retries as spans | Dev Server UI, cloud Insights SQL | Retries, failure handlers (K) | Cloud | Plan based | SQLite + in-memory Redis (R), RSS unknown | Copy queue delay as a metric |
| Hatchet | Runs, steps, events | Dashboard, OTel, Prometheus | Retries, scheduling timeout 5m, eviction | Slack, email, Sentry | 720h (R) | Postgres | Reference for eviction and scheduling timeout |
| Gas City | `events.jsonl` with seq, typed events | `gc events --follow --seq`, REST, SSE, dashboard | Health patrol orders | Event-triggered orders | Rotation of mirror at 100MiB | Go binary | Closest model: one log for humans, automation and export |
| Orca | Run inbox, dispatches, heartbeats, receipts | Desktop app, CLI | Per-dispatch retry, relay backoff never ends | In app | Receipts 10k rows, 30d (R) | Electron app | Copy row and age caps |
| T3 Code | Events, projections, outbox effects | App UI | Restart continuation max 3 per 5 min, usage-limit recovery | In app | Events ~1d, effects 7d (R) | 863MB app (M, busy) | Copy poison guard and usage-limit recovery |
| Sandbox Agent / Pi Durable | Session events with sequence; OTel GenAI spans | SDK, any OTel backend | `error.type` taxonomy, trace id kept across retries | None | In memory, caller persists | Server per sandbox | Copy privacy rule and error taxonomy |
| Claude Squad | Nothing structured | tmux preview | None | None | n/a | tmux | Copy pane-diff and prompt detection for tmux fallback |
| Phoenix | OTel and OpenInference spans | UI, SQL backend, client API | n/a | n/a | Per-project policies | 614MB (M) | On demand only |
| Langfuse | Traces, evals | UI, API | n/a | n/a | Configurable | 16GiB recommended (R) | No |
| otel-desktop-viewer | OTLP traces, logs, metrics in DuckDB | Browser UI, CLI, SQL | n/a | n/a | Size cap 2GB on disk | 78MB (M) | On demand viewer for optional export |
| SQLite events table | Whatever fleet emits | fleet CLI, SQL, Datasette | fleet's own | fleet's own | fleet's own | ~0 extra resident, 278 B per event (M) | Yes |
| ntfy | Notifications | Phone, desktop, web | n/a | Push, scheduled, updatable by id | 12h cache (R) | Go binary or ntfy.sh | Yes, as the alert sink |

## 4. Adversarial points

Where heavier tooling is worth it:
- Per-turn LLM debugging. When the question is "why did the agent call that tool" or "which prompt version regressed", a trace UI with spans per model call and tool call (Phoenix, Langfuse) beats any event table. The improver loop in Assessment 8 needs per-turn data and evals. That data belongs to the harness, which already exports it (Claude Code, Codex OTel); run Phoenix or otel-desktop-viewer on demand on the VPS when doing that work, never resident on every device.
- Cross-device causality. A task placed by kinosmac on ovhcloud that spawns a subtask back on kinosmac is one trace in OTel and three disconnected logs otherwise. If cross-device delegation grows, trace context propagation pays for itself. Until then, a shared `trace_id` column carried in the payload gives the same join for free.
- Replay as recovery. Temporal and Restate need a per-step journal because replay is how they recover. fleet recovers through ACP `session/load` and git, so a full journal would be audit only. Do not build replay-grade history.
- Time-window alert rules. Prometheus-style rules ("failure rate above 20% for 10 minutes") need a metrics store. One user with tens of jobs a day does not generate enough data for rates to mean much; counts and ages are enough.

Where an event table is enough, and why it is better here:
- Volume is small. Assume 300 jobs per device per day and 25 state-change events per job: 7,500 events, about 2MB per day at 278 bytes per event (M for bytes, assumption for counts). Thirty days is about 60MB, well inside budget, with zero extra processes.
- Atomicity. Writing the event in the same SQLite transaction as the state change (T3's EventSink pattern) means there is never a state change without its event, and never an event for a change that rolled back. A separate log file or an OTel exporter cannot give that.
- Single writer per device, so `seq` is a total order per device, and the hub merges by `(device, seq)` without clock trust, like Gas City's cursor and Sandbox Agent's offset.
- The panel is T3, not a web UI. A JSON CLI is the integration surface T3 threads and agents already use; a separate dashboard is one more tab nobody has open.

Risks of the event table, and mitigations:
- Write contention with the claim transaction (`BEGIN IMMEDIATE`). Only state changes are events; high-frequency observations (heartbeats, liveness samples, output byte counts) update columns on the live row and are not appended. Inserts are 35us p50 (M), small next to the 160ms enqueue path dominated by Python startup.
- Drift between events and truth. `fleet why` must compute the current blocker from live tables (slots, awaits, leases) and use events only for history. An AFTER UPDATE trigger on `jobs.status` that inserts a bare `job.state` event is a cheap safety net that makes "every transition is logged" a schema property, with code adding a reasoned event alongside.
- Unbounded growth. Per-level TTL plus a hard row cap, GC in small batches each tick, `auto_vacuum=INCREMENTAL` set at creation (M showed the file does not shrink otherwise).
- Privacy. Events never hold prompt text, tool arguments, tool output or raw error text from the model (Pi Durable rule, Codex default). Store a classified error type, exit code, a bounded stderr tail from fleet's own process wrapper, and pointers to transcripts.
- Watching the watcher. A dead daemon cannot alert. Needs an external dead man's switch (ntfy scheduled message replaced every tick), plus the service manager restart.
- Alert fatigue. One person: alerts are keyed and deduplicated, updated in place, resolved explicitly, and quiet in the "focus" presence level except for errors that need a human.
- GenAI semconv is Development status. Map to it only at export time, so renames do not touch storage.

## 5. Recommended design for fleet, in layers

### Layer 0: append-only events in the same SQLite, with TTL

One table in `~/.fleet/queue.db`, written in the same transaction as the state change it describes. Replaces `spawn_audit` (becomes `kind='tool.spawn_unmatched'`).

```sql
CREATE TABLE events(
  seq INTEGER PRIMARY KEY,          -- per-device total order, cursor for tail and hub sync
  ts REAL NOT NULL,
  device TEXT NOT NULL,
  level INTEGER NOT NULL,           -- 10 debug, 20 info, 30 warn, 40 error, 50 audit
  kind TEXT NOT NULL,               -- dotted, see taxonomy
  job_id INTEGER, session_id TEXT, trace_id TEXT,
  key TEXT,                         -- slot key, provider, lock path, alert key
  data TEXT                         -- small JSON: reason, attempt, exit, wait_ms, reset_at, error_type
);
CREATE INDEX ev_job ON events(job_id, seq);
CREATE INDEX ev_session ON events(session_id, seq);
CREATE INDEX ev_kind_ts ON events(kind, ts);
CREATE TABLE alerts(
  key TEXT PRIMARY KEY,             -- e.g. stalled:job:42, ratelimit:anthropic, cap:machine
  severity INTEGER NOT NULL, first_ts REAL, last_ts REAL, count INTEGER,
  resolved_ts REAL, notified_ts REAL, summary TEXT
);
```

Event taxonomy (state changes only, each with a `reason` where a decision was made):
- `job.enqueued` (source: cli, agent, t3, hub), `job.claimed`, `job.denied` (first denial and then at most once per minute per job, with the blocking slot key, holder job and `used/cap`), `job.started`, `job.exited` (exit code, error_type), `job.retry_scheduled` (attempt, backoff, error_type), `job.dead`, `job.cancelled` (by whom), `job.done`.
- `await.parked` (kind human, agent, resource, external; target; ttl), `await.woken` (by what), `await.expired`.
- `lease.acquired`, `lease.released`, `lease.expired` (holder pid alive or not), `lock.contended`.
- `ratelimit.hit` (provider, account, reset_at, source: harness message, 429, usage-limit text), `ratelimit.cleared`.
- `agent.spawned` (harness, pid, pgid, rss_at_start), `agent.first_output` (wake latency), `agent.stalled`, `agent.prompt_pending` (permission prompt seen), `agent.orphan_killed`, `agent.resumed` (session/load, duplicate turn flag), `agent.usage` (tokens in and out, cost, per turn, when known).
- `daemon.started` (version, recovered jobs), `daemon.stopping`, `daemon.tick_slow`, `cap.changed` (presence level, by whom), `alert.raised`, `alert.resolved`, `notify.sent`.
- `tool.spawn_unmatched` (toolcaps D9).

Retention: debug 2 days, info 14 days, warn and error 90 days, audit 180 days, and a hard cap of 500k rows per device (about 140MB at 278 bytes, M) whichever comes first, like Orca's receipts cap and River's short-success, long-failure split. GC deletes at most 2,000 rows per daemon tick, so a backlog drains over minutes without long write locks. Terminal jobs older than their events' TTL are deleted with them, so `jobs` is bounded too.

### Layer 1: derived signals in the daemon tick (watchdog)

Each tick evaluates rules against live tables and opens or resolves alerts by key, following Rivet's contract: warn once per crossing, re-arm only after recovery, and every message names the limit and the config key to change it.

| Signal | Rule (defaults to tune with the bench) | Severity |
|---|---|---|
| Error | `job.dead`, or same job failed 3 times with the same error_type | error |
| Poison | daemon restarted 3 times in 5 minutes while the same job was running (T3 rule); quarantine that job | error |
| Cap pressure | a slot key at or above 80% for 10 minutes with jobs queued behind it | warn |
| Bottleneck | oldest queued job waiting longer than 15 minutes, with the blocking key named | warn |
| Await stale | parked longer than its TTL, or a human await older than 30 minutes in "away" or "overnight" | warn |
| Lease orphan | lease holder pid gone, or lease older than 2x its expected duration | warn |
| Rate limit | `ratelimit.hit` for a provider; parked jobs wake at `reset_at`; do not consume an attempt | info, warn if reset is unknown |
| Hung agent | running turn with no ACP `session/update` (or tmux pane change) for 10 minutes and CPU near 0 | warn |
| Prompt pending | permission prompt detected (ACP request or Claude Squad style string match in tmux) | warn, needs human |
| Timeout | turn timeout or scheduling timeout reached (Hatchet's split) | warn |
| Resource | free memory or disk under threshold (Cloudroom style hysteresis) | warn, lowers cap |
| Unmatched spawn | heavy binary outside a lease | info |

Error handling changes that make these signals actionable:
- Classify each failure as transient, terminal, rate_limit or needs_human. Rate limits and pending prompts park the job instead of consuming attempts (T3 `UsageLimitRecoveryWorker`, Restate suspension).
- On attempts exhausted, `dead` stays resumable with the full attempt history in events, like River's `errors[]` and Restate's default pause; `fleet dead retry` already exists.
- A crash-loop counter per job (DBOS `max_recovery_attempts`, T3 restart continuation) quarantines a job that keeps killing the daemon.
- No compensation layer: the worktree and git are the compensation; fleet records what was spawned and in which worktree so a human can clean up.

### Layer 2: CLI

All commands print a table by default and JSON Lines with `--json`, with a published schema (Gas City pattern), so T3 threads, agents and scripts consume the same surface. Plus an agent skill, as Absurd ships, so any harness can debug fleet.

- `fleet events [--job N] [--session S] [--kind 'agent.*'] [--level warn] [--since 2h] [--json]`: history query.
- `fleet tail [-f] [--level info] [--since-seq N]`: follow by polling `seq > last` every 250ms; cheap, no server.
- `fleet why <job|session>`: current state, the computed blocker from live tables ("queued 14m behind repo:/x, held by job 17 (running 41m, last output 12m ago)"), open alerts, last 15 events, and the suggested action with the exact command.
- `fleet health [--json]`: per-device summary (live/cap, queued, parked by await kind, oldest await, rate-limited providers with reset times, open alerts, daemon tick age, DB size), exit code 0, 1 warn, 2 error, for scripts and the dead man's switch.
- `fleet alerts [--open] [ack <key>]`.
- On demand only: `uvx datasette ~/.fleet/queue.db` (62MB while open, M) for ad hoc browsing.

### Layer 3: optional OTel export, off by default

- One trace per job, `trace_id` minted at enqueue and kept across retries, parks and daemon restarts (Pi Durable). Spans: queue wait, each attempt, each await (with `step.kind`, `resume_at`, `timeout_at` as OpenWorkflow does), each turn mapped to GenAI `invoke_agent` with `gen_ai.agent.name` = harness, `gen_ai.conversation.id` = ACP session id, `gen_ai.provider.name`. Built from the events table by an exporter loop, so export can lag or fail without affecting scheduling.
- Harness correlation: set `OTEL_RESOURCE_ATTRIBUTES=fleet.job_id=...,fleet.device=...` and `TRACEPARENT` (K for harness support of the latter) on spawned harnesses, so Claude Code and Codex telemetry joins fleet's job when the user enables it.
- Tokens and cost: when the harness exports OTel metrics, a small OTLP/HTTP JSON receiver in the daemon could fold `claude_code.token.usage` and `claude_code.cost.usage` into `agent.usage` events. This is an extra listening socket in fleetd; spike it before committing. Alternative: read usage from ACP updates if the harness sends them (unknown, verify per harness).
- Viewer on demand: otel-desktop-viewer (78MB, M, 2GB disk cap) on the device, or on the VPS for cross-device traces. Not resident.

### Layer 4: notifications via ntfy

- One topic per device on a self-hosted ntfy on ovhcloud with an access token (or ntfy.sh with a long random topic and a token). Messages carry job id, kind, one-line reason and the `fleet why` command; never prompt text or code.
- Alert key = ntfy sequence id, so a repeat updates the same notification and a resolve clears it. Severity maps to ntfy priority (error 4, needs-human 4, warn 3, info not sent). Rate limit to 6 notifications per hour per device, then a digest.
- Presence-aware (`presence-aware-concurrency.md`): in focus, only errors and needs-human; away and overnight, warnings too.
- Dead man's switch: each device's daemon replaces a scheduled message `In: 5m` with sequence id `fleetd-<device>` every minute; if the daemon dies or the device sleeps unexpectedly, the alert fires (R, ntfy docs). Sleep is expected on laptops, so the switch message should say "unreachable" and the hub can suppress it when the device reported a planned sleep.
- Local fallback when offline: `osascript -e 'display notification ...'` on macOS (K).

### Layer 5: what T3 should show

- Device strip, one per device: live/cap with presence level, queued, parked by await kind, rate-limited providers with reset countdown, open alerts count, daemon last tick age, events DB size.
- Session list: state, the `why` one-liner, time in state, last event, tokens and cost when known, harness and RSS.
- Alerts list with the action command for each (retry, resume, cancel, raise cap, answer prompt), linked to the session.
- Timeline per job: events from `fleet events --job N --json`.
- Integration path is open: T3 has no plugin surface for fleet data that we found. Options are a T3 thread that runs `fleet health --json` on a schedule, an MCP server wrapping the CLI, or a `fleet tail -f --json` stream into a thread. Default to the CLI contract and pick the transport after a spike.

## 6. Bench and CI signals to add

To `bench/bench.py` (with the existing noise-floor runner) and CI:

1. `events-overhead`: enqueue median and cap makespan with events on vs off; gate at no more than 5% regression, which is inside the measured cv for enqueue (4.9-6%), so compare means over 10 repeats.
2. `events-completeness`: run the cap, chaos and orchestrator-kill scenarios, then assert every `jobs.status` transition has a matching event and every job's events form a valid state machine path (property test on the event stream).
3. `events-size`: bytes per event, events per job, projected MB per day at the bench's job mix; gate DB size under the configured cap after a simulated 30 days with GC on.
4. `gc-pause`: p99 tick duration with a GC backlog of 500k rows; gate under 50ms per tick.
5. `why-latency`: `fleet why` and `fleet health` wall time at 1M events; gate under 300ms (CLI budget), with the query part under 10ms.
6. `stall-detect`: stub ACP agent that stops emitting updates; assert `agent.stalled` within threshold plus one tick, and no alert for a slow stub that emits every 5 minutes (false positive check).
7. `prompt-detect`: stub that blocks on a permission request over ACP and a tmux stub that prints a prompt string; assert `agent.prompt_pending`.
8. `ratelimit-park`: stub that returns a usage-limit error with a reset time; assert the job parks, attempts do not increase, the slot is freed, and it wakes within 1s of reset.
9. `poison`: job that kills the daemon on start; assert quarantine after 3 restarts in 5 minutes and that other jobs keep running.
10. `alert-dedupe`: mock ntfy endpoint; one incident yields one notification, updates reuse the sequence id, resolution clears it, rate limit holds under a flood.
11. `deadman`: kill -9 the daemon with PID ownership check (per the framing process note); assert the scheduled alert is delivered by a local ntfy within 5m plus slack, and is replaced while the daemon is alive.
12. `orchestrator-kill` reuse: count duplicate turns and recovery actions from events instead of ad hoc probes, so the bench measures what the user sees.
13. `rss-with-events`: daemon RSS at 0, 100k and 1M events; gate fixed overhead growth under 10MB.
14. CI lint: no event `data` field contains prompt or tool-output fields (schema allowlist), and the JSON Lines schema of `fleet events --json` is versioned and checked.

## 7. Open questions

- Does ACP expose per-turn token usage for each harness, or only harness OTel? Verify per harness before building the OTLP receiver.
- Which transport T3 should use to show fleet state (scheduled thread, MCP tool, stream).
- ntfy idle RSS self-hosted on the VPS, not measured.
- Whether hub-side merge of device events is needed at all, or `fleet health --json` per device over the connector is enough for the panel.
