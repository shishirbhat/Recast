// GitHub, optional and separate from Google: one repository, with a fine-grained personal access token the person creates
// on github.com (that repository only; Issues: read and write; nothing else). Kept on this computer only, like the Google token.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Transport } from "@recast/bridges";

export interface GithubLink { token: string; owner: string; repo: string; connected_at: string }
export const REPO = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/;

export const githubFile = (dir: string) => path.join(dir, "github.json");
export function readGithub(dir: string): GithubLink | null { try { return JSON.parse(readFileSync(githubFile(dir), "utf8")) as GithubLink; } catch { return null; } }
export function forgetGithub(dir: string) { if (existsSync(githubFile(dir))) rmSync(githubFile(dir)); }

/** Checks the token can see the repository before saving anything; the token is never shown again or sent anywhere else. */
export async function connectGithub(dir: string, token: string, repo: string, f: typeof fetch, now: number): Promise<{ ok: true; link: GithubLink } | { ok: false; message: string }> {
  const m = REPO.exec(repo.trim()); token = token.trim();
  if (!m) return { ok: false, message: "Write the repository as owner/name, for example acme/app." };
  if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(token)) return { ok: false, message: "That does not look like a GitHub token (they start with github_pat_)." };
  let status = 0;
  try { status = (await f(`https://api.github.com/repos/${encodeURIComponent(m[1]!)}/${encodeURIComponent(m[2]!)}`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } })).status; }
  catch { return { ok: false, message: "GitHub could not be reached. Nothing was saved." }; }
  if (status !== 200) return { ok: false, message: status === 401 ? "GitHub did not accept that token. Nothing was saved." : `This token cannot see ${m[1]}/${m[2]} (GitHub answered ${status}). Nothing was saved.` };
  const link: GithubLink = { token, owner: m[1]!, repo: m[2]!, connected_at: new Date(now).toISOString() };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(githubFile(dir), JSON.stringify(link), { mode: 0o600 }); chmodSync(githubFile(dir), 0o600);
  return { ok: true, link };
}

export function githubTransport(link: GithubLink, f: typeof fetch): Transport {
  return async (req) => {
    if (new URL(req.url).origin !== "https://api.github.com") throw new Error("GitHub requests go to api.github.com only");
    const r = await f(req.url, { method: req.method, headers: { authorization: `Bearer ${link.token}`, ...(req.body !== undefined ? { "content-type": "application/json" } : {}), ...req.headers },
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}) });
    return { status: r.status, json: r.status === 204 ? null : await r.json().catch(() => null) };
  };
}
