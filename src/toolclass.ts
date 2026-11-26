// Shared tool-classification helpers: which tool class a spawn belongs to,
// how lease keys are derived, and the shlex splitter used for shell-string
// commands. Extracted from daemon.ts so the daemon's spawn path and the
// `coordinate run` adapter classify identically (D2: lease keys must agree).

import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { toolClasses } from "./config.ts";

export function toolSlotKey(cls: string, proj: string): string {
  return "tool:" + cls + ":" + proj;
}

export function matchToolClass(argv0: string): { cls: string; cost: number } | null {
  const norm = path.normalize(argv0);
  const parts = norm.split(path.sep).filter((p) => p !== "");
  const names: Record<string, boolean> = {};
  names[path.basename(argv0)] = true;
  for (const p of parts) {
    names[p] = true;
  }
  for (const cls of Object.keys(toolClasses())) {
    const spec = toolClasses()[cls];
    for (const m of spec.match) {
      if (names[m] === true) {
        return { cls, cost: spec.cost };
      }
    }
  }
  return null;
}

export function which(name: string): string | null {
  if (name.includes(path.sep)) {
    try {
      fs.accessSync(name, fs.constants.X_OK);
      return name;
    } catch {
      return null;
    }
  }
  const p = process.env["PATH"] || "";
  for (const d of p.split(path.delimiter)) {
    const full = path.join(d, name);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      // keep looking
    }
  }
  return null;
}

export function projectKey(cwd: string | null): string {
  const start = path.resolve(cwd === null || cwd === undefined || cwd === "" ? process.cwd() : cwd);
  let d = start;
  for (;;) {
    const dot = path.join(d, ".git");
    if (fs.existsSync(dot)) {
      try {
        if (fs.statSync(dot).isDirectory()) {
          return d;
        }
        // .git file: worktree; resolve gitdir + commondir
        const text = fs.readFileSync(dot, "utf8");
        let gitdir: string | null = null;
        for (const line of text.split("\n")) {
          if (line.startsWith("gitdir:")) {
            gitdir = path.resolve(d, line.slice(7).trim());
            break;
          }
        }
        if (gitdir !== null) {
          const common = fs.readFileSync(path.join(gitdir, "commondir"), "utf8").trim();
          return path.dirname(path.resolve(gitdir, common));
        }
      } catch {
        // fall through to git probe
      }
      try {
        const out = cp.execFileSync("git", ["-C", d, "rev-parse", "--git-common-dir"], { timeout: 2000, encoding: "utf8" }).trim();
        if (out !== "") {
          const p = path.resolve(d, out);
          if (path.basename(p) === ".git") {
            return path.dirname(p);
          }
          return fs.existsSync(path.join(p, ".git")) ? p : path.dirname(p);
        }
      } catch {
        // not resolvable
      }
    }
    const parent = path.dirname(d);
    if (parent === d) {
      return start;
    }
    d = parent;
  }
}

export function shlexSplit(s: string): string[] | null {
  const toks: string[] = [];
  let cur = "";
  let started = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (started) {
        toks.push(cur);
        cur = "";
        started = false;
      }
      i = i + 1;
      continue;
    }
    if (ch === "'") {
      started = true;
      i = i + 1;
      while (i < s.length && s[i] !== "'") {
        cur = cur + s[i];
        i = i + 1;
      }
      if (i >= s.length) {
        return null;
      }
      i = i + 1;
      continue;
    }
    if (ch === '"') {
      started = true;
      i = i + 1;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < s.length) {
          const n = s[i + 1];
          if (n === '"' || n === "\\" || n === "$" || n === "`") {
            cur = cur + n;
            i = i + 2;
            continue;
          }
        }
        cur = cur + s[i];
        i = i + 1;
      }
      if (i >= s.length) {
        return null;
      }
      i = i + 1;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 >= s.length) {
        return null;
      }
      cur = cur + s[i + 1];
      started = true;
      i = i + 2;
      continue;
    }
    cur = cur + ch;
    started = true;
    i = i + 1;
  }
  if (started) {
    toks.push(cur);
  }
  return toks;
}
