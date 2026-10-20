import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
}

export function resolveCommit(cwd: string, ref = "HEAD"): string {
  return git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
}

export function repoRoot(cwd: string): string {
  return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
}

/** Pathspecs that exclude exactly these repo-relative paths (and nothing that merely shares a prefix). */
function excludes(paths: readonly string[]): string[] {
  return paths.map((p) => `:(top,exclude,literal)${p}`);
}

/**
 * Every path that differs from base: committed, staged, unstaged, and untracked (minus ignored).
 * `exclude` removes Relay's own files, such as a database kept inside the repository.
 */
export function changedFiles(cwd: string, base: string, exclude: readonly string[] = []): string[] {
  const spec = [":/", ...excludes(exclude)];
  const tracked = git(cwd, ["diff", "--name-only", "--no-renames", base, "--", ...spec]).split("\n");
  const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard", "--full-name", "--", ...spec]).split("\n");
  return [...new Set([...tracked, ...untracked].filter(Boolean))].sort();
}

/**
 * Tree hash of the whole workspace as it is on disk, without touching the real index.
 * Two pieces of evidence with the same fingerprint were produced against identical files.
 */
export function workspaceFingerprint(cwd: string, exclude: readonly string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-idx-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
    git(cwd, ["add", "-A", "--", ":/", ...excludes(exclude)], env);
    return git(cwd, ["write-tree"], env).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Relay's own database files when the database lives inside the repository (they are never project changes). */
export function relayOwnFiles(root: string, dbPath: string): string[] {
  if (dbPath === ":memory:") return [];
  const rel = relative(realpathSync(root), resolvePath(dbPath));
  if (rel.startsWith("..") || isAbsolute(rel)) return [];
  const p = rel.split(sep).join("/");
  return [p, `${p}-wal`, `${p}-shm`, `${p}-journal`];
}

/** File content at a revision, or null if it doesn't exist there. */
export function showAt(cwd: string, rev: string, path: string): string | null {
  try {
    return execFileSync("git", ["show", `${rev}:${path}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;
  }
}
