// The triage TUI: TTY guard, the key state machine (pure reducer), the render,
// and the external-command hooks. The mutations go through the same queue
// operations as the CLI, so the tests assert on the events they emit.
import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { Database } from "@cutils/sqlite";
import "koffi";
import "@cutils/sqlite/node-binding";
import { initialState, handleKey, buildQuery, renderScreen, expandHook } from "../src/tui.ts";
import * as q from "../src/queue.ts";
import { queryJobs } from "../src/readmodel.ts";

let counter = 0;

function rig() {
  counter += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-tui-"));
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("COORDINATE_") || k.startsWith("FLEET_")) delete env[k];
  }
  env["COORDINATE_DB"] = path.join(dir, "queue.db");
  env["COORDINATE_MACHINE"] = "surfaces-p4";
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

function dbOf(r) {
  // point this test process at the rig DB before q.connect() resolves the path
  process.env["COORDINATE_DB"] = r.env["COORDINATE_DB"];
  process.env["XDG_STATE_HOME"] = r.env["XDG_STATE_HOME"];
  process.env["XDG_CONFIG_HOME"] = r.env["XDG_CONFIG_HOME"];
  process.env["COORDINATE_MACHINE"] = r.env["COORDINATE_MACHINE"];
  return q.connect();
}

function k(name, extra) {
  return { name, ctrl: false, meta: false, shift: false, sequence: extra?.sequence ?? "", ...extra };
}

