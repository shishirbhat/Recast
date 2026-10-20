/**
 * The differentiation demo: the 11-step workflow from the brief, end to end against the real Relay server, real Yjs
 * clients for the humans, real git worktrees, and Relay's real gates. The two coding agents are the SIMULATED agent
 * (test/fixtures/simulated-agent), scripted to reproduce a realistic mistake: the frontend agent updates one consumer of a
 * changed API and misses another. It shows Relay's mechanisms working together; it is NOT a measurement of any
 * provider's behaviour, and it is not a baseline comparison.
 *
 *   node bench/demo.ts [--out docs/evidence/demo.md]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { client, join as joinAs, testServer, until } from "../test/collab-helpers.ts";

const OUT = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1]! : null;
const SIM = resolve(import.meta.dirname, "../test/fixtures/simulated-agent");
const FILES: Record<string, string> = {
  "package.json": '{ "type": "module" }\n',
  "README.md": "# Corner Shop\n",
  "api/users.js": 'export function getUser(id) {\n  return { id, name: "Ada Lovelace", plan: "pro" };\n}\n',
  "api/users.test.js": 'import { test } from "node:test";\nimport assert from "node:assert";\nimport { getUser } from "./users.js";\ntest("user has a display name", () => assert.ok(getUser(1).fullName));\n',
  "web/greeting.js": 'import { getUser } from "../api/users.js";\n\nexport function greet(id) {\n  const u = getUser(id);\n  return "Welcome back, " + u.name;\n}\n',
  "web/profile.js": 'import { getUser } from "../api/users.js";\n\nexport function card(id) {\n  const { name, plan } = getUser(id);\n  return name + " (" + plan + ")";\n}\n',
  "web/web.test.js": 'import { test } from "node:test";\nimport assert from "node:assert";\nimport { greet } from "./greeting.js";\nimport { card } from "./profile.js";\ntest("greeting", () => assert.equal(greet(1), "Welcome back, Ada Lovelace"));\ntest("profile card", () => assert.equal(card(1), "Ada Lovelace (pro)"));\n',
};
const VERIFY_WEB = "node --test web/web.test.js";
const VERIFY_API = "node --test api/users.test.js";

const log: string[] = [];
const metrics: Record<string, number | string> = {};
const t0 = performance.now();
const step = (n: number, title: string) => log.push(`\n## ${n}. ${title}\n`);
const say = (s: string) => log.push(s);
const ms = () => Math.round(performance.now() - t0);
let humanActions = 0;

// The frontend agent's script: it updates the greeting but misses the profile card (the deliberate mismatch).
process.env.RELAY_SIM_EDITS = JSON.stringify({
  "T-api": { "api/users.js": [["name: \"Ada Lovelace\"", "fullName: \"Ada Lovelace\""]] },
  "T-web": { "web/greeting.js": [["u.name", "u.fullName"]] },
});

const { server, repo } = await testServer(FILES, { claudeBin: SIM });
try {
  const call = (cookie: string) => async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${server.url}/api${path}`, { method, headers: { cookie, "x-relay": "1", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: (await res.json()) as any };
  };
  const ada = await joinAs(server, "Ada", "owner");
  const bo = await joinAs(server, "Bo", "editor");
  const cy = await joinAs(server, "Cy", "viewer");
  const A = call(ada.cookie);
  const B = call(bo.cookie);
  const C = call(cy.cookie);

  step(1, "Two people work in the same project");
  const ra = await client(server, ada.cookie, "README.md");
  const rb = await client(server, bo.cookie, "README.md");
  const markers: string[] = [];
  for (let i = 0; i < 10; i++) {
    for (const [who, c] of [["ada", ra], ["bo", rb]] as const) {
      const m = `\n- ${who} note ${i}`;
      markers.push(m);
      c.text.insert(c.text.length, m);
    }
  }
  await until(() => ra.text.toString() === rb.text.toString() && markers.every((m) => ra.text.toString().includes(m)), 5000, "readme converges");
  say(`Ada and Bo typed 20 lines into README.md at the same time; both replicas converged with all 20 (${ms()} ms).`);

  step(2, "Ada plans a feature that needs coordinated changes");
  server.relay.proposeContract("user-api", "getUser(id) -> { id, name, plan }", { kind: "human", id: "Ada" });
  server.relay.acceptContract("user-api", 1, { kind: "human", id: "Ada" });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  for (const t of [
    { id: "T-api", objective: "Return fullName instead of name", scope: ["api/"], contracts: ["user-api"], verify: [VERIFY_API] },
    { id: "T-web", objective: "Show the user's fullName", scope: ["web/"], contracts: ["user-api"], verify: [VERIFY_WEB] },
  ]) {
    const r = await A("POST", "/tasks", t);
    if (r.status !== 201) throw new Error(JSON.stringify(r.data));
    await A("POST", `/tasks/${t.id}/transition`, { to: "queued" });
    humanActions += 2;
  }
  const dr = await A("POST", "/decisions", { title: "Users expose fullName", context: "The account service only has full names.", decision: "getUser returns fullName; name is removed.", scope: ["api/users.js"], contracts: ["user-api"], sources: [{ type: "file", ref: "api/users.js:2" }, { type: "contract", ref: "user-api@1" }] });
  await A("POST", `/decisions/${dr.data.id}/accept`);
  humanActions += 2;
  say(`Contract user-api v1 accepted; tasks T-api (api/) and T-web (web/) share it, each with tests Relay will run. Decision ${dr.data.id} accepted (base ${head.slice(0, 7)}).`);
  const ctx = (await C("GET", "/context?task=T-web")).data;
  say(`T-web's context: ${ctx.decisions.map((d: { id: string; why: string[] }) => `${d.id} (${d.why[0]})`).join("; ")}.`);

  step(3, "Two agents work in isolated worktrees (simulated agents)");
  const started = performance.now();
  await A("POST", "/runs", { tasks: ["T-api", "T-web"] });
  humanActions++;

  step(4, "People keep editing other parts of the project");
  for (let i = 0; i < 5; i++) rb.text.insert(rb.text.length, `\n- bo during agents ${i}`);
  await until(() => ["T-api", "T-web"].every((t) => ["finished", "failed"].includes(server.runs.forTask(t).at(-1)?.status ?? "")), 30000, "agents finish");
  metrics.agents_wall_ms = Math.round(performance.now() - started);
  await until(() => ra.text.toString().includes("bo during agents 4"), 3000, "edits during agents");
  say(`Both agents finished in ${metrics.agents_wall_ms} ms, each in its own worktree; Bo's 5 README edits during the runs reached Ada.`);
  for (const t of ["T-api", "T-web"]) {
    const run = server.runs.forTask(t).at(-1)!;
    say(`- ${t}: ${run.status}, changed ${run.changedFiles.join(", ")}; shared file untouched: ${readFileSync(join(repo, run.changedFiles[0]!), "utf8") === FILES[run.changedFiles[0]!]}`);
  }

  step(5, "Relay finds the dependency and the mismatch");
  const apiRun = server.runs.forTask("T-api").at(-1)!;
  const { ImpactService } = await import("../src/analysis/impact.ts");
  const impact = new ImpactService(server.relay, apiRun.worktree, ":memory:").compute({ base: apiRun.snapshot });
  for (const c of impact.consumers) say(`- consumer ${c.evidence.detail}${c.breaks.map((b) => `; line ${b.line} ${b.reason}`).join("")}`);
  say(`- affected test: ${impact.tests.map((t) => t.chain.join(" -> ")).join("; ")}`);
  metrics.consumers_found = impact.consumers.length;
  metrics.breaking_lines_found = impact.consumers.reduce((n, c) => n + c.breaks.length, 0);
  const webRun = server.runs.forTask("T-web").at(-1)!;
  const webDiff = execFileSync("git", ["diff", webRun.snapshot, "--", "web/"], { cwd: webRun.worktree, encoding: "utf8" });
  say(`T-web's actual diff touches ${(webDiff.match(/^\+\+\+ b\/(.+)$/gm) ?? []).map((l) => l.slice(6)).join(", ")} only, so web/profile.js still reads .name.`);

  step(6, "Unsafe integration is blocked");
  const blocked = await A("POST", "/integrations/check", { tasks: ["T-api", "T-web"], verify: [VERIFY_WEB, VERIFY_API] });
  humanActions++;
  say(`Combined check of T-api + T-web: ${blocked.data.status.toUpperCase()}`);
  for (const g of blocked.data.gaps) say(`- ${g.split("\n")[0]}`);
  metrics.integration_failures_caught_before_integration = blocked.data.status === "blocked" ? 1 : 0;
  say(`Editor approving it: HTTP ${(await B("POST", `/integrations/${blocked.data.id}/approve`)).status}. Owner approving it: HTTP ${(await A("POST", `/integrations/${blocked.data.id}/approve`)).status}. Shared api/users.js still has \`name\`: ${readFileSync(join(repo, "api/users.js"), "utf8").includes("name:")}.`);
  const inv = await B("POST", "/investigations", { title: "Combined check fails after the fullName change", description: "T-api + T-web blocked by the integration gate.", taskId: "T-web" });
  await B("POST", `/investigations/${inv.data.id}/entries`, { kind: "finding", body: "web/profile.js destructures name, which getUser no longer returns.", sources: [{ type: "file", ref: "web/profile.js:4" }, { type: "test", ref: "web/web.test.js" }] });
  humanActions += 2;
  say(`Bo opened ${inv.data.id} and recorded a sourced finding.`);

  step(7, "The dependent work is updated and combined verification reruns");
  process.env.RELAY_SIM_EDITS = JSON.stringify({ "T-web": { "web/greeting.js": [["u.name", "u.fullName"]], "web/profile.js": [["const { name, plan }", "const { fullName: name, plan }"]] } });
  await A("POST", "/tasks/T-web/transition", { to: "failed", reason: "missed web/profile.js" });
  await A("POST", "/tasks/T-web/transition", { to: "queued" });
  await A("POST", "/tasks/T-web/run");
  humanActions += 3;
  await until(() => server.runs.forTask("T-web").at(-1)?.status === "finished" && server.runs.forTask("T-web").length === 2, 30000, "rerun");
  const passed = await A("POST", "/integrations/check", { tasks: ["T-api", "T-web"], verify: [VERIFY_WEB, VERIFY_API] });
  if (!passed.data.status) throw new Error(`combined check failed to run: ${JSON.stringify(passed.data)}`);
  humanActions++;
  say(`T-web reran (now changes ${server.runs.forTask("T-web").at(-1)!.changedFiles.join(", ")}). Combined check: ${passed.data.status.toUpperCase()}.`);
  for (const r of passed.data.results ?? []) say(`- \`${r.command}\` exit ${r.exitCode} (run by Relay in a combined worktree)`);

  step(8, "People inspect diffs and evidence before approving");
  const rec = (await C("GET", "/tasks/T-web/change")).data;
  for (const s of rec.stages) say(`- [${s.state}] ${s.label}: ${s.detail}`);

  step(9, "An authorised person approves; Relay integrates");
  const approved = await A("POST", `/integrations/${passed.data.id}/approve`);
  humanActions++;
  await until(() => readFileSync(join(repo, "web/profile.js"), "utf8").includes("fullName"), 5000, "applied");
  say(`Applied: ${approved.data.applied.join(", ")}. T-api ${server.relay.requireTask("T-api").state}, T-web ${server.relay.requireTask("T-web").state}.`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // an empty-but-set value still makes node skip every file
  const after = execFileSync("node", ["--test", "web/web.test.js", "api/users.test.js"], { cwd: repo, encoding: "utf8", env });
  say(`Tests on the shared project afterwards: ${/# fail 0/.test(after) ? "all pass" : "FAILING"}.`);
  await B("POST", `/investigations/${inv.data.id}/entries`, { kind: "attempt", status: "worked", body: "T-web reran with profile.js updated; combined check passed.", sources: [{ type: "file", ref: "web/profile.js" }] });
  await B("POST", `/investigations/${inv.data.id}`, { status: "resolved" });
  humanActions += 2;

  step(10, "Nothing anyone typed was lost");
  const readme = readFileSync(join(repo, "README.md"), "utf8");
  const all = [...markers.map((m) => m.trim()), ...Array.from({ length: 5 }, (_, i) => `- bo during agents ${i}`)];
  metrics.lost_edits = all.filter((m) => !readme.includes(m)).length;
  say(`README.md on disk has ${all.length - (metrics.lost_edits as number)}/${all.length} of the lines Ada and Bo typed.`);

  step(11, "Another collaborator inspects the result and the history");
  const cyInv = (await C("GET", `/investigations/${inv.data.id}`)).data;
  say(`Cy (viewer) reads ${inv.data.id}: ${cyInv.investigation.status}, ${cyInv.entries.length} entries (${cyInv.entries.map((e: { kind: string }) => e.kind).join(", ")}), opened @${cyInv.investigation.revision}.`);
  const evs = (await C("GET", "/tasks/T-web")).data.events as { type: string }[];
  say(`T-web's event history has ${evs.length} events (${[...new Set(evs.map((e) => e.type))].slice(0, 8).join(", ")}, …).`);
  say(`Cy trying to approve or run anything: HTTP ${(await C("POST", "/integrations/check", { tasks: ["T-api"] })).status}.`);

  metrics.total_ms = ms();
  metrics.human_api_actions = humanActions;
  ra.close();
  rb.close();
} finally {
  await server.close();
}

const report = [
  "# Relay differentiation demo",
  "",
  `Run ${new Date().toISOString()} with \`node bench/demo.ts\`. Real server, real Yjs clients, real git worktrees, real gates; **the two coding agents are the simulated agent** (scripted, deterministic). This shows the mechanisms working together, not a provider's ability and not a comparison with a baseline.`,
  ...log,
  "\n## Numbers from this run\n",
  ...Object.entries(metrics).map(([k, v]) => `- ${k}: ${v}`),
  "",
].join("\n");
console.log(report);
if (OUT) writeFileSync(OUT, report);
