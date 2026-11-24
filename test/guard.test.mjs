// coordinate-guard tests: table-driven cases from issue #3 plus the contract
// (mode, job bypass, malformed stdin). The guard is Python; each case spawns
// it with a PreToolUse hook JSON payload on stdin and asserts the exit code.
import { test } from "node:test";
import * as assert from "node:assert";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as url from "node:url";

const GUARD = path.join(
  path.dirname(url.fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "coordinate-guard",
);

const B = 2; // block
const A = 0; // allow

// spawn a guard run with a clean env plus optional overrides
function run(command, env = {}) {
  const payload = JSON.stringify({ tool_input: { command } });
  const res = spawnSync("python3", [GUARD], {
    input: payload,
    env: { PATH: process.env["PATH"], ...env },
    encoding: "utf8",
  });
  return res;
}

test("spawn/mention table from issue #3", () => {
  const cases = [
    // [command, want, why]
    ['claude -p "hi"', B, "plain spawn"],
    ['/opt/homebrew/bin/claude -p "hi"', B, "path prefix"],
    ['~/.local/bin/codex exec "x"', B, "path prefix"],
    ['(claude -p "hi")', B, "subshell"],
    ['t3 thread start . "hi"', B, "t3 thread start is a full agent session"],
    ['t3 thread send t42 "go"', B, "t3 thread send"],
    ['bash -c \'codex exec "fix it"\'', B, "sh -c recursion"],
    ["sh -c 'claude --print \"hi\"'", B, "sh -c recursion, --print"],
    ["env COORDINATE_GUARD=off claude -p 'hi'", B, "env + VAR=.. prefix"],
    ["sudo /usr/bin/env codex exec 'x'", B, "sudo prefix"],
    ["nohup claude -p 'hi' &", B, "nohup prefix + background"],
    ["nice -n 5 codex run 'x'", B, "nice with value opt"],
    ["timeout 30 claude -p 'hi'", B, "timeout with duration"],
    ["timeout -s KILL 5 bash -c 'codex exec \"x\"'", B, "timeout opts + sh -c"],
    ["xargs -n 1 claude -p", B, "xargs prefix"],
    ["echo 'run codex exec later' > notes.md", A, "only mentions it"],
    ['t3q new . "use claude -p to ..."', A, "queue wrapper itself"],
    ["t3q send t1 'claude exec something'", A, "queue wrapper send"],
    ["cat > doc.md <<'X'\nuse codex exec to run it\nX", A, "heredoc body"],
    ["cat <<EOF | tee log\nclaude -p 'hi'\nEOF", A, "heredoc body piped"],
    ['grep -n "claude -p" README.md', A, "grep pattern"],
    ["claude --version", A, "no spawn flag"],
    ["npm run build", A, "unrelated"],
    ["git status", A, "unrelated"],
    ["echo claude", A, "bare mention, no spawn arg"],
    ["node scripts/claude-helper.js -p x", A, "basename not in SPAWNS"],
    ["echo 'unterminated", A, "unbalanced quotes: allow"],
    ["echo \"# claude -p hi\"", A, "quoted string"],
    ["echo hi # claude -p hi", A, "comment"],
    ["CLAUDE=1 echo codex exec", A, "VAR assignment, not spawn"],
  ];
  for (const [cmd, want, why] of cases) {
    const res = run(cmd);
    assert.equal(
      res.status,
      want,
      `case ${JSON.stringify(cmd)} (${why}): exit ${res.status}, stderr ${res.stderr}`,
    );
    if (want === B) assert.match(res.stderr, /BLOCKED/);
    else assert.equal(res.stderr, "");
  }
});

test("warn mode allows but notes on stderr", () => {
  const res = run('claude -p "hi"', { COORDINATE_GUARD: "warn" });
  assert.equal(res.status, A);
  assert.match(res.stderr, /WARN/);
});

test("COORDINATE_GUARD=off disables the guard", () => {
  const res = run('claude -p "hi"', { COORDINATE_GUARD: "off" });
  assert.equal(res.status, A);
  assert.equal(res.stderr, "");
});

test("inside a queue job (COORDINATE_JOB_ID) everything is allowed", () => {
  const res = run('claude -p "hi"', { COORDINATE_JOB_ID: "42" });
  assert.equal(res.status, A);
});

test("inside a queue job (FLEET_JOB_ID) everything is allowed", () => {
  const res = run('codex exec "x"', { FLEET_JOB_ID: "42" });
  assert.equal(res.status, A);
});

test("job bypass wins over mode", () => {
  const res = run('claude -p "hi"', {
    COORDINATE_GUARD: "block",
    COORDINATE_JOB_ID: "42",
  });
  assert.equal(res.status, A);
});

test("malformed stdin JSON is allowed", () => {
  const res = spawnSync("python3", [GUARD], {
    input: "not json {",
    env: { PATH: process.env["PATH"] },
    encoding: "utf8",
  });
  assert.equal(res.status, A);
});

test("missing or non-dict tool_input is allowed", () => {
  for (const payload of ["{}", JSON.stringify({ tool_input: "nope" })]) {
    const res = spawnSync("python3", [GUARD], {
      input: payload,
      env: { PATH: process.env["PATH"] },
      encoding: "utf8",
    });
    assert.equal(res.status, A, payload);
  }
});

test("empty command is allowed", () => {
  const res = run("");
  assert.equal(res.status, A);
});
