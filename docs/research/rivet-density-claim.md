# Rivet "7,242× more agents per server": provenance, reconstruction, transfer

Research date: 2026-11-22. Scope: where the claim lives, how it is computed, whether it transfers to an orchestrator of external CLI harnesses, and what we could publish instead. Context: `docs/orchestrator-framing.md`, Assessment 1.

Tags: M measured by us on this machine, R read in project docs or source, B blog or marketing copy, K memory, unverified.

## 1. Where the claim is made

- Landing page, section headline: "Run 7,242× more agents per server. An Actor runs inside your Node.js or Bun backend, not in its own container or VM. A server that held hundreds of sandboxes holds hundreds of thousands of Actors. 72.4 KB per running Actor. RSS increase per running Actor. Measured with the Rust rivetkit SDK. The sandbox figure is a provider's documented default allocation as of November 4, 2026, not measured memory use." Hero also says "72 KB per Actor". (B, https://rivet.dev/, fetched 2026-11-22)
- Docs page, "Comparison baseline" table: "Memory: 72.4 KB per running Rivet Actor | 512 MiB per sandbox | About 7,242×". Last updated November 20, 2026. (R, https://rivet.dev/docs/benchmarking)
- Source of that page: `docs/general/content/benchmarking.mdx`, row added in commit `0e94cc69` on 2026-11-05. (R, https://github.com/rivet-dev/rivet/commit/0e94cc69)
- Repo README, "How Actors compare to sandboxes": "Memory per instance | 72.4 KB | 512 MiB", and states "Rivet numbers come from the published Rivet Actors vs Cloudflare Durable Objects benchmark". (R, https://github.com/rivet-dev/rivet/blob/main/README.md)
- Benchmark repo: has no 72.4 KB figure and no sandbox comparison. It is Rivet vs Cloudflare Durable Objects. (R, https://github.com/rivet-dev/bench-rivet-actors-vs-durable-objects, `gh search code --owner rivet-dev "72.4"` returns only the README and the mdx)
- X posts and blog posts: not found. A web search for `"7,242" rivet agents per server` returned only the landing page. Unknown whether it was posted on X.

## 2. How 7,242 is computed

It is a ratio of two numbers from different sources, not a measurement of agents.

- Numerator: 512 MiB, E2B's default sandbox allocation. E2B docs: "Start with default resources (2 vCPU, 512 MiB RAM)". Rivet itself notes "This is allocated memory, not measured memory consumption or a minimum." (R, https://e2b.dev/docs/billing; R, https://rivet.dev/docs/benchmarking)
- Denominator: 72.4 KB, "the resident memory (RSS) added by one running Rivet Actor, measured in September 2026 with the Rust rivetkit SDK". (R, https://rivet.dev/docs/benchmarking). An earlier README revision adds "Measured September 2026 on FoundationDB with the Rust rivetkit SDK". (R, removed in https://github.com/rivet-dev/rivet/commit/11e3330e)
- Arithmetic: 512 × 1024 KiB / 72.4 KiB = 7,241.5, rounded to 7,242. So "KB" is KiB. With decimal KB the ratio would be 7,415. (M, computed)

What is counted as an "agent": one Rivet Actor. Nothing in the measurement runs an LLM loop. The published benchmark's actor is a ping actor: "No user state and no database: a create or wake measures the start path alone." (R, `rivet/app/src/index.ts` line 48, https://github.com/rivet-dev/bench-rivet-actors-vs-durable-objects/blob/main/rivet/app/src/index.ts). The Rust measurement behind 72.4 KB is not published anywhere I could find, so its workload is unknown.

In-process vs external harness: an Actor shares its node's process ("Rivet Actors share their node's process instead of each starting their own", R, https://rivet.dev/docs/benchmarking). The agent loop, if any, is user code inside that process; tools and code execution are reached through separate products (agentOS, sandboxes). An external CLI harness per agent is exactly what the comparison excludes. (R, same page; framing doc's "separating the head from the hands" is K for the exact Rivet wording, not re-verified here)

## 3. Inconsistencies in the claim

- The README says the Rivet numbers come from the published benchmark repo, but that repo's memory run measured 314.6 KiB per held actor on the node and 367.3 KiB across the three Engines, with rivetkit 3.0.3 on Node.js v24.10.0, stepping 1,000 to 10,000 held (noSleep) actors. (R, `report/results.md` "Rivet: memory per held actor" and `results/2026-11-05/rivet/hold-hold.summary.json`, https://github.com/rivet-dev/bench-rivet-actors-vs-durable-objects/blob/main/report/results.md)
- Using the reproducible number instead: 512 MiB / 314.6 KiB = 1,667×. Counting node plus Engines (682 KiB per actor): 769×. (M, computed from R)
- The 72.4 KB figure is from a different SDK (Rust), a different month (September), and a different backend (FoundationDB per the older README), with no raw samples published. (R, commits above)
- The figure has moved over time: an October README revision showed "~0.6KB" per actor ("RSS delta divided by actor count, measured by spawning 10,000 actors in Node.js v24") against "~50MB" per Kubernetes pod and "~512MB" per VM. (R, https://github.com/rivet-dev/rivet/commit/11e3330e diff)
- The baseline is an allocation ceiling, not usage. A sandbox running a small Node.js process uses far less than 512 MiB; Rivet acknowledges the floor is one Node.js runtime. (R, https://rivet.dev/docs/benchmarking)
- Fixed overhead is excluded. At 0 actors the node already used 987 MiB and the Engines 5,677 MiB. (R, `report/results.md`). The marginal number is honest as a marginal number, but "per server" density must subtract that floor.
- Cold-start ratios (295×, 341×) compare a Rivet run at concurrency 1 with ComputeSDK's 100-concurrent sandbox benchmark; Rivet itself says "these are separate benchmarks with different concurrency and environments". (R, https://rivet.dev/docs/benchmarking)

Fair reading: "a stateless Actor's marginal RSS is tens to hundreds of KiB, versus a sandbox's 512 MiB default allocation". Thousands of times denser for idle or ping-sized units; says nothing about agents doing LLM work.

## 4. Does it transfer to us

No, not as a live-agent number. Our unit is an external CLI process plus its MCP children.

Measured on kinosmac (24 GiB, Claude Code 2.1.330), 2026-11-22, `ps -o rss`:
- Five live `claude` stream-json processes: 367, 374, 386, 386, 407 MiB RSS. (M)
- Full process tree of two of them, including `chrome-devtools-mcp` (163 to 183 MiB) and a Node child (58 MiB): 598 and 613 MiB. (M)
- So one live Claude Code session here costs about 0.6 GiB, i.e. more than one E2B default sandbox allocation. Rivet's baseline is smaller than our agent. (M vs R)
- Codex (codex-cli 0.169.0), maki 0.7.2 and OpenCode v2.3.2 are installed but no process was running, so their RSS is unknown. The "under 100MB at start" figure stays K until measured. (M for versions, K for memory)

What does transfer is the shape of the trick: density comes from separating a cheap durable record from an expensive executor. Our parked session (harness, session id, cwd, device, wait condition, transcript pointer) is the analog of a sleeping Actor. Its cost is a row in a store, likely low KiB (K, not yet measured). A ratio like "0.6 GiB live / N KiB parked" would be the same kind of number as 7,242× and would carry the same flaw: it compares a parked thing with a live thing.

Binding limits for us, none of which Rivet's number addresses: device RAM for live harness trees, provider rate limits and concurrency caps, wake cost (harness process start plus `session/load` or resume replay plus first token), and disk for transcripts.

## 5. Metrics we could publish honestly

Each metric names its unit, its denominator, and what is excluded.

1. Live sessions per GiB, per harness. RSS (and PSS on Linux) of the full process tree (harness plus MCP children), sampled at idle-after-start, during a turn, and peak over a scripted task. Report per harness version and MCP config. Rivet analog: their per-actor RSS delta, but we measure the whole tree, not a marginal delta.
2. Parked sessions per device at fixed orchestrator RSS. Step N parked sessions 0, 1k, 10k, 100k (synthetic records), record orchestrator RSS and store bytes, report marginal KiB per parked session and the 0-session floor separately. Rivet analog: the `hold` scenario and `rss.sh` (https://github.com/rivet-dev/bench-rivet-actors-vs-durable-objects/blob/main/rivet/bench/rss.sh) apply directly; copy its step-and-sample method.
3. Wake latency p50/p99, per harness. From wake event to first streamed token of the resumed session, split into scheduler, process spawn, session load or replay, and model TTFT. Report nearest-rank, no trimming, sample count, and the transcript size bucket. Rivet analog: their "Wake" condition (6.26 / 8.15 ms) measures only the platform; ours must report the non-model part separately so the model's TTFT does not hide or dominate it.
4. Scheduler overhead at N parked and M live. CPU percent and orchestrator RSS at, for example, N=10k parked and M=3 live, plus park and wake throughput per second. Rivet analog: "creates/s while growing" in the hold table.
5. Sustained concurrent live sessions per device before failure. Increase M until memory pressure, swap, or provider throttling, report the first limit hit and the M at which p99 wake or turn latency degrades by 2×. No Rivet analog; this is where provider rate limits enter, and it is the honest ceiling on "concurrent agents".

Method rules taken from Rivet's good parts: publish raw samples and scripts in a repo, pin versions and hardware, state nearest-rank percentiles with sample counts, and say plainly which numbers are measured and which are quoted. Rules taken from its weak parts: never divide a ceiling allocation by a marginal delta, never compare parked with live in one ratio, include fixed floors, and keep the headline traceable to a reproducible run.

## 6. Open questions

- Where are the raw samples for the September 2026 Rust 72.4 KB measurement? Not in either public repo searched.
- Codex, maki, OpenCode RSS at start and during a turn: unmeasured, needs a controlled run.
- Byte size of a parked session record and its transcript pointer in our store: unmeasured.
- Whether Rivet published the 7,242× figure on X: not found.
