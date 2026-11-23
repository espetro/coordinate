#!/usr/bin/env bun
// fleet adapter CLI over the rivetkit coordinator actor (adapter contract,
// docs/tool-search-rubric.md section 3). Commands: daemon, enqueue, stats.
//
// Deadlines: every client call is wrapped in a hard deadline (default 5s) because
// the rivetkit client retries metadata lookups forever when the engine is down
// (p-retry with forever: true), so without the race the CLI hangs forever. On a
// deadline the CLI prints a clear error and exits non-zero.
//
// Durability note: submit is an action call, journalled by the engine only when
// the actor turn completes, so `enqueue` additionally appends the job to a JSONL
// spool file next to FLEET_DB before returning; the daemon replays the spool at
// start (dedup by id) and compacts it after replay. This is glue the engine does
// not provide for fire-and-forget enqueue.
import { createClient } from "rivetkit/client";
import type { registry } from "./qserver.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync as readProc } from "node:fs";
import { createServer } from "node:net";

const DEADLINE_MS = parseInt(process.env.RIVET_FILL_DEADLINE_MS ?? "5000", 10);
const READY_TIMEOUT_S = parseInt(process.env.RIVET_FILL_READY_TIMEOUT_S ?? "120", 10);
// the client call is raced against DEADLINE_MS, but the process must also be gone
// by then even if the websocket teardown hangs
const HARD_EXIT_MS = DEADLINE_MS + 1500;

const SPOOL = (): string => `${dataDir()}/enqueue-spool.jsonl`;
const PORT_FILE = (): string => `${dataDir()}/rivet-fill-port`;

/** The endpoint of the daemon that owns this data dir, from the port file it writes. */
function endpoint(): string {
	if (process.env.RIVET_ENDPOINT) return process.env.RIVET_ENDPOINT;
	const f = PORT_FILE();
	if (!existsSync(f)) {
		throw new Error(`rivet-fill: no daemon endpoint for this data dir (${f} missing); start the daemon first`);
	}
	return `http://127.0.0.1:${readFileSync(f, "utf8").trim()}`;
}

/** A free TCP port, so parallel or stale daemons on the shared host never collide. */
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const s = createServer();
		s.on("error", reject);
		s.listen(0, "127.0.0.1", () => {
			const p = (s.address() as any).port;
			s.close(() => resolve(p));
		});
	});
}

type SpoolRec = { id: number; cmd: string; cwd: string; repo: string; priority: number };

function dataDir(): string {
	const d = process.env.RIVET_DATA_DIR ?? (() => {
		const db = process.env.FLEET_DB;
		if (!db) { console.error("rivet-fill: RIVET_DATA_DIR or FLEET_DB not set"); process.exit(2); }
		return db.split("/").slice(0, -1).join("/") || "/tmp";
	})();
	mkdirSync(d, { recursive: true });
	return d;
}

/** Call the engine with a hard deadline; the rivetkit client never gives up on its own. */
async function call<T>(fn: (c: any) => Promise<T>, deadlineMs = DEADLINE_MS): Promise<T> {
	const ep = endpoint();
	const client = createClient<typeof registry>({ endpoint: ep });
	let timer: any;
	const hard = setTimeout(() => {
		console.error(`rivet-fill: hard deadline of ${HARD_EXIT_MS}ms exceeded (endpoint ${ep}); exiting`);
		process.exit(5);
	}, Math.max(HARD_EXIT_MS, deadlineMs + 1000));
	try {
		return await Promise.race([
			fn(client),
			new Promise<never>((_res, rej) => {
				timer = setTimeout(
					() => rej(new Error(`rivet client deadline of ${deadlineMs}ms exceeded (endpoint ${ep}); is the daemon running?`)),
					deadlineMs,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
		clearTimeout(hard);
		// dispose may wait on a dead websocket, so it never gets to block the exit
		try { Promise.race([client.dispose(), new Promise((r) => setTimeout(r, 500))]).catch(() => {}); } catch {}
	}
}

/** Direct children of pid, from /proc, so we only ever signal processes we spawned. */
function childrenOf(pid: number): number[] {
	const out: number[] = [];
	let pids: string[] = [];
	try { pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p)); } catch { return out; }
	for (const p of pids) {
		try {
			const stat = readProc(`/proc/${p}/stat`, "utf8");
			const ppid = parseInt(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1], 10);
			if (ppid === pid) out.push(parseInt(p, 10));
		} catch {}
	}
	return out;
}

function cmdlineOf(pid: number): string {
	try { return readProc(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " "); } catch { return ""; }
}

/** Every live process whose cmdline mentions the marker, so we only ever touch our own run. */
function processesWithMarker(marker: string): number[] {
	const out: number[] = [];
	let pids: string[] = [];
	try { pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p)); } catch { return out; }
	for (const p of pids) {
		const pid = parseInt(p, 10);
		if (pid === process.pid) continue;
		if (cmdlineOf(pid).includes(marker)) out.push(pid);
	}
	return out;
}

/** Kill the engine of a previous run of this data dir: it puts itself in its own
 * session, so it survives a group kill and would hold the old port forever. */
function killStaleEngines(dir: string): void {
	for (const pid of processesWithMarker(`${dir}/rivetstore`)) {
		if (!cmdlineOf(pid).includes("rivet-engine")) continue;
		try { process.kill(pid, "SIGKILL"); } catch {}
	}
}

