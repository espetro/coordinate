# Shared context across harnesses and devices: is a CRDT worth it? (M6)

Date: 2026-11-22. Research only, nothing implemented. Context: `docs/orchestrator-framing.md`, Assessments 2 and 3.

Evidence tags: M = measured by us, R = read in the project's own docs, source, issues or release metadata, B = blog, independent write-up or marketing claim, K = from memory, unverified. Star counts and last-push dates come from the GitHub API on 2026-11-22 (R). Binary sizes are compressed release assets for darwin arm64 from the latest GitHub release (R), not installed size and not RSS. Nothing here was run locally, so there are no M tags.

## 1. The question restated

Requirement 6 asks for shared context across harnesses (Claude Code, Codex, maki, OpenCode via ACP) and devices (kinosmac hub, kinosmac-pro, ovhcloud). T3 threads are not replicated, and T3 links go one way from kinosmac and do not chain (R, framing doc Assessment 2 and 3).

"Shared context" mixes four different things, and the answer differs per kind:

| Kind | Example | Writers | Natural owner |
| --- | --- | --- | --- |
| A. Session records | session id, harness, device, status, transcript pointer, await reason | one (the device running it) | that device |
| B. Work items | tasks, dependencies, claims, handoffs | many, rarely the same item at once | whoever holds the claim |
| C. Messages | agent-to-agent notes, handoff summaries, acks | append only | the sender |
| D. Durable knowledge | project facts, decisions, "remember X" | many, overlapping topics | nobody, needs curation |

A and C are naturally single-writer or append-only. B is multi-writer but partitionable by item plus a claim. Only D is genuinely multi-writer with overlapping content, and D is exactly where CRDTs do not help, because the conflicts are semantic (two contradicting facts), not structural (see section 5).

## 2. Beads, Gas Town and Gas City

### 2.1 Correct names and repos

- Beads (`bd`): https://github.com/gastownhall/beads, moved from `steveyegge/beads` (the old URL redirects). 28,926 stars, pushed 2026-11-22, MIT, 1,795 open issues, latest stable v1.3.4 on 2026-11-04 and v1.4.0-rc.4 on 2026-11-20 (R).
- Gas Town (`gt`): https://github.com/gastownhall/gastown, "multi-agent workspace manager", 18,868 stars, pushed 2026-11-14 (R). Introduced in Yegge's "Welcome to Gas Town" post, https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04 (B, linked from beads `ARTICLES.md`).
- Gas City (`gc`): https://github.com/gastownhall/gascity, "Orchestration-builder SDK for multi-agent coding workflows", 1,564 stars, pushed 2026-11-22, MIT, stewarded by Gas City, Inc. (R, README). Its README has a "Coming from Gas Town?" section, so Gas City is the successor platform built on beads (R). Docs: https://docs.gascity.com, beads docs at https://beads.gascity.com (R, beads README).
- Fork that kept the classic design: `beads_rust` (`br`), https://github.com/Dicklesworthstone/beads_rust, 1,161 stars, pushed 2026-11-22, "frozen at the classic SQLite + JSONL architecture" because Yegge's beads "is being replaced with approaches better suited to Steve's vision" (R, README).

### 2.2 The premise "git-backed JSONL plus SQLite" is out of date

