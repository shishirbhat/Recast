/**
 * Agents and people working on the same project at the same time, with the real server, real git worktrees, real Yjs
 * clients and the SIMULATED agent (test/fixtures/simulated-agent.ts, a real process that edits files as told).
 * What must hold: collaboration keeps working while Relay verifies; verification describes exactly what is applied;
 * nothing is applied twice, onto a moved file, or on a result nobody verified.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { HUMAN, git } from "./helpers.ts";
import { api, client, join as joinAs, testServer, until } from "./collab-helpers.ts";
import type { RelayServer } from "../src/server/server.ts";
import type { Member } from "../src/server/auth.ts";

const SIM = resolve(import.meta.dirname, "fixtures/simulated-agent");
const FILES = {
  "src/server.js": "export function getUser(id) {\n  return { id, name: 'Ada', nickname: 'A' };\n}\n",
  "src/ui.js": "import { getUser } from './server.js';\n\nexport function greet(id) {\n  return 'Hello ' + getUser(id).name;\n}\n\nexport const footer = 'bye';\n",
};
/** The task's own check: greet(1) must be exactly the warmer greeting. */
const VERIFY = `node --input-type=module -e "const {greet}=await import('./src/ui.js');if(greet(1)!=='Welcome, Ada'){console.error('got '+greet(1));process.exit(1)}"`;

async function setup(extraEnv: Record<string, string> = {}) {
  process.env.RELAY_SIM_EDITS = JSON.stringify({ "T-ui": { "src/ui.js": [["'Hello '", "'Welcome, '"]] } });
  for (const [k, v] of Object.entries(extraEnv)) process.env[k] = v;
  const t = await testServer(FILES, { claudeBin: SIM });
  const owner: Member = t.server.members.invite("Olu", "owner").member;
  t.server.relay.createTask({ id: "T-ui", objective: "Warmer greeting", scope: ["src/ui.js"], verify: [VERIFY] }, HUMAN);
  t.server.relay.transition("T-ui", "queued", HUMAN);
  return { ...t, owner };
}
const lastRun = (server: RelayServer) => server.runs.forTask("T-ui").at(-1);
const checked = (server: RelayServer) => until(() => lastRun(server)?.status === "finished" && !lastRun(server)!.checking, 20000, "the run to end and Relay's checks to finish");

test("the server keeps serving collaboration while a task's verification runs", { timeout: 60_000 }, async () => {
  const { server, repo } = await testServer({ "src/a.js": "a\n" });
  try {
    const ada = await joinAs(server, "Ada", "owner");
    server.relay.createTask({ id: "T1", objective: "x", scope: ["src/a.js"], verify: ["sleep 2"], baseCommit: git(repo, "rev-parse", "HEAD") }, HUMAN);
    const c = await client(server, ada.cookie, "src/a.js");
    const check = api(server, ada.cookie, "POST", "/api/tasks/T1/check", {});
    // While `sleep 2` runs: timers fire on time, and an edit reaches the shared document.
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(Date.now() - t0 < 600, `the event loop was blocked for ${Date.now() - t0} ms`);
    c.text.insert(0, "x");
    await until(() => server.docs.get("src/a.js")!.text.toString().startsWith("x"), 1500, "an edit during verification");
    assert.ok(Date.now() - t0 < 1900, "the edit arrived before verification finished");
    assert.equal((await check).status, 200);
    c.close();
  } finally {
    await server.close();
  }
});

test("a workspace that changed while verification ran can't satisfy the completion gate", { timeout: 60_000 }, async () => {
  const { server, repo } = await testServer({ "src/a.js": "a\n" });
  try {
    const ada = await joinAs(server, "Ada", "owner");
    server.relay.createTask({ id: "T1", objective: "x", scope: ["src/a.js"], verify: ["sleep 1"], baseCommit: git(repo, "rev-parse", "HEAD") }, HUMAN);
    const c = await client(server, ada.cookie, "src/a.js");
    const check = api(server, ada.cookie, "POST", "/api/tasks/T1/check", {});
    await new Promise((r) => setTimeout(r, 200));
    c.text.insert(0, "typed during the tests ");
    await until(() => readFileSync(join(repo, "src/a.js"), "utf8").startsWith("typed"), 3000, "the edit written to disk");
    const res = await check;
    assert.equal(res.status, 200);
    const ev = res.body.verification[0];
    assert.match(ev.environment.tree, /^changed-during-run:/, "recorded as describing no single state");
    assert.match(ev.output, /workspace changed while this ran/);
    const gaps = server.relay.completionGaps(server.relay.requireTask("T1"), repo);
    assert.ok(gaps.some((g) => /verification/.test(g)), `the gate still asks for verification: ${JSON.stringify(gaps)}`);
    c.close();
  } finally {
    await server.close();
  }
});

