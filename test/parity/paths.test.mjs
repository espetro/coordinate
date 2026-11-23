// Parity suite for legacy/python:tests/test_paths.py (the 6 config and database resolution
// tests). The legacy ~/.fleet fallback, `coordinate migrate`, the runtime dir and the log dir are
// not ported (see .agents/docs/ts-port-test-gap.md), so they are out of scope here.
//
// The TypeScript equivalent of paths.py is src/env.ts, so these run in-process against that module
// with a scrubbed environment.
import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Every env var the Python `clean_env` fixture deletes, plus the two it needs.
const SCRUB = ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "COORDINATE_DB", "COORDINATE_CONFIG", "FLEET_DB", "FLEET_CONFIG"];

function cleanEnv() {
  const saved = {};
  for (const k of SCRUB) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  return () => {
    for (const k of SCRUB) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}

async function freshEnvModule() {
  // src/env.ts reads process.env at call time, but the module cache keeps one instance per
  // process: reload it so a changed XDG_* is picked up.
  const url = new URL("../../src/env.ts", import.meta.url).href + "?v=" + Math.random();
  return await import(url);
}

test("test_env_coordinate_wins", async () => {
  const restore = cleanEnv();
  try {
    process.env["FLEET_DB"] = "/old/db";
    process.env["COORDINATE_DB"] = "/new/db";
    const env = await freshEnvModule();
    assert.equal(env.env("DB"), "/new/db");
  } finally {
    restore();
  }
});

test("test_env_fleet_fallback", async () => {
  const restore = cleanEnv();
  try {
    process.env["FLEET_DB"] = "/old/db";
    const env = await freshEnvModule();
    assert.equal(env.env("DB"), "/old/db");
  } finally {
    restore();
  }
});

test("test_db_default_xdg_state", async () => {
  const restore = cleanEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-paths-"));
  try {
    process.env["XDG_STATE_HOME"] = path.join(dir, "state");
    const env = await freshEnvModule();
    assert.equal(env.dbPath(), path.join(dir, "state", "coordinate", "queue.db"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    restore();
  }
});

test("test_config_default_xdg_config", async () => {
  const restore = cleanEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-paths-"));
  try {
    process.env["XDG_CONFIG_HOME"] = path.join(dir, "conf");
    const env = await freshEnvModule();
    assert.equal(env.configPath(), path.join(dir, "conf", "coordinate", "config.toml"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    restore();
  }
});

test("test_db_override", async () => {
  const restore = cleanEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-paths-"));
  try {
    process.env["COORDINATE_DB"] = path.join(dir, "x.db");
    const env = await freshEnvModule();
    assert.equal(env.dbPath(), path.join(dir, "x.db"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    restore();
  }
});

test("test_config_override", async () => {
  const restore = cleanEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coord-paths-"));
  try {
    process.env["FLEET_CONFIG"] = path.join(dir, "x.toml");
    const env = await freshEnvModule();
    assert.equal(env.configPath(), path.join(dir, "x.toml"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    restore();
  }
});
