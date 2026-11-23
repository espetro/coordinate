// Doctor verb tests under node --test. Each test gets its own temp state dir.
import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import "koffi";
import "@cutils/sqlite/node-binding";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "doctor-test-"));
}

async function doctorMod(dir) {
  process.env["COORDINATE_LEASE_S"] = "30";
  process.env["COORDINATE_DB"] = path.join(dir, "queue.db");
  process.env["COORDINATE_CONFIG"] = path.join(dir, "config.toml");
  return await import("../src/doctor.ts");
}

function byName(rep, name) {
  for (const r of rep.rows) {
    if (r.name === name) {
      return r;
    }
  }
  return null;
}

test("healthy report on a fresh state dir with no DB and no config", async () => {
  const d = await doctorMod(tmpdir());
  const rep = d.doctor();
  assert.equal(rep.healthy, true);
  const db = byName(rep, "db");
  assert.equal(db.ok, true);
  assert.match(db.detail, /not created yet/);
  const cfg = byName(rep, "config");
  assert.equal(cfg.ok, true);
  assert.match(cfg.detail, /missing/);
});

test("report reads stats once the DB exists", async () => {
  const dir = tmpdir();
  const d = await doctorMod(dir);
  const q = await import("../src/queue.ts");
  const db = q.connect();
  q.enqueue(db, { cmd: ["true"], cwd: null });
  db.close();
  const rep = d.doctor();
  assert.equal(rep.healthy, true);
  assert.match(byName(rep, "db").detail, /opens, schema tables present/);
  assert.match(byName(rep, "stats").detail, /"queued":1/);
});

test("fresh lease marks the daemon check as alive", async () => {
  const dir = tmpdir();
  const d = await doctorMod(dir);
  const q = await import("../src/queue.ts");
  const db = q.connect();
  q.enqueue(db, { cmd: ["true"], cwd: null });
  assert.notEqual(q.claim(db, "o:doctor"), null);
  const rep = d.doctor();
  assert.match(byName(rep, "daemon").detail, /a dispatcher is alive/);
  db.close();
});

test("expired lease reads as no daemon", async () => {
  const dir = tmpdir();
  const d = await doctorMod(dir);
  const q = await import("../src/queue.ts");
  const db = q.connect();
  q.enqueue(db, { cmd: ["true"], cwd: null });
  assert.notEqual(q.claim(db, "o:doctor"), null);
  db.prepareRaw("UPDATE jobs SET lease_expires_at = ?").run([Date.now() / 1000 - 60]);
  const rep = d.doctor();
  assert.match(byName(rep, "daemon").detail, /no daemon appears/);
  db.close();
});

test("invalid config.toml fails the config check", async () => {
  const dir = tmpdir();
  const d = await doctorMod(dir);
  fs.writeFileSync(path.join(dir, "config.toml"), "[defaults\nmax_runtime = ");
  const rep = d.doctor();
  assert.equal(rep.healthy, false);
  const cfg = byName(rep, "config");
  assert.equal(cfg.ok, false);
  assert.match(cfg.detail, /config.toml:\d+/);
});

test("valid config.toml passes the config check", async () => {
  const dir = tmpdir();
  const d = await doctorMod(dir);
  fs.writeFileSync(path.join(dir, "config.toml"), "[defaults]\nmax_runtime = \"15m\"\n");
  const rep = d.doctor();
  assert.equal(byName(rep, "config").ok, true);
});

test("disk check is skipped with a note", async () => {
  const d = await doctorMod(tmpdir());
  const rep = d.doctor();
  assert.match(byName(rep, "disk").detail, /skipped/);
});
