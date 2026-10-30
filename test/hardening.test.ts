/**
 * Integration hardening: retries after an uncertain outcome, applying and approving the same work at once, and a
 * failure while writing approved files. SIMULATED agents; git, checks, the server and its database are real. The
 * write failure is injected by replacing one method of the real document store for one call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, join as joinAs, until } from "./collab-helpers.ts";
import { COMPATIBLE, SIM, twoAgentTasks } from "./together-fixture.ts";
import { startServer } from "../src/server/server.ts";

test("retrying an approval or an apply after an uncertain outcome gets the recorded result, never a second apply", async () => {
  const s = await twoAgentTasks(COMPATIBLE);
  try {
    const own = await joinAs(s.server, "Ola", "owner");
    const integ = (await api(s.server, own.cookie, "POST", "/api/integrations/check", { tasks: ["T-api", "T-ui"] })).body;
    const first = await api(s.server, own.cookie, "POST", `/api/integrations/${integ.id}/approve`);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.applied.sort(), ["src/server.js", "src/ui.js"]);
    const again = await api(s.server, own.cookie, "POST", `/api/integrations/${integ.id}/approve`);
    assert.equal(again.status, 200);
    assert.equal(again.body.already, true);
    assert.deepEqual(again.body.applied, []);
    assert.equal(again.body.integration.status, "approved");
    assert.equal(s.server.relay.events().filter((e) => e.type === "agent.changes_applied").length, 1, "applied once");
    const apply = await api(s.server, own.cookie, "POST", "/api/tasks/T-api/apply");
    assert.equal(apply.status, 200);
    assert.equal(apply.body.already, true);
  } finally {
    await s.server.close();
  }
});

test("while one task is being applied, Check Together and approving a combined check that includes it are refused", async () => {
  const s = await twoAgentTasks(COMPATIBLE);
  try {
    const own = await joinAs(s.server, "Ola", "owner");
    const integ = (await api(s.server, own.cookie, "POST", "/api/integrations/check", { tasks: ["T-api", "T-ui"] })).body;
    assert.equal(integ.status, "passed");
    // Applying T-api alone, after an unrelated project change, re-runs its checks on the merged result: it takes a while.
    writeFileSync(join(s.repo, "README.md"), "# shop\n");
    const applying = s.server.runs.apply("T-api", s.owner);
    assert.throws(() => s.server.runs.approveTogether(integ.id, s.owner), /T-api is being applied on its own right now/);
    await assert.rejects(s.server.runs.checkTogether(["T-api", "T-ui"], []), /T-api is being applied right now/);
    // T-api shares a contract with T-ui, so its own apply is refused by the gate in the end; nothing was written.
    await assert.rejects(applying, /must be integrated in the same change\. Nothing was applied/);
    // Now free again: the combined check is refused only because the project moved (README), and says so.
    assert.throws(() => s.server.runs.approveTogether(integ.id, s.owner), /changed since this check/);
    assert.equal(s.server.relay.events().filter((e) => e.type === "agent.changes_applied").length, 0);
  } finally {
    await s.server.close();
  }
});

test("writing approved files fails: recorded on the run (and across a restart), and applying again finishes it", async () => {
  const s = await twoAgentTasks(COMPATIBLE);
  let server = s.server;
  try {
    const own = await joinAs(server, "Ola", "owner");
    const integ = (await api(server, own.cookie, "POST", "/api/integrations/check", { tasks: ["T-api", "T-ui"] })).body;
    const real = server.docs.applyText.bind(server.docs);
    let calls = 0;
    server.docs.applyText = (path, text, origin) => (++calls === 2 ? (() => { throw new Error("disk full"); })() : real(path, text, origin));
    const failed = await api(server, own.cookie, "POST", `/api/integrations/${integ.id}/approve`);
    server.docs.applyText = real;
    assert.equal(failed.status, 500, JSON.stringify(failed.body));
    assert.match(failed.body.message, /approved, but writing its files into the project failed: disk full\. Nothing is lost: apply again/);
    assert.equal(server.relay.requireTask("T-api").state, "completed", "the gate's approval stands");
    for (const id of ["T-api", "T-ui"]) {
      const r = server.runs.forTask(id).at(-1)!;
      assert.equal(r.status, "finished");
      assert.equal(r.applyPending?.error, "disk full");
    }
    assert.ok(server.relay.events().some((e) => e.type === "agent.apply_failed"));
    await server.close();

    server = await startServer({ root: s.repo, dbPath: s.dbPath, port: 0, flushMs: 30, claudeBin: SIM });
    assert.equal(server.runs.forTask("T-ui").at(-1)!.applyPending?.integrationId, integ.id, "kept across a restart");
    const own2 = await joinAs(server, "Ade", "owner");
    const finish = await api(server, own2.cookie, "POST", `/api/integrations/${integ.id}/approve`);
    assert.equal(finish.status, 200, JSON.stringify(finish.body));
    assert.deepEqual(finish.body.applied.sort(), ["src/server.js", "src/ui.js"]);
    await until(() => readFileSync(join(s.repo, "src/ui.js"), "utf8").includes("fullName") && readFileSync(join(s.repo, "src/server.js"), "utf8").includes("fullName"), 3000, "written");
    assert.equal((readFileSync(join(s.repo, "src/server.js"), "utf8").match(/fullName/g) ?? []).length, 1, "the file written before the failure isn't changed twice");
    for (const id of ["T-api", "T-ui"]) assert.equal(server.runs.forTask(id).at(-1)!.status, "applied");
  } finally {
    await server.close();
  }
});
