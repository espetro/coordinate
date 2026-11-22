#!/usr/bin/env bun
import { createClient } from "rivetkit/client";
import type { registry } from "./registry.js";

const ENDPOINT = process.env.RIVET_ENDPOINT ?? "http://127.0.0.1:6420";

const client = createClient<typeof registry>({ endpoint: ENDPOINT });

async function main() {
	const cmd = process.argv[2];
	const args = process.argv.slice(3);
	switch (cmd) {
		case "create": {
			const [key, harness, sessionId, cwd] = args;
			const h = client.session.getOrCreate(key);
			await h.init(harness ?? "unknown", sessionId ?? "", cwd ?? "/tmp");
			const r = await h.status();
			console.log(JSON.stringify({ ok: true, key, ...r }));
			break;
		}
		case "park": {
			const [key, waitingOn] = args;
			const h = client.session.get(key);
			const r = await h.park(waitingOn ?? "event");
			console.log(JSON.stringify(r));
			break;
		}
		case "wake": {
			const t0 = performance.now();
			const h = client.session.get(args[0]);
			const r = await h.wake(args[1] ?? "test");
			const dt = performance.now() - t0;
			console.log(JSON.stringify({ ...r, ms: dt }));
			break;
		}
		case "status": {
			const h = client.session.get(args[0]);
			const r = await h.status();
			console.log(JSON.stringify(r));
			break;
		}
		case "spawn": {
			const h = client.session.get(args[0]);
			const r = await h.spawnDetached(args.slice(1).join(" "));
			console.log(JSON.stringify(r));
			break;
		}
		case "wake-lat": {
			const [key, nStr] = args;
			const n = parseInt(nStr ?? "100", 10);
			const samples: number[] = [];
			for (let i = 0; i < n; i++) {
				const h = client.session.get(key);
				await h.park("hibernate");
				const t0 = performance.now();
				await h.wake("latency-probe");
				samples.push(performance.now() - t0);
				// allow re-sleep
				await new Promise((r) => setTimeout(r, 350));
			}
			samples.sort((a, b) => a - b);
			const p = (q: number) => samples[Math.min(samples.length - 1, Math.floor((q / 100) * samples.length))];
			console.log(JSON.stringify({ n, p50: p(50), p99: p(99), min: samples[0], max: samples[samples.length - 1] }));
			break;
		}
		default:
			console.error("usage: client.ts create|park|wake|status|spawn|wake-lat ...");
			process.exit(2);
	}
	await client.dispose();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
