/**
 * The change record through a full lifecycle on a backend/frontend fixture: a claim, a failed verification, a blocked
 * integration, the fix and a successful rerun, a person's review, an approved integration. Unauthorized steps are refused
 * by the server; the record never shows a stage as done without the evidence behind it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { join as joinAs, testServer } from "./collab-helpers.ts";
import { AGENT_A, AGENT_B, HUMAN, git } from "./helpers.ts";

const FILES = {
  "package.json": '{ "type": "module" }\n',
  "api/users.js": 'export function getUser(id) {\n  return { id, name: "Ada" };\n}\n',
  "web/greeting.js": 'import { getUser } from "../api/users.js";\n\nexport function greet(id) {\n  const u = getUser(id);\n  return "Hi " + u.name;\n}\n',
  "web/greeting.test.js": 'import { test } from "node:test";\nimport assert from "node:assert";\nimport { greet } from "./greeting.js";\ntest("greets", () => assert.equal(greet(1), "Hi Ada"));\n',
};
const VERIFY = "node --test web/greeting.test.js";

test("change lifecycle: claim, failed verification, blocked integration, rerun, review, approved integration", async () => {
  const { server, repo } = await testServer(FILES);
  try {
    const call = (cookie: string) => async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${server.url}/api${path}`, { method, headers: { cookie, "x-relay": "1", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, data: (await res.json()) as any };
    };
    const owner = call((await joinAs(server, "Ada", "owner")).cookie);
    const editor = call((await joinAs(server, "Bo", "editor")).cookie);
    const viewer = call((await joinAs(server, "Vi", "viewer")).cookie);
    const r = server.relay;
    const baseCommit = git(repo, "rev-parse", "HEAD");
    r.proposeContract("user-api", "getUser(id) -> { id, name }", HUMAN);
    r.acceptContract("user-api", 1, HUMAN);
    r.createTask({ id: "T-api", objective: "Return fullName", scope: ["api/"], contracts: { "user-api": 1 }, baseCommit }, HUMAN);
    r.createTask({ id: "T-web", objective: "Greeting", scope: ["web/"], contracts: { "user-api": 1 }, verify: [VERIFY], baseCommit }, HUMAN);
    for (const t of ["T-api", "T-web"]) await owner("POST", `/tasks/${t}/transition`, { to: "queued" });

    // Agents work; the backend agent changes the response shape. Both claim they're done.
    r.claim("T-api", AGENT_B);
    r.claim("T-web", AGENT_A);
    writeFileSync(join(repo, "api/users.js"), 'export function getUser(id) {\n  return { id, fullName: "Ada" };\n}\n');
    r.transition("T-api", "review_required", AGENT_B);
    r.transition("T-web", "review_required", AGENT_A);

    const stage = (rec: any, id: string) => rec.stages.find((s: { id: string }) => s.id === id).state;
    let rec = (await viewer("GET", "/tasks/T-web/change")).data;
    assert.equal(stage(rec, "claimed"), "done");
    assert.equal(stage(rec, "executed"), "missing", "a claim is not execution");
    assert.equal(stage(rec, "tested"), "missing");
    assert.equal(stage(rec, "contracts"), "missing", "partner T-api not checked together yet");
    assert.ok(rec.blockers.includes("web/greeting.js:5 reads .name, which getUser() no longer returns"), rec.blockers.join("\n"));
    assert.equal(rec.safeToIntegrate, false);

    // Relay runs the frontend's verification: it fails.
    assert.equal((await viewer("POST", "/tasks/T-web/check")).status, 403);
    await editor("POST", "/tasks/T-web/check");
    rec = (await viewer("GET", "/tasks/T-web/change")).data;
    assert.equal(stage(rec, "executed"), "done");
    assert.equal(stage(rec, "tested"), "failed");
    assert.equal(rec.tests[0].exitCode, 1);

    // The combined gate blocks; nobody can force it.
    const blocked = await editor("POST", "/integrations/check", { tasks: ["T-api", "T-web"], verify: [] });
    assert.equal(blocked.data.status, "blocked");
    assert.equal(stage((await viewer("GET", "/tasks/T-web/change")).data, "contracts"), "failed");
    assert.equal((await editor("POST", `/integrations/${blocked.data.id}/approve`)).status, 403, "editors can't approve");
    assert.equal((await owner("POST", `/integrations/${blocked.data.id}/approve`)).status, 409, "a blocked integration can't be approved, even by an owner");
    assert.equal((await editor("POST", "/tasks/T-web/transition", { to: "completed" })).status, 403);
    assert.equal((await owner("POST", "/tasks/T-web/transition", { to: "completed" })).status, 409, "the completion gate refuses a failing task");

    // The frontend is fixed, verification reruns and passes, the combined gate passes.
    writeFileSync(join(repo, "web/greeting.js"), FILES["web/greeting.js"].replace("u.name", "u.fullName"));
    await editor("POST", "/tasks/T-web/check");
    await editor("POST", "/tasks/T-api/check");
    rec = (await viewer("GET", "/tasks/T-web/change")).data;
    assert.equal(stage(rec, "tested"), "done");
    assert.equal(rec.tests[0].fresh, true);
    assert.equal((await editor("POST", "/integrations/check", { tasks: ["T-api", "T-web"], verify: [VERIFY] })).status, 403, "only owners add commands that run on the machine");
    const passed = await owner("POST", "/integrations/check", { tasks: ["T-api", "T-web"], verify: [VERIFY] });
    assert.equal(passed.data.status, "passed", passed.data.gaps?.join("\n"));
    rec = (await viewer("GET", "/tasks/T-web/change")).data;
    assert.equal(stage(rec, "contracts"), "done");
    assert.equal(stage(rec, "approved"), "missing");
    assert.equal(rec.safeToIntegrate, true, rec.blockers.join("\n"));
    assert.throws(() => r.approveIntegration(passed.data.id, AGENT_A, repo), { code: "forbidden" });

    // A person reviews and approves; both tasks complete.
    assert.equal((await owner("POST", `/integrations/${passed.data.id}/approve`)).status, 200);
    rec = (await viewer("GET", "/tasks/T-web/change")).data;
    assert.equal(stage(rec, "approved"), "done");
    assert.equal(stage(rec, "integrated"), "done");
    assert.match(rec.rollback[0], new RegExp(`Base revision ${baseCommit.slice(0, 7)}`));
    assert.ok(rec.security.some((s: { detail: string }) => s.detail.includes(VERIFY)), "commands run on the machine are listed");
    assert.equal((await viewer("GET", "/tasks/T-api/change")).data.task.state, "completed");
  } finally {
    await server.close();
  }
});
