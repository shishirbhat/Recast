/**
 * Conflict Radar and the changed-file ownership map, through the server's HTTP API. SIMULATED agents make the changes
 * (deterministic edits); git, merges, the dependency map, the edit log and the server are real. Each test sets up one
 * situation and checks the alert says what is known, what is only suspected, why, and what can be done.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { HUMAN } from "./helpers.ts";
import { api, client, join as joinAs, until } from "./collab-helpers.ts";
import { BREAKING, COMPATIBLE, twoAgentTasks } from "./together-fixture.ts";
import type { Radar, RadarAlert } from "../src/analysis/radar.ts";

type Edits = Parameters<typeof twoAgentTasks>[0];

async function withRadar(edits: Edits, fn: (s: Awaited<ReturnType<typeof twoAgentTasks>>, get: () => Promise<Radar>, cookie: string) => Promise<void>) {
  const s = await twoAgentTasks(edits);
  try {
    const { cookie } = await joinAs(s.server, "Vi", "viewer");
    const get = async () => {
      const r = await api(s.server, cookie, "GET", "/api/radar");
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body as Radar;
    };
    await fn(s, get, cookie);
  } finally {
    await s.server.close();
  }
}
const ofKind = (r: Radar, kind: RadarAlert["kind"]) => r.alerts.filter((a) => a.kind === kind);

test("an agent changes an interface another task still reads: suspected, high, with the read it found; following the change raises nothing", async () => {
  await withRadar(BREAKING, async (_s, get) => {
    const r = await get();
    const [a, ...rest] = ofKind(r, "interface-changed");
    assert.ok(a, JSON.stringify(r.alerts, null, 1));
    assert.equal(rest.length, 0);
    assert.equal(a.certainty, "suspected", "static analysis is never presented as proof");
    assert.equal(a.severity, "high");
    assert.deepEqual(a.tasks, ["T-api", "T-ui"]);
    assert.match(a.title, /T-api changed getUser\(\); T-ui's src\/ui\.js still reads \.name/);
    assert.ok(a.evidence.some((e) => e.source === "agent-run" && /no longer returns name/.test(e.text) && e.at));
    assert.ok(a.evidence.some((e) => e.source === "static-analysis" && /src\/ui\.js:\d+ reads \.name/.test(e.text)));
    const together = a.options.find((o) => o.action.kind === "check-together")!;
    assert.deepEqual(together.action, { kind: "check-together", tasks: ["T-api", "T-ui"] });
    assert.equal(together.disabled, undefined, "both runs finished: checking together is available");
    assert.ok(a.since, "the alert says when the situation began");
    assert.ok(r.limits.some((l) => /JavaScript and TypeScript/.test(l)), "what the radar can't see is stated");
  });
  await withRadar(COMPATIBLE, async (_s, get) => {
    assert.deepEqual(ofKind(await get(), "interface-changed"), [], "T-ui's version reads .fullName: no alert");
  });
});

test("a combined check settles a suspicion: blocked makes it known; passed keeps it visible at low severity", async () => {
  await withRadar(BREAKING, async (s, get) => {
    const own = await joinAs(s.server, "Ola", "owner");
    const checked = (await api(s.server, own.cookie, "POST", "/api/integrations/check", { tasks: ["T-api", "T-ui"] })).body;
    assert.equal(checked.status, "blocked");
    const [a] = ofKind(await get(), "interface-changed");
    assert.equal(a!.certainty, "known");
    assert.match(a!.detail, /^Confirmed by checking them together/);
    assert.ok(a!.evidence.some((e) => e.source === "engine" && /Checked together .*: blocked/.test(e.text)));
  });
  // Verification that never runs the UI code passes together: the static finding stays, but no longer high.
  const s = await twoAgentTasks(BREAKING, "node --check src/ui.js");
  try {
    const own = await joinAs(s.server, "Ola", "owner");
    assert.equal((await api(s.server, own.cookie, "POST", "/api/integrations/check", { tasks: ["T-api", "T-ui"] })).body.status, "passed");
    const [a] = ofKind((await api(s.server, own.cookie, "GET", "/api/radar")).body as Radar, "interface-changed");
    assert.equal(a!.certainty, "suspected");
    assert.equal(a!.severity, "low");
    assert.match(a!.detail, /combined verification passed/);
  } finally {
    await s.server.close();
  }
});

test("two agents edit the same lines: known conflict from a real merge; different parts of a file: suspected, merges as text", async () => {
  await withRadar({ "T-api": { "src/ui.js": [["'bye'", "'ciao'"]] }, "T-ui": { "src/ui.js": [["'bye'", "'see you soon'"]] } }, async (_s, get) => {
    const [a] = ofKind(await get(), "same-file");
    assert.ok(a);
    assert.equal(a.certainty, "known");
    assert.equal(a.severity, "high");
    assert.match(a.title, /conflicting edits to src\/ui\.js/);
    assert.ok(a.evidence.some((e) => e.source === "git" && /conflicting hunks/.test(e.text)));
    assert.ok(a.options.some((o) => o.action.kind === "open-diff" && o.action.task === "T-api" && o.action.path === "src/ui.js"));
    // T-api also stepped into T-ui's scope, but that file is already reported as a same-file alert: said once.
    assert.deepEqual(ofKind(await get(), "scope-crossing"), []);
  });
  await withRadar({ "T-api": { "src/ui.js": [["import { getUser }", "import { getUser as get }"], ["getUser(id)", "get(id)"]] }, "T-ui": { "src/ui.js": [["'bye'", "'see you soon'"]] } }, async (_s, get) => {
    const [a] = ofKind(await get(), "same-file");
    assert.ok(a);
    assert.equal(a.certainty, "suspected", "a clean textual merge doesn't prove the result works");
    assert.equal(a.severity, "medium");
    assert.ok(a.evidence.some((e) => /clean as text/.test(e.text)));
  });
});

test("the project changes under a finished agent: known; a conflicting edit says Apply will refuse, a separate one that Apply re-checks", async () => {
  await withRadar(COMPATIBLE, async (s, get) => {
    // A person edits the very line the agent changed, in the shared project, through a real collaboration client.
    const ed = await joinAs(s.server, "Ed", "editor");
    const c = await client(s.server, ed.cookie, "src/server.js");
    const at = c.text.toString().indexOf("name: 'Ada'");
    c.text.insert(at + "name: 'Ada'".length, ", admin: false");
    await until(() => s.server.docs.get("src/server.js")!.text.toString().includes("admin"), 3000, "edit arrives");
    c.close();
    const [a] = ofKind(await get(), "project-moved");
    assert.ok(a, "the person's edit to a file the agent changed is seen");
    assert.equal(a.certainty, "known");
    assert.equal(a.severity, "high");
    assert.match(a.detail, /Applying will be refused/);
    assert.deepEqual(a.files, ["src/server.js"]);
    assert.ok(a.evidence.some((e) => e.source === "editing" && /Ed edited src\/server\.js/.test(e.text) && e.at), JSON.stringify(a.evidence));
    // The radar's word matches what Apply does.
    const applied = await s.server.runs.apply("T-api", s.owner);
    assert.deepEqual(applied.conflicts.map((x) => x.path), ["src/server.js"]);
    assert.deepEqual(applied.applied, []);
  });
  await withRadar(COMPATIBLE, async (s, get) => {
    const ed = await joinAs(s.server, "Ed", "editor");
    const c = await client(s.server, ed.cookie, "src/server.js");
    c.text.insert(c.text.length, "\nexport const version = 2;\n");
    await until(() => s.server.docs.get("src/server.js")!.text.toString().includes("version = 2"), 3000, "edit arrives");
    c.close();
    const [a] = ofKind(await get(), "project-moved");
    assert.ok(a);
    assert.equal(a.severity, "medium");
    assert.match(a.detail, /re-runs the task's verification on the merged result/);
  });
});

test("a contract moves on after the tasks were built: known, high, for every task on the old version", async () => {
  await withRadar(COMPATIBLE, async (s, get) => {
    s.server.relay.proposeContract("user-api", "getUser(id) -> { id, fullName, email }", HUMAN);
    s.server.relay.acceptContract("user-api", 2, HUMAN);
    const alerts = ofKind(await get(), "contract-mismatch");
    assert.deepEqual(alerts.map((a) => a.tasks[0]).sort(), ["T-api", "T-ui"]);
    for (const a of alerts) {
      assert.equal(a.certainty, "known");
      assert.match(a.title, /built against user-api v1; v2 is current/);
    }
  });
});

test("a passed Check Together goes out of date when the project changes; the radar says approval would be refused", async () => {
  await withRadar(COMPATIBLE, async (s, get) => {
    const own = await joinAs(s.server, "Ola", "owner");
    const checked = (await api(s.server, own.cookie, "POST", "/api/integrations/check", { tasks: ["T-api", "T-ui"] })).body;
    assert.equal(checked.status, "passed", checked.report);
    assert.deepEqual(ofKind(await get(), "integration-outdated"), [], "current right after the check");
    writeFileSync(join(s.repo, "README.md"), "# shop\n");
    const [a] = ofKind(await get(), "integration-outdated");
    assert.ok(a);
    assert.equal(a.certainty, "known");
    assert.match(a.detail, /Approving it would be refused/);
    assert.ok(a.evidence.some((e) => /changed after the check/.test(e.text)));
    // The radar's word matches the gate's.
    const approve = await api(s.server, own.cookie, "POST", `/api/integrations/${checked.id}/approve`);
    assert.equal(approve.status, 409);
  });
});

test("ownership map: who owns each changed file by scope, who changed it and where; contested files first", async () => {
  await withRadar({ "T-api": { "src/server.js": [["name: 'Ada'", "fullName: 'Ada'"]], "src/ui.js": [["'bye'", "'ciao'"]] }, "T-ui": { "src/ui.js": [["'bye'", "'see you soon'"]] } }, async (s, _get, cookie) => {
    const r = await api(s.server, cookie, "GET", "/api/ownership");
    assert.equal(r.status, 200);
    const files = r.body.files as { path: string; scopeOwners: string[]; changes: { task: string; by: string; where: string; worktree?: string }[]; contested: boolean }[];
    assert.deepEqual(files.map((f) => f.path), ["src/ui.js", "src/server.js"], "contested first");
    const ui = files[0]!;
    assert.deepEqual(ui.scopeOwners, ["T-ui"]);
    assert.deepEqual(ui.changes.map((c) => c.task).sort(), ["T-api", "T-ui"]);
    assert.ok(ui.changes.every((c) => c.where === "agent-worktree" && c.by.startsWith("agent:") && c.worktree?.startsWith(".relay/worktrees/")));
    assert.equal(ui.contested, true);
    assert.equal(files[1]!.contested, false);
  });
});

test("radar and ownership need a session", async () => {
  await withRadar(COMPATIBLE, async (s) => {
    for (const path of ["/api/radar", "/api/ownership"]) assert.equal((await api(s.server, "", "GET", path)).status, 401);
  });
});

test("a decision changes after an agent started: the tasks it touches are marked, with who changed it and why; others aren't", async () => {
  await withRadar(COMPATIBLE, async (s, get) => {
    const rec = s.server.records;
    const d = rec.proposeDecision({ title: "Names are one field", context: "c", decision: "getUser returns fullName only.", scope: ["src/server.js"], sources: [{ type: "file", ref: "src/server.js" }] }, "Ada");
    rec.decide(d.id, "accepted", "Ada");
    const other = rec.proposeDecision({ title: "Docs by hand", context: "c", decision: "x", scope: ["docs/"], sources: [{ type: "file", ref: "src/ui.js" }] }, "Ada");
    rec.decide(other.id, "accepted", "Ada");
    let alerts = ofKind(await get(), "decision-changed");
    assert.deepEqual(alerts.map((a) => a.tasks[0]), ["T-api"], "only the task whose scope the decision covers");
    assert.equal(alerts[0]!.certainty, "known");
    assert.equal(alerts[0]!.severity, "medium");
    assert.match(alerts[0]!.title, new RegExp(`Decision ${d.id} was accepted after T-api's work started`));

    rec.decide(d.id, "invalidated", "Bo", "fullName broke the CSV export");
    alerts = ofKind(await get(), "decision-changed").filter((a) => /invalidated/.test(a.title));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.severity, "high");
    assert.match(alerts[0]!.detail, /fullName broke the CSV export.*briefed before this changed/);
    assert.ok(alerts[0]!.evidence.some((e) => e.text === `Bo marked ${d.id} invalidated (fullName broke the CSV export)`));
    // A rejected proposal never applied to anyone.
    const no = rec.proposeDecision({ title: "Rejected idea", context: "c", decision: "x", scope: ["src/ui.js"], sources: [{ type: "file", ref: "src/ui.js" }] }, "Ada");
    rec.decide(no.id, "rejected", "Ada");
    assert.ok(!ofKind(await get(), "decision-changed").some((a) => a.title.includes(no.id)));
  });
});
