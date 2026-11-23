# Restate adapter shim

Implements the M4 scheduler adapter contract (.agents/docs/tool-search-rubric.md section 3) on Restate 1.8.1.

- daemon: starts `restate-server` (ingress 5500, admin 5501, node 15502) plus a Python worker (`restate-sdk` ASGI service on 59080) in the shim's process group; jobs run with `start_new_session=True`.
- enqueue: scoped send `POST /restate/scope/machine/send/JobRunner/run` with `x-restate-limit-key: <repo key>`; rules `*` (machine cap from FLEET_CAP) and `machine/<repo>` (FLEET_REPO_CAP) are upserted idempotently.
- tool leases: weighted ToolLease VirtualObject per (tool class, project); a job awaiting a lease parks on an awakeable and the invocation suspends, freeing its machine slot.

Setup: `cd bench/adapters/restate && uv sync` (creates `.venv`).
Run: `python shim.py daemon|enqueue|stats` with the FLEET_* environment from the contract.