test("tui refuses to run when stdout is not a TTY", async () => {
  const r = rig();
  try {
    cli(r, "enqueue", "--cwd", "/tmp", "--", "true");
    const out = cli(r, "tui");
    assert.notEqual(out.status, 0, "the TUI must fail without a TTY");
    assert.ok(out.stderr.includes("not a terminal"), "clear stderr: " + out.stderr);
    assert.equal(out.stdout, "", "no escape sequences may reach a pipe");
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("tui exits on q inside a pty", { timeout: 15000 }, async () => {
  if (process.platform === "win32" || spawnSync("sh", ["-c", "command -v script"]).status !== 0) {
    return;
  }
  const r = rig();
  try {
    const shq = (s) => "'" + String(s).split("'").join("'\\''") + "'";
    const bin = path.join(import.meta.dirname, "..", "bin", "coordinate.mjs");
    const wrapper = path.join(r.dir, "run-tui.sh");
    fs.writeFileSync(wrapper, "#!/bin/sh\nexec " + shq(process.execPath) + " " + shq(bin) + " tui\n");
    fs.chmodSync(wrapper, 0o755);
    const scriptCmd =
      process.platform === "darwin"
        ? "script -q /dev/null " + shq(wrapper)
        : "script -q -e -c " + shq(wrapper) + " /dev/null";
    const p = spawnSync("sh", ["-c", "(sleep 1; printf q) | " + scriptCmd], {
      env: r.env,
      encoding: "utf8",
      timeout: 8000,
    });
    assert.equal(p.error, null, "the TUI did not exit after q: " + String(p.error));
    assert.equal(p.status, 0, "pty run failed: " + p.stderr + "\n" + p.stdout);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("the reducer moves the selection and routes mutations through the queue", async () => {
  const r = rig();
  try {
    const a = Number(cli(r, "enqueue", "--cwd", "/tmp", "--shell", "--", "echo one").stdout.trim());
    const b = Number(cli(r, "enqueue", "--cwd", "/tmp", "--shell", "--", "echo two").stdout.trim());
    const db = dbOf(r);
    const st = initialState();
    const rows = queryJobs(db, buildQuery(st));
    assert.equal(rows.length, 2);
    // jobs sort id desc, so the selection starts at the newest job (b)
    assert.equal(rows[0].id, b);
    // ctrl-n moves down within bounds
    const down = handleKey(st, k("n", { ctrl: true, sequence: "\x0e" }), db, {});
    assert.equal(st.sel, 1);
    assert.ok(down.repaint);
    const up = handleKey(st, k("p", { ctrl: true, sequence: "\x10" }), db, {});
    assert.equal(st.sel, 0);
    assert.ok(up.repaint);
    // confirmed cancel mutates through q.cancel and emits the event
    handleKey(st, k("x", { sequence: "x" }), db, {});
    assert.equal(st.mode, "confirm");
    handleKey(st, k("y", { sequence: "y" }), db, {});
    const rec = queryJobs(db, { status: ["failed"] });
    assert.equal(rec.length, 1);
    assert.equal(rec[0].id, b);
    const evs = q.qAll(db, "SELECT kind FROM events WHERE job_id=?", [b]);
    assert.ok(evs.some((e) => e.kind === "cancelled"), "cancel must emit the cancelled event");
    // retry on the failed job
    const st2 = initialState();
    queryJobs(db, buildQuery(st2));
    handleKey(st2, k("R", { sequence: "R" }), db, {});
    assert.equal(st2.confirmAction, "retry");
    handleKey(st2, k("y", { sequence: "y" }), db, {});
    const again = queryJobs(db, { status: ["queued"] });
    assert.ok(again.some((j) => j.id === b), "retry must requeue the failed job");
    assert.ok(q.qAll(db, "SELECT kind FROM events WHERE job_id=?", [b]).some((e) => e.kind === "requeued"));
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("filter, sort and state cycling drive the shared JobQuery", async () => {
  const r = rig();
  try {
    cli(r, "enqueue", "--cwd", "/tmp", "--shell", "--", "echo NEEDLE");
    cli(r, "enqueue", "--cwd", "/var", "--shell", "--", "echo other");
    const db = dbOf(r);
    const st = initialState();
    handleKey(st, k("/", { sequence: "/" }), db, {});
    assert.equal(st.mode, "filter");
    for (const ch of "needle".split("")) {
      handleKey(st, k(ch, { sequence: ch }), db, {});
    }
    handleKey(st, k("return", { sequence: "\r" }), db, {});
    assert.equal(st.filter, "needle");
    assert.equal(queryJobs(db, buildQuery(st)).length, 1);
    // sort cycles through the documented keys
    const s0 = st.sortIdx;
    handleKey(st, k("s", { sequence: "s" }), db, {});
    assert.equal(st.sortIdx, (s0 + 1) % 5);
    // state filter cycles
    handleKey(st, k("f", { sequence: "f" }), db, {});
    assert.deepEqual(buildQuery(st).status, ["queued"]);
    handleKey(st, k("f", { sequence: "f" }), db, {});
    assert.deepEqual(buildQuery(st).status, ["running"]);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("the event prompt releases through q.release", async () => {
  const r = rig();
  try {
    const id = Number(cli(r, "enqueue", "--wait-on", "golive", "--cwd", "/tmp", "--", "true").stdout.trim());
    const db = dbOf(r);
    const st = initialState();
    handleKey(st, k("e", { sequence: "e" }), db, {});
    assert.equal(st.mode, "event");
    for (const ch of "golive".split("")) {
      handleKey(st, k(ch, { sequence: ch }), db, {});
    }
    handleKey(st, k("return", { sequence: "\r" }), db, {});
    assert.equal(st.mode, "list");
    const rec = queryJobs(db, {});
    assert.equal(rec[0].status, "queued", "the released job must leave waiting");
    assert.ok(q.qAll(db, "SELECT kind FROM events WHERE job_id=?", [id]).some((e) => e.kind === "released"));
    // escape cancels the prompt without touching the queue
    cli(r, "enqueue", "--wait-on", "golive2", "--cwd", "/tmp", "--", "true");
    const st2 = initialState();
    handleKey(st2, k("e", { sequence: "e" }), db, {});
    handleKey(st2, k("escape", { sequence: "\x1b" }), db, {});
    assert.equal(st2.mode, "list");
    assert.equal(st2.eventName, "");
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("hooks substitute safe quoted tokens and pass job JSON on stdin", async () => {
  const r = rig();
  try {
    const id = Number(cli(r, "enqueue", "--cwd", "/tmp/w space", "--repo", "r'1", "--shell", "--", "echo hi").stdout.trim());
    const db = dbOf(r);
    const rec = queryJobs(db, { sort: "id" })[0];
    const expanded = expandHook("open {id} --at {cwd} --repo {repo} --state {status}", rec);
    assert.ok(expanded.includes("'/tmp/w space'"), "cwd must be shell quoted: " + expanded);
    assert.ok(expanded.includes("'r'\\''1'"), "quotes must be escaped: " + expanded);
    // a real hook writes what it saw; the reducer runs it on a bound key
    const script = path.join(r.dir, "hook.sh");
    fs.writeFileSync(script, "cat > " + path.join(r.dir, "hook.out") + "\nenv > " + path.join(r.dir, "hook.env") + "\n");
    fs.chmodSync(script, 0o755);
    const st = initialState();
    handleKey(st, k("h", { sequence: "h" }), db, { h: expanded + " ; sh " + script });
    const seen = fs.readFileSync(path.join(r.dir, "hook.out"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(seen[0].id, id);
    assert.equal(seen[0].payload.cwd, "/tmp/w space");
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("config [tui] hooks parse as a table of command strings", async () => {
  const r = rig();
  try {
    fs.mkdirSync(path.join(r.dir, "conf", "coordinate"), { recursive: true });
    fs.writeFileSync(
      path.join(r.dir, "conf", "coordinate", "config.toml"),
      '[tui]\nw = "codex open {id}"\n',
    );
    const out = cli(r, "health");
    assert.equal(out.status, 0, "a valid [tui] section must not break other verbs: " + out.stderr);
    const { tuiHooks } = await import("../src/tui.ts");
    process.env["XDG_CONFIG_HOME"] = r.env["XDG_CONFIG_HOME"];
    const hooks = tuiHooks();
    assert.equal(hooks.w, "codex open {id}");
    delete process.env["XDG_CONFIG_HOME"];
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test("the render is one screen of plain text with header, table and footer", async () => {
  const r = rig();
  try {
    cli(r, "enqueue", "--cwd", "/tmp", "--shell", "--", "echo visible");
    const db = dbOf(r);
    const st = initialState();
    const rows = queryJobs(db, buildQuery(st));
    const screen = renderScreen(st, rows, db, 100, {});
    assert.ok(screen.includes("coordinate"), "a header naming the tool");
    assert.ok(screen.includes("ID") && screen.includes("COMMAND"), "the table header from the shared renderer");
    assert.ok(screen.includes("echo visible"), "the row");
    assert.ok(screen.includes("q quit"), "the key legend");
    assert.ok(!screen.includes("\x1b"), "renderScreen returns plain text; escapes are the loop's job");
    assert.equal(screen.split("\n").length >= 4, true);
  } finally {
    fs.rmSync(r.dir, { recursive: true, force: true });
  }
});
