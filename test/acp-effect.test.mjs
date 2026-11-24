// ACP Effect-machinery tests: the JSON-RPC request lifetime that the ACP
// lane migration moved onto Effect. The protocol behavior itself is covered
// by test/acp.test.mjs (framing, session lifecycle, resume) and
// test/parity/acp.test.mjs (the daemon against the stub agent); these tests
// pin the Effect seams the migration relies on.
import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as cp from "node:child_process";
import "koffi";
import "@cutils/sqlite/node-binding";

const STUB = path.resolve(import.meta.dirname, "..", "fixtures", "stub_acp_agent.mjs");

async function freshAcp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-effect-"));
  process.env["COORDINATE_LEASE_S"] = "30";
  process.env["COORDINATE_DB"] = path.join(dir, "queue.db");
  process.env["COORDINATE_MACHINE"] = "bench";
  process.env["COORDINATE_CAP"] = "3";
  process.env["COORDINATE_REPO_CAP"] = "1";
  delete process.env["COORDINATE_CONFIG"];
  delete process.env["COORDINATE_ACP_CMD"];
  const acp = await import("../src/acp.ts");
  return { acp, dir };
}

function spawnStub(dir) {
  return cp.spawn(process.execPath, [STUB], { cwd: dir, stdio: ["pipe", "pipe", "inherit"] });
}

test("acp request seam: the response resumes the request effect without a poll loop", async () => {
  const { acp, dir } = await freshAcp();
  const proc = spawnStub(dir);
  const client = new acp.AcpClient(proc, () => {});
  const started = Date.now();
  await client.initialize();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5000, "initialize should answer at once (took " + String(elapsed) + "ms)");
  proc.kill("SIGKILL");
});

test("acp request seam: a request against a closed agent fails instead of hanging", async () => {
  const { acp, dir } = await freshAcp();
  const proc = spawnStub(dir);
  const client = new acp.AcpClient(proc, () => {});
  await client.initialize();
  proc.kill("SIGKILL");
  // The agent is gone: the pending request must reject (stdout closed), not
  // wait out the 30s timeout.
  await assert.rejects(() => client.newSession(dir), /closed|broken|EPIPE|error/i);
});

test("acp request seam: a request that never gets an answer times out", async () => {
  const { acp } = await freshAcp();
  // A client over a process that never speaks: the request must reject with
  // the method name and 'timed out'.
  const silent = cp.spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const client = new acp.AcpClient(silent, () => {});
  const started = Date.now();
  await assert.rejects(() => client.request("initialize", {}, 300), /initialize timed out/);
  assert.ok(Date.now() - started < 5000, "the timeout must fire, not the default 30s");
  silent.kill("SIGKILL");
});

test("acp request seam: the pending map is a Map, so a resolved request is dropped", async () => {
  const { acp, dir } = await freshAcp();
  const proc = spawnStub(dir);
  const client = new acp.AcpClient(proc, () => {});
  await client.initialize();
  const sid = await client.newSession(dir);
  assert.ok(sid.startsWith("stub-"));
  // The pending map is private, so the observable proof is that a second
  // request still works after the first resolved: a leaked slot would make
  // the client answer the second request with the first response.
  const sid2 = await client.newSession(dir);
  assert.notEqual(sid2, sid, "the second session/new must not be answered with the first response");
  proc.kill("SIGKILL");
});
