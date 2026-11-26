// Publish step for the changesets release flow: create and push the version
// tag, which is what triggers the binary builds in release.yml. Not an npm
// publish — coordinate distributes as binaries, not a registry package.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const tag = "v" + version;
const existing = execSync("git tag -l " + tag, { encoding: "utf8" }).trim();
if (existing === tag) {
  console.log(tag + " already exists, nothing to do");
  process.exit(0);
}
execSync("git tag -a " + tag + " -m " + JSON.stringify("release " + tag), { stdio: "inherit" });
execSync("git push origin " + tag, { stdio: "inherit" });
console.log("tagged and pushed " + tag + " — release.yml builds the binaries");
