import { test } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canTransition, TRANSITIONS } from "../src/core/statemachine.ts";
import { TASK_STATES } from "../src/core/types.ts";
import { Relay } from "../src/core/engine.ts";
import { AGENT_A, AGENT_B, HUMAN, USER_API_V2, git, makeRepo, scenario } from "./helpers.ts";

test("state machine: agents can never approve, complete, or cancel", () => {
  for (const from of TASK_STATES) {
    assert.equal(canTransition(from, "completed", "agent"), false);
    assert.equal(canTransition(from, "cancelled", "agent"), false);
  }
  assert.equal(canTransition("proposed", "queued", "agent"), false);
  assert.equal(canTransition("proposed", "queued", "human"), true);
  assert.deepEqual(TRANSITIONS.completed, {});
  assert.deepEqual(TRANSITIONS.cancelled, {});
});

test("illegal transitions are rejected with a typed error", () => {
  const { relay } = scenario();
  assert.throws(() => relay.transition("T-ui", "completed", HUMAN, { cwd: tmpdir() }), { code: "illegal_transition" });
  assert.throws(() => relay.transition("T-ui", "review_required", AGENT_A), { code: "illegal_transition" });
});

test("concurrent claims: exactly one agent gets the task", () => {
  const { relay } = scenario();
  relay.claim("T-ui", AGENT_A);
  assert.throws(() => relay.claim("T-ui", AGENT_B), { code: "stale_state" });
  assert.equal(relay.requireTask("T-ui").agent, "claude-code");
  // Re-claim by the holder is a no-op, not an error.
  assert.equal(relay.claim("T-ui", AGENT_A).state, "running");
});

test("idempotency key: a duplicated transition is applied once", () => {
  const { relay } = scenario();
  relay.claim("T-ui", AGENT_A, "k1");
  relay.transition("T-ui", "blocked", AGENT_A, { idempotencyKey: "k2", reason: "waiting" });
  relay.transition("T-ui", "blocked", AGENT_A, { idempotencyKey: "k2", reason: "waiting" });
  const blocked = relay.events("T-ui").filter((e) => e.type === "task.transition" && e.toState === "blocked");
  assert.equal(blocked.length, 1);
});

test("prerequisites must be completed before a task can run", () => {
  const { relay } = scenario();
  relay.createTask({ id: "T-docs", objective: "Docs", scope: ["README.md"], prerequisites: ["T-ui"] }, HUMAN);
  relay.transition("T-docs", "queued", HUMAN);
  assert.throws(() => relay.claim("T-docs", AGENT_B), { code: "blocked" });
});

test("contracts: an agent's proposal has no authority until a human accepts it", () => {
  const { relay } = scenario();
  const proposed = relay.proposeContract("user-api", USER_API_V2, AGENT_A, "rename for clarity");
  assert.equal(proposed.status, "proposed");
  assert.equal(relay.currentContract("user-api")!.version, 1);
  assert.throws(() => relay.acceptContract("user-api", 2, AGENT_A), { code: "forbidden" });
  const { affectedTasks } = relay.acceptContract("user-api", 2, HUMAN);
  assert.deepEqual(affectedTasks.sort(), ["T-api", "T-ui"]);
  assert.equal(relay.getContract("user-api", 1)!.status, "superseded");
  assert.equal(relay.events("T-ui").filter((e) => e.type === "task.contract_stale").length, 1);
});

test("stale contract blocks edits until the task acknowledges the current version", () => {
  const { relay, repo } = scenario();
  relay.claim("T-ui", AGENT_A);
  const meta = { point: "pre_action" as const, tool: "Edit", actor: "agent:test", provider: "test" };
  assert.equal(relay.checkEdit("T-ui", "src/ui.js", repo, meta).decision, "allow");

  relay.proposeContract("user-api", USER_API_V2, HUMAN);
  relay.acceptContract("user-api", 2, HUMAN);
  const stale = relay.checkEdit("T-ui", join(repo, "src/ui.js"), repo, meta);
  assert.equal(stale.decision, "deny");
  const c = stale.conflicts.find((x) => x.rule === "stale_contract")!;
  assert.deepEqual([c.contract!.plannedVersion, c.contract!.currentVersion], [1, 2]);
  assert.match(stale.reason, /fullName/, "the denial carries the authoritative contract text");

  assert.throws(() => relay.acknowledgeContract("T-ui", "user-api", 1, AGENT_A), { code: "stale_state" });
  relay.acknowledgeContract("T-ui", "user-api", 2, AGENT_A);
  assert.equal(relay.checkEdit("T-ui", "src/ui.js", repo, meta).decision, "allow");
});

