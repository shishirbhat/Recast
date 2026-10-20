/** A MOCK of the GitHub REST endpoints Relay uses, backed by a real bare repository. For tests and screenshots only. */
import { createServer } from "node:http";
import type { Server } from "node:http";
import { git } from "./helpers.ts";

export const TOKEN = "ghp_mocktoken_never_leaks";

interface MockPull {
  number: number;
  title: string;
  head: string;
  sha: string;
  base: string;
  state: "open" | "closed";
  merged: boolean;
  polls: number;
}

/** Enough of the GitHub REST API for Relay's ship/merge flow, backed by a bare repository. */
export function mockGitHub(bare: string) {
  const pulls = new Map<number, MockPull>();
  const log: { method: string; path: string; auth: string | undefined; body: string }[] = [];
  const opts = { conflict: false, refuseMerge: false };
  const server: Server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    log.push({ method: req.method!, path: req.url!, auth: req.headers.authorization, body });
    const send = (status: number, data: unknown) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(data)));
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: "Bad credentials" });
    const url = req.url!;
    const pullJson = (p: MockPull) => ({ number: p.number, html_url: `https://github.com/acme/shop/pull/${p.number}`, title: p.title, state: p.state, merged: p.merged, mergeable: p.polls++ === 0 ? null : !opts.conflict, mergeable_state: opts.conflict ? "dirty" : "clean", head: { ref: p.head, sha: p.sha }, base: { ref: p.base } });
    if (req.method === "GET" && url === "/repos/acme/shop") return send(200, { html_url: "https://github.com/acme/shop", default_branch: "main", private: true, permissions: { push: true }, allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: false });
    if (req.method === "POST" && url === "/repos/acme/shop/pulls") {
      const b = JSON.parse(body) as { title: string; head: string; base: string };
      let sha: string;
      try {
        sha = git(bare, "rev-parse", `refs/heads/${b.head}`);
      } catch {
        return send(422, { message: "Validation Failed", errors: [{ message: `No commits between main and ${b.head}` }] });
      }
      const p: MockPull = { number: pulls.size + 1, title: b.title, head: b.head, sha, base: b.base, state: "open", merged: false, polls: 0 };
      pulls.set(p.number, p);
      return send(201, pullJson(p));
    }
    const m = /^\/repos\/acme\/shop\/pulls\/(\d+)(\/merge)?$/.exec(url);
    if (m) {
      const p = pulls.get(Number(m[1]));
      if (!p) return send(404, { message: "Not Found" });
      if (req.method === "GET") return send(200, pullJson(p));
      if (req.method === "PUT" && m[2]) {
        const b = JSON.parse(body) as { merge_method: string; sha: string };
        if (opts.refuseMerge) return send(405, { message: "Required status check \"ci\" is expected." });
        if (b.sha !== p.sha) return send(409, { message: "Head branch was modified" });
        // Squash: one commit on main with the PR head's tree.
        const tree = git(bare, "rev-parse", `${p.sha}^{tree}`);
        const parent = git(bare, "rev-parse", "refs/heads/main");
        const commit = git(bare, "-c", "user.email=gh@mock", "-c", "user.name=GitHub", "commit-tree", tree, "-p", parent, "-m", `${p.title} (#${p.number})`);
        git(bare, "update-ref", "refs/heads/main", commit);
        p.merged = true;
        p.state = "closed";
        return send(200, { merged: true, sha: commit, message: "Pull Request successfully merged" });
      }
    }
    const ref = /^\/repos\/acme\/shop\/git\/refs\/heads\/(.+)$/.exec(url);
    if (req.method === "DELETE" && ref) {
      git(bare, "update-ref", "-d", `refs/heads/${decodeURIComponent(ref[1]!)}`);
      return (res.writeHead(204), res.end());
    }
    send(404, { message: `mock: no route for ${req.method} ${url}` });
  });
  return { server, pulls, log, opts };
}

