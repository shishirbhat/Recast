import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { RelayError } from "../core/types.ts";
import { changedFiles } from "../git.ts";
import { isSecretPath } from "./files.ts";

/**
 * GitHub delivery: ship the shared workspace as a pull request and merge it, in one or two clicks.
 *
 * The token lives only in this process (GITHUB_TOKEN / GH_TOKEN, or `gh auth token`). It is never returned by the API,
 * never logged, and never put on a command line: git receives it through GIT_CONFIG_* environment variables.
 * Shipping never touches the working tree, the real index, or the current branch: the commit is built in a
 * temporary index and pushed to a fresh `relay/ship-*` branch.
 */

export interface GitHubOptions {
  /** A token, `null` for "not connected", or undefined to read GITHUB_TOKEN / GH_TOKEN / `gh auth token`. */
  token?: string | null;
  /** REST API base. Defaults to RELAY_GITHUB_API or https://api.github.com. */
  api?: string;
  /** owner/name. Defaults to RELAY_GITHUB_REPO or the `origin` remote's URL. */
  repo?: string;
  remote?: string;
}

export type MergeMethod = "squash" | "merge" | "rebase";

export interface PullRequest {
  number: number;
  url: string;
  title: string;
  state: "open" | "closed" | "merged";
  branch: string;
  base: string;
  mergeable: boolean | null;
  mergeableState: string | null;
  headSha: string;
}

export interface Check {
  id: string;
  ok: boolean;
  /** Blocking checks stop a ship; the rest are shown as warnings. */
  blocking: boolean;
  label: string;
  detail?: string;
}

export interface GitHubStatus {
  connected: boolean;
  reason?: string;
  tokenSource?: "options" | "GITHUB_TOKEN" | "GH_TOKEN" | "gh";
  repo?: { owner: string; name: string; url: string; defaultBranch: string; private: boolean; mergeMethods: MergeMethod[] };
  branch: string | null;
  changes: { files: number; ahead: number | null };
  pr: PullRequest | null;
}

/** Workspace facts the ship gate needs; supplied by the server so this module doesn't reach into the engine. */
export interface Preflight {
  conflicts: number;
  runningAgents: number;
  awaitingReview: string[];
  unappliedProposals: string[];
}

type ShipRow = { number: number; branch: string; created_at: string; merged_at: string | null };

export function parseGitHubRemote(url: string): { owner: string; name: string } | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1]!, name: m[2]! } : null;
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }).trim();
}
function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

export class GitHub {
  private root: string;
  private db: DatabaseSync;
  private dbPath: string;
  private opts: GitHubOptions;
  private token: { value: string; source: NonNullable<GitHubStatus["tokenSource"]> } | null | undefined;
  private repoInfo: GitHubStatus["repo"] | undefined;

  constructor(root: string, db: DatabaseSync, dbPath: string, opts: GitHubOptions = {}) {
    this.root = root;
    this.db = db;
    this.dbPath = dbPath;
    this.opts = opts;
    db.exec(`CREATE TABLE IF NOT EXISTS github_ships (
      number INTEGER PRIMARY KEY, branch TEXT NOT NULL, repo TEXT NOT NULL, created_by TEXT NOT NULL,
      created_at TEXT NOT NULL, merged_at TEXT
    )`);
  }

  private get api(): string {
    return (this.opts.api ?? process.env.RELAY_GITHUB_API ?? "https://api.github.com").replace(/\/$/, "");
  }
  private get remote(): string {
    return this.opts.remote ?? "origin";
  }

  /** Forget cached credentials and repository facts (after `gh auth login`, for example). */
  refresh(): void {
    this.token = undefined;
    this.repoInfo = undefined;
  }

