/**
 * The coordination read model: statuses come only from engine state, the latest agent run and the change record, so
 * "finished" never reads as "verified" and "verified" never reads as "safe to integrate".
 */
import { test } from "node:test";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { statusOf } from "../src/analysis/coordination.ts";
import type { Task } from "../src/core/types.ts";
import type { AgentRun } from "../src/server/runs.ts";
import { api, join as joinAs, testServer, until } from "./collab-helpers.ts";
import { SHOP_FILES, seed } from "./e2e/fixture.ts";
import { HUMAN } from "./helpers.ts";

const task = (state: Task["state"]): Task => ({ id: "T", objective: "o", state, owner: null, agent: null, scope: ["a.js"], contracts: {}, prerequisites: [], verify: ["npm test"], baseCommit: null, createdAt: "", updatedAt: "" }) as Task;
const run = (status: AgentRun["status"]): AgentRun => ({ id: "r", taskId: "T", group: "g", provider: "claude-code", startedBy: "m", snapshot: "s", worktree: "/w", status, startedAt: "", endedAt: null, exitCode: null, costUsd: null, changedFiles: [], staleInputs: [], activity: [] });
const rec = (tested: string, safe: boolean, blockers: string[] = []) => ({ stages: [{ id: "tested", label: "", state: tested, detail: `tested ${tested}`, evidence: [] }, { id: "contracts", label: "", state: "n/a", detail: "", evidence: [] }] as never, blockers, safeToIntegrate: safe });

test("status mapping keeps running, stopped, finished, verified and safe apart", () => {
  assert.equal(statusOf(task("running"), run("running"), null, []).status, "running");
  assert.equal(statusOf(task("running"), run("cancelled"), null, []).status, "stopped");
  assert.equal(statusOf(task("running"), run("failed"), null, []).status, "stopped");
  assert.equal(statusOf(task("running"), run("finished"), null, []).status, "checking", "a finished run is not verified");
  assert.equal(statusOf(task("review_required"), null, rec("missing", false), []).status, "verification_required");
  assert.equal(statusOf(task("review_required"), null, rec("stale", false), []).status, "verification_required");
  assert.equal(statusOf(task("review_required"), null, rec("failed", false), []).status, "verification_failed");
  assert.equal(statusOf(task("review_required"), null, rec("done", false, ["needs approval"]), []).status, "review", "verified is not safe while blockers remain");
  assert.equal(statusOf(task("review_required"), null, rec("done", true), []).status, "ready");
  assert.equal(statusOf(task("queued"), null, null, ["T-x"]).status, "waiting");
  assert.equal(statusOf(task("queued"), null, null, []).status, "queued");
  assert.equal(statusOf(task("completed"), null, null, []).status, "done");
});

test("GET /api/coordination: dependencies, contract partners and answers from the real engine", async () => {
  const { server } = await testServer(SHOP_FILES);
  try {
    seed(server);
    server.relay.createTask({ id: "T-after", objective: "Ship after the API", scope: ["package.json"], prerequisites: ["T-api"] }, HUMAN);
    server.relay.transition("T-after", "queued", HUMAN);
    const ada = await joinAs(server, "Ada", "editor");
    const r = await api(server, ada.cookie, "GET", "/api/coordination");
    assert.equal(r.status, 200);
    const by = new Map((r.body.tasks as { id: string; status: string; waitingOn: string[]; blocks: string[]; partners: string[] }[]).map((t) => [t.id, t]));
    assert.equal(by.get("T-api")!.status, "running");
    assert.equal(by.get("T-docs")!.status, "proposed");
    assert.equal(by.get("T-after")!.status, "waiting");
    assert.deepEqual(by.get("T-after")!.waitingOn, ["T-api"]);
    assert.deepEqual(by.get("T-api")!.blocks, ["T-after"]);
    assert.ok(by.get("T-api")!.partners.includes("T-ui"), "T-api and T-ui share user-api");
    assert.deepEqual(r.body.answers.blocking, ["T-api"]);
    assert.ok(r.body.answers.running.includes("T-api"));
    assert.ok(r.body.answers.related.some((x: { a: string; b: string }) => x.a === "T-api" && x.b === "T-ui"));
    assert.deepEqual(r.body.answers.safeNext, [], "nothing is reported safe without a passing record");
    assert.equal((await api(server, null, "GET", "/api/coordination")).status, 401);
  } finally {
    await server.close();
  }
});

test("a verified agent change with no partners is ready: the completion gate is judged in its worktree, as apply does", { timeout: 60_000 }, async () => {
  process.env.RELAY_SIM_EDITS = JSON.stringify({ "T-readme": { "README.md": [["A tiny shop", "A tiny corner shop"]] } });
  process.env.RELAY_SIM_DELAY_MS = "50";
  const { server } = await testServer(SHOP_FILES, { claudeBin: resolve(import.meta.dirname, "fixtures/simulated-agent") });
  try {
    server.relay.createTask({ id: "T-readme", objective: "Describe the shop", scope: ["README.md"], verify: ["node --test"] }, HUMAN);
    server.relay.transition("T-readme", "queued", HUMAN);
    await server.runs.start("T-readme", server.members.invite("Olu", "owner").member);
    await until(() => server.runs.forTask("T-readme").at(-1)?.status === "finished" && !server.runs.forTask("T-readme").at(-1)!.checking, 30_000, "the simulated run to finish and Relay's checks to complete");
    const ada = await joinAs(server, "Ada", "owner");
    const t = (await api(server, ada.cookie, "GET", "/api/coordination")).body.tasks.find((x: { id: string }) => x.id === "T-readme");
    assert.deepEqual(t.blockers, [], "the shared workspace's state doesn't block work that lives in the worktree");
    assert.equal(t.status, "ready");
    assert.deepEqual((await api(server, ada.cookie, "GET", "/api/coordination")).body.answers.safeNext, ["T-readme"]);
  } finally {
    for (const k of ["RELAY_SIM_EDITS", "RELAY_SIM_DELAY_MS"]) delete process.env[k];
    await server.close();
  }
});
