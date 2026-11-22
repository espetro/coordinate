#!/usr/bin/env bun
// Bulk create parked actors and report timing. Also probes wake latency.
import { createClient } from "rivetkit/client";
import type { registry } from "./registry.js";

const ENDPOINT = process.env.RIVET_ENDPOINT ?? "http://127.0.0.1:6420";
const N = parseInt(process.argv[2] ?? "1000", 10);
const PREFIX = process.argv[3] ?? "bulk";
const CONC = 8;

const client = createClient<typeof registry>({ endpoint: ENDPOINT });

async function createOne(i: number) {
	const key = `${PREFIX}-${i}`;
	const h = client.session.getOrCreate(key);
	await h.init("claude", `sess-${key}`, "/tmp");
	await h.park("hibernate");
}

const t0 = performance.now();
let done = 0;
const workers = Array.from({ length: CONC }, async () => {
	while (true) {
		const i = done++;
		if (i >= N) break;
		await createOne(i);
	}
});
await Promise.all(workers);
const dt = performance.now() - t0;
console.log(JSON.stringify({ n: N, seconds: +(dt / 1000).toFixed(2), per_s: +(N / (dt / 1000)).toFixed(1) }));
await client.dispose();