  private async resolveToken() {
    if (this.token !== undefined) return this.token;
    if (this.opts.token === null) return (this.token = null);
    if (this.opts.token) return (this.token = { value: this.opts.token, source: "options" as const });
    for (const name of ["GITHUB_TOKEN", "GH_TOKEN"] as const) {
      const v = process.env[name]?.trim();
      if (v) return (this.token = { value: v, source: name });
    }
    const fromGh = await new Promise<string | null>((ok) => {
      execFile("gh", ["auth", "token"], { timeout: 3000, encoding: "utf8" }, (err, out) => ok(err ? null : out.trim() || null));
    });
    return (this.token = fromGh ? { value: fromGh, source: "gh" as const } : null);
  }

  private repoSlug(): { owner: string; name: string } | null {
    const o = this.opts.repo ?? process.env.RELAY_GITHUB_REPO;
    if (o) {
      const [owner, name] = o.split("/");
      return owner && name ? { owner, name } : null;
    }
    const url = tryGit(this.root, ["remote", "get-url", this.remote]);
    return url ? parseGitHubRemote(url) : null;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const tok = await this.resolveToken();
    if (!tok) throw new RelayError("forbidden", "GitHub isn't connected");
    const res = await fetch(`${this.api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${tok.value}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "relay-ide",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { message: text.slice(0, 300) };
    }
    return { status: res.status, data: data as T };
  }

  private async repo(): Promise<NonNullable<GitHubStatus["repo"]>> {
    if (this.repoInfo) return this.repoInfo;
    if (!(await this.resolveToken())) throw new RelayError("forbidden", "GitHub isn't connected. Set GITHUB_TOKEN (or run `gh auth login`) for the Relay server.");
    const slug = this.repoSlug();
    if (!slug) throw new RelayError("invalid", `The "${this.remote}" remote isn't a GitHub repository. Set RELAY_GITHUB_REPO=owner/name to choose one.`);
    const r = await this.call<{ html_url: string; default_branch: string; private: boolean; permissions?: { push?: boolean }; allow_squash_merge?: boolean; allow_merge_commit?: boolean; allow_rebase_merge?: boolean; message?: string }>("GET", `/repos/${slug.owner}/${slug.name}`);
    if (r.status === 401) throw new RelayError("forbidden", "GitHub rejected the token (expired or revoked).");
    if (r.status === 404) throw new RelayError("not_found", `${slug.owner}/${slug.name} wasn't found, or the token can't see it.`);
    if (r.status !== 200) throw new RelayError("invalid", `GitHub answered ${r.status}: ${r.data.message ?? "unexpected response"}`);
    if (r.data.permissions && r.data.permissions.push === false) throw new RelayError("forbidden", `The token can read ${slug.owner}/${slug.name} but can't push to it.`);
    const methods: MergeMethod[] = [];
    if (r.data.allow_squash_merge !== false) methods.push("squash");
    if (r.data.allow_merge_commit !== false) methods.push("merge");
    if (r.data.allow_rebase_merge !== false) methods.push("rebase");
    return (this.repoInfo = { owner: slug.owner, name: slug.name, url: r.data.html_url, defaultBranch: r.data.default_branch, private: r.data.private, mergeMethods: methods });
  }

  private ownFiles(): string[] {
    const rel = relative(realpathSync(this.root), this.dbPath);
    if (rel.startsWith("..") || isAbsolute(rel)) return [];
    const p = rel.split(sep).join("/");
    return [p, `${p}-wal`, `${p}-shm`, `${p}-journal`];
  }

  /** What would be shipped: changed files minus Relay's own files, and the secrets that will be left out. */
  private changes(): { files: string[]; secrets: string[] } {
    const all = changedFiles(this.root, "HEAD", this.ownFiles());
    return { files: all.filter((f) => !isSecretPath(f)), secrets: all.filter(isSecretPath) };
  }

  private ahead(base: string): number | null {
    const n = tryGit(this.root, ["rev-list", "--count", `${this.remote}/${base}..HEAD`]);
    return n === null ? null : Number(n);
  }

  private latestShip(): ShipRow | undefined {
    return this.db.prepare("SELECT number, branch, created_at, merged_at FROM github_ships ORDER BY created_at DESC LIMIT 1").get() as ShipRow | undefined;
  }

  private async pull(number: number): Promise<PullRequest> {
    const repo = await this.repo();
    const r = await this.call<{ number: number; html_url: string; title: string; state: string; merged: boolean; mergeable: boolean | null; mergeable_state?: string; head: { ref: string; sha: string }; base: { ref: string }; message?: string }>("GET", `/repos/${repo.owner}/${repo.name}/pulls/${number}`);
    if (r.status !== 200) throw new RelayError("not_found", `Pull request #${number}: ${r.data.message ?? r.status}`);
    const p = r.data;
    return { number: p.number, url: p.html_url, title: p.title, state: p.merged ? "merged" : p.state === "open" ? "open" : "closed", branch: p.head.ref, base: p.base.ref, mergeable: p.mergeable, mergeableState: p.mergeable_state ?? null, headSha: p.head.sha };
  }

  async status(): Promise<GitHubStatus> {
    const branch = tryGit(this.root, ["symbolic-ref", "--short", "-q", "HEAD"]);
    const files = this.changes().files.length;
    const tok = await this.resolveToken();
    if (!tok) return { connected: false, reason: "No GitHub token on the Relay server. Set GITHUB_TOKEN (or run `gh auth login`), then check again.", branch, changes: { files, ahead: null }, pr: null };
    try {
      const repo = await this.repo();
      const last = this.latestShip();
      let pr: PullRequest | null = null;
      if (last && !last.merged_at) {
        pr = await this.pull(last.number).catch(() => null);
        if (pr?.state === "merged") this.markMerged(pr.number);
      }
      return { connected: true, tokenSource: tok.source, repo, branch, changes: { files, ahead: this.ahead(repo.defaultBranch) }, pr: pr?.state === "open" ? pr : null };
    } catch (e) {
      return { connected: false, tokenSource: tok.source, reason: (e as Error).message, branch, changes: { files, ahead: null }, pr: null };
    }
  }

  /** Relay's ship gate. Blocking checks must pass; warnings are shown and shipped past. */
  checks(pre: Preflight, connected: boolean): Check[] {
    const { files, secrets } = this.changes();
    return [
      { id: "connected", ok: connected, blocking: true, label: "GitHub connected" },
      { id: "conflicts", ok: pre.conflicts === 0, blocking: true, label: "No unresolved edit conflicts", detail: pre.conflicts ? `${pre.conflicts} file${pre.conflicts > 1 ? "s" : ""} changed on disk and in the editor at once` : undefined },
      { id: "agents", ok: pre.runningAgents === 0, blocking: true, label: "No agent mid-run", detail: pre.runningAgents ? `${pre.runningAgents} still working; their changes live in worktrees until applied` : undefined },
      { id: "changes", ok: files.length > 0 || (this.repoInfo ? (this.ahead(this.repoInfo.defaultBranch) ?? 1) > 0 : true), blocking: true, label: "Something to ship", detail: files.length ? `${files.length} changed file${files.length > 1 ? "s" : ""}` : undefined },
      { id: "review", ok: pre.awaitingReview.length === 0, blocking: false, label: "No tasks awaiting review", detail: pre.awaitingReview.length ? `${pre.awaitingReview.join(", ")} not approved yet; shipped as they are on disk` : undefined },
      { id: "proposals", ok: pre.unappliedProposals.length === 0, blocking: false, label: "Agent proposals applied", detail: pre.unappliedProposals.length ? `${pre.unappliedProposals.join(", ")} not applied; they won't be included` : undefined },
      { id: "secrets", ok: secrets.length === 0, blocking: false, label: "No secrets in the change", detail: secrets.length ? `Left out: ${secrets.join(", ")}` : undefined },
    ];
  }

  /** Environment that hands git the token for https remotes without exposing it on the command line. */
  private async pushEnv(): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    const url = tryGit(this.root, ["remote", "get-url", this.remote]) ?? "";
    const tok = await this.resolveToken();
    if (tok && /^https:\/\//.test(url)) {
      const n = Number(env.GIT_CONFIG_COUNT ?? 0);
      env.GIT_CONFIG_COUNT = String(n + 1);
      env[`GIT_CONFIG_KEY_${n}`] = `http.${new URL(url).origin}/.extraheader`;
      env[`GIT_CONFIG_VALUE_${n}`] = `Authorization: Basic ${Buffer.from(`x-access-token:${tok.value}`).toString("base64")}`;
    }
    return env;
  }

