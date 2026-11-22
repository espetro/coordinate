import { actor, type ActorContext, type ActionContext } from "rivetkit";
import { spawn } from "node:child_process";

export interface SessionVars {
	harness: string;
	sessionId: string;
	cwd: string;
	status: "parked" | "running" | "done";
	waitingOn: string | null;
	pid: number | null;
	pgid: number | null;
}

export const session = actor<
	unknown, unknown, unknown, SessionVars, { harness: string; sessionId: string; cwd: string }
>({
	createVars: () => ({
		harness: "unknown",
		sessionId: "",
		cwd: "/tmp",
		status: "parked" as const,
		waitingOn: null,
		pid: null,
		pgid: null,
	}),
	actions: {
		init: (c: any, harness: string, sessionId: string, cwd: string) => {
			c.vars.harness = harness;
			c.vars.sessionId = sessionId;
			c.vars.cwd = cwd;
			c.vars.status = "parked";
			c.vars.waitingOn = null;
			return { ok: true };
		},
		park: (c: any, waitingOn: string) => {
			c.vars.status = "parked";
			c.vars.waitingOn = waitingOn;
			c.sleep();
			return { ok: true, status: c.vars.status, waitingOn };
		},
		wake: (c: any, reason: string) => {
			c.vars.status = "running";
			c.vars.waitingOn = null;
			return { ok: true, status: c.vars.status, reason };
		},
		status: (c: any) => {
			return {
				harness: c.vars.harness,
				sessionId: c.vars.sessionId,
				cwd: c.vars.cwd,
				status: c.vars.status,
				waitingOn: c.vars.waitingOn,
				pid: c.vars.pid,
			};
		},
		spawnDetached: (c: any, cmd: string) => {
			const child = spawn("/bin/sh", ["-c", cmd], {
				cwd: c.vars.cwd,
				detached: true,
				stdio: "ignore",
			});
			child.unref();
			c.vars.pid = child.pid ?? null;
			c.vars.pgid = child.pid ?? null;
			c.vars.status = "running";
			return { ok: true, pid: child.pid ?? null };
		},
	},
});
