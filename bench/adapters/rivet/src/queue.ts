// Queue coordinator actor: holds the run queue, machine cap, per-repo caps and
// weighted tool leases in one actor. rivetkit 3.x deprecated queues ("use actions
// and store pending work in SQLite (c.db)"), so this one-actor-coordinator shape
// is the idiomatic replacement.
//
// IMPORTANT: the engine serializes actor handlers by source (onWake failed at
// runtime with "reconcile is not defined" when it called module-level helpers),
// so every handler below is fully self-contained: no module functions, no shared
// module state. Scheduling logic is duplicated inline in submit and onWake.
import { actor } from "rivetkit";
import { spawn } from "node:child_process";
import * as fs from "node:fs";

interface Job {
	id: number;
	cmd: string;
	cwd: string;
	repo: string;
	priority: number;
	attempts: number;
	pid: number | null;
}

interface CoordVars {
	nextId: number;
	jobs: Map<number, Job>;
	runningRepo: Map<string, number>; // repo -> running count
	toolHeld: Map<string, number>; // "cls|repo" -> held cost
	procs: Map<number, number>; // job id -> pid
	cap: number;
	repoCap: number;
	slots: Record<string, number>;
	dataDir: string;
	killed: boolean;
}

const TOOL_COST_JSON = JSON.stringify({
	vitest: 2, jest: 2, tsc: 2, cargo: 2, pytest: 2, eslint: 2, webpack: 2,
	vite: 2, make: 2, cmake: 2, gradle: 2, maven: 2, docker: 2, terraform: 2,
	playwright: 2, cypress: 2, next: 2, ruff: 1, go: 1,
});

function readSlots(): Record<string, number> {
	const path = process.env.FLEET_CONFIG;
	if (!path) return {};
	try {
		const txt = fs.readFileSync(path, "utf8");
		const out: Record<string, number> = {};
		let inSlots = false;
		for (const line of txt.split("\n")) {
			if (/^\s*\[/.test(line)) { inSlots = line.trim() === "[slots]"; continue; }
			if (!inSlots) continue;
			const m = line.match(/^\s*'?([^'=]+?)'?\s*=\s*(\d+)/);
			if (m) out[m[1].trim()] = parseInt(m[2], 10);
		}
		return out;
	} catch { return {}; }
}

