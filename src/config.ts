// config.toml reader: a real TOML subset (tables, dotted and quoted keys, basic and
// literal strings, integers with `_` separators, booleans, arrays and inline tables,
// comments), replacing the line matcher that honored one [slots] spelling (B8).
// A missing file means defaults, as in the Python version; a file that exists but is
// unreadable or invalid fails with the file and line, never a silent fallback.

import * as fs from "node:fs";
import { configPath } from "./env.ts";

export class ConfigError extends Error {
  public file: string;
  public line: number;
  constructor(file: string, line: number, msg: string) {
    super(file + ":" + line + ": " + msg);
    this.name = "ConfigError";
    this.file = file;
    this.line = line;
  }
}

export interface ConfigFile {
  file: string;
  root: Record<string, unknown>;
  lines: Record<string, number>;
}

const INT_RE = /^[+-]?[0-9]([0-9_]*[0-9])?$/;
const FLOAT_RE = /^[+-]?([0-9]+(\.[0-9]+)?|\.[0-9]+)([eE][+-]?[0-9]+)?$/;

function isRecord(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

class Parser {
  private text: string;
  private pos: number;
  private line: number;
  private file: string;
  private lines: Record<string, number>;

  constructor(file: string, text: string) {
    this.text = text;
    this.pos = 0;
    this.line = 1;
    this.file = file;
    this.lines = {};
  }

  private err(msg: string): ConfigError {
    return new ConfigError(this.file, this.line, msg);
  }

  private peek(): string {
    return this.pos < this.text.length ? this.text.charAt(this.pos) : "";
  }

  private advance(): void {
    if (this.pos < this.text.length) {
      if (this.text.charAt(this.pos) === "\n") {
        this.line++;
      }
      this.pos++;
    }
  }

  private skipInline(): void {
    while (this.pos < this.text.length) {
      const c = this.text.charAt(this.pos);
      if (c === " " || c === "\t" || c === "\r") {
        this.pos++;
      } else {
        break;
      }
    }
  }

  private skipAll(): void {
    for (;;) {
      const c = this.peek();
      if (c === " " || c === "\t" || c === "\r") {
        this.pos++;
      } else if (c === "\n") {
        this.advance();
      } else if (c === "#") {
        while (this.pos < this.text.length && this.text.charAt(this.pos) !== "\n") {
          this.pos++;
        }
      } else {
        break;
      }
    }
  }

  private expectLineEnd(where: string): void {
    this.skipInline();
    if (this.peek() === "#") {
      while (this.pos < this.text.length && this.text.charAt(this.pos) !== "\n") {
        this.pos++;
      }
    }
    const c = this.peek();
    if (c === "\n") {
      this.advance();
      return;
    }
    if (c === "") {
      return;
    }
    throw this.err("expected a newline after " + where);
  }

  private parseBasicString(): string {
    const startLine = this.line;
    this.advance(); // opening quote
    let out = "";
    for (;;) {
      if (this.pos >= this.text.length || this.peek() === "\n") {
        throw new ConfigError(this.file, startLine, "unterminated string");
      }
      const c = this.text.charAt(this.pos);
      if (c === '"') {
        this.advance();
        return out;
      }
      if (c === "\\") {
        this.advance();
        const e = this.peek();
        if (e === "n") out += "\n";
        else if (e === "t") out += "\t";
        else if (e === "r") out += "\r";
        else if (e === "b") out += "\b";
        else if (e === "f") out += "\f";
        else if (e === '"') out += '"';
        else if (e === "\\") out += "\\";
        else if (e === "u") {
          let hex = "";
          for (let i = 0; i < 4; i++) {
            this.advance();
            hex += this.peek();
          }
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw this.err("bad \\u escape in string");
          }
          out += String.fromCharCode(parseInt(hex, 16));
        } else {
          throw this.err("bad escape \\" + e + " in string");
        }
        this.advance();
        continue;
      }
      out += c;
      this.advance();
    }
  }

  private parseLiteralString(): string {
    const startLine = this.line;
    this.advance(); // opening quote
    let out = "";
    for (;;) {
      if (this.pos >= this.text.length || this.peek() === "\n") {
        throw new ConfigError(this.file, startLine, "unterminated string");
      }
      const c = this.text.charAt(this.pos);
      if (c === "'") {
        this.advance();
        return out;
      }
      out += c;
      this.advance();
    }
  }

  private parseSimpleKey(): string {
    const c = this.peek();
    if (c === '"') {
      return this.parseBasicString();
    }
    if (c === "'") {
      return this.parseLiteralString();
    }
    let key = "";
    while (this.pos < this.text.length) {
      const ch = this.text.charAt(this.pos);
      if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "_" || ch === "-") {
        key += ch;
        this.pos++;
      } else {
        break;
      }
    }
    if (key === "") {
      throw this.err("expected a key");
    }
    return key;
  }

  private parseKeyPath(): string[] {
    const parts: string[] = [this.parseSimpleKey()];
    for (;;) {
      this.skipInline();
      if (this.peek() === ".") {
        this.advance();
        this.skipInline();
        parts.push(this.parseSimpleKey());
      } else {
        return parts;
      }
    }
  }

  private parseNumberOrBool(): unknown {
    let tok = "";
    while (this.pos < this.text.length) {
      const c = this.text.charAt(this.pos);
      if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "," || c === "]" || c === "}" || c === "#") {
        break;
      }
      tok += c;
      this.pos++;
    }
    if (tok === "true") {
      return true;
    }
    if (tok === "false") {
      return false;
    }
    if (INT_RE.test(tok)) {
      return Number(tok.replace(/_/g, ""));
    }
    if (FLOAT_RE.test(tok)) {
      return Number(tok);
    }
    throw this.err("invalid value " + JSON.stringify(tok));
  }

  private parseValue(): unknown {
    const c = this.peek();
    if (c === '"') {
      return this.parseBasicString();
    }
    if (c === "'") {
      return this.parseLiteralString();
    }
    if (c === "[") {
      this.advance();
      const arr: unknown[] = [];
      for (;;) {
        this.skipAll();
        if (this.peek() === "]") {
          this.advance();
          return arr;
        }
        arr.push(this.parseValue());
        this.skipAll();
        if (this.peek() === ",") {
          this.advance();
        } else if (this.peek() !== "]") {
          throw this.err("expected ',' or ']' in array");
        }
      }
    }
    if (c === "{") {
      this.advance();
      const tbl: Record<string, unknown> = {};
      for (;;) {
        this.skipAll();
        if (this.peek() === "}") {
          this.advance();
          return tbl;
        }
        const path = this.parseKeyPath();
        this.skipInline();
        if (this.peek() !== "=") {
          throw this.err("expected '=' in inline table");
        }
        this.advance();
        this.skipInline();
        assign(tbl, path, this.parseValue(), this.file, this.line);
        this.skipAll();
        if (this.peek() === ",") {
          this.advance();
        } else if (this.peek() !== "}") {
          throw this.err("expected ',' or '}' in inline table");
        }
      }
    }
    return this.parseNumberOrBool();
  }

  parse(): ConfigFile {
    const root: Record<string, unknown> = {};
    let cur: Record<string, unknown> = root;
    let prefix = "";
    for (;;) {
      this.skipAll();
      if (this.pos >= this.text.length) {
        break;
      }
      if (this.peek() === "[") {
        this.advance();
        this.skipInline();
        const headerLine = this.line;
        const path = this.parseKeyPath();
        this.skipInline();
        if (this.peek() !== "]") {
          throw this.err("expected ']' after table header");
        }
        this.advance();
        cur = tableFor(root, path, this.file, headerLine);
        prefix = path.join(".");
        this.lines[prefix] = headerLine;
        this.expectLineEnd("table header");
        continue;
      }
      const keyLine = this.line;
      const rel = this.parseKeyPath();
      this.skipInline();
      if (this.peek() !== "=") {
        throw this.err("expected '=' after key");
      }
      this.advance();
      this.skipInline();
      const value = this.parseValue();
      assign(cur, rel, value, this.file, keyLine);
      this.lines[joinPath(prefix, rel)] = keyLine;
      this.expectLineEnd("key/value pair");
    }
    return { file: this.file, root, lines: this.lines };
  }
}

