import "koffi";
import "@cutils/sqlite/node-binding";
process.env.COORDINATE_DB = "/tmp/tstest25/queue.db";
process.env.COORDINATE_CAP = "3";
process.env.COORDINATE_LEASE_S = "5";
const q = await import("./src/queue.ts");
const cp = await import("node:child_process");
const os = await import("node:os");
const db = q.connect();
await q.enqueue(db, { cmd: ["true"], cwd: "/tmp" });
const owner = os.hostname() + ":1";
const running = [];
let delay = 0.05;
let lastHb = 0.0, lastReap = 0.0;
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });
const exitProc = (r, code) => { q.finish(db, r.jid, owner, code === 0 ? "done" : "failed"); };
const killGroup = (proc) => { try { process.kill(-proc.pid, "SIGKILL"); } catch {} };
setTimeout(() => { console.log("STOP"); process.exit(0); }, 2000);
console.log("loop start");
while (!stopping) {
  let busy = false;
  const now = Date.now() / 1000;
  console.log("iter expired");
  for (const row of q.expiredRunning(db)) { busy = true; }
  console.log("iter running poll");
  for (let i = running.length - 1; i >= 0; i--) {
    const r = running[i];
    if (r.proc.exitCode !== null || r.proc.signalCode !== null) { exitProc(r, r.proc.exitCode); running.splice(i, 1); busy = true; }
  }
  console.log("iter hb");
  if (now - lastHb >= q.LEASE_S / 3) { lastHb = now; }
  console.log("iter reap");
  if (now - lastReap >= q.LEASE_S / 3) { q.reap(db); lastReap = now; }
  console.log("iter claim");
  while (running.length < q.machineCap()) {
    const got = q.claim(db, owner);
    if (got === null) break;
    busy = true;
    console.log("spawning");
    const cmd = got.payload.cmd;
    const opts = { cwd: got.payload.cwd, detached: true, env: { PATH: process.env.PATH }, stdio: "ignore" };
    const proc = typeof cmd === "string" ? cp.spawn("/bin/sh", ["-c", cmd], opts) : cp.spawn(cmd[0], cmd.slice(1), opts);
    q.setProc(db, got.jid, owner, proc.pid);
    running.push({ jid: got.jid, proc });
    console.log("spawned", proc.pid);
  }
  console.log("iter sleep", delay);
  delay = busy ? 0.05 : Math.min(delay * 2, 2.0);
  const wake = Date.now() + delay * 1000;
  while (Date.now() < wake && !stopping) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, wake - Date.now()));
  }
}
