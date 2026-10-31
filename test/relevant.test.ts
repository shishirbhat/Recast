/**
 * Relevant-test selection: tests that reach a task's change through imports, with the chain as evidence, and changed
 * code no test reaches. A person's change is judged in the shared project, agent work in its worktree.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { HUMAN } from "./helpers.ts";
import { api, join as joinAs, testServer } from "./collab-helpers.ts";
import { COMPATIBLE, twoAgentTasks } from "./together-fixture.ts";

const T = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n";

test("a person's change: the test that reaches it through two imports is found with its chain; untested code is named", async () => {
  const t = await testServer({
    "package.json": '{ "type": "module" }\n',
    "src/a.js": "export const a = 1;\n",
    "src/b.js": "import { a } from './a.js';\nexport const b = a + 1;\n",
    "src/b.test.js": `${T}import { b } from './b.js';\ntest('b', () => assert.equal(b, 2));\n`,
    "src/c.js": "export const c = 3;\n",
    "src/other.test.js": `${T}test('other', () => assert.ok(true));\n`,
  });
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: t.repo, encoding: "utf8" }).trim();
    const r = t.server.relay;
    r.createTask({ id: "T-a", objective: "a", scope: ["src/a.js", "src/c.js"], baseCommit: head }, HUMAN);
    r.transition("T-a", "queued", HUMAN);
    r.transition("T-a", "running", HUMAN);
    writeFileSync(join(t.repo, "src/a.js"), "export const a = 2;\n");
    writeFileSync(join(t.repo, "src/c.js"), "export const c = 4;\n");
    const ed = await joinAs(t.server, "Ed", "editor");
    const body = (await api(t.server, ed.cookie, "GET", "/api/tasks/T-a/relevant-tests")).body;
    assert.equal(body.where, "shared-project");
    assert.deepEqual(body.tests, [{ file: "src/b.test.js", chain: ["src/b.test.js", "src/b.js", "src/a.js"], changedItself: false }]);
    assert.deepEqual(body.unreached, ["src/c.js"], "changed code no test reaches is said, not hidden");
    assert.match(body.limits[0], /aren't found: run the task's full checks/);
  } finally {
    await t.server.close();
  }
});

test("agent work is judged in its worktree", async () => {
  const s = await twoAgentTasks(COMPATIBLE);
  try {
    const own = await joinAs(s.server, "Ola", "owner");
    const body = (await api(s.server, own.cookie, "GET", "/api/tasks/T-ui/relevant-tests")).body;
    assert.equal(body.where, "agent-worktree");
    assert.deepEqual(body.tests.map((x: { file: string }) => x.file), ["src/ui.test.js"]);
    assert.deepEqual(body.unreached, []);
  } finally {
    await s.server.close();
  }
});
