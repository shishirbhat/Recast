/**
 * The live dependency map on a fixture with a shared API, frontend consumers, a re-export barrel, a type file and tests.
 * Then the full loop: an API change is traced to consumers, tests and dependent tasks; earlier verification goes stale;
 * the integration gate blocks the mismatch; the consumer is fixed; the gate passes; a person approves.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Relay } from "../src/core/engine.ts";
import { ImpactService } from "../src/analysis/impact.ts";
import { parseModule } from "../src/analysis/depgraph.ts";
import { resolveCommit } from "../src/git.ts";
import { AGENT_A, AGENT_B, HUMAN, makeRepo, tempDb } from "./helpers.ts";

const FILES: Record<string, string> = {
  "package.json": '{ "type": "module" }\n',
  "api/users.js": 'export function getUser(id) {\n  return { id, name: "Ada", plan: "pro" };\n}\nexport const VERSION = 1;\n',
  "api/index.js": 'export { getUser } from "./users.js";\n',
  "api/types.ts": "export interface User {\n  id: string;\n  name: string;\n}\n",
  "web/greeting.js": 'import { getUser } from "../api/index.js";\n\nexport function greet(id) {\n  const u = getUser(id);\n  return "Hi " + u.name;\n}\n',
  "web/profile.js": 'import { getUser } from "../api/users.js";\n\nexport async function card(id) {\n  const { name, plan } = await getUser(id);\n  return name + " " + plan;\n}\n',
  "web/types-consumer.ts": 'import type { User } from "../api/types";\nexport const show = (u: User) => u.id;\n',
  "web/greeting.test.js": 'import { test } from "node:test";\nimport assert from "node:assert";\nimport { greet } from "./greeting.js";\ntest("greets", () => assert.match(greet(1), /Hi Ada/));\n',
  "web/lazy.js": 'const m = "../api/" + "users.js";\nexport const load = () => import(m);\n',
  "web/other.js": "export const unrelated = 1;\n",
};
const USERS_V2 = 'export function getUser(id) {\n  return { id, fullName: "Ada", plan: "pro" };\n}\nexport const VERSION = 1;\n';
const VERIFY = "node --test web/greeting.test.js";

function setup() {
  const repo = makeRepo(FILES);
  const db = tempDb();
  const relay = new Relay(db);
  const baseCommit = resolveCommit(repo);
  relay.proposeContract("user-api", "getUser(id) -> { id, name, plan }", HUMAN);
  relay.acceptContract("user-api", 1, HUMAN);
  relay.createTask({ id: "T-api", objective: "Rename name to fullName", scope: ["api/"], contracts: { "user-api": 1 }, baseCommit }, HUMAN);
  relay.createTask({ id: "T-web", objective: "Greeting and profile", scope: ["web/"], contracts: { "user-api": 1 }, verify: [VERIFY], baseCommit }, HUMAN);
  relay.createTask({ id: "T-docs", objective: "Docs", scope: ["README.md"] }, HUMAN);
  for (const t of ["T-api", "T-web", "T-docs"]) relay.transition(t, "queued", HUMAN);
  return { repo, relay, svc: new ImpactService(relay, repo, db) };
}

test("parser: imports, re-exports, exports with signatures and returned keys, property reads, computed imports", () => {
  const m = parseModule("web/profile.js", FILES["web/profile.js"]!, () => "api/users.js");
  assert.deepEqual(m.imports.map((i) => [i.to, i.names[0]!.imported, i.kind]), [["api/users.js", "getUser", "import"]]);
  assert.deepEqual(m.uses.map((u) => u.prop).sort(), ["name", "plan"]);
  const api = parseModule("api/users.js", FILES["api/users.js"]!, () => null);
  const getUser = api.exports.find((e) => e.name === "getUser")!;
  assert.equal(getUser.signature, "getUser(id)");
  assert.deepEqual(getUser.returnKeys, ["id", "name", "plan"]);
  const lazy = parseModule("web/lazy.js", FILES["web/lazy.js"]!, () => null);
  assert.match(lazy.gaps[0]!, /computed path/);
});

test("an API change is traced to its consumers (through a re-export), affected tests, and dependent tasks; unrelated code is not", () => {
  const { repo, svc } = setup();
  writeFileSync(join(repo, "api/users.js"), USERS_V2);
  writeFileSync(join(repo, "api/types.ts"), "export interface User {\n  id: string;\n  fullName: string;\n}\n");
  const r = svc.compute();

  const shape = r.interfaces.find((i) => i.symbol === "getUser")!;
  assert.equal(shape.change, "shape");
  assert.deepEqual(shape.removedKeys, ["name"]);
  assert.deepEqual(shape.addedKeys, ["fullName"]);
  assert.equal(r.interfaces.find((i) => i.symbol === "User")!.change, "signature");
  assert.ok(!r.interfaces.some((i) => i.symbol === "VERSION"), "unchanged exports aren't reported");

  const greeting = r.consumers.find((c) => c.file === "web/greeting.js")!;
  assert.match(greeting.evidence.detail, /via api\/index\.js:1/, "found through the re-export barrel");
  assert.deepEqual(greeting.breaks.map((b) => [b.prop, b.line]), [["name", 5]]);
  const profile = r.consumers.find((c) => c.file === "web/profile.js")!;
  assert.deepEqual(profile.breaks.map((b) => b.prop), ["name"], "destructured read of the removed key; `plan` still exists");
  assert.ok(r.consumers.some((c) => c.file === "web/types-consumer.ts" && c.symbol === "User"));
  assert.ok(!r.consumers.some((c) => c.file === "web/other.js"));

  assert.deepEqual(r.tests.map((t) => t.file), ["web/greeting.test.js"]);
  assert.deepEqual(r.tests[0]!.chain, ["web/greeting.test.js", "web/greeting.js", "api/index.js", "api/users.js"]);
  assert.ok(r.suggestions.some((s) => s.startsWith("Update web/greeting.js:5") && s.includes("fullName")));
  assert.ok(r.gaps.some((g) => g.includes("web/lazy.js")) === false, "gaps list only concerns changed files");

  const web = r.tasks.find((t) => t.taskId === "T-web")!;
  assert.ok(web.reasons.some((x) => x.kind === "static" && x.detail.includes("web/greeting.js:1")));
  assert.ok(web.reasons.some((x) => x.kind === "declared" && x.detail.includes("contract user-api")));
  assert.ok(r.tasks.some((t) => t.taskId === "T-api"));
  assert.ok(!r.tasks.some((t) => t.taskId === "T-docs"));
  assert.deepEqual(r.contracts, [{ id: "user-api", version: 1, providers: ["T-api"], consumers: ["T-web"] }]);
});

test("incremental: unchanged files are not re-parsed; one edit costs one parse", async () => {
  const { repo, svc } = setup();
  svc.compute();
  const before = svc.graph.refresh(Object.keys(FILES));
  assert.equal(before.parsed, 0);
  await new Promise((r) => setTimeout(r, 10));
  writeFileSync(join(repo, "web/other.js"), "export const unrelated = 2;\n");
  assert.equal(svc.graph.refresh(Object.keys(FILES)).parsed, 1);
});

test("the full loop: stale verification, a blocked integration, the fix, a passing gate, and a person's approval", () => {
  const { repo, relay, svc } = setup();
  // T-web verified against the old API.
  relay.claim("T-web", AGENT_A);
  const [ok] = relay.runVerification("T-web", repo);
  assert.equal(ok!.exitCode, 0);
  assert.equal(svc.compute().stale.length, 0);

  // T-api changes the response shape.
  relay.claim("T-api", AGENT_B);
  writeFileSync(join(repo, "api/users.js"), USERS_V2);
  const r = svc.compute();
  const stale = r.stale.find((s) => s.taskId === "T-web" && s.command === VERIFY)!;
  assert.match(stale.reason, /api\/users\.js#getUser \(shape\)/);

  // The gate runs the affected test on the combined workspace and blocks.
  relay.transition("T-api", "review_required", AGENT_B);
  relay.transition("T-web", "review_required", AGENT_A);
  const blocked = relay.checkIntegration(["T-api", "T-web"], repo, r.tests.map((t) => `node --test ${t.file}`));
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.gaps.some((g) => g.includes("verification failed: node --test web/greeting.test.js")), blocked.gaps.join("\n"));

  // The consumers are updated as the map suggested; no breaks remain; the gate passes.
  writeFileSync(join(repo, "web/greeting.js"), FILES["web/greeting.js"]!.replace("u.name", "u.fullName"));
  writeFileSync(join(repo, "web/profile.js"), FILES["web/profile.js"]!.replace("{ name, plan }", "{ fullName: name, plan }"));
  const fixed = svc.compute();
  assert.ok(fixed.consumers.every((c) => c.breaks.length === 0), JSON.stringify(fixed.consumers.map((c) => c.breaks)));
  const passed = relay.checkIntegration(["T-api", "T-web"], repo, fixed.tests.map((t) => `node --test ${t.file}`));
  assert.equal(passed.status, "passed", passed.gaps.join("\n"));

  // Only a person approves.
  assert.throws(() => relay.approveIntegration(passed.id, AGENT_A, repo), { code: "forbidden" });
  assert.equal(relay.approveIntegration(passed.id, HUMAN, repo).status, "approved");
  assert.equal(relay.requireTask("T-api").state, "completed");
  assert.equal(relay.requireTask("T-web").state, "completed");
});

test("API: any member can read the impact of the shared workspace; a malformed base is refused", async () => {
  const { testServer, join: joinAs } = await import("./collab-helpers.ts");
  const { server, repo } = await testServer(FILES);
  try {
    const viewer = (await joinAs(server, "Vi", "viewer")).cookie;
    writeFileSync(join(repo, "api/users.js"), USERS_V2);
    const res = await fetch(`${server.url}/api/impact`, { headers: { cookie: viewer } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { consumers: { file: string; breaks: unknown[] }[] };
    assert.ok(body.consumers.some((c) => c.file === "web/greeting.js" && c.breaks.length === 1));
    const bad = await fetch(`${server.url}/api/impact?base=${encodeURIComponent("HEAD; rm -rf /")}`, { headers: { cookie: viewer } });
    assert.equal(bad.status, 400);
    const anon = await fetch(`${server.url}/api/impact`);
    assert.equal(anon.status, 401);
  } finally {
    await server.close();
  }
});