test("ownership: outside scope, owned by another task, shared scope", () => {
  const { relay, repo } = scenario();
  relay.claim("T-ui", AGENT_A);
  const meta = { point: "pre_action" as const, tool: "Edit", actor: "agent:test", provider: "test" };
  const owned = relay.checkEdit("T-ui", "src/server.js", repo, meta);
  assert.equal(owned.decision, "deny");
  assert.equal(owned.conflicts[0]!.rule, "owned_by_other_task");
  assert.deepEqual(owned.conflicts[0]!.otherTasks, ["T-api"]);

  const outside = relay.checkEdit("T-ui", "README.md", repo, meta);
  assert.equal(outside.conflicts[0]!.rule, "outside_scope");

  // Two tasks may legitimately share a file: warn, do not block.
  relay.createTask({ id: "T-ui2", objective: "Also UI", scope: ["src/"] }, HUMAN);
  relay.transition("T-ui2", "queued", HUMAN);
  const shared = relay.checkEdit("T-ui", "src/ui.js", repo, meta);
  assert.equal(shared.decision, "allow");
  assert.equal(shared.conflicts[0]!.rule, "shared_scope");
  assert.equal(shared.conflicts[0]!.severity, "warn");
});

test("edits require a claimed task", () => {
  const { relay, repo } = scenario();
  const d = relay.checkEdit("T-ui", "src/ui.js", repo, { point: "pre_action", tool: "Edit", actor: "x", provider: "x" });
  assert.equal(d.decision, "deny");
  assert.equal(d.conflicts[0]!.rule, "inactive_task");
});

test("path traversal, symlink escape, and protected paths are denied", () => {
  const { relay, repo } = scenario();
  relay.createTask({ id: "T-all", objective: "Everything", scope: ["src/"] }, HUMAN);
  relay.transition("T-all", "queued", HUMAN);
  relay.claim("T-all", AGENT_B);
  const meta = { point: "pre_action" as const, tool: "Write", actor: "x", provider: "x" };
  assert.equal(relay.checkEdit("T-all", "../../etc/passwd", repo, meta).conflicts[0]!.rule, "protected_path");
  assert.equal(relay.checkEdit("T-all", "/etc/passwd", repo, meta).conflicts[0]!.rule, "protected_path");
  symlinkSync(tmpdir(), join(repo, "escape"));
  assert.equal(relay.checkEdit("T-all", "escape/evil.txt", repo, meta).decision, "deny");
  for (const p of [".claude/settings.json", ".git/config", ".relay/relay.db", ".mcp.json"]) {
    assert.equal(relay.checkEdit("T-all", p, repo, meta).conflicts[0]!.rule, "protected_path", p);
  }
});

test("unknown task is denied and still audited", () => {
  const { relay, repo } = scenario();
  const d = relay.checkEdit("T-nope", "src/ui.js", repo, { point: "pre_action", tool: "Edit", actor: "x", provider: "x" });
  assert.equal(d.decision, "deny");
  assert.ok(relay.events().some((e) => e.type === "enforcement.decision" && (e.data.decision as string) === "deny"));
});

test("intents: inside scope is active, outside scope is only a proposal until a human approves", () => {
  const { relay, repo } = scenario();
  relay.claim("T-ui", AGENT_A);
  assert.equal(relay.declareIntent("T-ui", ["src/ui.js"], repo, AGENT_A).intent.status, "active");
  const r = relay.declareIntent("T-ui", ["src/ui.js", "README.md"], repo, AGENT_A);
  assert.equal(r.intent.status, "proposed");
  assert.deepEqual(r.outsideScope, ["README.md"]);
  assert.equal(relay.requireTask("T-ui").scope.includes("README.md"), false);
  assert.throws(() => relay.approveIntent(r.intent.id, AGENT_A), { code: "forbidden" });
  assert.ok(relay.approveIntent(r.intent.id, HUMAN).scope.includes("README.md"));
  assert.throws(() => relay.declareIntent("T-ui", ["../outside"], repo, AGENT_A), { code: "invalid" });
});

test("diff check sees writes that bypassed the hook (shell writes, untracked files)", () => {
  const { relay, repo } = scenario();
  relay.claim("T-ui", AGENT_A);
  writeFileSync(join(repo, "src/ui.js"), "export function greet(u) { return 'Hi ' + u.name; }\n");
  writeFileSync(join(repo, "src/server.js"), "// tampered via shell\n");
  writeFileSync(join(repo, "notes.txt"), "untracked\n");
  const r = relay.diffCheck("T-ui", repo);
  assert.deepEqual(r.files, ["notes.txt", "src/server.js", "src/ui.js"]);
  assert.equal(r.decisions["src/ui.js"]!.decision, "allow");
  assert.equal(r.decisions["src/server.js"]!.conflicts[0]!.rule, "owned_by_other_task");
  assert.equal(r.decisions["notes.txt"]!.conflicts[0]!.rule, "outside_scope");
  assert.equal(r.evidence.exitCode, 1);
  assert.equal(r.evidence.verified, true);
});

