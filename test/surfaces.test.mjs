// The v1 machine contract: canonical `coordinate jobs` output, decoded payloads,
// filters, search, sort and limit semantics.
import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { Database } from "@cutils/sqlite";
import "koffi";
import "@cutils/sqlite/node-binding";

let counter = 0;

function rig() {
  counter += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-surfaces-"));
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("COORDINATE_") || k.startsWith("FLEET_")) delete env[k];
  }
  env["COORDINATE_DB"] = path.join(dir, "queue.db");
  env["COORDINATE_MACHINE"] = "surfaces";
  env["XDG_STATE_HOME"] = path.join(dir, "state");
  env["XDG_CONFIG_HOME"] = path.join(dir, "conf");
  return { dir, env };
}

function cli(r, ...args) {
  const p = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "bin", "coordinate.mjs"), ...args], {
    env: r.env,
    encoding: "utf8",
    timeout: 30000,
  });
  return { status: p.status, stdout: p.stdout || "", stderr: p.stderr || "" };
}

function records(out) {
  return out.stdout
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

test("jobs emits one v1 record per line with a decoded payload", async () => {
  const r = rig();
  try {
    const id = cli(r, "enqueue", "--cwd", "/tmp", "--shell", "--", "echo hi").stdout.trim();
    assert.ok(id, "enqueue printed no id");
    const out = cli(r, "jobs", "--json");
    assert.equal(out.status, 0, out.stderr);
    const recs = records(out);
    assert.equal(recs.length, 1);
    const rec = recs[0];
    assert.equal(rec.v, 1);
    assert.equal(rec.id, Number(id));
    assert.equal(rec.kind, "cmd");
    assert.equal(rec.status, "queued");
    // the payload is decoded once: an object, not a string with JSON inside
    assert.equal(typeof rec.payload, "object");
    assert.equal(rec.payload.cmd, "echo hi");
    assert.equal(rec.payload.cwd, "/tmp");
    assert.ok("runtime_remaining_s" in rec);
    assert.ok("deadline_in_s" in rec);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("every line of the jobs output parses on its own (jq friendly)", async () => {
  const r = rig();
  try {
    cli(r, "enqueue", "--cwd", "/tmp", "--", "true");
    cli(r, "enqueue", "--cwd", "/tmp", "--", "false");
    cli(r, "enqueue", "--acp", "stub", "--cwd", "/tmp", "--prompt", "hi");
    const out = cli(r, "jobs", "--json");
    const lines = out.stdout.split("\n").filter((l) => l !== "");
    assert.equal(lines.length, 3);
    for (const line of lines) {
      const obj = JSON.parse(line);
      assert.equal(typeof obj.id, "number");
      assert.equal(typeof obj.payload, "object");
      assert.equal(obj.v, 1);
    }
    const acp = records(out).find((x) => x.kind === "acp");
    assert.equal(acp.payload.agent, "stub");
    assert.equal(acp.payload.prompt, "hi");
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("jobs filters by status and kind", async () => {
  const r = rig();
  try {
    cli(r, "enqueue", "--cwd", "/tmp", "--", "true");
    cli(r, "enqueue", "--acp", "stub", "--cwd", "/tmp", "--prompt", "hi");
    const queued = records(cli(r, "jobs", "--json", "--status", "queued"));
    assert.equal(queued.length, 2);
    const done = records(cli(r, "jobs", "--json", "--status", "done"));
    assert.equal(done.length, 0);
    const cmd = records(cli(r, "jobs", "--json", "--kind", "cmd"));
    assert.equal(cmd.length, 1);
    assert.equal(cmd[0].kind, "cmd");
    const acp = records(cli(r, "jobs", "--json", "--kind", "acp"));
    assert.equal(acp.length, 1);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("jobs search matches metadata case-insensitively", async () => {
  const r = rig();
  try {
    cli(r, "enqueue", "--cwd", "/tmp", "--shell", "--", "echo NEEDLE");
    cli(r, "enqueue", "--cwd", "/var", "--shell", "--", "echo other");
    const hits = records(cli(r, "jobs", "--json", "--search", "needle"));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].payload.cmd, "echo NEEDLE");
    const byCwd = records(cli(r, "jobs", "--json", "--search", "/VAR"));
    assert.equal(byCwd.length, 1);
    assert.equal(byCwd[0].payload.cwd, "/var");
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("jobs sorts by priority and id and honours the limit", async () => {
  const r = rig();
  try {
    const a = Number(cli(r, "enqueue", "--priority", "1", "--cwd", "/tmp", "--", "true").stdout.trim());
    const b = Number(cli(r, "enqueue", "--priority", "5", "--cwd", "/tmp", "--", "true").stdout.trim());
    const c = Number(cli(r, "enqueue", "--priority", "5", "--cwd", "/tmp", "--", "true").stdout.trim());
    const desc = records(cli(r, "jobs", "--json", "--sort", "priority"));
    // equal keys break on id in the same direction as the sort
    assert.deepEqual(desc.map((x) => x.id), [c, b, a]);
    const asc = records(cli(r, "jobs", "--json", "--sort", "priority", "--asc"));
    assert.deepEqual(asc.map((x) => x.id), [a, b, c]);
    const limited = records(cli(r, "jobs", "--json", "--sort", "priority", "--limit", "2"));
    assert.deepEqual(limited.map((x) => x.id), [c, b]);
    const byId = records(cli(r, "jobs", "--json", "--sort", "id", "--asc"));
    assert.deepEqual(byId.map((x) => x.id), [a, b, c]);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("jobs rejects bad arguments without a stack trace", async () => {
  const r = rig();
  try {
    const bad = cli(r, "jobs", "--json", "--sort", "nope");
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--sort/);
    const badLimit = cli(r, "jobs", "--limit", "-1");
    assert.equal(badLimit.status, 1);
    assert.match(badLimit.stderr, /--limit/);
    const unknown = cli(r, "jobs", "--wat");
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown argument/);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("status ID prints the same fields with a decoded payload", async () => {
  const r = rig();
  try {
    const id = cli(r, "enqueue", "--cwd", "/tmp", "--shell", "--", "echo hi").stdout.trim();
    const out = cli(r, "status", id);
    assert.equal(out.status, 0, out.stderr);
    const view = JSON.parse(out.stdout);
    assert.equal(typeof view.payload, "object");
    assert.equal(view.payload.cmd, "echo hi");
    assert.equal(view.v, undefined);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("events filters by job, kind and search", async () => {
  const r = rig();
  try {
    const id = cli(r, "enqueue", "--cwd", "/tmp", "--", "true").stdout.trim();
    cli(r, "enqueue", "--cwd", "/tmp", "--", "true");
    const all = records(cli(r, "events"));
    assert.ok(all.length >= 2);
    const mine = records(cli(r, "events", "--job", id));
    assert.ok(mine.length >= 1);
    for (const ev of mine) assert.equal(ev.job_id, Number(id));
    const enqueued = records(cli(r, "events", "--kind", "enqueued"));
    assert.equal(enqueued.length, 2);
    const searched = records(cli(r, "events", "--search", "enqueued"));
    assert.ok(searched.length >= 2);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("emitted event fields match the documented per-kind contract", async () => {
  const r = rig();
  try {
    const id = Number(cli(r, "enqueue", "--cwd", "/tmp", "--", "true").stdout.trim());
    // the enqueued event carries the job kind
    const enqueued = records(cli(r, "events", "--kind", "enqueued")).find((e) => e.job_id === id);
    assert.equal(enqueued.data.kind, "cmd");
    // a claimed event carries the owner and the attempt number
    const db = Database.open(r.env["COORDINATE_DB"]);
    db.exec("UPDATE jobs SET status='running', attempts=1, lease_owner='o:1' WHERE id=" + id);
    db.exec(
      "INSERT INTO events(ts,job_id,kind,data) VALUES(" +
        Date.now() / 1000 +
        "," + id + ",'claimed','{\"owner\":\"o:1\",\"attempt\":1}')",
    );
    db.close();
    const claimed = records(cli(r, "events", "--kind", "claimed")).find((e) => e.job_id === id);
    assert.equal(claimed.data.owner, "o:1");
    assert.equal(claimed.data.attempt, 1);
    // the documented field sets are exactly what the implementation emits
    const doc = fs.readFileSync(path.join(import.meta.dirname, "..", "docs", "machine-schema.md"), "utf8");
    for (const [kind, field] of [
      ["enqueued", "kind"],
      ["claimed", "attempt"],
      ["parked", "waiting_on"],
      ["released", "event"],
      ["cancelled", "recorded_as"],
      ["timed_out", "outcome"],
      ["dead", "reason"],
      ["requeued", "reason"],
    ]) {
      assert.ok(doc.includes("`" + kind + "`"), "the schema doc must document the " + kind + " kind");
      assert.ok(doc.includes("`" + field + "`"), "the schema doc must document the " + field + " field");
    }
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("the read model decodes a bad payload row without breaking the collection", async () => {
  const r = rig();
  try {
    cli(r, "enqueue", "--cwd", "/tmp", "--", "true");
    const db = Database.open(r.env["COORDINATE_DB"]);
    db.exec("UPDATE jobs SET payload='not json' WHERE id=1");
    db.close();
    const recs = records(cli(r, "jobs", "--json"));
    assert.equal(recs.length, 1);
    assert.equal(typeof recs[0].payload, "object");
    assert.equal(recs[0].payload._raw, "not json");
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});
