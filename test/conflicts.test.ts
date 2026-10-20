/**
 * Outside-edit conflicts are settled by a person, never silently: both sides are readable, viewers can't decide, a
 * decision is recorded once, and the outside version stays stored whichever side is kept.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, join as joinAs, testServer, until } from "./collab-helpers.ts";

test("conflicts: read both sides, viewers can't resolve, keep-shared and use-outside, recorded once", async () => {
  const { server, repo } = await testServer({ "a.js": "export const v = 1;\n", "b.js": "export const w = 1;\n" });
  try {
    const ed = await joinAs(server, "Ed", "editor");
    const vi = await joinAs(server, "Vi", "viewer");
    const conflict = (path: string, ours: string, theirs: string) => {
      const entry = server.docs.open(path);
      const base = entry.text.toString();
      server.docs.applyText(path, ours, "disk");
      entry.lastWritten = base;
      writeFileSync(join(repo, path), theirs);
      assert.equal(server.docs.reconcile(entry, theirs), "conflict");
      return server.docs.conflicts(path)[0]!.id;
    };

    const a = conflict("a.js", "export const v = 2;\n", "export const v = 3;\n");
    const got = await api(server, vi.cookie, "GET", `/api/conflicts/${a}`);
    assert.equal(got.status, 200);
    assert.deepEqual([got.body.path, got.body.theirs, got.body.current], ["a.js", "export const v = 3;\n", "export const v = 2;\n"]);
    assert.equal((await api(server, vi.cookie, "POST", `/api/conflicts/${a}/resolve`, { take: "shared" })).status, 403);
    assert.equal((await api(server, ed.cookie, "POST", `/api/conflicts/${a}/resolve`, { take: "neither" })).status, 400);
    assert.equal((await api(server, ed.cookie, "POST", `/api/conflicts/${a}/resolve`, { take: "shared" })).status, 200);
    assert.equal(server.docs.get("a.js")!.text.toString(), "export const v = 2;\n", "shared copy kept");
    assert.equal((await api(server, ed.cookie, "POST", `/api/conflicts/${a}/resolve`, { take: "outside" })).status, 409, "decided once");
    assert.equal(server.docs.conflict(a)!.theirs, "export const v = 3;\n", "outside version still stored");

    const b = conflict("b.js", "export const w = 2;\n", "export const w = 3;\n");
    assert.equal((await api(server, ed.cookie, "POST", `/api/conflicts/${b}/resolve`, { take: "outside" })).status, 200);
    await until(() => server.docs.get("b.js")!.text.toString() === "export const w = 3;\n", 2000, "outside taken");
    assert.equal(server.docs.conflicts().length, 0);
    assert.equal((await api(server, ed.cookie, "GET", "/api/conflicts/nope")).status, 404);
    const recorded = server.relay.events().filter((e) => e.type === "doc.conflict_resolved").map((e) => [e.data.path, e.data.kept]);
    assert.deepEqual(recorded, [["a.js", "shared"], ["b.js", "outside"]]);
  } finally {
    await server.close();
  }
});
