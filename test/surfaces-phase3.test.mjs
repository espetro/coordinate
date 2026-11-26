// The human table surface: `coordinate jobs` default output, --json machine
// records, search and sort shared with the machine query, and the non-
// interactive --watch mode. The table is presentation only; the machine
// contract is the v1 NDJSON (docs/machine-schema.md).
import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import "koffi";
import "@cutils/sqlite/node-binding";

let counter = 0;

function rig() {
  counter += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-table-"));
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("COORDINATE_") || k.startsWith("FLEET_")) delete env[k];
  }
  env["COORDINATE_DB"] = path.join(dir, "queue.db");
  env["COORDINATE_MACHINE"] = "surfaces-p3";
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

function lines(out) {
  return out.split("\n").filter((l) => l !== "");
}

test("default jobs output is a human table with a header and one row per job", async () => {
  const r = rig();
  try {
    const id = Number(cli(r, "enqueue", "--cwd", "/tmp", "--shell", "--", "echo hi there").stdout.trim());
    const out = cli(r, "jobs");
    assert.equal(out.status, 0, out.stderr);
    const ls = lines(out.stdout);
    assert.ok(ls[0].startsWith("ID"), "expected a header row: " + ls[0]);
    for (const col of ["STATUS", "AGE", "COMMAND"]) {
      assert.ok(ls[0].includes(col), "header must name " + col);
    }
    assert.equal(ls.length, 2, "one row per job plus the header");
    assert.ok(ls[1].startsWith(String(id) + " "), "the row starts with the job id");
    assert.ok(ls[1].includes("queued"), "the row shows the state");
    assert.ok(ls[1].includes("echo hi there"), "the row shows the command");
    // the default table is not the machine contract: no JSON on stdout
    assert.throws(() => JSON.parse(ls[1]), "table rows must not be JSON");
    // age column: a compact unit, not an epoch number
    assert.match(ls[1], /\b\d+[smhd]\b/);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("--json keeps the byte-compatible v1 NDJSON records", async () => {
  const r = rig();
  try {
    const id = Number(cli(r, "enqueue", "--cwd", "/tmp", "--shell", "--", "echo hi").stdout.trim());
    const out = cli(r, "jobs", "--json");
    assert.equal(out.status, 0, out.stderr);
    const recs = lines(out.stdout).map((l) => JSON.parse(l));
    assert.equal(recs.length, 1);
    assert.equal(recs[0].v, 1);
    assert.equal(recs[0].id, id);
    assert.equal(recs[0].payload.cmd, "echo hi");
    // the schema doc states the table is not the machine contract
    const doc = fs.readFileSync(path.join(import.meta.dirname, "..", "docs", "machine-schema.md"), "utf8");
    assert.ok(doc.includes("not the machine contract"), "machine-schema.md must mark the table as non-contract");
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("the table honours filters, search and sort like the machine query", async () => {
  const r = rig();
  try {
    cli(r, "enqueue", "--cwd", "/tmp", "--shell", "--", "echo NEEDLE");
    cli(r, "enqueue", "--cwd", "/var", "--shell", "--", "echo other");
    // search
    const hits = cli(r, "jobs", "--search", "needle");
    assert.equal(lines(hits.stdout).length, 2, "header plus one hit");
    assert.ok(hits.stdout.includes("echo NEEDLE"));
    // status filter
    const none = cli(r, "jobs", "--status", "done");
    assert.equal(lines(none.stdout).length, 1, "only the header remains");
    // sort: highest priority first, ties break on id descending
    const a = Number(cli(r, "enqueue", "--priority", "1", "--cwd", "/tmp", "--", "true").stdout.trim());
    const b = Number(cli(r, "enqueue", "--priority", "5", "--cwd", "/tmp", "--", "true").stdout.trim());
    const desc = lines(cli(r, "jobs", "--sort", "priority").stdout).slice(1);
    assert.ok(desc[0].startsWith(String(b) + " "), "highest priority first");
    const asc = lines(cli(r, "jobs", "--sort", "priority", "--asc").stdout).slice(1);
    assert.ok(asc[asc.length - 1].startsWith(String(b) + " "), "lowest priorities come first with --asc, highest last");
    // limit
    const lim = lines(cli(r, "jobs", "--json", "--limit", "2").stdout);
    assert.equal(lim.length, 2);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("the table truncates long commands", async () => {
  const r = rig();
  try {
    const long = "x".repeat(200);
    cli(r, "enqueue", "--cwd", "/tmp", "--shell", "--", "echo " + long);
    const row = lines(cli(r, "jobs").stdout)[1];
    assert.ok(row.length < 120, "a long command must not blow out the row: " + row.length);
    assert.ok(row.slice(0, 200).includes("\u2026"), "the cut is marked with an ellipsis");
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("the no-id status verb keeps the historical TSV rows", async () => {
  const r = rig();
  try {
    cli(r, "enqueue", "--cwd", "/tmp", "--shell", "--", "echo hi");
    const out = cli(r, "status");
    assert.equal(out.status, 0, out.stderr);
    assert.ok(out.stdout.includes("\t"), "the compatibility rows stay tab-separated");
    assert.match(out.stdout, /^1\tqueued\t0\t3\t\t/, "id, state, attempts, max, waiting_on, payload");
    // `status ID` stays pretty JSON
    const one = JSON.parse(cli(r, "status", "1").stdout);
    assert.equal(one.id, 1);
    assert.equal(typeof one.payload, "object");
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("--watch repaints the table and --json --watch is refused", async () => {
  const r = rig();
  try {
    cli(r, "enqueue", "--cwd", "/tmp", "--shell", "--", "echo hi");
    // --watch loops forever; run it briefly under the CLI timeout and read
    // whatever it painted before the timeout killed it.
    const p = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "bin", "coordinate.mjs"), "jobs", "--watch"], {
      env: r.env,
      encoding: "utf8",
      timeout: 2500,
    });
    const painted = (p.stdout || "");
    assert.ok(painted.includes("\x1b[H"), "watch repaints with cursor-home ANSI");
    assert.ok(painted.includes("\x1b[2J"), "watch clears the screen between frames");
    assert.ok(painted.includes("echo hi"), "watch paints the same table");
    const refused = cli(r, "jobs", "--json", "--watch");
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /--watch/);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});