Beads today stores everything in Dolt, not SQLite plus JSONL. "Beads issue data lives in Dolt. The local Dolt database is the source of truth" and "`.beads/issues.jsonl` is an export ... It is not the canonical cross-machine sync channel" (R, https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md). The JSONL era ended around v0.50: "For pre-0.50 installations with JSONL data, use the migration script" and `bd migrate --to-dolt` was removed in v0.58.0 (R, https://github.com/gastownhall/beads/blob/main/docs/architecture/dolt.md). A user reports staying on "version 0.49.6 (c064f2aa), the last before the Dolt switch" (R, comment on https://github.com/gastownhall/beads/issues/2573).

The classic design (still in beads_rust) was: SQLite as the local query cache, JSONL committed to git as the sync format, hash IDs to avoid collisions, and a `bd merge` git merge driver for the JSONL (R, beads_rust README; the merge driver existed per https://github.com/gastownhall/beads/issues/671 "bd merge omits priority:0"). The original framing from Yegge: "There's a SQLite cache for fast queries, but the source of truth is version-controlled" (B, https://paddo.dev/blog/beads-memory-for-coding-agents/).

### 2.3 How beads shares state today

- Data model: issues, dependencies (blocks, parent-child, related), graph links (`relates-to`, `duplicates`, `supersedes`, `replies-to`), message issue type with threads, and `bd remember` memories injected by `bd prime` (R, README).
- IDs: hash-based (`bd-a1b2`) and hierarchical (`bd-a3f8.1`) to avoid merge collisions (R, README).
- Storage modes: embedded Dolt ("Single-writer (one process at a time)", file-locked), server mode (`dolt sql-server`, concurrent writers) and a shared server per machine on port 3308 (R, dolt.md "Modes of Operation").
- Sync: `bd dolt push` / `bd dolt pull` to a Dolt remote, by default the same git `origin`, under `refs/dolt/data` (R, sync-concepts.md). Merges are Dolt merges: "cell-level diffs and merges, not line-based" (R, dolt.md).
- Federation: `bd federation add-peer` registers Dolt remotes (DoltHub, S3, GCS, file, SSH, or a peer `dolt sql-server` on remotesapi port 8080). Documented topologies are hub-spoke, mesh and hierarchical. "Without `--strategy`, a sync that hits merge conflicts pauses and reports the conflicting tables for manual resolution", otherwise `--strategy ours|theirs` (R, https://github.com/gastownhall/beads/blob/main/docs/multi-agent/federation.md).
- Leases are deliberately not replicated: "The `leases` table is clone-local and never replicates ... stale on every other replica by up to one sync interval", "Reclaim belongs to the granting replica" (R, federation.md). This is the same single-writer-per-device rule as our Assessment 2, arrived at independently.

Fit with our topology: a Dolt remote can be a file path or SSH URL on kinosmac, so spokes never need to reach each other (R, federation.md lists `file://` and SSH). Whether a spoke can initiate SSH to kinosmac over Tailscale is our network question, not a beads one (unknown, see section 6).

Gas City uses beads as its default store but offers a file-based provider: "set `GC_BEADS=file` ... (no dolt/bd/flock needed)" (R, gascity README). Its shared-store federation setting is validated but "does **not enforce them yet** ... Do not attach a bead store that another city also uses until you run a build that enforces the setting" (R, https://github.com/gastownhall/gascity/blob/main/docs/guides/sharing-a-rig-store.md).

### 2.4 Known problems (adversarial)

Merge and sync:
- Open: "`bd dolt pull` over a git-protocol remote (ssh://) leaves a conflicted merge open; every later write and pull then fails" (R, https://github.com/gastownhall/beads/issues/7839).
- Open: "`bd dolt pull` unmergeable when two machines create children under the same parent in parallel - colliding child ids + `child_counters` conflict" (R, https://github.com/gastownhall/beads/issues/4796). Hash IDs do not cover hierarchical child counters.
- Open: "bd sync drops a clone's own comment when both clones edit the same issue (auto-merge last-write-wins)" (R, https://github.com/gastownhall/beads/issues/7757). Silent data loss under the exact concurrent-edit case a merge layer exists for.
- Open: schema migrations fork history: migration 0062 "makes a store unmergeable with any clone that has un-pulled commits ... unresolvable by --ours or --theirs" (R, https://github.com/gastownhall/beads/issues/6727); similar closed case for 0043 (R, https://github.com/gastownhall/beads/issues/4259). Multi-device stores need lock-step upgrades.
- Open, filed today: "concurrent writers commit Dolt conflict artifacts" (R, https://github.com/gastownhall/beads/issues/8590).
- Open: "federation sync deletes local excluded-type issues on the second sync" (R, https://github.com/gastownhall/beads/issues/7873).
- The official merge-conflict runbook is "`bd doctor --fix`" and "Avoid concurrent modifications from multiple clones without the Dolt server running" (R, https://github.com/gastownhall/beads/blob/main/docs/recovery/merge-conflicts.md).

JSONL churn and drift:
- JSONL is now a lagging export: `export.interval` "is only a *minimum* time between refreshes ... the file can lag the database indefinitely", and JSONL import "is upsert-only; it cannot infer that records absent from an export were deleted" (R, sync-concepts.md). So JSONL in git is not a safe sync channel for beads any more.
- Open: auto-export does not notice a JSONL rewound by `git stash` (R, https://github.com/gastownhall/beads/issues/8585); a deleted issue's orphan JSONL record "permanently wedges auto-export" (R, https://github.com/gastownhall/beads/issues/5308).
- Pre-Dolt, `--append-notes` "silently drops writes in rapid succession" (R, closed, https://github.com/gastownhall/beads/issues/3964).

Footprint and operations:
- Release tarball 46MB for `bd` (R, v1.3.4 assets), and server mode needs `dolt` (39MB tarball, R, Dolt v2.7.6 assets), so beads is near our 60MB module budget before RSS.
- Open: "dolt sql-server memory grows without bound with many databases - beads never sets GOMEMLIMIT" (R, https://github.com/gastownhall/beads/issues/7287); orphaned embedded servers "several at ~38% CPU / ~2 GB RSS" (R, https://github.com/gastownhall/beads/issues/4282); a doctor check drove Dolt "to 120GB RSS via recursive CTE" (R, https://github.com/gastownhall/beads/issues/4475).
- User report after the Dolt move: "Tasks disappear, dolt is often breaking access to tasks, or the db is unreachable", 23 comments, with others pinning v0.49.6 or moving to beads_rust (R, https://github.com/gastownhall/beads/issues/2573).

Agent adherence:
- Beads relies on instruction files and hooks (`bd setup claude`, `bd prime`) to get agents to use it (R, README). Open: "agent mode never turns on under Claude Code, because bd checks CLAUDE_CODE and Claude Code sets CLAUDECODE" (R, https://github.com/gastownhall/beads/issues/8296). Open: `bd prime` hardcodes "Do NOT use MEMORY.md files", which collides with Claude Code auto memory (R, https://github.com/gastownhall/beads/issues/5169). So beads competes with harness memory instead of composing with it.
- Yegge's own mitigation is a ritual, "land the plane", at session end (B, https://paddo.dev/blog/beads-memory-for-coding-agents/). Adherence is a prompt-engineering property, not a store property. I found no measured adherence rate (unknown).
- Complexity: "Simplify CLI UX: overwhelming number of commands and flags" (R, closed, https://github.com/gastownhall/beads/issues/780).

Verdict on beads for M6: the data model (hash IDs, claims, dependency graph, `bd ready`, messages, per-replica leases) is the best reference design found. The current Dolt implementation is too heavy and too unstable across machines for our budget. beads_rust keeps the simpler SQLite plus JSONL model but inherits git-merge semantics on JSONL.

## 3. Alternatives

Hub-and-spoke column: "yes" means it works when only kinosmac talks to each spoke (spokes never talk to each other), with the hub storing and relaying.

| Option | Data model | Hub-and-spoke | Conflict semantics | Footprint | Maturity (2026-11-22) | Fit |
| --- | --- | --- | --- | --- | --- | --- |
| beads (Dolt) | SQL tables with versioned history | yes, via Dolt remote on hub (file, SSH) | cell-level 3-way merge, else manual or ours/theirs | bd 46MB + dolt 39MB tarballs; server RSS issues | 28.9k stars, very active, 1,795 open issues | reference model, too heavy |
| beads_rust | SQLite + JSONL in git | yes, via git | git merge on JSONL lines | 16MB tarball | 1,161 stars, active | candidate for B |
| Automerge | JSON-like CRDT documents | yes, a repo forwards to its peers | automatic, LWW per map key, list/text merge | Rust core, JS and others; size unknown | 6.7k stars, v3.5.0 2026-09 | only for D-style shared docs |
| Yjs | shared types (map, array, text) | yes, typically via y-websocket server | automatic CRDT merge | JS; Rust port Yrs; size unknown | 23k stars, v13.6.33 2026-09 | editor-centric, poor fit |
| Loro | CRDT doc with map, list, text, tree, version vectors | yes, transport-agnostic | automatic; Map key conflict hides one value | Rust + WASM; size unknown | 6.3k stars, active | same as Automerge |
| cr-sqlite | SQLite tables as CRDTs (LWW columns) | yes, transport is yours | per-column LWW with causal length | loadable extension; size unknown | 3.8k stars, last release v0.16.3 2024-01 | stalled, avoid |
| ElectricSQL | Postgres read-path sync | needs Postgres server | server authoritative | Postgres required | 10.4k stars, now `neondatabase/electric` | fails "no external server" |
| PowerSync | client SQLite synced to a backend DB via service | needs service + backend DB | server authoritative | server stack | service 406 stars | fails "no external server" |
| Turso sync | SQLite-compatible DB with push/pull | yes, hub runs `tursodb --sync-server` | unknown, not documented on pages read | CLI tarball 5MB | 25k stars, v0.8.4 2026-11-20 | worth a look for A |
| Litestream | WAL shipping, one writer | one-way backup only | none, single writer | 16MB tarball | 14.7k stars, v0.5.18 2026-11 | backup, not sync |
| LiteFS | FUSE replicated SQLite, one primary | single primary | none, single writer | needs FUSE | 4.9k stars, beta | fails macOS fit |
| Syncthing | files | yes, hub has all folders | whole-file, loser renamed `.sync-conflict-*` | 12MB zip | 90.7k stars, v2.1.7 2026-10 | transport for append-only files |
| git (files, notes) | files or `refs/notes` | yes, bare repo on hub | line merge; notes: manual, ours, theirs, union, cat_sort_uniq | already installed | n/a | default transport |
| git-bug | op-based entities in git refs, Lamport clocks | yes, any git remote | deterministic op ordering, no textual conflicts | 22MB binary | 10.9k stars, v0.12.0 2026-11-07 | design model for B and C |
| Dolt alone | versioned SQL | yes, remotes | cell-level merge | 39MB tarball + server RSS | 25k stars, v2.7.6 2026-11-21 | same cost as beads |
| MCP Agent Mail (Rust) | identities, inboxes, threads, file leases; git archive + SQLite index | per machine server; cross-machine unknown | leases advisory, messages append-only | 55MB tarball | 275 stars, active; Python original deprecated | candidate for C, single device |
| Claude Code memory | Markdown files, `MEMORY.md` index | none, machine-local | none | built in | product feature | source and sink, not a store |
| Codex memories | generated files in `$CODEX_HOME/memories*` | none, machine-local | none | built in | product feature, off by default | source, not a store |
| basic-memory | Markdown files + SQLite index, MCP | via files (git or Syncthing) or their cloud | file-level | Python; size unknown | 4.7k stars, AGPL-3.0 | candidate for D |
| mem0 | vector memories extracted by an LLM | library or Docker server | LLM decides update vs add | needs LLM + embeddings, Qdrant | 69k stars | fails local-first spirit |
| Letta | stateful agent server, memory blocks, MemFS in git | central server | server authoritative | Docker + Postgres/pgvector | 25.5k stars | fails "no external server" |

Sources for each row:

- Automerge: `Repo` takes a `StorageAdapter` and "zero or more `NetworkAdapter`s"; changes "will be stored in the attached storage adapter and distributed to other peers" (R, https://automerge.org/docs/reference/repositories/). "network" means "any other instance of `Repo` which I am communicating with by message passing", with websocket server/client adapters (R, https://automerge.org/docs/reference/repositories/networking/). The repo README ships a `sync-server` example and a NodeFS storage adapter (R, https://github.com/automerge/automerge-repo). Hub relaying to spokes that never meet each other follows from that design (K, not tested). Repo stars (R).
- Yjs: repo metadata (R, https://github.com/yjs/yjs). Topology via y-websocket and Yrs is K.
- Loro: "Due to CRDT properties, document consistency is guaranteed when peers receive the same updates, regardless of order or duplicates", and "If two offline peers create regular child containers under the same Map key, sync will converge to one visible Map value and the other child can be hidden by the Map conflict rule" (R, https://loro.dev/docs/tutorial/sync). Convergence with a silently hidden write is precisely a semantic-loss case.
- cr-sqlite: last release v0.16.3 on 2024-01-17, recent commits are build fixes, and an issue titled "Is this project dead?" (R, https://github.com/vlcn-io/cr-sqlite/issues/444). LWW column semantics are K.
- ElectricSQL: "Electric is a read-path sync engine for Postgres" and requires "a Postgres database with logical replication enabled" (R, https://github.com/neondatabase/electric).
- PowerSync: repo metadata (R, https://github.com/powersync-ja/powersync-service); "requires a backend database" is K.
- Turso: "With Turso Sync, all reads and writes happen locally by default - you control when to sync with explicit `push()` and `pull()` calls" (R, https://docs.turso.tech/sync/usage). "The `tursodb` CLI includes a built-in sync server ... no Turso Cloud account required", but framed "for development and testing" (R, https://docs.turso.tech/sync/local-sync-server). Conflict semantics for concurrent pushes: unknown. Production readiness claim (R, README, vendor).
- Litestream: "a standalone disaster recovery tool for SQLite" replicating the WAL "to a local file or a supported remote storage backend" (R, https://github.com/benbjohnson/litestream).
- LiteFS: "FUSE-based file system", "currently in a beta state" (R, https://github.com/superfly/litefs). macOS needs a FUSE kernel extension (K).
- Syncthing: conflict handling renames the older copy to `<filename>.sync-conflict-<date>-<time>-<modifiedBy>.<ext>`, and those files "are treated as normal files ... so they are propagated between devices"; watcher batches changes for 10s, deletes for 1min (R, https://docs.syncthing.net/users/syncing.html). Relaying via a hub that shares the folder with every spoke is K.
- git notes: "The following strategies are recognized: manual (default), ours, theirs, union and cat_sort_uniq" (R, `git help notes`, https://git-scm.com/docs/git-notes).
- git-bug: entities are "a series of edit operations ... a common idea, notably with Operation-based CRDTs", stored as git commits under refs, ordered by Lamport clocks then "the lexicographic order of the `OperationPack`'s identifier", and "use git remotes as a medium for synchronisation" (R, https://github.com/git-bug/git-bug/blob/master/doc/design/data-model.md).
- MCP Agent Mail: "MCP server with 47 tools and 25 resources, Git-backed archive, SQLite indexing", "advisory file reservations (leases)", "Server starts on 127.0.0.1:8765", Linux and macOS binaries (R, https://github.com/Dicklesworthstone/mcp_agent_mail_rust). The Python original is marked "Deprecated: superseded by mcp_agent_mail_rust" (R, https://github.com/Dicklesworthstone/mcp_agent_mail). Multi-machine story: unknown. 275 stars, above the 10-star bar but young.
- Claude Code: "Auto memory is machine-local ... Files are not shared across machines or cloud environments"; location `~/.claude/projects/<project>/memory/`, overridable with `autoMemoryDirectory`; first 200 lines or 25KB of `MEMORY.md` load at start (R, https://code.claude.com/docs/en/memory). `autoMemoryDirectory` means the directory could point at a synced folder (R for the setting, K that it behaves well when synced).
- Codex: "local Codex clients use a separate local memory store", stored under `$CODEX_HOME/memories_v2/` or `memories/`, "Treat these files as generated state", off by default (R, https://developers.openai.com/codex/memories, served from learn.chatgpt.com).
- basic-memory: "Local-first. Plain text on your disk", "Cloud, optional. Sync across devices when you want" (R, https://github.com/basicmachines-co/basic-memory). AGPL-3.0 (R, API metadata).
- mem0: library defaults are OpenAI LLM and embeddings, "Local Qdrant at `/tmp/qdrant`", "SQLite at `~/.mem0/history.db`"; server is "A Docker stack" with Postgres + pgvector (R, https://docs.mem0.ai/open-source/overview).
- Letta: self-hosting is `docker run ... letta/letta:latest` with Postgres data, pgvector for your own Postgres; MemFS is "git-backed", but in local mode "the git HTTP proxy endpoint returns 501" (R, https://docs.letta.com/guides/selfhosting).

## 4. The case against CRDTs here

- We have a natural global order per partition. CRDTs earn their cost when there is no authority: "CRDTs are complex, in both the runtime overhead and cognitive load senses, but in a peer-to-peer environment, this is a necessary cost", and with a central server "we can sidestep the need to pay the CRDT complexity tax" (B, Paul Butler, https://web.archive.org/web/20250117234459/https://jamsocket.com/blog/you-might-not-need-a-crdt). Our hub is an authority for placement, and each device is an authority for its own sessions.
- Figma, quoted there: "Figma isn't using true CRDTs ... Since Figma is centralized ... we can simplify our system" (B, same URL, quoting https://www.figma.com/blog/how-figmas-multiplayer-technology-works/).
- Convergence is not correctness. "Both paths will allow us to ensure that each replica converges on the same state, but that alone does not guarantee that this state is the 'correct' state from the point of view of user intent" (B, same URL). Composite invariants break: "two innocent changes made concurrently on two replicas could combine to break the invariant" (cycle in a DAG) (B, same URL). A beads-style dependency graph is a DAG, so a CRDT would converge to a cyclic dependency graph without complaint.
- Concrete instance in a CRDT library's own docs: Loro's Map rule hides one of two concurrent child containers (R, https://loro.dev/docs/tutorial/sync). Beads' Dolt auto-merge loses a comment under last-write-wins (R, https://github.com/gastownhall/beads/issues/7757). Both "succeed" while losing intent.
- History cost: "CRDTs accumulate a large change history" (R, Ink and Switch, https://www.inkandswitch.com/essay/local-first/), which fights requirement 1 (TTL and GC). Compaction in Automerge and Loro exists (Loro "Shallow Snapshot", R, Loro README) but adds design work.
- Social locking: concurrent edits of the same object "tends to be rare" in practice (B, Butler). With agents, the equivalent is a claim or lease, which beads, Agent Mail and our Assessment 2 already use.
- The real failure mode for agent memory is semantic, not structural: two agents write "use pnpm" and "use bun" for the same repo, or a stale decision is never superseded. A CRDT merges both bytes perfectly. The fix is supersession links and a curator step (beads already models `supersedes` and an open feature asks dependents to acknowledge a superseded decision, R, https://github.com/gastownhall/beads/issues/8501), plus TTL. Yegge's diagnosis of markdown sprawl applies: "If you got competing documents, obsolete documents, conflicting documents, ambiguous documents - they get dementia" (B, https://paddo.dev/blog/beads-memory-for-coding-agents/).
- Adherence dominates. A store agents do not read is worthless, and beads' own issues show integration bugs that silently disable agent mode (R, #8296). Every option needs a harness hook that injects a small context slice at session start and an exit ritual that writes it, and that cost is the same with or without a CRDT.

The case for CRDTs, to be fair: if two spokes edit the same shared note while the hub is off for days, an op-based CRDT merges without human help, where git line-merge on a single file would conflict and Syncthing would fork a `.sync-conflict` copy. That scenario only exists for kind D and is avoidable by partitioning (each device appends its own file).

## 5. A model that needs no CRDT

Per kind, matching Assessment 2's single-writer rule:

- A. Session records: single writer per device. Publish as a per-device snapshot or append-only log under `context/<device>/sessions.jsonl`. The hub only reads. No merge.
- B. Work items: one file or op log per item with hash IDs (beads, git-bug). Mutations are ops appended by the claimant; non-claimants may only append comments. Order by Lamport clock then op id, as git-bug does (R). Ops are commutative for comments and adds; field updates use LWW per field with the claim as the tiebreaker owner.
- C. Messages: append-only per sender, `context/<device>/<agent>/outbox.jsonl`. Union merge is always correct. Acks are messages too.
- D. Knowledge: one file per fact (as Claude Code auto memory already does, R), written only by its device, with `supersedes:` links and TTL. A curator pass on the hub dedupes and resolves contradictions with an LLM or a human, and writes the result as a new fact. This is the step a CRDT cannot do.

Transport for all of it: a git repo with a bare remote on kinosmac (spokes push and pull, or the hub fetches from spokes over SSH), or Syncthing with kinosmac as the only peer of each spoke. Because every file has exactly one writer, git merges are fast-forward or trivially union, and Syncthing never produces conflict copies (K for both, the spike should confirm).

## 6. Unknowns

- Whether spokes can initiate connections to kinosmac over Tailscale (needed for spoke-initiated git push or Syncthing). T3 link direction is documented (R, framing doc); Tailscale ACLs on this tailnet are not known.
- Turso Sync conflict semantics on concurrent push from two clients, and whether the local sync server is supported outside "development and testing".
- RSS of any candidate on our machines. All sizes above are compressed downloads.
- Agent adherence rate for any shared-context store (no measured numbers found).
- MCP Agent Mail cross-machine operation.
- Automerge and Loro JS or native bundle sizes.

## 7. Recommendation shortlist

1. Partitioned append-only files in git, hub-and-spoke (recommended default). Per-device, per-kind JSONL or one-file-per-fact Markdown, single writer each, bare repo on kinosmac, union semantics, TTL GC by rewriting old segments. Borrow beads' data model (hash IDs, claims, `ready`, `supersedes`) and git-bug's op ordering. Zero new binaries, works offline, no CRDT. beads_rust (16MB) is the off-the-shelf variant if we want the CLI and accept JSONL line merges for kind B.
2. git-bug style op log for work items (kind B) if option 1's per-item LWW turns out to lose claims or comments. It is an op-based CRDT on git with deterministic ordering (R), so it gives automatic merges without a sync server, at 22MB.
3. Automerge (or Loro) for kind D only, gated on the spike showing real concurrent edits of shared documents. The hub runs one repo with NodeFS storage and a websocket adapter, spokes connect to it. Keep it out of A, B and C.

Not recommended: beads with Dolt (footprint and open cross-machine merge bugs), cr-sqlite (stalled), ElectricSQL, PowerSync, Letta, mem0 server (external servers), LiteFS (FUSE, beta), Litestream (backup only, though useful as the backup layer for a SQLite index).

## 8. What a spike would measure (not implemented)

Workload: replay a day of real sessions across the three devices (session records, 50 to 200 work items, a few hundred messages, 20 to 50 memory facts), with scripted concurrent edits and one 24h period with the hub offline.

Measure, per option:

- Convergence latency hub-relayed, p50 and p99, from a write on kinosmac-pro to visibility on ovhcloud.
- Structural conflict rate: git merge conflicts, Syncthing `.sync-conflict-*` files, CRDT hidden writes, Dolt conflict pauses.
- Lost-intent rate: injected concurrent edits whose outcome differs from the scripted intent (lost comment, lost claim, cyclic dependency, hidden map value). This is the number that decides whether a CRDT pays.
- Semantic conflict rate in kind D: contradictory or duplicate facts after a day, before and after the curator pass, and curator cost in tokens.
- Footprint: RSS idle and under write load, disk growth per day, size after TTL GC.
- Durability: kill -9 during write and during sync, then verify no loss and no wedged state (the beads #7839 class).
- Upgrade safety: change the schema on one device only, sync, and check the others still merge (the beads #6727 class).
- Adherence: fraction of sessions per harness (Claude Code, Codex, maki, OpenCode) that read the injected context at start and write back at end, with hooks versus instructions only.
- Cold start for a fresh harness on a different device: tokens and seconds to resume a handed-off session from the shared store versus from the transcript.