test("a person's edit since the agent's verification: the result as it would be applied is checked first", { timeout: 60_000 }, async () => {
  const { server, repo, owner } = await setup();
  const kai = await joinAs(server, "Kai", "editor");
  const ck = await client(server, kai.cookie, "src/server.js");
  try {
    await server.runs.start("T-ui", owner);
    await checked(server);
    assert.ok(server.relay.evidence("T-ui").some((e) => e.kind === "command" && e.exitCode === 0), "the agent's own copy passes");
    // After the agent's verification, Kai changes a file the agent never touched. Nothing conflicts, but the project
    // with the agent's change applied would fail the task's check.
    const s = ck.text.toString();
    const at = s.indexOf("name: 'Ada'") + "name: 'Ada".length;
    ck.text.insert(at, " L.");
    await until(() => server.docs.open("src/server.js").text.toString().includes("Ada L."), 3000, "Kai's edit");

    await assert.rejects(server.runs.apply("T-ui", owner), /merged with the project as it is now didn't pass: verification failed/);
    assert.equal(server.relay.requireTask("T-ui").state, "review_required", "not completed on a result that fails");
    assert.doesNotMatch(server.docs.open("src/ui.js").text.toString(), /Welcome/, "nothing applied");
    const checkedEv = server.relay.events().filter((e) => e.type === "integration.checked").at(-1)!;
    assert.equal(checkedEv.data.status, "blocked");
    const integ = server.relay.getIntegration(checkedEv.data.integrationId as string)!;
    assert.match(integ.results[0]!.output, /got Welcome, Ada L\./, "the check ran on the merged, current project");
    // The row stops calling it ready while the project is as the check judged it.
    const owner2 = await joinAs(server, "Ola", "owner");
    const row = async () => (await api(server, owner2.cookie, "GET", "/api/coordination")).body.tasks.find((t: { id: string }) => t.id === "T-ui");
    server.docs.flushAll();
    const after = await row();
    assert.notEqual(after.status, "ready", JSON.stringify(after));
    assert.ok(after.blockers.some((b: string) => /merged with the project as it is now, it didn't pass/.test(b)), JSON.stringify(after.blockers));
    // Kai undoes the breaking edit: the project moved, so Apply is offered again (and would check again).
    const s2 = ck.text.toString();
    ck.text.delete(s2.indexOf(" L."), 3);
    await until(() => !server.docs.open("src/server.js").text.toString().includes("Ada L."), 3000, "Kai's undo");
    server.docs.flushAll();
    assert.equal((await row()).status, "ready");
    const leftovers = git(repo, "worktree", "list").split("\n").filter((l) => l.includes("verify-T-ui-"));
    assert.deepEqual(leftovers, [], "the temporary worktree is removed");
  } finally {
    ck.close();
    delete process.env.RELAY_SIM_EDITS;
    await server.close();
  }
});

test("a person's harmless edit since the snapshot: the merged result is verified, then applied, both edits kept", { timeout: 60_000 }, async () => {
  const { server, repo, owner } = await setup();
  try {
    await server.runs.start("T-ui", owner);
    await checked(server);
    server.docs.applyEdits("src/ui.js", [{ from: server.docs.open("src/ui.js").text.toString().indexOf("'bye'") + 1, to: server.docs.open("src/ui.js").text.toString().indexOf("'bye'") + 1, insert: "see you, " }], "member:kai");
    const res = await server.runs.apply("T-ui", owner);
    assert.equal(res.reverified, true, "checked on the merged, current project");
    assert.equal(server.relay.getIntegration(res.integrationId!)!.status, "approved");
    assert.deepEqual(res.applied, ["src/ui.js"]);
    assert.equal(server.relay.requireTask("T-ui").state, "completed");
    const text = server.docs.open("src/ui.js").text.toString();
    assert.match(text, /'Welcome, '/);
    assert.match(text, /see you, bye/);
    await until(() => readFileSync(join(repo, "src/ui.js"), "utf8") === text, 3000, "on disk");
  } finally {
    delete process.env.RELAY_SIM_EDITS;
    await server.close();
  }
});

test("two people press Apply at the same time: it is applied once", { timeout: 60_000 }, async () => {
  const { server, owner } = await setup();
  try {
    const other = server.members.invite("Pat", "owner").member;
    await server.runs.start("T-ui", owner);
    await checked(server);
    // A person's edit forces the slower path (verification of the merged result), widening the race window.
    const s = server.docs.open("src/ui.js").text.toString();
    server.docs.applyEdits("src/ui.js", [{ from: s.indexOf("'bye'") + 1, to: s.indexOf("'bye'") + 1, insert: "ciao, " }], "member:kai");
    const results = await Promise.allSettled([server.runs.apply("T-ui", owner), server.runs.apply("T-ui", other)]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    assert.equal(ok.length, 1, "exactly one apply succeeds");
    assert.equal(refused.length, 1);
    assert.match(String(refused[0]!.reason), /already being applied|is applied/);
    assert.equal(server.docs.open("src/ui.js").text.toString().match(/Welcome, /g)?.length, 1, "the change is in the file once");
    // Applying again afterwards (a retry after an uncertain outcome) says it's already applied and writes nothing.
    const again = await server.runs.apply("T-ui", owner);
    assert.equal(again.already, true);
    assert.deepEqual(again.applied, []);
    assert.equal(server.docs.open("src/ui.js").text.toString().match(/Welcome, /g)?.length, 1, "still in the file once");
  } finally {
    delete process.env.RELAY_SIM_EDITS;
    await server.close();
  }
});

test("a file renamed or deleted while the agent worked: apply refuses and never brings the old path back", { timeout: 60_000 }, async () => {
  for (const op of ["rename", "delete"] as const) {
    const { server, repo, owner } = await setup();
    try {
      const ada = await joinAs(server, "Ada", "owner");
      await server.runs.start("T-ui", owner);
      await checked(server);
      const r = op === "rename" ? await api(server, ada.cookie, "POST", "/api/files/rename", { from: "src/ui.js", to: "src/view.js" }) : await api(server, ada.cookie, "POST", "/api/files/delete", { path: "src/ui.js" });
      assert.equal(r.status, 200);
      await assert.rejects(server.runs.apply("T-ui", owner), /renamed or deleted in the project while the agent worked; nothing was applied/);
      assert.ok(!existsSync(join(repo, "src/ui.js")), `${op}: the old path stays gone`);
      assert.equal(server.relay.requireTask("T-ui").state, "review_required");
      if (op === "rename") assert.doesNotMatch(readFileSync(join(repo, "src/view.js"), "utf8"), /Welcome/, "the renamed file is untouched");
    } finally {
      delete process.env.RELAY_SIM_EDITS;
      await server.close();
    }
  }
});

test("apply is refused while Relay is still checking the agent's work", { timeout: 60_000 }, async () => {
  const { server, owner } = await setup();
  try {
    // A slow check: the run finishes, then verification takes a while.
    server.relay.createTask({ id: "T-slow", objective: "x", scope: ["src/ui.js"], verify: ["sleep 2"] }, HUMAN);
    server.relay.transition("T-slow", "queued", HUMAN);
    process.env.RELAY_SIM_EDITS = JSON.stringify({ "T-slow": { "src/ui.js": [["'bye'", "'later'"]] } });
    await server.runs.start("T-slow", owner);
    await until(() => server.runs.forTask("T-slow").at(-1)?.status === "finished", 20000, "the run to finish");
    assert.equal(server.runs.forTask("T-slow").at(-1)!.checking, true);
    await assert.rejects(server.runs.apply("T-slow", owner), /still checking/);
    const ada = await joinAs(server, "Ada", "owner");
    const row = (await api(server, ada.cookie, "GET", "/api/coordination")).body.tasks.find((t: { id: string }) => t.id === "T-slow");
    assert.equal(row.status, "checking", "the row says Relay is checking, not 'verification required'");
    await until(() => !server.runs.forTask("T-slow").at(-1)!.checking, 10000, "checks to finish");
    const res = await server.runs.apply("T-slow", owner);
    assert.deepEqual(res.applied, ["src/ui.js"]);
  } finally {
    delete process.env.RELAY_SIM_EDITS;
    await server.close();
  }
});
