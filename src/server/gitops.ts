import { execFileSync } from "node:child_process";
import { RelayError } from "../core/types.ts";
import { isSecretPath } from "./files.ts";

/**
 * The project's Git workflow: status with staged and unstaged changes, diffs, stage/unstage, commit, branches, log,
 * pull and push. Every command runs the real git; a failure is reported with git's own message, never as success.
 * Nothing here discards work: there is no reset --hard, no checkout of paths, no forced push, and switching branches is
 * refused while tracked files have uncommitted changes.
 */

export interface FileChange {
  path: string;
  /** Staged (index vs HEAD) and unstaged (worktree vs index) status letters, git's own: M A D R C U ? */
  staged: string | null;
  unstaged: string | null;
  from?: string;
}

export interface GitState {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  files: FileChange[];
  conflicted: string[];
  hasRemote: boolean;
}

function git(root: string, args: string[], env?: NodeJS.ProcessEnv): string {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...(env ?? process.env), GIT_TERMINAL_PROMPT: "0" }, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    const msg = String((e as { stderr?: string }).stderr ?? (e as Error).message).replace(/Authorization:[^\n]*/gi, "Authorization: [hidden]").trim();
    throw new RelayError("invalid", `git ${args[0]} failed: ${msg.split("\n").slice(-4).join(" ") || "unknown error"}`);
  }
}
const tryGit = (root: string, args: string[]) => {
  try {
    return git(root, args).trim();
  } catch {
    return null;
  }
};

export function gitState(root: string): GitState {
  const raw = git(root, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]);
  const st: GitState = { branch: null, head: null, upstream: null, ahead: null, behind: null, files: [], conflicted: [], hasRemote: !!tryGit(root, ["remote"]) };
  const parts = raw.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const l = parts[i]!;
    if (!l) continue;
    if (l.startsWith("# branch.oid ")) st.head = l.slice(13, 20) === "(initia" ? null : l.slice(13, 20);
    else if (l.startsWith("# branch.head ")) st.branch = l.slice(14) === "(detached)" ? null : l.slice(14);
    else if (l.startsWith("# branch.upstream ")) st.upstream = l.slice(18);
    else if (l.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(l);
      if (m) (st.ahead = Number(m[1])), (st.behind = Number(m[2]));
    } else if (l[0] === "1" || l[0] === "2") {
      const f = l.split(" ");
      const xy = f[1]!;
      const path = f.slice(l[0] === "1" ? 8 : 9).join(" ");
      const from = l[0] === "2" ? parts[++i] : undefined;
      if (isSecretPath(path)) continue;
      st.files.push({ path, staged: xy[0] === "." ? null : xy[0]!, unstaged: xy[1] === "." ? null : xy[1]!, from });
    } else if (l[0] === "u") {
      const path = l.split(" ").slice(10).join(" ");
      if (!isSecretPath(path)) (st.conflicted.push(path), st.files.push({ path, staged: "U", unstaged: "U" }));
    } else if (l[0] === "?") {
      const path = l.slice(2);
      if (!isSecretPath(path)) st.files.push({ path, staged: null, unstaged: "?" });
    }
  }
  return st;
}

/** Content on each side of a change. `staged`: HEAD vs index. Otherwise: index (or HEAD) vs the working file. */
export function diffSides(root: string, path: string, staged: boolean, working: string | null): { before: string; after: string } {
  const show = (spec: string) => tryGitRaw(root, ["show", spec]);
  if (staged) return { before: show(`HEAD:${path}`) ?? "", after: show(`:${path}`) ?? "" };
  return { before: show(`:${path}`) ?? show(`HEAD:${path}`) ?? "", after: working ?? "" };
}
function tryGitRaw(root: string, args: string[]): string | null {
  try {
    return git(root, args);
  } catch {
    return null;
  }
}

