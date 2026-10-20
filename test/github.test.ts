/**
 * GitHub ship and merge against a MOCK GitHub REST API (a local HTTP server) and a REAL local bare git remote.
 * The real GitHub API is not exercised here.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGitHubRemote } from "../src/server/github.ts";
import { TOKEN, mockGitHub } from "./github-mock.ts";
import type { RelayServer } from "../src/server/server.ts";
import { join as joinAs, testServer } from "./collab-helpers.ts";
import { git, makeRepo } from "./helpers.ts";

let server: RelayServer;
let repo: string;
let bare: string;
let mock: ReturnType<typeof mockGitHub>;
let owner: string;
let editor: string;

const call = async (cookie: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${server.url}/api${path}`, { method, headers: { cookie, "x-relay": "1", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, text, data: JSON.parse(text) as Record<string, any> };
};

before(async () => {
  repo = makeRepo({ "src/app.js": "export const greeting = 'hi';\n", "README.md": "# shop\n" });
  bare = join(mkdtempSync(join(tmpdir(), "relay-remote-")), "shop.git");
  git(repo, "init", "-q", "--bare", "-b", "main", bare);
  git(repo, "remote", "add", "origin", bare);
  git(repo, "push", "-q", "origin", "main");
  git(repo, "fetch", "-q", "origin");
  mock = mockGitHub(bare);
  await new Promise<void>((ok) => mock.server.listen(0, "127.0.0.1", ok));
  const api = `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`;
  server = (await testServer({}, { root: repo, github: { token: TOKEN, api, repo: "acme/shop" } })).server;
  owner = (await joinAs(server, "Ada", "owner")).cookie;
  editor = (await joinAs(server, "Ed", "editor")).cookie;
});
after(async () => {
  await server.close();
  await new Promise<void>((ok) => mock.server.close(() => ok()));
});

test("parses GitHub remotes in https, ssh and scp form", () => {
  assert.deepEqual(parseGitHubRemote("https://github.com/acme/shop.git"), { owner: "acme", name: "shop" });
  assert.deepEqual(parseGitHubRemote("git@github.com:acme/shop.git"), { owner: "acme", name: "shop" });
  assert.deepEqual(parseGitHubRemote("ssh://git@github.com/acme/my.repo"), { owner: "acme", name: "my.repo" });
  assert.equal(parseGitHubRemote("https://gitlab.com/acme/shop.git"), null);
  assert.equal(parseGitHubRemote("/tmp/shop.git"), null);
});

test("status: connected, repository facts, changes and the ship gate; the token never reaches the client", async () => {
  writeFileSync(join(repo, "src/app.js"), "export const greeting = 'hello';\n");
  writeFileSync(join(repo, ".env"), "SECRET=1\n");
  const s = await call(editor, "GET", "/github");
  assert.equal(s.status, 200);
  assert.equal(s.data.connected, true);
  assert.equal(s.data.repo.defaultBranch, "main");
  assert.deepEqual(s.data.repo.mergeMethods, ["squash", "merge"]);
  assert.equal(s.data.changes.files, 1, ".env is not counted as a shippable change");
  assert.equal(s.data.tokenSource, "options");
  const secrets = s.data.checks.find((c: { id: string }) => c.id === "secrets");
  assert.equal(secrets.ok, false);
  assert.match(secrets.detail, /\.env/);
  assert.ok(!s.text.includes(TOKEN), "token is not in the response");
});

test("editors can't ship or merge; owners ship a pull request without touching the working tree, index or branch", async () => {
  assert.equal((await call(editor, "POST", "/github/ship", { title: "Greeting" })).status, 403);
  assert.equal((await call(editor, "POST", "/github/merge", {})).status, 403);
  const headBefore = git(repo, "rev-parse", "HEAD");
  const r = await call(owner, "POST", "/github/ship", { title: "Friendlier greeting", body: "Says hello." });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.data.pr.number, 1);
  assert.match(r.data.pr.branch, /^relay\/ship-/);
  assert.deepEqual(r.data.secrets, [".env"]);
  // The branch on the remote has the change and not the secret.
  const shipped = git(bare, "rev-parse", `refs/heads/${r.data.pr.branch}`);
  assert.equal(git(bare, "show", `${shipped}:src/app.js`), "export const greeting = 'hello';");
  assert.throws(() => git(bare, "show", `${shipped}:.env`));
  assert.equal(git(bare, "log", "-1", "--format=%s", shipped), "Friendlier greeting");
  // Local state is exactly as before.
  assert.equal(git(repo, "rev-parse", "HEAD"), headBefore);
  assert.equal(git(repo, "symbolic-ref", "--short", "HEAD"), "main");
  assert.equal(git(repo, "diff", "--cached", "--name-only"), "");
  assert.equal(readFileSync(join(repo, "src/app.js"), "utf8"), "export const greeting = 'hello';\n");
  // A second ship while that PR is open is refused.
  assert.equal((await call(owner, "POST", "/github/ship", { title: "again" })).status, 409);
  // The status shows the open PR.
  const s = await call(owner, "GET", "/github");
  assert.equal(s.data.pr.number, 1);
  // Every API call carried the token in the header only, never in a body.
  assert.ok(mock.log.every((l) => !l.body.includes(TOKEN)));
});

test("merge: waits for mergeability, squash-merges, deletes the branch, and fast-forwards local main without touching files", async () => {
  const r = await call(owner, "POST", "/github/merge", {});
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.method, "squash");
  assert.equal(r.data.pr.state, "merged");
  assert.equal(git(bare, "show", "main:src/app.js"), "export const greeting = 'hello';");
  assert.throws(() => git(bare, "rev-parse", "--verify", `refs/heads/${r.data.pr.branch}`), "ship branch deleted");
  assert.match(r.data.local, /now points at the merge/);
  assert.equal(git(repo, "rev-parse", "HEAD"), git(bare, "rev-parse", "main"));
  assert.equal(git(repo, "status", "--porcelain"), "?? .env", "only the secret that was left out remains");
  // Nothing left to ship.
  const again = await call(owner, "POST", "/github/ship", { title: "nothing" });
  assert.equal(again.status, 409);
  assert.match(again.data.message, /Something to ship/);
  const events = server.relay.events().map((e) => e.type);
  assert.ok(events.includes("github.shipped") && events.includes("github.merged"));
});

test("one click: ship and merge together; a refused merge leaves the pull request open and says why", async () => {
  writeFileSync(join(repo, "README.md"), "# shop\n\nNow with docs.\n");
  const r = await call(owner, "POST", "/github/ship", { title: "Docs", merge: true });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.data.merged.pr.state, "merged");
  assert.equal(git(bare, "show", "main:README.md"), "# shop\n\nNow with docs.");

  writeFileSync(join(repo, "README.md"), "# shop\n\nProtected branch.\n");
  mock.opts.refuseMerge = true;
  const refused = await call(owner, "POST", "/github/ship", { title: "Needs CI", merge: true });
  assert.equal(refused.status, 201);
  assert.equal(refused.data.merged, undefined);
  assert.match(refused.data.mergeError, /Required status check/);
  assert.equal((await call(owner, "GET", "/github")).data.pr.number, refused.data.pr.number, "the PR stays open");
  mock.opts.refuseMerge = false;
  mock.opts.conflict = true;
  const conflicted = await call(owner, "POST", "/github/merge", {});
  assert.equal(conflicted.status, 409);
  assert.match(conflicted.data.message, /conflicts with main/);
  mock.opts.conflict = false;
});

test("the ship gate blocks on edit conflicts and running agents", async () => {
  const pre = { conflicts: 1, runningAgents: 2, awaitingReview: ["T-1"], unappliedProposals: [] };
  const checks = server.github.checks(pre, true);
  assert.equal(checks.find((c) => c.id === "conflicts")!.ok, false);
  assert.equal(checks.find((c) => c.id === "agents")!.ok, false);
  assert.equal(checks.find((c) => c.id === "review")!.blocking, false);
  await assert.rejects(server.github.ship({ title: "x", by: { id: "m", name: "Ada" } }, pre), /edit|agent/);
});

test("not connected: a clear reason, and shipping is refused", async () => {
  const { server: s2 } = await testServer({ "a.txt": "a\n" }, { github: { token: null } });
  try {
    const c = (await joinAs(s2, "Own", "owner")).cookie;
    const res = await fetch(`${s2.url}/api/github`, { headers: { cookie: c } });
    const body = (await res.json()) as { connected: boolean; reason: string };
    assert.equal(body.connected, false);
    assert.match(body.reason, /GITHUB_TOKEN/);
    const ship = await fetch(`${s2.url}/api/github/ship`, { method: "POST", headers: { cookie: c, "x-relay": "1", "content-type": "application/json" }, body: JSON.stringify({ title: "x" }) });
    assert.equal(ship.status, 403);
  } finally {
    await s2.close();
  }
});