function joinPath(prefix: string, rel: string[]): string {
  const all: string[] = [];
  if (prefix !== "") {
    all.push(prefix);
  }
  for (const p of rel) {
    all.push(p);
  }
  return all.join(".");
}

function tableFor(root: Record<string, unknown>, path: string[], file: string, line: number): Record<string, unknown> {
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < path.length; i++) {
    const k = path[i];
    const existing = cur[k];
    if (i === path.length - 1) {
      if (existing !== undefined && isRecord(existing)) {
        throw new ConfigError(file, line, "duplicate table [" + path.join(".") + "]");
      }
      if (existing !== undefined) {
        throw new ConfigError(file, line, "key " + k + " is already a value, cannot be a table");
      }
      const tbl: Record<string, unknown> = {};
      cur[k] = tbl;
      return tbl;
    }
    if (existing === undefined) {
      const tbl: Record<string, unknown> = {};
      cur[k] = tbl;
      cur = tbl;
    } else if (isRecord(existing)) {
      cur = existing as Record<string, unknown>;
    } else {
      throw new ConfigError(file, line, "key " + k + " is already a value, cannot be a table");
    }
  }
  return cur;
}

function assign(tbl: Record<string, unknown>, path: string[], value: unknown, file: string | null, line: number): void {
  let cur = tbl;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    const next = cur[k];
    if (next === undefined) {
      const made: Record<string, unknown> = {};
      cur[k] = made;
      cur = made;
    } else if (isRecord(next)) {
      cur = next as Record<string, unknown>;
    } else {
      if (file !== null) {
        throw new ConfigError(file, line, "key " + k + " is already a value, cannot be dotted through");
      }
      throw new Error("key " + k + " is already a value");
    }
  }
  const last = path[path.length - 1];
  if (cur[last] !== undefined && file !== null) {
    throw new ConfigError(file, line, "duplicate key " + last);
  }
  cur[last] = value;
}