export const coordinator = actor({
	createVars: (): CoordVars => ({
		nextId: 1,
		jobs: new Map(),
		runningRepo: new Map(),
		toolHeld: new Map(),
		procs: new Map(),
		cap: parseInt(process.env.FLEET_CAP ?? "4", 10),
		repoCap: parseInt(process.env.FLEET_REPO_CAP ?? "1", 10),
		slots: readSlots(),
		dataDir: process.env.RIVET_DATA_DIR ?? "/tmp",
		killed: false,
	}),
	actions: {
		submit: (c: any, cmd: string, cwd: string, repo: string, priority: number): number => {
			const v = c.vars as CoordVars;
			if (v.killed) v.killed = false; // a submit after a destroy means a fresh life
			const id = v.nextId++;
			v.jobs.set(id, { id, cmd, cwd, repo, priority, attempts: 0, pid: null });
			// ---- inline scheduler (handlers must be self-contained) ----
			const costs = JSON.parse(TOOL_COST_JSON) as Record<string, number>;
			const toolOf = (cmdStr: string): [string, number] | null => {
				const tok = cmdStr.trim().split(/\s+/);
				if (!tok.length) return null;
				const name = tok[0].split("/").pop()!.split(":").pop()!;
				const cost = costs[name];
				return cost ? [name, cost] : null;
			};
			const trySchedule = (): void => {
				if (v.killed) return;
				const ready = [...v.jobs.values()]
					.filter((j) => !v.procs.has(j.id) && j.attempts === 0)
					.sort((a, b) => b.priority - a.priority || a.id - b.id);
				for (const j of ready) {
					if (v.procs.size >= v.cap) break;
					if ((v.runningRepo.get(j.repo) ?? 0) >= v.repoCap) continue;
					const tk = toolOf(j.cmd);
					let key: string | null = null;
					if (tk) {
						const [cls, cost] = tk;
						key = `${cls}|${j.repo}`;
						const limit = v.slots[`${cls}:*`] ?? v.slots[`tool:${cls}:*`] ?? 1;
						if ((v.toolHeld.get(key) ?? 0) + cost > limit) continue; // park
					}
					if (tk && key) v.toolHeld.set(key, (v.toolHeld.get(key) ?? 0) + tk[1]);
					v.runningRepo.set(j.repo, (v.runningRepo.get(j.repo) ?? 0) + 1);
					// admit: spawn detached, own session/pgroup (excluded from daemon RSS)
					j.attempts++;
					const logFd = fs.openSync(`${v.dataDir}/job-${j.id}.log`, "a");
					const child = spawn("/bin/sh", ["-c", j.cmd], {
						cwd: j.cwd,
						env: process.env,
						stdio: ["ignore", logFd, logFd],
						detached: true,
					});
					child.unref();
					j.pid = child.pid ?? null;
					v.procs.set(j.id, child.pid ?? -1);
					fs.writeFileSync(`${v.dataDir}/job-${j.id}.start`, String(j.attempts));
				}
			};
			const finish = (j: Job): void => {
				v.procs.delete(j.id);
				v.runningRepo.set(j.repo, Math.max(0, (v.runningRepo.get(j.repo) ?? 1) - 1));
				const tk = toolOf(j.cmd);
				if (tk) {
					const key = `${tk[0]}|${j.repo}`;
					v.toolHeld.set(key, Math.max(0, (v.toolHeld.get(key) ?? tk[1]) - tk[1]));
					if ((v.toolHeld.get(key) ?? 0) <= 0) v.toolHeld.delete(key);
				}
				try { fs.unlinkSync(`${v.dataDir}/job-${j.id}.start`); } catch {}
			};
			trySchedule();
			// ---- inline driver loop: reap by pid, reschedule every 50ms ----
			const drive = (): void => {
				if (v.killed) return;
				for (const j of v.jobs.values()) {
					if (!v.procs.has(j.id) || !j.pid) continue;
					try { process.kill(j.pid, 0); } catch { finish(j); }
				}
				trySchedule();
				const busy = v.procs.size > 0 || [...v.jobs.values()].some((j) => j.attempts === 0);
				if (busy) setTimeout(drive, 50);
			};
			drive();
			return id;
		},
		stats: (c: any) => {
			const v = c.vars as CoordVars;
			let running = 0, queued = 0, done = 0;
			for (const j of v.jobs.values()) {
				if (v.procs.has(j.id)) running++;
				else if (j.attempts > 0) done++;
				else queued++;
			}
			return { running, queued, done, total: v.jobs.size, cap: v.cap };
		},
	},
	onWake: (c: any) => {
		// Engine restart or hibernation wake. Self-contained (see file header):
		// a job whose .start marker exists was mid-flight when we died, so clear
		// bookkeeping and let the scheduler run it again (at-least-once).
		const v = c.vars as CoordVars;
		for (const j of v.jobs.values()) {
			if (v.procs.has(j.id)) continue;
			if (fs.existsSync(`${v.dataDir}/job-${j.id}.start`)) {
				j.attempts = 0;
				j.pid = null;
			}
		}
		v.runningRepo.clear();
		v.toolHeld.clear();
		v.procs.clear();
		// same inline scheduler/driver as submit, reading costs from the constant
		const costs = JSON.parse(TOOL_COST_JSON) as Record<string, number>;
		const toolOf = (cmdStr: string): [string, number] | null => {
			const tok = cmdStr.trim().split(/\s+/);
			if (!tok.length) return null;
			const name = tok[0].split("/").pop()!.split(":").pop()!;
			const cost = costs[name];
			return cost ? [name, cost] : null;
		};
		const trySchedule = (): void => {
			const ready = [...v.jobs.values()]
				.filter((j) => !v.procs.has(j.id) && j.attempts === 0)
				.sort((a, b) => b.priority - a.priority || a.id - b.id);
			for (const j of ready) {
				if (v.procs.size >= v.cap) break;
				if ((v.runningRepo.get(j.repo) ?? 0) >= v.repoCap) continue;
				const tk = toolOf(j.cmd);
				let key: string | null = null;
				if (tk) {
					const [cls, cost] = tk;
					key = `${cls}|${j.repo}`;
					const limit = v.slots[`${cls}:*`] ?? v.slots[`tool:${cls}:*`] ?? 1;
					if ((v.toolHeld.get(key) ?? 0) + cost > limit) continue;
				}
				if (tk && key) v.toolHeld.set(key, (v.toolHeld.get(key) ?? 0) + tk[1]);
				v.runningRepo.set(j.repo, (v.runningRepo.get(j.repo) ?? 0) + 1);
				j.attempts++;
				const logFd = fs.openSync(`${v.dataDir}/job-${j.id}.log`, "a");
				const child = spawn("/bin/sh", ["-c", j.cmd], {
					cwd: j.cwd, env: process.env, stdio: ["ignore", logFd, logFd], detached: true,
				});
				child.unref();
				j.pid = child.pid ?? null;
				v.procs.set(j.id, child.pid ?? -1);
				fs.writeFileSync(`${v.dataDir}/job-${j.id}.start`, String(j.attempts));
			}
		};
		const finish = (j: Job): void => {
			v.procs.delete(j.id);
			v.runningRepo.set(j.repo, Math.max(0, (v.runningRepo.get(j.repo) ?? 1) - 1));
			const tk = toolOf(j.cmd);
			if (tk) {
				const key = `${tk[0]}|${j.repo}`;
				v.toolHeld.set(key, Math.max(0, (v.toolHeld.get(key) ?? tk[1]) - tk[1]));
				if ((v.toolHeld.get(key) ?? 0) <= 0) v.toolHeld.delete(key);
			}
			try { fs.unlinkSync(`${v.dataDir}/job-${j.id}.start`); } catch {}
		};
		const drive = (): void => {
			for (const j of v.jobs.values()) {
				if (!v.procs.has(j.id) || !j.pid) continue;
				try { process.kill(j.pid, 0); } catch { finish(j); }
			}
			trySchedule();
			const busy = v.procs.size > 0 || [...v.jobs.values()].some((j) => j.attempts === 0);
			if (busy) setTimeout(drive, 50);
		};
		drive();
	},
	onDestroy: (c: any) => {
		// kill only children we spawned, by the pids we recorded ourselves
		const v = c.vars as CoordVars;
		for (const j of v.jobs.values()) {
			if (j.pid && v.procs.has(j.id)) { try { process.kill(j.pid, "SIGKILL"); } catch {} }
		}
		v.killed = true;
	},
});
