/**
 * Automatic rechecks: off until an owner turns them on; then, after a quiet period following people's edits, a
 * person's task under review whose checks no longer match its files is checked again. Real server, edits and checks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { HUMAN } from "./helpers.ts";
import { api, client, join as joinAs, testServer, until } from "./collab-helpers.ts";

const T = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n";

test("after people's edits go quiet, a stale person's task is checked again on the current files; never while off", async () => {
  const t = await testServer({ "package.json": '{ "type": "module" }\n', "src/a.js": "export const a = 1;\n", "src/a.test.js": `${T}import { a } from './a.js';\ntest('a', () => assert.equal(a, 1));\n` }, { recheckQuietMs: 300 });
  try {
    const r = t.server.relay;
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: t.repo, encoding: "utf8" }).trim();
    r.createTask({ id: "T-p", objective: "a", scope: ["src/a.js"], verify: ["node --test src/a.test.js"], baseCommit: head }, HUMAN);
    for (const st of ["queued", "running", "review_required"] as const) r.transition("T-p", st, HUMAN);
    const own = await joinAs(t.server, "Ola", "owner");
    const ed = await joinAs(t.server, "Ed", "editor");
    assert.equal((await api(t.server, own.cookie, "POST", "/api/tasks/T-p/check")).status, 200);
    const runs = () => r.evidence("T-p").filter((e) => e.kind === "command");
    assert.equal(runs().at(-1)!.exitCode, 0);

    // Off by default: an edit changes nothing.
    assert.equal((await api(t.server, ed.cookie, "GET", "/api/settings")).body.autoRecheck, false);
    const c = await client(t.server, ed.cookie, "src/a.js");
    c.text.insert(c.text.toString().indexOf("1"), "4");
    await until(() => t.server.docs.get("src/a.js")!.text.toString().includes("41"), 3000, "edit");
    await sleep(1200);
    assert.equal(runs().length, 1, "nothing ran while it was off");

    // Only owners turn it on; then the next edit, once quiet, triggers a recheck that records the new failure.
    assert.equal((await api(t.server, ed.cookie, "POST", "/api/settings", { autoRecheck: true })).status, 403);
    assert.equal((await api(t.server, own.cookie, "POST", "/api/settings", { autoRecheck: true })).body.autoRecheck, true);
    c.text.insert(0, "// note\n");
    await until(() => runs().length === 2, 15_000, "automatic recheck");
    assert.equal(runs().at(-1)!.exitCode, 1, "the recheck ran on the edited file, where a is 41");
    assert.ok(r.events("T-p").some((e) => e.type === "task.auto_recheck" && e.actor === "system:auto-recheck"));
    c.close();
  } finally {
    await t.server.close();
  }
});
