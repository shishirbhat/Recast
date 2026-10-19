import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { normalizePath } from "../core/conflicts.ts";
import { RelayError } from "../core/types.ts";

/** Never shared, never listed, never opened as a document, whatever .gitignore says. */
const SECRET_PATTERNS = [
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.relay(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|\/)\.(npmrc|netrc|pgpass)$/,
  /(^|\/)(credentials|secrets?)\.(json|ya?ml|toml)$/i,
];

export const MAX_DOC_BYTES = 2 * 1024 * 1024;

export function isSecretPath(rel: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(rel));
}

/** Files the IDE may show: tracked or untracked-but-not-ignored, minus secret paths. */
export function listProjectFiles(root: string): string[] {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return [...new Set(out.split("\0").filter(Boolean))].filter((p) => !isSecretPath(p) && existsSync(join(root, p))).sort();
}

function isIgnored(root: string, rel: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", rel], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a client-supplied path to a safe repo-relative one, or throws.
 * Rejects escapes (.., absolute, symlinks out), secret paths and gitignored paths.
 */
export function resolveProjectPath(root: string, requested: string): string {
  if (typeof requested !== "string" || !requested || requested.length > 512 || requested.includes("\0")) {
    throw new RelayError("invalid", "Invalid path");
  }
  const rel = normalizePath(root, requested);
  if (rel === null) throw new RelayError("forbidden", "Path is outside the project");
  if (isSecretPath(rel)) throw new RelayError("forbidden", `${rel} is a protected path and is never shared`);
  if (isIgnored(root, rel)) throw new RelayError("forbidden", `${rel} is ignored by git and is not shared`);
  return rel;
}

/** Reads a file as editable text, or explains why it cannot be a collaborative document. */
export function readText(root: string, rel: string): string | null {
  const abs = join(root, rel);
  if (!existsSync(abs)) return null;
  const st = statSync(abs);
  if (!st.isFile()) throw new RelayError("invalid", `${rel} is not a regular file`);
  if (st.size > MAX_DOC_BYTES) throw new RelayError("too_large", `${rel} is ${Math.round(st.size / 1024)} KB; the collaborative limit is ${MAX_DOC_BYTES / 1024} KB`);
  const buf = readFileSync(abs);
  if (buf.includes(0)) throw new RelayError("binary", `${rel} looks binary and can't be edited collaboratively`);
  const text = buf.toString("utf8");
  if (Buffer.from(text, "utf8").length !== buf.length) throw new RelayError("binary", `${rel} is not valid UTF-8`);
  return text;
}

/** Write via temp file + fsync + rename so a crash never leaves a half-written file. */
export function writeAtomic(root: string, rel: string, text: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = join(dirname(abs), `.${basename(abs)}.relay-${process.pid}-${Date.now()}.tmp`);
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, abs);
}

/** 3-way merge with git's own algorithm. Never throws on conflicts; reports them. */
export function merge3(base: string, ours: string, theirs: string): { clean: boolean; text: string } {
  const dir = mkdtempSync(join(tmpdir(), "relay-merge-"));
  try {
    const [b, o, t] = ["base", "ours", "theirs"].map((n) => join(dir, n));
    writeFileSync(b!, base);
    writeFileSync(o!, ours);
    writeFileSync(t!, theirs);
    try {
      const text = execFileSync("git", ["merge-file", "-p", "-L", "shared", "-L", "base", "-L", "incoming", o!, b!, t!], { encoding: "utf8" });
      return { clean: true, text };
    } catch (e) {
      const err = e as { status?: number; stdout?: string };
      if (typeof err.status === "number" && err.status > 0 && typeof err.stdout === "string") return { clean: false, text: err.stdout };
      throw e;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The single region where `a` and `b` differ, as an index plus delete count plus insert text. */
export function splice(a: string, b: string): { index: number; remove: number; insert: string } | null {
  if (a === b) return null;
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  // Never split a surrogate pair.
  const high = (c: number) => c >= 0xd800 && c <= 0xdbff;
  if (start > 0 && high(a.charCodeAt(start - 1))) start--;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  if (endA < a.length && endA > start && high(a.charCodeAt(endA - 1))) {
    endA++;
    endB++;
  }
  return { index: start, remove: endA - start, insert: b.slice(start, endB) };
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

/**
 * Literal, case-insensitive search across shared files with git's own grep (tracked + untracked, never ignored).
 * Secret paths are filtered out; results are capped so a broad query can't flood the client.
 */
export function searchProject(root: string, query: string, limit = 300): { hits: SearchHit[]; truncated: boolean } {
  if (!query || query.length > 200) return { hits: [], truncated: false };
  let out = "";
  try {
    out = execFileSync("git", ["grep", "-n", "-I", "-i", "-F", "--untracked", "--full-name", "-e", query, "--", ":/"], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    if (err.status === 1) return { hits: [], truncated: false }; // no matches
    throw e;
  }
  const hits: SearchHit[] = [];
  for (const row of out.split("\n")) {
    const m = /^(.*?):(\d+):(.*)$/.exec(row);
    if (!m || isSecretPath(m[1]!)) continue;
    hits.push({ path: m[1]!, line: Number(m[2]), text: m[3]!.slice(0, 240) });
    if (hits.length >= limit) return { hits, truncated: true };
  }
  return { hits, truncated: false };
}

export interface GitStatus {
  branch: string | null;
  head: string | null;
  changes: { path: string; status: string }[];
}

/** Working-tree changes against HEAD, as `git status` reports them, minus secrets and Relay's own files. */
export function gitStatus(root: string): GitStatus {
  const run = (args: string[], trim = true) => {
    try {
      const out = execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return trim ? out.trim() : out;
    } catch {
      return null;
    }
  };
  // Never trim porcelain output: its first column is significant (" M path").
  const raw = run(["status", "--porcelain=v1", "-z", "--untracked-files=all"], false) ?? "";
  const changes: { path: string; status: string }[] = [];
  const parts = raw.split("\0").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code[0] === "R" || code[0] === "C") i++; // renames carry the old path as the next entry
    if (isSecretPath(path)) continue;
    const status = code === "??" ? "untracked" : code.includes("D") ? "deleted" : code.includes("A") ? "added" : code.includes("R") ? "renamed" : "modified";
    changes.push({ path, status });
  }
  return { branch: run(["rev-parse", "--abbrev-ref", "HEAD"]), head: run(["rev-parse", "--short", "HEAD"]), changes };
}
