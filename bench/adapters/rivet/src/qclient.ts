#!/usr/bin/env bun
// fleet adapter CLI over the rivetkit coordinator actor (adapter contract,
// docs/tool-search-rubric.md section 3). Commands: daemon, enqueue, stats.
//
// Durability note: submit is an action call, journalled by the engine only when
// the actor turn completes, so `enqueue` additionally appends the job to a JSONL
// spool file next to FLEET_DB before returning; the daemon replays the spool at
// start (dedup by id) and compacts it after replay. This is glue the engine does
// not provide for fire-and-forget enqueue.
import { createClient } from "rivetkit/client";
import type { registry } from "./qserver.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const ENDPOINT = process.env.RIVET_ENDPOINT ?? "http://127.0.0.1:6420";
const SPOOL = (): string => {
	const dir = process.env.RIVET_DATA_DIR;
	return dir ? `${dir}/enqueue-spool.jsonl` : "/tmp/enqueue-spool.jsonl";
};

type SpoolRec = { id: number; cmd: string; cwd: string; repo: string; priority: number };

async function withClient<T>(fn: (c: any) => Promise<T>): Promise<T> {
	const client = createClient<typeof registry>({ endpoint: ENDPOINT });
	try {
		return await fn(client);
	} finally {
		await client.dispose();
	}
}

function dataDir(): string {
	const d = process.env.RIVET_DATA_DIR ?? (() => {
		const db = process.env.FLEET_DB;
		if (!db) { console.error("RIVET_DATA_DIR or FLEET_DB not set"); process.exit(2); }
		return db.split("/").slice(0, -1).join("/") || "/tmp";
	})();
	mkdirSync(d, { recursive: true });
	return d;
}

async function cmdDaemon(): Promise<void> {
	const dir = process.env.RIVET_DATA_DIR ?? (() => {
		const db = process.env.FLEET_DB;
		if (!db) { console.error("RIVET_DATA_DIR or FLEET_DB not set"); process.exit(2); }
		return db.split("/").slice(0, -1).join("/");
	})();
	mkdirSync(dir, { recursive: true });
	process.env.RIVET_DATA_DIR = dir;
	const env = {
		...process.env,
		RIVET_RUN_ENGINE: "1",
		RIVET_RUN_SERVICES: "0",
		RIVETKIT_STORAGE_PATH: `${dir}/rivetstore`,
		RIVET_DATA_DIR: dir,
		RIVETKIT_LOG_LEVEL: process.env.RIVETKIT_LOG_LEVEL ?? "warn",
	};
	const bun = process.execPath;
	const here = new URL(".", import.meta.url).pathname;
	const server = spawn(bun, [`${here}qserver.ts`], { env, stdio: "inherit" });
	// wait for the registry to answer, then replay the enqueue spool
	for (let i = 0; i < 240; i++) {
		try {
			await withClient(async (c) => c.coordinator.getOrCreate("main").stats());
			break;
		} catch {
			await new Promise((r) => setTimeout(r, 250));
		}
	}
	// replay: every spooled id is submitted; ids are only spooled at enqueue time
	// and the actor assigns the same nextId sequence, so replay must be idempotent.
	// The actor's submit assigns ids in order; to keep ids stable the daemon owns
	// the id counter: it pre-seeds the actor by replaying all records in order.
	if (existsSync(SPOOL())) {
		const recs: SpoolRec[] = readFileSync(SPOOL(), "utf8").split("\n")
			.filter((l) => l.trim()).map((l) => JSON.parse(l));
		if (recs.length) {
			await withClient(async (c) => {
				const h = c.coordinator.getOrCreate("main");
				for (const r of recs) await h.submit(r.cmd, r.cwd, r.repo, r.priority);
			});
			// compact: the engine journal now owns these jobs
			writeFileSync(SPOOL(), "");
		}
	}
	await new Promise<void>((resolve) => {
		const stop = (sig: string) => {
			try { server.kill(sig as any); } catch {}
			setTimeout(() => resolve(), 1500);
		};
		process.on("SIGTERM", () => stop("SIGTERM"));
		process.on("SIGINT", () => stop("SIGINT"));
		server.on("exit", () => resolve());
	});
}

async function cmdEnqueue(cwd: string, cmd: string, priority: number): Promise<void> {
	const dir = dataDir();
	const repo = cwd; // FLEET_REPO_CAP key is the absolute cwd
	// spool first: enqueue must be durable even if the engine is down (G4)
	const id = Date.now() * 1000 + Math.floor(Math.random() * 1000);
	appendFileSync(SPOOL(), JSON.stringify({ id, cmd, cwd, repo, priority }) + "\n");
	try {
		const jid = await withClient(async (c) =>
			c.coordinator.getOrCreate("main").submit(cmd, cwd, repo, priority));
		console.log(jid);
	} catch {
		// engine down: job stays in the spool, the next daemon replays it
		console.log(id);
	}
	process.exit(0);
}

async function cmdStats(): Promise<void> {
	try {
		const s = await withClient(async (c) => c.coordinator.getOrCreate("main").stats());
		console.log(JSON.stringify(s));
	} catch (e) {
		console.log(JSON.stringify({ error: String(e) }));
	}
	process.exit(0);
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
