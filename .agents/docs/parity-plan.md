# Python to TypeScript parity plan

Date: 2026-11-23. The Python version (branch `legacy/python`) is the specification. Its 97 pytest tests (95 run by default, 2 need a real agent) are the parity target. This plan says which features earn their place in the TypeScript version and which do not. The per-test map is in `ts-port-test-gap.md` and the known regressions are in `ts-port-regressions.md`.

## Decisions

| Group | Python tests | Decision | Why |
| --- | --- | --- | --- |
| Queue core: acceptance, caps, events, orphans (reap), project key, slots, spawn shim | 29 | Keep, parity tests now | This is the product: durable admission, caps, tool slots, events, worktree-aware repo keys |
| Time caps | 17 | Keep, parity tests now | Outcome-driven jobs with a deadline and an agent-visible identity were an explicit goal |
| Paths: config and database resolution | 6 | Keep, parity tests now | Needed by every verb |
| Paths: runtime and log folders | 3 | Keep, ported with their consumers | The service and the ACP lane use them |
| Service install (systemd, launchd) | 4 | Keep, port next | A daemon colleagues cannot install does not get adopted |
| ACP lane: session in payload, 2 real-agent pilots | 3 | Keep, port after core parity | Durable agent sessions are the differentiator, and the Python lane's known gaps (cancel leaves the agent running, one duplicate turn) get fixed on top of parity, not before |
| Plugin runner and `plugins` verb | 13 | Drop | `forward --exec` already hooks events to anything. A second extension mechanism is surface nobody asked for |
| Legacy `~/.fleet` fallback, `migrate`, `FLEET_*` variables | 5 | Drop | The product is new. The old `fleet` tool stays a separate binary until cutover, and nobody else ever had `~/.fleet` |
| Benchmark gate comparator (`compare`) | 18 | Defer | It ports together with the benchmark gate, which is a separate item |

Totals: 51 tests are parity targets for the TypeScript code now, 10 follow their feature (service, runtime and log folders, ACP lane), 18 are deferred with the gate, and 18 are retired with the dropped features. The code for the dropped features stays on `legacy/python`.

## Order

1. Port the 51 now-tests. A test that fails because of a known regression or a missing feature is marked `todo` with the audit ID, so each fix thread flips its own tests to enforced.
2. Fix the regressions in `ts-port-regressions.md`, in the audit's order.
3. Time cap enforcement in the daemon (deadline kill path, `COORDINATE_DEADLINE_AT`, the derived `status` fields). The audit points at these gaps, and the 17 time cap tests will show their full size.
4. Service install, then the ACP lane with its tests.
5. The benchmark gate and its comparator.
