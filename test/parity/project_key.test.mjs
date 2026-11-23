// Parity suite for legacy/python:tests/test_project_key.py.
//
// The Python suite calls queue.project_key() directly. In TypeScript the same function is
// private in src/daemon.ts, so it is observed the way the gap map says it is: through the
// `project` column of the spawn_audit table, which the daemon writes for every heavy-tool spawn
// (queue.py:158 audit_spawn).
//
// The Python suite injects a fake `git` probe with a `_probe=` argument. TypeScript has no such
// seam, but the daemon resolves `git` through PATH, so a fake `git` on PATH is the equivalent
// stand-in for the injected probe.
import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { BIN, cleanup, fakeBin, git, rig, rows, startDaemon, waitFor } from "./helpers.mjs";

function tmpdir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(path.join(fs.realpathSync(path.join(path.sep, "tmp")), prefix), "")));
}

// A git repo with one empty commit, like the Python `repo()` fixture.
function repo(base, name) {
  const d = path.join(base, name);
  fs.mkdirSync(d, { recursive: true });
  const r = git(d, "init", "-q");
  assert.equal(r.status, 0, r.stderr);
  const c = git(d, "commit", "-q", "--allow-empty", "-m", "init");
  assert.equal(c.status, 0, c.stderr);
  return d;
}

// Read the project key the daemon computed for a job started in `cwd`.
async function projectKeyFor(cwd, extra = {}) {
  const r = rig({ COORDINATE_LEASE_S: "3", COORDINATE_CAP: "3", COORDINATE_REPO_CAP: "1" });
  try {
    fakeBin(r, "vitest", "sleep 1");
    fs.writeFileSync(r.env.COORDINATE_CONFIG, "[slots]\n'tool:vitest:*' = 2\n");
    const p = spawnSync(process.execPath, [BIN, "enqueue", "--cwd", cwd, "--repo", "k", "--", "vitest", "run"], {
      env: { ...r.env, ...extra },
      encoding: "utf8",
    });
    assert.equal(p.status, 0, p.stderr);
    startDaemon(r, extra);
    const ok = await waitFor(() => rows(r, "SELECT COUNT(*) AS n FROM spawn_audit")[0]?.n > 0, 15000);
    assert.ok(ok, "the heavy-tool spawn was never audited");
    return rows(r, "SELECT project FROM spawn_audit")[0].project;
  } finally {
    await cleanup(r);
  }
}

test("test_plain_repo_key", async () => {
  const base = tmpdir("coord-pk-");
  try {
    const d = repo(base, "main");
    const got = await projectKeyFor(d);
    assert.equal(got, d);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("test_worktree_shares_main_repo_key", async () => {
  const base = tmpdir("coord-pk-");
  try {
    const d = repo(base, "main");
    const wt = path.join(base, "wt");
    const r = git(d, "worktree", "add", "-q", wt);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.statSync(path.join(wt, ".git")).isFile(), "the bug precondition: .git is a file, not a dir");
    const fromWt = await projectKeyFor(wt);
    const fromMain = await projectKeyFor(d);
    assert.equal(fromWt, d);
    assert.equal(fromMain, fromWt);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("test_two_repos_do_not_share", async () => {
  const base = tmpdir("coord-pk-");
  try {
    const d1 = repo(base, "main");
    const d2 = repo(path.join(base, "b"), "second");
    const w1 = path.join(base, "w1");
    const r = git(d1, "worktree", "add", "-q", w1);
    assert.equal(r.status, 0, r.stderr);
    const k1 = await projectKeyFor(d1);
    const kw1 = await projectKeyFor(w1);
    const k2 = await projectKeyFor(d2);
    assert.equal(new Set([k1, kw1, k2]).size, 2);
    assert.equal(kw1, k1);
    assert.notEqual(k2, k1);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("test_non_repo_falls_back_to_cwd", async () => {
  const base = tmpdir("coord-pk-");
  try {
    const plain = path.join(base, "plain");
    fs.mkdirSync(plain);
    const got = await projectKeyFor(plain);
    assert.equal(got, plain);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("test_worktree_via_git_probe", async () => {
  // Python: the .git file names an unreadable gitdir, and the injected probe answers
  // `git rev-parse --git-common-dir` with the main repo's .git. The TypeScript daemon resolves
  // `git` through PATH, so the fake git below stands in for the injected probe.
  const base = tmpdir("coord-pk-");
  try {
    const d = repo(base, "main");
    const wt = path.join(base, "wt2");
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, ".git"), "gitdir: /bogus/path\n");
    const fake = path.join(base, "fakebin");
    fs.mkdirSync(fake);
    const g = path.join(fake, "git");
    fs.writeFileSync(g, `#!/bin/sh\nprintf '%s\\n' "${d}/.git"\n`);
    fs.chmodSync(g, 0o755);
    const got = await projectKeyFor(wt, { PATH: fake + path.delimiter + process.env["PATH"] });
    assert.equal(got, d);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("test_probe_gets_2s_timeout", async () => {
  // Python: the probe raises TimeoutExpired and the test asserts it was called with timeout=2.
  // TypeScript: the daemon runs `git rev-parse` with execFileSync({timeout: 2000}); a git that
  // hangs must therefore be given up on after about 2 seconds, and the daemon must go on.
  const base = tmpdir("coord-pk-");
  try {
    const d = repo(base, "main");
    const fake = path.join(base, "fakebin");
    fs.mkdirSync(fake);
    const g = path.join(fake, "git");
    fs.writeFileSync(g, "#!/bin/sh\nsleep 30\n");
    fs.chmodSync(g, 0o755);
    const t0 = Date.now();
    const got = await projectKeyFor(d, { PATH: fake + path.delimiter + process.env["PATH"] });
    const elapsed = (Date.now() - t0) / 1000;
    // The probe hangs: the key falls back to the cwd, and the 2s timeout keeps the daemon moving.
    assert.equal(got, d);
    assert.ok(elapsed < 10, `the 2s probe timeout did not fire (the whole run took ${elapsed.toFixed(1)}s)`);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
