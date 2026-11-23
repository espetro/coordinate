// Parity suite for legacy/python:tests/test_spawn_shim.py.
//
// The spawn shim: heavy-class matcher, weighted tool leases, park-at-boundary, audit log.
import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { NOW, cleanup, cli, drain, fakeBin, peakOverlap, rig, rows, startDaemon, waitFor } from "./helpers.mjs";

const DAEMON_T = 120000;

function shimRig() {
  const r = rig({
    COORDINATE_MACHINE: "vps",
    COORDINATE_LEASE_S: "3",
    COORDINATE_CAP: "4",
    COORDINATE_REPO_CAP: "4",
    FAKE_SLEEP: "2", // heavy jobs run 2s so lease contention is observable
  });
  fs.writeFileSync(
    r.env.COORDINATE_CONFIG,
    "[slots]\n" +
      "'tool:vitest:*' = 2\n" +
      "'build:global' = 2\n" +
      "'tool:sqlload:*' = 2\n" +
      "[tools]\n" +
      'sqlload = { cost = 1, match = ["sqlload"] }\n',
  );
  // Fake heavy binaries so the tests never hit the user's real vitest/tsc shims.
  for (const name of ["vitest", "sqlload", "tsc"]) {
    fakeBin(r, name, "sleep ${FAKE_SLEEP:-0}; exit 0");
  }
  // The repo is the cwd of every job here, like the Python fixture.
  const repo = path.join(r.dir, "repo");
  fs.mkdirSync(repo);
  return { r, repo };
}

function enqueue(r, cwd, tag, cmd) {
  const out = cli(r, "enqueue", "--cwd", cwd, "--shell", "--", cmd);
  assert.equal(out.status, 0, out.stderr);
}

function spans(log, tag) {
  return `echo s ${tag} ${NOW} >> ${log}; sleep 0.8; echo e ${tag} ${NOW} >> ${log}`;
}

function audit(r) {
  return rows(r, "SELECT argv0, tool_class, project, job_id FROM spawn_audit");
}

async function waitParked(r, jid, timeout = 30000) {
  let found = null;
  await waitFor(
    () => {
      const row = rows(r, `SELECT status, waiting_on FROM jobs WHERE id=${jid}`)[0];
      if (row && row.status === "waiting") {
        found = row.waiting_on;
        return true;
      }
      return false;
    },
    timeout,
  );
  return found;
}

test("test_heavy_parks_at_cap_and_resumes_on_release", { timeout: DAEMON_T }, async () => {
  const { r, repo } = shimRig();
  const log = path.join(r.dir, "spans");
  try {
    for (let i = 0; i < 3; i++) {
      // tool:vitest limit 2, cost 2 + 2s jobs: the first runs, the later ones park
      enqueue(r, repo, `v${i}`, `vitest run ${spans(log, `v${i}`)}`);
    }
    const ids = rows(r, "SELECT id FROM jobs ORDER BY id").map((x) => Number(x.id));
    assert.equal(ids.length, 3);
    startDaemon(r);
    const parked = await waitParked(r, ids[2]);
    assert.ok(parked && parked.startsWith("tool:vitest:"), "third vitest parked at boundary");
    const [, done] = drain(r, 3);
    assert.equal(done, 3, "all three complete as leases free up (park -> resume path)");
    const a = audit(r);
    assert.deepEqual(new Set(a.map((x) => x.tool_class)), new Set(["vitest"]), "heavy spawns audited with their class");
  } finally {
    await cleanup(r);
  }
});

test("test_unmatched_tool_audited_never_blocked", { timeout: DAEMON_T }, async () => {
  const { r, repo } = shimRig();
  const log = path.join(r.dir, "spans");
  try {
    // unmatched binary: runs immediately without a lease or audit row
    enqueue(r, repo, "triv", `echo t0 $(date +%s.%N) >> ${log}`);
    startDaemon(r);
    const [, done] = drain(r, 1);
    assert.equal(done, 1);
    assert.deepEqual(audit(r), [], "unmatched binary: no audit row, no lease");
  } finally {
    await cleanup(r);
  }
});

test("test_weighted_cost_excludes_cheaper_sibling", { timeout: DAEMON_T }, async () => {
  const { r, repo } = shimRig();
  const log = path.join(r.dir, "spans");
  try {
    // weighted semantics: two tsc (cost 2, limit 2) serialize, while the cheap sqlload
    // (its own key) runs freely alongside - weights bind within a key (D3)
    fs.writeFileSync(
      r.env.COORDINATE_CONFIG,
      '[tools]\nsqlload = { cost = 1, match = ["sqlload"] }\n' +
        "[slots]\n'tool:tsc-build:*' = 2\n'tool:sqlload:*' = 2\n",
    );
    enqueue(r, repo, "t0", `tsc --build; ${spans(log, "t0")}`);
    enqueue(r, repo, "t1", `tsc --build; ${spans(log, "t1")}`);
    enqueue(r, repo, "s0", `sqlload run; ${spans(log, "s0")}`);
    startDaemon(r);
    const [, done] = drain(r, 3);
    assert.equal(done, 3);
    const ovTsc = peakOverlap(log, new Set(["t0", "t1"]));
    const ovAny = peakOverlap(log);
    assert.equal(ovTsc, 1, "cost-2 tsc runs serialize within their key at limit 2");
    assert.equal(ovAny, 2, "cheap sqlload on its own key overlaps a running tsc");
    const a = audit(r);
    assert.deepEqual(
      new Set(a.map((x) => x.tool_class)),
      new Set(["tsc-build", "sqlload"]),
      "both heavy classes audited",
    );
  } finally {
    await cleanup(r);
  }
});

test("test_trivial_tools_pay_nothing", { timeout: DAEMON_T }, async () => {
  const { r, repo } = shimRig();
  try {
    enqueue(r, repo, "g", `grep -r x ${repo} > /dev/null; echo done`);
    startDaemon(r);
    const t0 = Date.now();
    const [, done] = drain(r, 1);
    assert.equal(done, 1);
    assert.ok(Date.now() - t0 < 60000, "a trivial tool must not wait for a lease");
    assert.deepEqual(audit(r), [], "grep-class spawn: no audit row, no lease");
  } finally {
    await cleanup(r);
  }
});
