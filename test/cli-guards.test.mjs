// Guards against CLI invocations that silently do far more than was asked.
import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-guards-"));
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("COORDINATE_") || k.startsWith("FLEET_")) delete env[k];
  }
  env["COORDINATE_DB"] = path.join(dir, "queue.db");
  env["COORDINATE_MACHINE"] = "guards";
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

function failedJobs(r, n) {
  for (let i = 1; i <= n; i++) {
    assert.equal(cli(r, "enqueue", "--", "true").status, 0);
    assert.equal(cli(r, "cancel", String(i)).status, 0);
  }
}

test("dead retry with no target refuses and requeues nothing", () => {
  const r = rig();
  failedJobs(r, 2);
  const out = cli(r, "dead", "retry");
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /--all/);
  assert.equal(JSON.parse(cli(r, "stats").stdout).failed, 2);
});

test("dead retry takes one id, or --all", () => {
  const r = rig();
  failedJobs(r, 3);
  assert.equal(cli(r, "dead", "retry", "2").stdout.trim(), "2");
  assert.deepEqual(cli(r, "dead", "retry", "--all").stdout.trim().split("\n").sort(), ["1", "3"]);
});

test("dead retry rejects extra or non-numeric arguments", () => {
  const r = rig();
  failedJobs(r, 2);
  for (const args of [["1", "2"], ["--help"], ["abc"]]) {
    assert.notEqual(cli(r, "dead", "retry", ...args).status, 0, args.join(" "));
  }
  assert.equal(JSON.parse(cli(r, "stats").stdout).failed, 2);
});
