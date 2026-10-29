/**
 * Agent work survives a server restart. Unapplied agent changes live in worktrees on disk; before runs were persisted,
 * a restart forgot them, so finished work could no longer be applied and a passed Check Together could no longer be
 * approved. SIMULATED agent; git, the database, the server and its HTTP API are real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HUMAN } from "./helpers.ts";
import { api, join as joinAs, testServer, until } from "./collab-helpers.ts";
import { COMPATIBLE, SIM, twoAgentTasks } from "./together-fixture.ts";
import { startServer } from "../src/server/server.ts";
import type { RelayServer } from "../src/server/server.ts";

function restart(repo: string, dbPath: string): Promise<RelayServer> {
  return startServer({ root: repo, dbPath, port: 0, flushMs: 30, claudeBin: SIM });
}

test("after a restart, a passed Check Together can still be approved, and the runs are still listed as finished", async () => {
  const s = await twoAgentTasks(COMPATIBLE);
  let server = s.server;
  try {
    const own = await joinAs(server, "Ola", "owner");
    const checked = (await api(server, own.cookie, "POST", "/api/integrations/check", { tasks: ["T-api", "T-ui"] })).body;
    assert.equal(checked.status, "passed", checked.report);
    const before = server.runs.forTask("T-api").at(-1)!;
    await server.close();

    server = await restart(s.repo, s.dbPath);
    const after = server.runs.forTask("T-api").at(-1)!;
    assert.equal(after.id, before.id);
    assert.equal(after.status, "finished");
    assert.deepEqual(after.changedFiles, ["src/server.js"]);
    assert.equal(after.worktree, before.worktree);
    assert.ok(server.runs.hasCombined(checked.id), "the combined worktree is known again");

    const own2 = await joinAs(server, "Ola2", "owner");
    const done = await api(server, own2.cookie, "POST", `/api/integrations/${checked.id}/approve`);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual(done.body.applied.sort(), ["src/server.js", "src/ui.js"]);
    await until(() => readFileSync(join(s.repo, "src/ui.js"), "utf8").includes("fullName"), 3000, "applied");
    assert.equal(server.relay.requireTask("T-ui").state, "completed");
    assert.equal(server.runs.forTask("T-ui").at(-1)!.status, "applied");
  } finally {
    await server.close();
  }
});

test("after a restart, a finished run is applied normally; one whose worktree vanished is marked failed, not offered", async () => {
  process.env.RELAY_SIM_EDITS = JSON.stringify({ "T-a": { "src/app.js": [["'hi'", "'hello'"]] }, "T-b": { "src/app.js": [["greeting", "greeting"]] } });
  const t = await testServer(undefined, { claudeBin: SIM });
  let server = t.server;
  try {
    const owner = server.members.invite("Olu", "owner").member;
    server.relay.createTask({ id: "T-a", objective: "Warmer", scope: ["src/app.js"], verify: ["node --check src/app.js"] }, HUMAN);
    server.relay.transition("T-a", "queued", HUMAN);
    await server.runs.start("T-a", owner);
    await until(() => server.runs.forTask("T-a").at(-1)?.status === "finished" && !server.runs.forTask("T-a").at(-1)!.checking, 15000, "run");
    await server.close();

    server = await restart(t.repo, t.dbPath);
    const owner2 = server.members.invite("Ade", "owner").member;
    assert.equal(server.runs.forTask("T-a").at(-1)!.status, "finished");
    const res = await server.runs.apply("T-a", owner2);
    assert.deepEqual(res.applied, ["src/app.js"]);
    await until(() => readFileSync(join(t.repo, "src/app.js"), "utf8").includes("'hello'"), 3000, "applied");
    assert.equal(server.relay.requireTask("T-a").state, "completed");
    await server.close();

    // The applied run stays applied; a finished run whose worktree was removed by hand is not offered for applying.
    const db = new DatabaseSync(t.dbPath);
    const row = db.prepare("SELECT data FROM agent_runs WHERE task_id = 'T-a'").get() as { data: string };
    db.prepare("UPDATE agent_runs SET data = ? WHERE task_id = 'T-a'").run(JSON.stringify({ ...JSON.parse(row.data), status: "finished", worktree: join(t.repo, ".relay/worktrees/gone") }));
    db.close();
    server = await restart(t.repo, t.dbPath);
    const gone = server.runs.forTask("T-a").at(-1)!;
    assert.equal(gone.status, "failed");
    assert.match(gone.activity.at(-1)!.detail!, /no longer exists/);
  } finally {
    delete process.env.RELAY_SIM_EDITS;
    await server.close();
  }
});

test("a run that was going when the server stopped is recorded as interrupted, its worktree kept, its claim released", async () => {
  process.env.RELAY_SIM_EDITS = "{}";
  process.env.RELAY_SIM_MODE = "sleep";
  const t = await testServer(undefined, { claudeBin: SIM });
  let server = t.server;
  try {
    const owner = server.members.invite("Olu", "owner").member;
    server.relay.createTask({ id: "T-x", objective: "never finishes", scope: ["src/app.js"] }, HUMAN);
    server.relay.transition("T-x", "queued", HUMAN);
    const [run] = await server.runs.start("T-x", owner);
    await until(() => server.runs.forTask("T-x").at(-1)!.activity.length > 0, 5000, "agent alive");
    // The agent had claimed the task when the server went down.
    server.relay.transition("T-x", "running", { kind: "agent", id: "simulated-agent" });
    await server.close();

    server = await restart(t.repo, t.dbPath);
    const r = server.runs.forTask("T-x").at(-1)!;
    assert.equal(r.status, "cancelled");
    assert.match(r.activity.at(-1)!.detail!, /server stopped while this agent was running/);
    assert.ok(existsSync(run!.worktree), "its work so far is kept");
    assert.equal(server.relay.requireTask("T-x").state, "failed", "nobody is left holding the task");
    await server.close();

    // A crash leaves the row as "running" (close() never ran): the restart treats it the same way.
    const db = new DatabaseSync(t.dbPath);
    const row = db.prepare("SELECT data FROM agent_runs WHERE task_id = 'T-x'").get() as { data: string };
    db.prepare("UPDATE agent_runs SET data = ? WHERE task_id = 'T-x'").run(JSON.stringify({ ...JSON.parse(row.data), status: "running", activity: [] }));
    db.close();
    server = await restart(t.repo, t.dbPath);
    const crashed = server.runs.forTask("T-x").at(-1)!;
    assert.equal(crashed.status, "cancelled");
    assert.match(crashed.activity.at(-1)!.detail!, /server stopped/);
    // And a new run can be started on the task once it's queued again.
    server.relay.transition("T-x", "queued", HUMAN);
    const owner2 = server.members.invite("Ade", "owner").member;
    const [again] = await server.runs.start("T-x", owner2);
    assert.notEqual(again!.id, run!.id);
  } finally {
    delete process.env.RELAY_SIM_MODE;
    delete process.env.RELAY_SIM_EDITS;
    await server.close();
  }
});