test("completion gate: needs Relay-run verification and a clean diff check on the current workspace", () => {
  const { relay, repo } = scenario();
  // T-api shares user-api; with it cancelled, T-ui may complete on its own.
  relay.transition("T-api", "cancelled", HUMAN);
  relay.claim("T-ui", AGENT_A);
  writeFileSync(join(repo, "src/ui.js"), "export function greet(user) { return 'Hello ' + user.name + '!'; }\n");

  // The agent claims success: stored, but worth nothing to the gate.
  const claim = relay.recordEvidence({ taskId: "T-ui", kind: "command", command: "node --check src/ui.js", exitCode: 0, output: "all good", source: "agent" });
  assert.equal(claim.kind, "agent_claim");
  assert.equal(claim.verified, false);

  relay.transition("T-ui", "review_required", AGENT_A);
  assert.throws(() => relay.transition("T-ui", "completed", AGENT_A, { cwd: repo }), { code: "illegal_transition" });
  assert.throws(() => relay.transition("T-ui", "completed", HUMAN, { cwd: repo }), (e: Error & { code?: string }) => e.code === "unverified" && /no diff check/.test(e.message) && /verification not run/.test(e.message));

  relay.diffCheck("T-ui", repo);
  relay.runVerification("T-ui", repo);
  // Workspace changes after verification invalidate it.
  writeFileSync(join(repo, "src/ui.js"), "syntax error (\n");
  assert.throws(() => relay.transition("T-ui", "completed", HUMAN, { cwd: repo }), /workspace changed/);

  relay.diffCheck("T-ui", repo);
  assert.equal(relay.runVerification("T-ui", repo)[0]!.exitCode !== 0, true);
  assert.throws(() => relay.transition("T-ui", "completed", HUMAN, { cwd: repo }), /verification failed/);

  writeFileSync(join(repo, "src/ui.js"), "export function greet(user) { return 'Hello ' + user.name + '!'; }\n");
  relay.diffCheck("T-ui", repo);
  relay.runVerification("T-ui", repo);
  assert.equal(relay.transition("T-ui", "completed", HUMAN, { cwd: repo }).state, "completed");
});

test("a database kept inside the repository is not a workspace change, but the rest of .relay/ is protected", () => {
  const repo = makeRepo({ "src/ui.js": "export const x = 1;\n" });
  const relay = new Relay(join(repo, ".relay/relay.db"));
  relay.createTask({ id: "T", objective: "x", scope: ["src/ui.js"], verify: ["node --check src/ui.js"], baseCommit: git(repo, "rev-parse", "HEAD") }, HUMAN);
  relay.transition("T", "queued", HUMAN);
  relay.claim("T", AGENT_A);
  writeFileSync(join(repo, "src/ui.js"), "export const x = 2;\n");
  assert.deepEqual(relay.diffCheck("T", repo).files, ["src/ui.js"]);
  relay.runVerification("T", repo);
  relay.transition("T", "review_required", AGENT_A);
  // Recording evidence wrote to the database again; the gate must still see an unchanged workspace.
  assert.equal(relay.transition("T", "completed", HUMAN, { cwd: repo }).state, "completed");

  writeFileSync(join(repo, ".relay/injected.json"), "{}");
  const relay2 = new Relay(join(repo, ".relay/relay.db"));
  relay2.createTask({ id: "T2", objective: "x", scope: ["src/ui.js"], baseCommit: git(repo, "rev-parse", "HEAD") }, HUMAN);
  relay2.transition("T2", "queued", HUMAN);
  relay2.claim("T2", AGENT_A);
  const d = relay2.diffCheck("T2", repo).decisions[".relay/injected.json"]!;
  assert.equal(d.conflicts[0]!.rule, "protected_path");
});

const SERVER_V2 = "export function getUser(id) { return { id, fullName: 'Ada' }; }\n";
const UI_V2 = "export function greet(user) { return 'Hello ' + user.fullName; }\n";
const INTEGRATION_TEST = `node --input-type=module -e "const {getUser}=await import('./src/server.js');const {greet}=await import('./src/ui.js');const g=greet(getUser(1));if(g!=='Hello Ada'){console.error('got',g);process.exit(1)}"`;