// ---- file loading and typed accessors ---------------------------------------------------------

export function readConfig(p: string | null = null): ConfigFile | null {
  const file = p === null ? configPath() : p;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return null;
    }
    throw new ConfigError(file, 0, "cannot read config: " + err.message);
  }
  return new Parser(file, text).parse();
}

function section(cf: ConfigFile, name: string): Record<string, unknown> {
  const v = cf.root[name];
  if (v === undefined || v === null) {
    return {};
  }
  if (!isRecord(v)) {
    const line = cf.lines[name];
    throw new ConfigError(cf.file, line, "[" + name + "] must be a table");
  }
  return v as Record<string, unknown>;
}

function lineOf(cf: ConfigFile, path: string): number {
  const l = cf.lines[path];
  return l === undefined ? 0 : l;
}

function nonNegInt(cf: ConfigFile, path: string, v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new ConfigError(cf.file, lineOf(cf, path), path + " must be a non-negative integer, got " + JSON.stringify(v));
  }
  return v;
}

export function slotsConfig(): Record<string, number> {
  const out: Record<string, number> = {};
  const cf = readConfig();
  if (cf === null) {
    return out;
  }
  const slots = section(cf, "slots");
  for (const key of Object.keys(slots)) {
    out[key] = nonNegInt(cf, "slots." + key, slots[key]);
  }
  return out;
}

export function slotLimit(key: string): number {
  const cfg = slotsConfig();
  const direct = cfg[key];
  if (direct !== undefined) {
    return direct;
  }
  if (key.startsWith("tool:")) {
    const parts = key.split(":");
    if (parts.length === 3) {
      const wl = cfg[parts[0] + ":" + parts[1] + ":*"];
      if (wl !== undefined) {
        return wl;
      }
    }
  }
  return 1;
}

export interface ToolClassSpec {
  cost: number;
  match: string[];
}

