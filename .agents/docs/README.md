# Contributor docs

Design notes, research and spike reports. The user documentation is in `docs/`, and the overview is in `ARCHITECTURE.md` at the repo root.

## Design

- `t3-integration.md`, `events-bridge.md`: showing jobs in T3 threads
- `readoption-design.md`: re-attaching to agents after a daemon restart
- `timecap.md`: execution-time caps for jobs
- `toolcaps-design.md`: concurrency caps per tool class
- `fallback-design.md`: cross-harness fallback

## Spikes and measurements

- `ts-port-spike.md`: the TypeScript port against the Python version
- `park-wake.md`: parked-job density and wake latency
- `windows-spike.md`, `v0.1.0-release.md`: Windows and release engineering
- `restate-spike.md`, `restate-suspension.md`, `rivet-spike.md`, `term-fallback-spike.md`: alternatives that were measured. The raw data is in `data/`
- `bench-v2.md`, `bench-ci.md`: the retired Python benchmark harness

## Decisions and plans

- `orchestrator-framing.md`: requirements and assessments behind the design
- `candidates-survey.md`, `tool-search-rubric.md`: how candidate tools were scored
- `python-retirement.md`: what moved from Python to TypeScript and what is left
- `research/`: longer research notes (actor model, observability, telemetry, orchestrator landscape, self-improvement, shared context, language choice)

## Archive

`archive/` keeps documents that no longer describe the project: the earlier `fleet` architecture and plan, the rejected DBOS spike, the first Python reference spike, and the plugin extensibility design (the plugin runner was retired in favor of `forward --exec`).