test("replay of real run 3: a task cannot complete alone while a contract partner is unfinished", () => {
  const { relay, repo } = scenario();
  relay.proposeContract("user-api", USER_API_V2, HUMAN);
  relay.acceptContract("user-api", 2, HUMAN);
  relay.claim("T-ui", AGENT_A);
  relay.acknowledgeContract("T-ui", "user-api", 2, AGENT_A);
  writeFileSync(join(repo, "src/ui.js"), UI_V2);
  relay.transition("T-ui", "review_required", AGENT_A);
  relay.diffCheck("T-ui", repo);
  relay.runVerification("T-ui", repo);
  // Per-task checks all pass, as they did in run 3...
  assert.throws(() => relay.transition("T-ui", "completed", HUMAN, { cwd: repo }), /shares a contract with unfinished task\(s\) T-api/);

  // ...and the integration gate names exactly what is wrong.
  const alone = relay.checkIntegration(["T-ui"], repo, [INTEGRATION_TEST]);
  assert.equal(alone.status, "blocked");
  assert.ok(alone.gaps.some((g) => /T-api depend on the same contract/.test(g)), alone.gaps.join("\n"));
  assert.ok(alone.gaps.some((g) => /verification failed: node --input-type/.test(g)), "the integration test catches 'Hello undefined'");
  const both = relay.checkIntegration(["T-ui", "T-api"], repo, [INTEGRATION_TEST]);
  assert.ok(both.gaps.includes("T-api is queued, not review_required"));
  assert.ok(both.gaps.includes("T-api was built against user-api v1; current is v2"));
  assert.throws(() => relay.approveIntegration(both.id, HUMAN, repo), { code: "unverified" });
});

test("integration gate passes once both sides follow the contract, and approval completes both tasks", () => {
  const { relay, repo } = scenario();
  relay.proposeContract("user-api", USER_API_V2, HUMAN);
  relay.acceptContract("user-api", 2, HUMAN);
  for (const [task, agent, file, body] of [["T-ui", AGENT_A, "src/ui.js", UI_V2], ["T-api", AGENT_B, "src/server.js", SERVER_V2]] as const) {
    relay.claim(task, agent);
    relay.acknowledgeContract(task, "user-api", 2, agent);
    writeFileSync(join(repo, file), body);
    relay.transition(task, "review_required", agent);
  }
  const integ = relay.checkIntegration(["T-ui", "T-api"], repo, [INTEGRATION_TEST]);
  assert.equal(integ.status, "passed", integ.gaps.join("\n"));
  assert.deepEqual(integ.contracts, { "user-api": 2 });
  assert.throws(() => relay.approveIntegration(integ.id, AGENT_A, repo), { code: "forbidden" });

  // Approval binds to the checked tree: a later edit invalidates it.
  writeFileSync(join(repo, "src/ui.js"), UI_V2 + "// late edit\n");
  assert.throws(() => relay.approveIntegration(integ.id, HUMAN, repo), { code: "stale_state" });
  writeFileSync(join(repo, "src/ui.js"), UI_V2);
  assert.equal(relay.approveIntegration(integ.id, HUMAN, repo).status, "approved");
  assert.equal(relay.requireTask("T-ui").state, "completed");
  assert.equal(relay.requireTask("T-api").state, "completed");
});

test("integration gate: out-of-scope change, failing test, and a contract change after the check", () => {
  const { relay, repo } = scenario();
  relay.proposeContract("user-api", USER_API_V2, HUMAN);
  relay.acceptContract("user-api", 2, HUMAN);
  for (const [task, agent] of [["T-ui", AGENT_A], ["T-api", AGENT_B]] as const) {
    relay.claim(task, agent);
    relay.acknowledgeContract(task, "user-api", 2, agent);
    relay.transition(task, "review_required", agent);
  }
  writeFileSync(join(repo, "README.md"), "changed by nobody's task\n");
  const r = relay.checkIntegration(["T-ui", "T-api"], repo, ["exit 3"]);
  assert.ok(r.gaps.includes("README.md changed but belongs to none of T-ui, T-api"));
  assert.ok(r.gaps.includes("verification failed: exit 3 (exit 3)"));

  writeFileSync(join(repo, "README.md"), "demo\n");
  const ok = relay.checkIntegration(["T-ui", "T-api"], repo, ["true"]);
  assert.equal(ok.status, "passed", ok.gaps.join("\n"));
  relay.proposeContract("user-api", "v3", HUMAN);
  relay.acceptContract("user-api", 3, HUMAN);
  assert.throws(() => relay.approveIntegration(ok.id, HUMAN, repo), /user-api changed since the integration check/);
});
