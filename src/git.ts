import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
