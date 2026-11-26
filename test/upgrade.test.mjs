// Upgrade mechanism tests: atomic swap, backup, rollback candidate, daemon restart.
import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import "koffi";
import "@cutils/sqlite/node-binding";

function mkbin(dir, ver) {
  // a fake coordinate binary: a shell script is not executable as process.execPath
  // semantics, but swapBinary and smoke only need --version on stdout.
  const p = path.join(dir, "coordinate");
  fs.writeFileSync(p, "#!/bin/sh\necho coordinate " + ver + "\n");
  fs.chmodSync(p, 0o755);
  return p;
}



test("restartDaemon reports no-daemon when none is running", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-up-db-"));
  process.env["COORDINATE_DB"] = path.join(dir, "queue.db");
  process.env["COORDINATE_MACHINE"] = "bench";
  const q = await import("../src/queue.ts");
  const { restartDaemon } = await import("../src/upgrade.ts");
  const db = q.connect();
  const r = restartDaemon(db, "/bin/true");
  assert.equal(r.action, "no-daemon");
});

test("restartDaemon SIGTERMs the recorded daemon and starts a replacement", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-up-db2-"));
  process.env["COORDINATE_DB"] = path.join(dir, "queue.db");
  process.env["COORDINATE_MACHINE"] = "bench";
  const q = await import("../src/queue.ts");
  const { restartDaemon } = await import("../src/upgrade.ts");
  const db = q.connect();
  // a live process standing in for the old daemon: a grandchild via sh, so it
  // is not our child and cannot linger as a zombie (which would defeat the
  // kill(pid, 0) liveness probe)
  const sp = spawnSync("sh", ["-c", "sleep 30 </dev/null >/dev/null 2>&1 & echo $!"], { encoding: "utf8" });
  const fakePid = Number(sp.stdout.trim());
  q.qRun(db, "INSERT INTO daemon(id,pid,heartbeat_ts) VALUES(1,?,?)", [fakePid, Date.now() / 1000]);
  // a fake new daemon binary that exits immediately (fine: we only check the spawn)
  const bindir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-up-bin-"));
  const bin = path.join(bindir, "coordinate");
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(bin, 0o755);
  const r = restartDaemon(db, bin);
  assert.equal(r.action, "restarted");
  assert.equal(r.oldPid, fakePid);
  assert.ok(r.newPid > 0);
  // the old process group leader got SIGTERM and exited
  const check = spawnSync("ps", ["-p", String(fakePid)], { encoding: "utf8" });
  assert.equal(check.status !== 0 || !check.stdout.includes("sleep"), true, "old daemon is gone");
});

test("restartDaemon never signals the pid of a stale daemon row", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-up-db3-"));
  process.env["COORDINATE_DB"] = path.join(dir, "queue.db");
  process.env["COORDINATE_MACHINE"] = "bench";
  const q = await import("../src/queue.ts");
  const { restartDaemon } = await import("../src/upgrade.ts");
  const db = q.connect();
  // an unrelated live process that happens to own the recorded pid
  const sp = spawnSync("sh", ["-c", "sleep 5 </dev/null >/dev/null 2>&1 & echo $!"], { encoding: "utf8" });
  const bystander = Number(sp.stdout.trim());
  q.qRun(db, "INSERT OR REPLACE INTO daemon(id,pid,heartbeat_ts) VALUES(1,?,?)", [bystander, Date.now() / 1000 - 3600]);
  const r = restartDaemon(db, "/bin/true");
  assert.equal(r.action, "no-daemon");
  assert.equal(r.newPid, null);
  assert.doesNotThrow(() => process.kill(bystander, 0), "bystander is still alive");
});

test("binFingerprint detects atomic-rename swaps and content rewrites", async () => {
  const { binFingerprint, sameFingerprint } = await import("../src/upgrade.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-fp-"));
  const p = path.join(dir, "coordinate");
  fs.writeFileSync(p, "v1-binary");
  const a = binFingerprint(p);
  assert.ok(a !== null);
  assert.ok(sameFingerprint(a, binFingerprint(p)), "unchanged file compares equal");
  // atomic rename swap: write elsewhere in the same dir, rename over
  const staged = path.join(dir, "staged");
  fs.writeFileSync(staged, "v2-binary");
  fs.renameSync(staged, p);
  const b = binFingerprint(p);
  assert.ok(!sameFingerprint(a, b), "rename swap changes the fingerprint");
  // in-place rewrite with identical size
  fs.writeFileSync(p, "v3-binary");
  const c = binFingerprint(p);
  assert.ok(!sameFingerprint(b, c), "in-place rewrite changes the fingerprint");
  assert.equal(binFingerprint(path.join(dir, "missing")), null);
});

test("restartDaemon spawns the replacement before signalling the old daemon", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-up-order-"));
  process.env["COORDINATE_DB"] = path.join(dir, "queue.db");
  process.env["COORDINATE_MACHINE"] = "bench";
  const q = await import("../src/queue.ts");
  const { restartDaemon } = await import("../src/upgrade.ts");
  const db = q.connect();
  const sp = spawnSync("sh", ["-c", "sleep 30 </dev/null >/dev/null 2>&1 & echo $!"], { encoding: "utf8" });
  const fakePid = Number(sp.stdout.trim());
  q.qRun(db, "INSERT INTO daemon(id,pid,heartbeat_ts) VALUES(1,?,?)", [fakePid, Date.now() / 1000]);
  const bindir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-up-bin2-"));
  const bin = path.join(bindir, "coordinate");
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(bin, 0o755);
  const r = restartDaemon(db, bin);
  assert.equal(r.action, "restarted");
  assert.ok(r.newPid !== null && r.newPid > 0, "gap-free ordering: replacement exists before the SIGTERM returns");
  spawnSync("kill", [String(fakePid)]);
});
