// service unit-file generation tests under node --test. Pure generate-and-verify:
// renderers are exercised with fake inputs, no real systemctl/launchd calls and
// no writes to the user's system directories.
import { test } from "node:test";
import * as assert from "node:assert";
import "koffi";
import "@cutils/sqlite/node-binding";

const svc = await import("../src/service.ts");

const ENV = { db: "/tmp/x/queue.db", machine: "vps", cap: "4", pathValue: "/usr/bin:/home/me/bin" };

test("systemd unit embeds absolute binary, daemon verb and resolved env", () => {
  const unit = svc.renderSystemdUnit("/home/me/bin/coordinate", ENV);
  assert.match(unit, /\[Unit\]/);
  assert.match(unit, /\[Service\]/);
  assert.match(unit, /\[Install\]\nWantedBy=default\.target/);
  assert.match(unit, /ExecStart="\/home\/me\/bin\/coordinate" daemon/);
  assert.match(unit, /Environment=COORDINATE_DB="\/tmp\/x\/queue\.db"/);
  assert.match(unit, /Environment=COORDINATE_MACHINE="vps"/);
  assert.match(unit, /Environment=COORDINATE_CAP="4"/);
  assert.match(unit, /Environment=PATH="\/usr\/bin:\/home\/me\/bin"/);
  assert.match(unit, /Restart=on-failure/);
  // no bare `coordinate` ExecStart that would break on PATH changes
  assert.ok(!unit.includes("ExecStart=coordinate"));
});

test("systemd unit quotes values with spaces and skips unset env", () => {
  const unit = svc.renderSystemdUnit("/opt/bin/coordinate", {
    db: null,
    machine: "my laptop",
    cap: null,
    pathValue: "/a:/b c",
  });
  assert.ok(!unit.includes("COORDINATE_DB"));
  assert.ok(!unit.includes("COORDINATE_CAP"));
  assert.match(unit, /Environment=COORDINATE_MACHINE="my laptop"/);
  assert.match(unit, /Environment=PATH="\/a:\/b c"/);
});

test("launchd plist is well-formed and embeds binary path plus env", () => {
  const plist = svc.renderLaunchdPlist("/usr/local/bin/coordinate", ENV);
  assert.match(plist, /<plist version="1\.0">/);
  assert.match(plist, /<key>Label<\/key><string>sh\.coordinate\.daemon<\/string>/);
  assert.match(plist, /<string>\/usr\/local\/bin\/coordinate<\/string>\n    <string>daemon<\/string>/);
  assert.match(plist, /<key>COORDINATE_DB<\/key><string>\/tmp\/x\/queue\.db<\/string>/);
  assert.match(plist, /<key>COORDINATE_MACHINE<\/key><string>vps<\/string>/);
  assert.match(plist, /<key>COORDINATE_CAP<\/key><string>4<\/string>/);
  assert.match(plist, /<key>PATH<\/key><string>\/usr\/bin:\/home\/me\/bin<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
});

test("launchd plist XML-escapes env values", () => {
  const plist = svc.renderLaunchdPlist("/bin/coordinate", {
    db: "/tmp/a&b<q>.db",
    machine: null,
    cap: null,
    pathValue: "/bin",
  });
  assert.match(plist, /<key>COORDINATE_DB<\/key><string>\/tmp\/a&amp;b&lt;q&gt;\.db<\/string>/);
  assert.ok(!plist.includes("COORDINATE_MACHINE"));
});

test("unit paths land under the per-platform user directories", () => {
  const p = svc.unitPath();
  if (process.platform === "darwin") {
    assert.match(p, /Library\/LaunchAgents\/sh\.coordinate\.daemon\.plist$/);
  } else {
    assert.match(p, /systemd\/user\/coordinate\.service$/);
  }
});

test("binaryPath returns an absolute path", () => {
  assert.ok(svc.binaryPath().startsWith("/"));
});
