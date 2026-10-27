/**
 * Check Together through the server's HTTP API, the one service the browser IDE, the VS Code extension and the CLI
 * all call. Agents are the SIMULATED agent (deterministic edits); git, tests, the server and its auth are real.
 * Covers: a blocked rehearsal with its explanation and report, the project left untouched, authorization and bad
 * input, approval still required (and refused when blocked or stale), and no apply or second check mid-rehearsal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HUMAN } from "./helpers.ts";
import { api, join as joinAs, testServer, until } from "./collab-helpers.ts";
import { BREAKING, COMPATIBLE, FILES, SIM, projectState, twoAgentTasks } from "./together-fixture.ts";

async function withServer(fn: (s: Awaited<ReturnType<typeof twoAgentTasks>>) => Promise<void>, edits = BREAKING) {
  const s = await twoAgentTasks(edits);
  try {
    await fn(s);
  } finally {
    await s.server.close();
  }
}

test("blocked: the combined check fails, the explanation is confirmed, the report says why, nothing is applied", () =>
  withServer(async ({ server, repo }) => {
    const before = projectState(repo);
    const ed = await joinAs(server, "Bo", "editor");
    const res = await api(server, ed.cookie, "POST", "/api/integrations/check", { tasks: ["T-api", "T-ui"] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const integ = res.body;
    assert.equal(integ.status, "blocked");
    assert.ok(integ.gaps.includes("verification failed: node --test src/ui.test.js (exit 1)"), integ.gaps.join("\n"));
    assert.equal(integ.explanation.verdict, "confirmed");
    assert.equal(integ.explanation.causes[0].consumer.file, "src/ui.js");
    // The report: verification first, then why it was blocked, then the evidence-based cause.
    const report: string = integ.report;
    assert.match(report, /^BLOCKED {2}T-api \+ T-ui {2}\(integration /);
    assert.match(report, /FAIL {2}node --test src\/ui\.test\.js \(exit 1\)/);
    assert.match(report, /not ok {2}"greets the user by name" \(src\/ui\.test\.js:4\): expected 'Hello Ada', got 'Hello undefined'/);
    assert.match(report, /Cause \(confirmed\): Confirmed cause: T-api changed getUser in src\/server\.js/);
    assert.match(report, /src\/ui\.js:4 reads \.name, which getUser\(\) no longer returns/);
    assert.ok(report.indexOf("Combined verification:") < report.indexOf("Cause ("), "verification comes before the explanation");
    assert.match(report, /Nothing was applied/);
    assert.equal(projectState(repo), before, "the shared project is byte-for-byte unchanged");

    // The same record reads back identically, and a blocked integration can't be approved.
    const again = await api(server, ed.cookie, "GET", `/api/integrations/${integ.id}`);
    assert.equal(again.body.report, report);
    const own = await joinAs(server, "Ola", "owner");
    const approve = await api(server, own.cookie, "POST", `/api/integrations/${integ.id}/approve`);
    assert.equal(approve.status, 409);
    assert.match(approve.body.error.message ?? approve.body.message ?? JSON.stringify(approve.body), /blocked/);
    assert.equal(projectState(repo), before);
    assert.equal(server.relay.requireTask("T-api").state, "review_required");
  }));

test("refused before anything runs: viewers, editors adding commands, unknown or empty task lists, mixed agent and human work", () =>
  withServer(async ({ server }) => {
    const viewer = await joinAs(server, "Vi", "viewer");
    const ed = await joinAs(server, "Bo", "editor");
    assert.equal((await api(server, viewer.cookie, "POST", "/api/integrations/check", { tasks: ["T-api", "T-ui"] })).status, 403);
    assert.equal((await api(server, null, "POST", "/api/integrations/check", { tasks: ["T-api", "T-ui"] })).status, 401);
    assert.equal((await api(server, ed.cookie, "POST", "/api/integrations/check", { tasks: ["T-api", "T-ui"], verify: ["rm -rf /"] })).status, 403);
    assert.equal((await api(server, ed.cookie, "POST", "/api/integrations/check", { tasks: ["T-api", "T-nope"] })).status, 404);
    assert.equal((await api(server, ed.cookie, "POST", "/api/integrations/check", { tasks: [] })).status, 400);
    server.relay.createTask({ id: "T-docs", objective: "docs", scope: ["README.md"] }, HUMAN);
    const mixed = await api(server, ed.cookie, "POST", "/api/integrations/check", { tasks: ["T-api", "T-docs"] });
    assert.equal(mixed.status, 409);
    assert.match(JSON.stringify(mixed.body), /can't combine/);
    assert.equal((server.relay.db.prepare("SELECT COUNT(*) AS n FROM integrations").get() as { n: number }).n, 0, "no check ran");
  }));

test("passed: still nothing applied until an owner approves; an editor can't; a project change in between needs a new check", () =>
  withServer(async ({ server, repo }) => {
    const before = projectState(repo);
    const ed = await joinAs(server, "Bo", "editor");
    const own = await joinAs(server, "Ola", "owner");
    const first = (await api(server, ed.cookie, "POST", "/api/integrations/check", { tasks: ["T-api", "T-ui"] })).body;
    assert.equal(first.status, "passed", first.report);
    assert.equal(first.explanation, null);
    assert.match(first.report, /A project owner must approve/);
    assert.equal(projectState(repo), before, "a passing check applies nothing either");
    assert.equal((await api(server, ed.cookie, "POST", `/api/integrations/${first.id}/approve`)).status, 403);

    // Someone changes the shared project after the check: the old result no longer covers it.
    writeFileSync(join(repo, "README.md"), "# shop\n");
    const stale = await api(server, own.cookie, "POST", `/api/integrations/${first.id}/approve`);
    assert.equal(stale.status, 409);
    assert.match(JSON.stringify(stale.body), /changed since this check/);
    assert.equal(server.relay.requireTask("T-api").state, "review_required");

    // A new check builds on the project as it is now, passes, and only then the owner's approval applies it.
    const second = (await api(server, ed.cookie, "POST", "/api/integrations/check", { tasks: ["T-ui", "T-api"] })).body;
    assert.equal(second.status, "passed", second.report);
    const done = await api(server, own.cookie, "POST", `/api/integrations/${second.id}/approve`);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual(done.body.applied.sort(), ["src/server.js", "src/ui.js"]);
    await until(() => readFileSync(join(repo, "src/ui.js"), "utf8").includes("fullName"), 3000, "applied");
    assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "# shop\n", "the other change survives");
    assert.equal(server.relay.requireTask("T-api").state, "completed");
  }, COMPATIBLE));

test("while a combined check runs, neither task can be applied or checked again; afterwards the result is recorded", async () => {
  const s = await twoAgentTasks(BREAKING);
  try {
    const slow = s.server.runs.checkTogether(["T-api", "T-ui"], ["sleep 1"]);
    await assert.rejects(() => s.server.runs.checkTogether(["T-ui", "T-api"], []), /already being checked together/);
    await assert.rejects(() => s.server.runs.apply("T-api", s.owner), /being checked together/);
    assert.equal(s.server.runs.isRehearsing("T-ui"), true);
    const integ = await slow;
    assert.equal(integ.status, "blocked");
    assert.equal(s.server.runs.isRehearsing("T-ui"), false);
  } finally {
    await s.server.close();
  }
});

test("a rehearsal is refused while Relay is still checking a run, or when a run failed", async () => {
  process.env.RELAY_SIM_FAIL = "T-ui";
  try {
    const s = await testServer(FILES, { claudeBin: SIM });
    try {
      process.env.RELAY_SIM_EDITS = JSON.stringify(BREAKING);
      const r = s.server.relay;
      r.createTask({ id: "T-api", objective: "api", scope: ["src/server.js"] }, HUMAN);
      r.createTask({ id: "T-ui", objective: "ui", scope: ["src/ui.js"] }, HUMAN);
      for (const id of ["T-api", "T-ui"]) r.transition(id, "queued", HUMAN);
      await s.server.runs.start(["T-api", "T-ui"], s.server.members.invite("Olu", "owner").member);
      await until(() => ["T-api", "T-ui"].every((id) => ["finished", "failed"].includes(s.server.runs.forTask(id).at(-1)?.status ?? "") && !s.server.runs.forTask(id).at(-1)!.checking), 20_000, "runs");
      await assert.rejects(() => s.server.runs.checkTogether(["T-api", "T-ui"], ["true"]), /T-ui's agent run is failed/);
    } finally {
      await s.server.close();
    }
  } finally {
    delete process.env.RELAY_SIM_FAIL;
  }
});