export const DEFAULT_TOOL_CLASSES: Record<string, ToolClassSpec> = {
  vitest: { cost: 2, match: ["vitest", "jest", "playwright"] },
  "tsc-build": { cost: 2, match: ["tsc", "vite"] },
  cargo: { cost: 2, match: ["cargo"] },
  docker: { cost: 2, match: ["docker", "docker-compose"] },
  "pkg-install": { cost: 1, match: ["npm", "pnpm", "yarn", "uv"] },
};

// [tools] from config (class -> {cost, match}) overlaid on the shipped defaults.
export function toolClasses(): Record<string, ToolClassSpec> {
  const out: Record<string, ToolClassSpec> = {};
  const cf = readConfig();
  if (cf !== null) {
    const tools = section(cf, "tools");
    for (const name of Object.keys(tools)) {
      const spec = tools[name];
      if (!isRecord(spec)) {
        throw new ConfigError(cf.file, lineOf(cf, "tools." + name), "[tools] " + name + " must be a table with cost and match");
      }
      const rec = spec as Record<string, unknown>;
      const costV = rec["cost"];
      const matchV = rec["match"];
      let cost = 1;
      if (costV !== undefined) {
        cost = nonNegInt(cf, "tools." + name + ".cost", costV);
      }
      const match: string[] = [];
      if (matchV !== undefined) {
        if (!Array.isArray(matchV)) {
          throw new ConfigError(cf.file, lineOf(cf, "tools." + name + ".match"), "[tools] " + name + ".match must be an array");
        }
        for (const m of matchV) {
          if (typeof m !== "string") {
            throw new ConfigError(cf.file, lineOf(cf, "tools." + name + ".match"), "[tools] " + name + ".match must contain strings");
          }
          match.push(m);
        }
      }
      out[name] = { cost, match };
    }
  }
  for (const k of Object.keys(DEFAULT_TOOL_CLASSES)) {
    if (out[k] === undefined) {
      out[k] = DEFAULT_TOOL_CLASSES[k];
    }
  }
  return out;
}

// '15m' style suffix (s/m/h, plain number = seconds) to seconds. 0 = no cap.
// Returns null for a malformed duration (the caller decides the message).
export function parseDurationSecs(text: string): number | null {
  const t = String(text).trim().toLowerCase();
  const mult: Record<string, number> = { s: 1.0, m: 60.0, h: 3600.0 };
  const last = t.slice(-1);
  if (mult[last] !== undefined) {
    const head = t.slice(0, -1);
    const v = Number(head);
    if (head === "" || Number.isNaN(v) || v < 0) {
      return null;
    }
    return v * mult[last];
  }
  const v = Number(t);
  if (t === "" || Number.isNaN(v) || v < 0) {
    return null;
  }
  return v;
}

// [defaults] max_runtime from config.toml, so no job is unbounded unless capped at 0.
export function defaultMaxRuntimeS(): number {
  const cf = readConfig();
  if (cf === null) {
    return 0.0;
  }
  const defaults = section(cf, "defaults");
  const raw = defaults["max_runtime"];
  if (raw === undefined || raw === null) {
    return 0.0;
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0) {
      throw new ConfigError(cf.file, lineOf(cf, "defaults.max_runtime"), "defaults.max_runtime must be a duration");
    }
    return raw;
  }
  if (typeof raw === "string") {
    const secs = parseDurationSecs(raw);
    if (secs === null) {
      throw new ConfigError(cf.file, lineOf(cf, "defaults.max_runtime"), "bad duration " + JSON.stringify(raw) + " for defaults.max_runtime (use e.g. 90s, 15m, 2h)");
    }
    return secs;
  }
  throw new ConfigError(cf.file, lineOf(cf, "defaults.max_runtime"), "defaults.max_runtime must be a duration");
}

// Validates every section the daemon and CLI consume: called at daemon start and at
// enqueue so an invalid file fails loudly instead of degrading per key.
export function validateConfig(): void {
  const cf = readConfig();
  if (cf === null) {
    return;
  }
  slotsConfig();
  toolClasses();
  defaultMaxRuntimeS();
}