  /** A commit of the workspace on top of HEAD, built in a temporary index. Secrets and Relay's files keep their HEAD state. */
  private buildCommit(message: string, author: string): { commit: string; files: string[]; secrets: string[] } {
    const { files, secrets } = this.changes();
    const head = git(this.root, ["rev-parse", "HEAD"]);
    if (!files.length) return { commit: head, files, secrets };
    const dir = mkdtempSync(join(tmpdir(), "relay-ship-"));
    try {
      const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
      git(this.root, ["read-tree", "HEAD"], env);
      const exclude = [...secrets, ...this.ownFiles()].map((p) => `:(top,exclude,literal)${p}`);
      git(this.root, ["add", "-A", "--", ":/", ...exclude], env);
      const tree = git(this.root, ["write-tree"], env);
      const name = git(this.root, ["config", "--default", author, "user.name"]);
      const email = git(this.root, ["config", "--default", "relay@localhost", "user.email"]);
      const ids = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
      return { commit: git(this.root, ["commit-tree", tree, "-p", head, "-m", message], { ...env, ...ids }), files, secrets };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Push the workspace to a new branch and open a pull request against the default branch. */
  async ship(input: { title: string; body?: string; by: { id: string; name: string } }, pre: Preflight): Promise<{ pr: PullRequest; files: string[]; secrets: string[] }> {
    const repo = await this.repo();
    const blocked = this.checks(pre, true).filter((c) => c.blocking && !c.ok);
    if (blocked.length) throw new RelayError("blocked", `Can't ship yet: ${blocked.map((c) => c.detail ?? c.label).join("; ")}`);
    const open = this.latestShip();
    if (open && !open.merged_at) {
      const pr = await this.pull(open.number).catch(() => null);
      if (pr?.state === "open") throw new RelayError("conflict", `Pull request #${pr.number} is still open. Merge or close it first.`);
      if (pr?.state === "merged") this.markMerged(pr.number);
    }
    const { commit, files, secrets } = this.buildCommit(input.title, input.by.name);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
    const branch = `relay/ship-${stamp}`;
    try {
      git(this.root, ["push", "--quiet", this.remote, `${commit}:refs/heads/${branch}`], await this.pushEnv());
    } catch (e) {
      const msg = String((e as { stderr?: string }).stderr ?? (e as Error).message).replace(/Authorization:[^\n]*/gi, "Authorization: [hidden]").trim();
      throw new RelayError("invalid", `git push failed: ${msg.split("\n").slice(-3).join(" ")}`);
    }
    const body = [input.body?.trim(), "", `Shipped from Relay by ${input.by.name}.`, files.length ? `\n${files.length} file${files.length > 1 ? "s" : ""} changed.` : "", secrets.length ? `\nLeft out as likely secrets: ${secrets.map((s) => `\`${s}\``).join(", ")}` : ""].filter((x) => x !== undefined).join("\n").trim();
    const r = await this.call<{ number: number; message?: string; errors?: { message?: string }[] }>("POST", `/repos/${repo.owner}/${repo.name}/pulls`, { title: input.title, head: branch, base: repo.defaultBranch, body });
    if (r.status !== 201) throw new RelayError("invalid", `GitHub refused the pull request: ${r.data.errors?.[0]?.message ?? r.data.message ?? r.status}`);
    this.db.prepare("INSERT INTO github_ships (number, branch, repo, created_by, created_at) VALUES (?, ?, ?, ?, ?)").run(r.data.number, branch, `${repo.owner}/${repo.name}`, input.by.id, new Date().toISOString());
    return { pr: await this.pull(r.data.number), files, secrets };
  }

  private markMerged(number: number): void {
    this.db.prepare("UPDATE github_ships SET merged_at = COALESCE(merged_at, ?) WHERE number = ?").run(new Date().toISOString(), number);
  }

  /**
   * Merge the open pull request. Waits briefly while GitHub computes mergeability. Afterwards, if the local branch is the
   * default branch and nothing would be lost, moves it to the merge result without touching any file (a mixed reset to a
   * commit whose tree is what's already on disk), so `git status` is clean again.
   */
  async merge(input: { number?: number; method?: MergeMethod }, waitMs = 15_000): Promise<{ pr: PullRequest; sha: string; method: MergeMethod; local: string }> {
    const repo = await this.repo();
    const number = input.number ?? this.latestShip()?.number;
    if (!number) throw new RelayError("not_found", "There's no pull request to merge. Ship first.");
    let pr = await this.pull(number);
    const until = Date.now() + waitMs;
    while (pr.state === "open" && pr.mergeable === null && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1000));
      pr = await this.pull(number);
    }
    if (pr.state === "merged") throw new RelayError("conflict", `#${number} is already merged.`);
    if (pr.state === "closed") throw new RelayError("conflict", `#${number} was closed without merging.`);
    if (pr.mergeable === null) throw new RelayError("stale_state", "GitHub is still checking whether this can merge. Try again in a few seconds.");
    if (pr.mergeable === false) throw new RelayError("conflict", `#${number} conflicts with ${pr.base}. Pull ${pr.base}, resolve, and ship again.`);
    const method = input.method && repo.mergeMethods.includes(input.method) ? input.method : (repo.mergeMethods[0] ?? "merge");
    const r = await this.call<{ merged?: boolean; sha?: string; message?: string }>("PUT", `/repos/${repo.owner}/${repo.name}/pulls/${number}/merge`, { merge_method: method, sha: pr.headSha });
    if (r.status !== 200 || !r.data.merged) throw new RelayError(r.status === 409 ? "conflict" : "blocked", `GitHub didn't merge #${number}: ${r.data.message ?? r.status}`);
    this.markMerged(number);
    await this.call("DELETE", `/repos/${repo.owner}/${repo.name}/git/refs/heads/${pr.branch}`).catch(() => {});
    return { pr: { ...pr, state: "merged" }, sha: r.data.sha!, method, local: await this.syncLocal(repo.defaultBranch, pr.branch) };
  }

  private async syncLocal(base: string, shipBranch: string): Promise<string> {
    try {
      git(this.root, ["fetch", "--quiet", this.remote, `refs/heads/${base}:refs/remotes/${this.remote}/${base}`], await this.pushEnv());
    } catch {
      return `Merged on GitHub. Couldn't fetch ${base}; pull it when convenient.`;
    }
    const current = tryGit(this.root, ["symbolic-ref", "--short", "-q", "HEAD"]);
    if (current !== base) return `Merged on GitHub. You're on ${current ?? "a detached HEAD"}, so nothing local was changed.`;
    const target = `${this.remote}/${base}`;
    if (tryGit(this.root, ["merge-base", "--is-ancestor", "HEAD", target]) === null) return `Merged on GitHub. Your local ${base} has commits that aren't on GitHub, so it was left alone.`;
    // Only move the branch if the merged tree is exactly what's on disk (ignoring files that were deliberately left out).
    const remaining = changedFiles(this.root, target, this.ownFiles()).filter((f) => !isSecretPath(f));
    if (remaining.length) return `Merged on GitHub. ${remaining.length} local file${remaining.length > 1 ? "s differ" : " differs"} from the merge (edited since shipping?), so ${base} was left alone.`;
    git(this.root, ["reset", "--quiet", "--mixed", target]);
    void shipBranch;
    return `Local ${base} now points at the merge. No files were changed.`;
  }
}
