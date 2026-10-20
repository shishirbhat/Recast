/**
 * The Git workflow through the HTTP API on a real repository with a real bare remote: status, diffs, stage, commit
 * credited to the person, branches, dirty-safe switching (shared documents follow the switch), pull, push, and honest
 * errors. Secrets can't be staged; viewers can't change anything; switching, pulling and pushing are owner-only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, join as joinAs, testServer, until } from "./collab-helpers.ts";
import { git } from "./helpers.ts";

test("git: stage, diff, commit, branch, safe switch, push and pull; failures are reported, never hidden", async () => {
  const { server, repo } = await testServer({ "src/app.js": "export const v = 1;\n", "README.md": "# app\n" });
  try {
    const call = (cookie: string) => async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${server.url}/api${path}`, { method, headers: { cookie, "x-relay": "1", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, data: (await res.json()) as any };
    };
    const owner = call((await joinAs(server, "Olu", "owner")).cookie);
    const bo = await joinAs(server, "Bo", "editor");
    const editor = call(bo.cookie);
    const viewer = call((await joinAs(server, "Vi", "viewer")).cookie);

    // A shared edit shows up as an unstaged change with the right diff sides.
    const cb = await client(server, bo.cookie, "src/app.js");
    cb.text.delete(0, cb.text.length);
    cb.text.insert(0, "export const v = 2;\n");
    await until(() => server.docs.get("src/app.js")!.text.toString() === "export const v = 2;\n", 3000, "edit");
    writeFileSync(join(repo, ".env"), "TOKEN=1\n");
    let st = (await viewer("GET", "/git/state")).data;
    assert.deepEqual(st.files.map((f: { path: string; staged: string | null; unstaged: string | null }) => [f.path, f.staged, f.unstaged]), [["src/app.js", null, "M"]], ".env is never listed");
    const d = (await viewer("GET", "/git/diff?path=src/app.js")).data;
    assert.deepEqual([d.before, d.after], ["export const v = 1;\n", "export const v = 2;\n"]);

    // Permissions and secrets.
    assert.equal((await viewer("POST", "/git/stage", { paths: ["src/app.js"] })).status, 403);
    assert.equal((await editor("POST", "/git/stage", { paths: [".env"] })).status, 403);
    assert.equal((await editor("POST", "/git/commit", { message: "nothing staged" })).data.message, "Nothing is staged. Stage the changes you want in this commit first.");

    // Stage, see the staged diff, commit as Bo.
    st = (await editor("POST", "/git/stage", { paths: ["src/app.js"] })).data;
    assert.deepEqual(st.files[0], { path: "src/app.js", staged: "M", unstaged: null });
    assert.equal((await viewer("GET", "/git/diff?path=src/app.js&staged=1")).data.after, "export const v = 2;\n");
    const c = await editor("POST", "/git/commit", { message: "Bump v" });
    assert.equal(c.status, 201);
    assert.equal(git(repo, "log", "-1", "--format=%an|%s"), "Bo|Bump v");
    assert.equal((await viewer("GET", "/git/state")).data.log[0].subject, "Bump v");

    // Branches: editors create, only owners switch; a dirty tree blocks switching instead of mixing changes in.
    assert.equal((await editor("POST", "/git/branch", { name: "feature/x" })).status, 201);
    assert.equal((await editor("POST", "/git/switch", { name: "feature/x" })).status, 403);
    cb.text.insert(0, "// wip\n");
    await until(() => server.docs.get("src/app.js")!.text.toString().startsWith("// wip"), 3000, "wip");
    const blocked = await owner("POST", "/git/switch", { name: "feature/x" });
    assert.equal(blocked.status, 409);
    assert.match(blocked.data.message, /Commit or undo your changes first/);
    assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main", "nothing moved");
    cb.text.delete(0, "// wip\n".length);
    await until(() => !server.docs.get("src/app.js")!.text.toString().startsWith("// wip"), 3000, "undo wip");

    // Switch for real: the shared document follows the branch's file content.
    git(repo, "switch", "-q", "feature/x");
    writeFileSync(join(repo, "src/app.js"), "export const v = 3;\n");
    git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "v3 on feature");
    git(repo, "switch", "-q", "main");
    server.docs.checkAll();
    await until(() => cb.text.toString() === "export const v = 2;\n", 3000, "back on main");
    const sw = await owner("POST", "/git/switch", { name: "feature/x" });
    assert.equal(sw.status, 200, JSON.stringify(sw.data));
    await until(() => cb.text.toString() === "export const v = 3;\n", 4000, "shared doc follows the branch");
    assert.equal((await owner("POST", "/git/switch", { name: "no-such-branch" })).status, 400, "git's own failure is reported");

    // Push and pull against a real bare remote.
    const bare = join(mkdtempSync(join(tmpdir(), "relay-remote-")), "r.git");
    git(repo, "init", "-q", "--bare", "-b", "main", bare);
    git(repo, "remote", "add", "origin", bare);
    assert.equal((await editor("POST", "/git/push")).status, 403);
    const pushed = await owner("POST", "/git/push");
    assert.equal(pushed.status, 200, JSON.stringify(pushed.data));
    assert.equal(git(bare, "log", "-1", "--format=%s", "feature/x"), "v3 on feature");
    const other = mkdtempSync(join(tmpdir(), "relay-clone-"));
    git(other, "clone", "-q", "-b", "feature/x", bare, "c");
    writeFileSync(join(other, "c", "README.md"), "# app\n\nfrom elsewhere\n");
    git(join(other, "c"), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "remote change");
    git(join(other, "c"), "push", "-q");
    const pulled = await owner("POST", "/git/pull");
    assert.equal(pulled.status, 200, JSON.stringify(pulled.data));
    assert.equal(git(repo, "log", "-1", "--format=%s"), "remote change");
    const types = server.relay.events().map((e) => e.type);
    for (const t of ["git.committed", "git.branch_created", "git.branch_switched", "git.pushed", "git.pulled"]) assert.ok(types.includes(t), t);
    cb.close();
  } finally {
    await server.close();
  }
});
