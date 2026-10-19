/**
 * Agent orchestration with a SIMULATED agent (test/fixtures/simulated-agent.ts): worktree isolation, stale input,
 * 3-way apply, conflict refusal, coupled tasks through the combined gate, cancellation.
 * These prove Relay's plumbing, not any provider's behaviour. Real-provider runs live in test/real/.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HUMAN } from "./helpers.ts";
import { client, join as joinAs, testServer, until } from "./collab-helpers.ts";
import type { RelayServer } from "../src/server/server.ts";
import type { Member } from "../src/server/auth.ts";

const SIM = resolve(import.meta.dirname, "fixtures/simulated-agent");
const FILES = {
  "src/server.js": "export function getUser(id) {\n  return { id, name: 'Ada' };\n}\n",
  "src/ui.js": "import { getUser } from './server.js';\n\nexport function greet(id) {\n  return 'Hello ' + getUser(id).name;\n}\n\nexport const footer = 'bye';\n",
};
const INTEGRATION = `node --input-type=module -e "const {greet}=await import('./src/ui.js');if(greet(1)!=='Hello Ada'){console.error(greet(1));process.exit(1)}"`;

async function setup(edits: Record<string, Record<string, [string, string][]>>, extraEnv: Record<string, string> = {}) {
  process.env.RELAY_SIM_EDITS = JSON.stringify(edits);
  for (const [k, v] of Object.entries(extraEnv)) process.env[k] = v;
  const t = await testServer(FILES, { claudeBin: SIM });
  const owner: Member = t.server.members.invite("Olu", "owner").member;
  return { ...t, owner };
}

function finished(server: RelayServer, taskId: string) {
  return until(() => ["finished", "failed"].includes(server.runs.forTask(taskId).at(-1)?.status ?? ""), 15000, `${taskId} run to end`);
}

test("simulated agent: works in its own worktree; the shared file is untouched until a person approves", async () => {
  const { server, repo, owner } = await setup({ "T-ui": { "src/ui.js": [["'Hello '", "'Welcome, '"]] } });
  try {
    server.relay.createTask({ id: "T-ui", objective: "Warmer greeting", scope: ["src/ui.js"], verify: ["node --check src/ui.js"] }, HUMAN);
    server.relay.transition("T-ui", "queued", HUMAN);
    const [run] = await server.runs.start("T-ui", owner);
    assert.ok(run!.worktree.includes(".relay/worktrees/"));
    await finished(server, "T-ui");
    const r = server.runs.forTask("T-ui").at(-1)!;
    assert.equal(r.status, "finished");
    assert.deepEqual(r.changedFiles, ["src/ui.js"]);
    assert.ok(r.activity.some((a) => a.kind === "tool" && a.tool === "Edit"));
    assert.equal(server.relay.requireTask("T-ui").state, "review_required");
    assert.match(readFileSync(join(repo, "src/ui.js"), "utf8"), /'Hello '/, "shared copy unchanged before approval");
    // Relay ran its own checks in the worktree after the run.
    assert.ok(server.relay.evidence("T-ui").some((e) => e.kind === "diff_check" && e.source === "system" && e.exitCode === 0));
    assert.ok(server.relay.evidence("T-ui").some((e) => e.kind === "command" && e.exitCode === 0));
    const applied = server.runs.apply("T-ui", owner);
    assert.deepEqual(applied.applied, ["src/ui.js"]);
    assert.equal(server.relay.requireTask("T-ui").state, "completed");
    await until(() => readFileSync(join(repo, "src/ui.js"), "utf8").includes("'Welcome, '"), 3000, "applied to disk");
  } finally {
    await server.close();
  }
});

test("a human edit during the run is flagged as stale input, and both edits survive the 3-way apply", async () => {
  const { server, repo, owner } = await setup({ "T-ui": { "src/ui.js": [["'Hello '", "'Welcome, '"]] } });
  try {
    server.relay.createTask({ id: "T-ui", objective: "Warmer greeting", scope: ["src/ui.js"] }, HUMAN);
    server.relay.transition("T-ui", "queued", HUMAN);
    const kai = await joinAs(server, "Kai");
    const ck = await client(server, kai.cookie, "src/ui.js");
    await server.runs.start("T-ui", owner);
    // Kai edits another line of the same file while the agent works from its snapshot.
    const s = ck.text.toString();
    ck.text.insert(s.indexOf("'bye'") + 1, "see you, ");
    await until(() => server.runs.forTask("T-ui").at(-1)!.staleInputs.length > 0, 5000, "stale input");
    assert.equal(server.runs.forTask("T-ui").at(-1)!.staleInputs[0]!.by, "Kai");
    assert.ok(server.relay.events("T-ui").some((e) => e.type === "task.input_changed"));
    await finished(server, "T-ui");
    const res = server.runs.apply("T-ui", owner);
    assert.deepEqual(res.conflicts, []);
    await until(() => ck.text.toString().includes("'Welcome, '") && ck.text.toString().includes("see you, bye"), 3000, "both edits");
    ck.close();
    await until(() => readFileSync(join(repo, "src/ui.js"), "utf8").includes("see you, bye"), 3000, "disk");
  } finally {
    await server.close();
  }
});

test("a conflicting human edit: apply refuses, applies nothing, and leaves the task in review", async () => {
  const { server, owner } = await setup({ "T-ui": { "src/ui.js": [["'Hello '", "'Welcome, '"]] } });
  try {
    server.relay.createTask({ id: "T-ui", objective: "Warmer greeting", scope: ["src/ui.js"] }, HUMAN);
    server.relay.transition("T-ui", "queued", HUMAN);
    await server.runs.start("T-ui", owner);
    await finished(server, "T-ui");
    server.docs.applyText("src/ui.js", server.docs.open("src/ui.js").text.toString().replace("'Hello '", "'Hi there '"), "restore");
    const res = server.runs.apply("T-ui", owner);
    assert.equal(res.conflicts.length, 1);
    assert.match(res.conflicts[0]!.text, /<<<<<<< shared/);
    assert.deepEqual(res.applied, []);
    assert.equal(server.relay.requireTask("T-ui").state, "review_required");
    assert.match(server.docs.open("src/ui.js").text.toString(), /'Hi there '/);
  } finally {
    await server.close();
  }
});

test("coupled agent tasks: approving one alone is refused; the combined gate tests both, then applies both", async () => {
  const { server, repo, owner } = await setup({
    "T-api": { "src/server.js": [["name: 'Ada'", "fullName: 'Ada'"]] },
    "T-ui": { "src/ui.js": [["getUser(id).name", "getUser(id).fullName"]] },
  });
  try {
    const r = server.relay;
    r.proposeContract("user-api", "{ id, name }", HUMAN);
    r.acceptContract("user-api", 1, HUMAN);
    r.createTask({ id: "T-api", objective: "server", scope: ["src/server.js"], contracts: { "user-api": 1 } }, HUMAN);
    r.createTask({ id: "T-ui", objective: "ui", scope: ["src/ui.js"], contracts: { "user-api": 1 } }, HUMAN);
    r.transition("T-api", "queued", HUMAN);
    r.transition("T-ui", "queued", HUMAN);
    r.proposeContract("user-api", "{ id, fullName }", HUMAN);
    r.acceptContract("user-api", 2, HUMAN);
    await server.runs.start(["T-api", "T-ui"], owner);
    await finished(server, "T-api");
    await finished(server, "T-ui");
    assert.throws(() => server.runs.apply("T-ui", owner), /shares a contract with unfinished task\(s\) T-api/);
    const integ = server.runs.checkTogether(["T-ui", "T-api"], [INTEGRATION]);
    assert.equal(integ.status, "passed", integ.gaps.join("\n"));
    const done = server.runs.approveTogether(integ.id, owner);
    assert.deepEqual(done.applied.sort(), ["src/server.js", "src/ui.js"]);
    assert.equal(r.requireTask("T-api").state, "completed");
    assert.equal(r.requireTask("T-ui").state, "completed");
    await until(() => readFileSync(join(repo, "src/server.js"), "utf8").includes("fullName"), 3000, "server applied");
    assert.match(readFileSync(join(repo, "src/ui.js"), "utf8"), /fullName/);
  } finally {
    await server.close();
  }
});

test("cancelling a hung agent kills its process group; the task stays queued because the agent never claimed it", async () => {
  const { server, owner } = await setup({}, { RELAY_SIM_MODE: "sleep" });
  try {
    server.relay.createTask({ id: "T-x", objective: "never finishes", scope: ["src/ui.js"] }, HUMAN);
    server.relay.transition("T-x", "queued", HUMAN);
    server.relay.transition("T-x", "running", { kind: "agent", id: "simulated-agent" });
    // The task is running (claimed) but the agent hangs: start needs queued, so test cancel on a fresh queued task.
    server.relay.transition("T-x", "failed", { kind: "system", id: "test" });
    server.relay.transition("T-x", "queued", HUMAN);
    const [run] = await server.runs.start("T-x", owner);
    await until(() => server.runs.forTask("T-x").at(-1)!.activity.length > 0, 5000, "agent alive");
    server.runs.cancel("T-x");
    await until(() => server.runs.forTask("T-x").at(-1)!.endedAt !== null, 5000, "process exit");
    assert.equal(server.runs.forTask("T-x").at(-1)!.status, "cancelled");
    assert.ok(existsSync(run!.worktree), "the worktree is kept for inspection");
    assert.equal(server.relay.requireTask("T-x").state, "queued", "the hung agent never claimed it, so it stays queued");
  } finally {
    delete process.env.RELAY_SIM_MODE;
    await server.close();
  }
});