function checkPaths(paths: string[]): void {
  if (!paths.length) throw new RelayError("invalid", "No files given");
  for (const p of paths) {
    if (p.startsWith("-") || p.includes("..") || p.startsWith("/")) throw new RelayError("invalid", `Invalid path ${p}`);
    if (isSecretPath(p)) throw new RelayError("forbidden", `${p} is a protected path and can't be staged from Relay`);
  }
}

export function stage(root: string, paths: string[]): void {
  checkPaths(paths);
  git(root, ["add", "--", ...paths]);
}

export function unstage(root: string, paths: string[]): void {
  checkPaths(paths);
  if (tryGit(root, ["rev-parse", "--verify", "HEAD"])) git(root, ["restore", "--staged", "--", ...paths]);
  else git(root, ["rm", "--cached", "--quiet", "--", ...paths]);
}

/** Commit what is staged, credited to the person who asked. Refuses an empty commit. */
export function commit(root: string, message: string, author: { name: string; id: string }): { sha: string; files: string[] } {
  const staged = git(root, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
  if (!staged.length) throw new RelayError("invalid", "Nothing is staged. Stage the changes you want in this commit first.");
  if (!message.trim()) throw new RelayError("invalid", "A commit needs a message");
  const name = git(root, ["config", "--default", author.name, "user.name"]).trim();
  const email = git(root, ["config", "--default", "relay@localhost", "user.email"]).trim();
  git(root, ["-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "--quiet", "--author", `${author.name} <${author.id}@users.relay.invalid>`, "-m", message]);
  return { sha: git(root, ["rev-parse", "--short", "HEAD"]).trim(), files: staged };
}

export function branches(root: string): { name: string; current: boolean; upstream: string | null; lastCommit: string }[] {
  const out = tryGit(root, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(committerdate:iso-strict)", "refs/heads"]) ?? "";
  return out.split("\n").filter(Boolean).map((l) => {
    const [name, head, upstream, date] = l.split("\t");
    return { name: name!, current: head === "*", upstream: upstream || null, lastCommit: date ?? "" };
  });
}

function checkBranchName(root: string, name: string): void {
  if (!name || name.startsWith("-") || tryGit(root, ["check-ref-format", "--branch", name]) === null) throw new RelayError("invalid", `"${name}" isn't a valid branch name`);
}

export function createBranch(root: string, name: string, switchTo: boolean): void {
  checkBranchName(root, name);
  if (switchTo) {
    // Creating and switching from the current commit keeps uncommitted changes as they are; nothing is lost.
    git(root, ["switch", "--quiet", "-c", name]);
  } else git(root, ["branch", name]);
}

/** Switch branches only from a clean tree: uncommitted changes to tracked files must be committed first. */
export function switchBranch(root: string, name: string): void {
  checkBranchName(root, name);
  const dirty = gitState(root).files.filter((f) => f.unstaged !== "?" && (f.staged || f.unstaged)).map((f) => f.path);
  if (dirty.length) throw new RelayError("blocked", `Commit or undo your changes first; switching would mix them into ${name}: ${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", …" : ""}`);
  git(root, ["switch", "--quiet", name]);
}

export function log(root: string, n = 30): { sha: string; author: string; date: string; subject: string }[] {
  const out = tryGit(root, ["log", `-n${n}`, "--format=%h%x1f%an%x1f%aI%x1f%s"]) ?? "";
  return out.split("\n").filter(Boolean).map((l) => {
    const [sha, author, date, subject] = l.split("\x1f");
    return { sha: sha!, author: author!, date: date!, subject: subject! };
  });
}

export function pull(root: string, env?: NodeJS.ProcessEnv): string {
  return git(root, ["pull", "--ff-only", "--no-rebase"], env).trim() || "Already up to date.";
}

export function push(root: string, env?: NodeJS.ProcessEnv): string {
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (branch === "HEAD") throw new RelayError("invalid", "You're on a detached HEAD; switch to a branch first");
  git(root, ["push", "--quiet", "--set-upstream", "origin", branch], env);
  return `Pushed ${branch}.`;
}