async function cmdDaemon(): Promise<void> {
	const dir = dataDir();
	process.env.RIVET_DATA_DIR = dir;
	killStaleEngines(dir);
	const port = await freePort();
	writeFileSync(PORT_FILE(), String(port));
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
	// the runner must not see RIVET_ENDPOINT, otherwise rivetkit assumes an external
	// engine and never spawns the local one (observed: pool configuration never ready)
	delete env.RIVET_ENDPOINT;
	env.RIVET_RUN_ENGINE = "1";
	env.RIVET_RUN_SERVICES = "0";
	env.RIVET_RUN_ENGINE_PORT = String(port);
	env.RIVETKIT_STORAGE_PATH = `${dir}/rivetstore`;
	env.RIVET_DATA_DIR = dir;
	env.RIVETKIT_LOG_LEVEL = process.env.RIVETKIT_LOG_LEVEL ?? "error";
	env.RIVET_LOG_LEVEL = process.env.RIVET_LOG_LEVEL ?? "error";

	const bun = process.execPath;
	const here = new URL(".", import.meta.url).pathname;
	const server = spawn(bun, [`${here}qserver.ts`], { env, stdio: "inherit" });
	const cleanup = () => {
		try { unlinkSync(PORT_FILE()); } catch {}
		// the engine puts itself in its own session, so it survives a group kill;
		// stop it by pid, only the children of the runner we spawned
		for (const pid of childrenOf(server.pid ?? -1)) {
			if (cmdlineOf(pid).includes("rivet-engine")) { try { process.kill(pid, "SIGKILL"); } catch {} }
		}
	};

	// wait for the registry to answer, then replay the enqueue spool
	const deadline = Date.now() + READY_TIMEOUT_S * 1000;
	let ready = false;
	while (Date.now() < deadline) {
		if (server.exitCode !== null) break;
		try {
			await call(async (c) => c.coordinator.getOrCreate("main").stats(), 2000);
			ready = true;
			break;
		} catch {
			await new Promise((r) => setTimeout(r, 250));
		}
	}
	if (!ready) {
		console.error(`rivet-fill: daemon did not become ready within ${READY_TIMEOUT_S}s`);
		server.kill("SIGTERM");
		cleanup();
		process.exit(3);
	}
	// replay: the spool only holds jobs the engine never acknowledged, so replay
	// is exactly the fire-and-forget backlog of an engine-down period
	if (existsSync(SPOOL())) {
		const recs: SpoolRec[] = readFileSync(SPOOL(), "utf8").split("\n")
			.filter((l) => l.trim()).map((l) => JSON.parse(l));
		if (recs.length) {
			await call(async (c) => {
				const h = c.coordinator.getOrCreate("main");
				for (const r of recs) await h.submit(r.cmd, r.cwd, r.repo, r.priority);
			}, Math.max(DEADLINE_MS, recs.length * 200));
			// compact: the engine journal now owns these jobs
			writeFileSync(SPOOL(), "");
		}
	}
	await new Promise<void>((resolve) => {
		const stop = (sig: string) => {
			try { server.kill(sig as any); } catch {}
			setTimeout(() => { cleanup(); resolve(); }, 1500);
		};
		process.on("SIGTERM", () => stop("SIGTERM"));
		process.on("SIGINT", () => stop("SIGINT"));
		server.on("exit", () => { cleanup(); resolve(); });
	});
	process.exit(0);
}

async function cmdEnqueue(cwd: string, cmd: string, priority: number): Promise<void> {
	const dir = dataDir();
	const repo = cwd; // FLEET_REPO_CAP key is the absolute cwd
	// spool first: enqueue must be durable even if the engine is down (G4)
	const id = Date.now() * 1000 + Math.floor(Math.random() * 1000);
	const rec: SpoolRec = { id, cmd, cwd, repo, priority };
	appendFileSync(SPOOL(), JSON.stringify(rec) + "\n");
	try {
		const jid = await call(async (c) =>
			c.coordinator.getOrCreate("main").submit(cmd, cwd, repo, priority));
		// the engine journalled the action, so the job is durable there now: drop the
		// spool record, otherwise a daemon restart would submit it a second time
		dropSpoolRecord(id);
		console.log(jid);
	} catch (e) {
		// engine down or over deadline: job stays in the spool, the next daemon replays it
		console.error(`rivet-fill: enqueue not acknowledged by the engine (${String(e)}); spooled as ${id}`);
		console.log(id);
	}
	process.exit(0);
}

/** Remove one acknowledged record from the spool file. */
function dropSpoolRecord(id: number): void {
	try {
		const lines = readFileSync(SPOOL(), "utf8").split("\n").filter((l) => l.trim());
		const kept = lines.filter((l) => { try { return JSON.parse(l).id !== id; } catch { return true; } });
		writeFileSync(SPOOL(), kept.length ? kept.join("\n") + "\n" : "");
	} catch {}
}

async function cmdStats(): Promise<void> {
	try {
		const s = await call(async (c) => c.coordinator.getOrCreate("main").stats());
		console.log(JSON.stringify(s));
		process.exit(0);
	} catch (e) {
		console.log(JSON.stringify({ error: String(e) }));
		process.exit(4);
	}
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "daemon") await cmdDaemon();
else if (cmd === "enqueue") {
	// parse: enqueue --cwd DIR [--priority N] --shell -- CMD...
	const cwdIdx = args.indexOf("--cwd");
	const cwd = args[cwdIdx + 1];
	const pIdx = args.indexOf("--priority");
	const priority = pIdx >= 0 ? parseInt(args[pIdx + 1], 10) : 0;
	const dd = args.indexOf("--");
	const cmdStr = args.slice(dd + 1).join(" ");
	await cmdEnqueue(cwd, cmdStr, priority);
} else if (cmd === "stats") await cmdStats();
else { console.error("usage: rivet-fill daemon|enqueue|stats"); process.exit(2); }
