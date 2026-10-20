/**
 * Review: a task's diff shows exactly its change, and line comments are pinned to the revision they were made on;
 * when the file changes afterwards, the comment is marked outdated instead of silently pointing at different code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { client, join as joinAs, testServer, until } from "./collab-helpers.ts";
import { HUMAN, git } from "./helpers.ts";

test("review: task diff, revision-bound comments that go outdated, permissions", async () => {
  const { server, repo } = await testServer({ "src/app.js": "export const v = 1;\n" });
  try {
    const bo = await joinAs(server, "Bo", "editor");
    const vi = await joinAs(server, "Vi", "viewer");
    const call = (cookie: string) => async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${server.url}/api${path}`, { method, headers: { cookie, "x-relay": "1", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, data: (await res.json()) as any };
    };
    const B = call(bo.cookie);
    const V = call(vi.cookie);
    server.relay.createTask({ id: "T-1", objective: "bump", scope: ["src/app.js"], baseCommit: git(repo, "rev-parse", "HEAD") }, HUMAN);
    const cb = await client(server, bo.cookie, "src/app.js");
    cb.text.delete(0, cb.text.length);
    cb.text.insert(0, "export const v = 2;\n");
    await until(() => server.docs.get("src/app.js")!.text.toString().includes("2"), 3000, "edit");

    const d = (await V("GET", "/tasks/T-1/diff?path=src/app.js")).data;
    assert.deepEqual([d.before, d.after, d.beforeLabel.startsWith("base")], ["export const v = 1;\n", "export const v = 2;\n", true]);

    assert.equal((await V("POST", "/reviews", { task: "T-1", path: "src/app.js", line: 1, body: "why 2?" })).status, 403);
    const c = await B("POST", "/reviews", { task: "T-1", path: "src/app.js", line: 1, body: "Should this be 3?" });
    assert.equal(c.status, 201);
    let list = (await V("GET", "/reviews?task=T-1&path=src/app.js")).data.comments;
    assert.deepEqual(list.map((x: { line: number; outdated: boolean; author: string }) => [x.line, x.outdated, x.author]), [[1, false, "Bo"]]);

    cb.text.delete(0, cb.text.length);
    cb.text.insert(0, "export const v = 3;\n");
    await until(() => server.docs.get("src/app.js")!.text.toString().includes("3"), 3000, "second edit");
    list = (await V("GET", "/reviews?task=T-1")).data.comments;
    assert.equal(list[0].outdated, true, "the code it was about has changed");
    cb.close();
  } finally {
    await server.close();
  }
});
