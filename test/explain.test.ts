/**
 * Why a combined change failed, from evidence only. Each case runs the real integration check (real git, real
 * `node --test`) and asserts on the explanation Relay stored with it: confirmed when the whole chain is established,
 * likely when a link is missing or more than one cause fits, unknown when nothing explains the failure. The block
 * itself always comes from the verification result, never from the explanation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { Relay } from "../src/core/engine.ts";
import { parseFailures } from "../src/analysis/explain.ts";
import { resolveCommit } from "../src/git.ts";
import { AGENT_A, AGENT_B, HUMAN, makeRepo, tempDb } from "./helpers.ts";

const TEST_HEAD = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n";
const BASE: Record<string, string> = {
  "package.json": '{ "type": "module" }\n',
  "api/users.js": "export function getUser(id) {\n  return { id, name: 'Ada' };\n}\nexport function getAccount(id) {\n  return { id, email: 'ada@example.com' };\n}\n",
  "api/index.js": "export { getUser, getAccount } from './users.js';\n",
  "web/greeting.js": "import { getUser } from '../api/index.js';\n\nexport function greet(id) {\n  const u = getUser(id);\n  return 'Hi ' + u.name;\n}\n\nexport const footer = 'bye';\n",
  "web/greeting.test.js": `${TEST_HEAD}import { greet, footer } from './greeting.js';\ntest('greets by name', () => assert.equal(greet(1), 'Hi Ada'));\ntest('footer', () => assert.equal(footer, 'bye'));\n`,
};

/** Two tasks on one base, both in review, with the given edits applied to the shared workspace. */
function scenario(edits: Record<string, string>, opts: { files?: Record<string, string>; contract?: string | null; apiOn?: number; webOn?: number } = {}) {
  const repo = makeRepo({ ...BASE, ...opts.files });
  const relay = new Relay(tempDb());
  const contracts: Record<string, number> = {};
  if (opts.contract !== null) {
    relay.proposeContract("user-api", opts.contract ?? "getUser(id) -> { id, fullName }", HUMAN);
    relay.acceptContract("user-api", 1, HUMAN);
    contracts["user-api"] = 1;
  }
  const baseCommit = resolveCommit(repo);
  relay.createTask({ id: "T-api", objective: "API", scope: ["api/"], contracts: opts.contract === null ? {} : { "user-api": opts.apiOn ?? 1 }, verify: [], baseCommit }, HUMAN);
  relay.createTask({ id: "T-web", objective: "Web", scope: ["web/"], contracts: opts.contract === null ? {} : { "user-api": opts.webOn ?? 1 }, verify: ["node --test web/greeting.test.js"], baseCommit }, HUMAN);
  for (const [t, a] of [["T-api", AGENT_A], ["T-web", AGENT_B]] as const) {
    relay.transition(t, "queued", HUMAN);
    relay.claim(t, a);
  }
  for (const [p, text] of Object.entries(edits)) writeFileSync(join(repo, p), text);
  for (const [t, a] of [["T-api", AGENT_A], ["T-web", AGENT_B]] as const) relay.transition(t, "review_required", a);
  return { repo, relay };
}
const RENAMED = BASE["api/users.js"]!.replace("name: 'Ada'", "fullName: 'Ada'");

test("confirmed: an API field removed by one task, read by the other's code, fails the combined test; the contract is current", () => {
  const { repo, relay } = scenario({ "api/users.js": RENAMED, "web/greeting.js": BASE["web/greeting.js"]!.replace("'bye'", "'see you'"), "web/greeting.test.js": BASE["web/greeting.test.js"]!.replace("(footer, 'bye')", "(footer, 'see you')") });
  const integ = relay.checkIntegration(["T-api", "T-web"], repo, ["node --test"]);
  assert.equal(integ.status, "blocked");
  assert.ok(integ.gaps.some((g) => g.startsWith("verification failed")), "the block comes from verification");
  const x = integ.explanation!;
  assert.equal(x.verdict, "confirmed", JSON.stringify(x, null, 2));
  assert.equal(x.causes.length, 1);
  const c = x.causes[0]!;
  assert.deepEqual([c.provider.tasks, c.provider.file, c.provider.symbol, c.provider.removedKeys, c.provider.addedKeys], [["T-api"], "api/users.js", "getUser", ["name"], ["fullName"]]);
  assert.deepEqual([c.consumer.tasks, c.consumer.file, c.consumer.line, c.consumer.read], [["T-web"], "web/greeting.js", 5, "name"]);
  assert.equal(c.contracts[0]!.status, "current");
  assert.match(c.contracts[0]!.detail, /does not include `name`/);
  // The chain goes through the re-export barrel, and the failing test is named with its file.
  assert.ok(c.evidence.some((e) => e.includes("via api/index.js")), c.evidence.join("\n"));
  assert.deepEqual(c.failing, [{ command: "node --test web/greeting.test.js", test: "greets by name", file: "web/greeting.test.js" }, { command: "node --test", test: "greets by name", file: "web/greeting.test.js" }]);
  assert.match(x.summary, /^Confirmed cause: T-api changed getUser in api\/users\.js \(part of contract user-api v1\) so it no longer returns `name`.*T-web still reads `name` from getUser\(\) at web\/greeting\.js:5/);
  assert.match(x.resolve, /Relay does not choose/);
  assert.deepEqual(x.uncertain, []);
  // The failing output is kept, not replaced by the explanation; the stored record reads back the same.
  assert.ok(integ.results.some((r) => r.exitCode !== 0 && r.output.includes("not ok")));
  assert.deepEqual(relay.getIntegration(integ.id)!.explanation, x);
});

test("confirmed from code alone: no shared contract, the changed field and its consumer still establish the cause", () => {
  const { repo, relay } = scenario({ "api/users.js": RENAMED }, { contract: null });
  const x = relay.checkIntegration(["T-api", "T-web"], repo, ["node --test"]).explanation!;
  assert.equal(x.verdict, "confirmed");
  assert.deepEqual(x.causes[0]!.contracts, []);
  assert.doesNotMatch(x.summary, /contract/);
});

test("unknown: a failing test no traced change explains is reported as unknown, with the failure shown", () => {
  // T-web changes a constant and forgets its own test; T-api changes nothing anyone reads.
  const { repo, relay } = scenario({ "web/greeting.js": BASE["web/greeting.js"]!.replace("'bye'", "'see you'"), "api/users.js": BASE["api/users.js"]!.replace("'ada@example.com'", "'a@example.com'") });
  const integ = relay.checkIntegration(["T-api", "T-web"], repo, ["node --test"]);
  assert.equal(integ.status, "blocked");
  const x = integ.explanation!;
  assert.equal(x.verdict, "unknown", JSON.stringify(x, null, 2));
  assert.deepEqual(x.causes, []);
  assert.match(x.summary, /^Cause unknown\./);
  assert.deepEqual(x.failures[0]!.tests.map((t) => [t.name, t.file]), [["footer", "web/greeting.test.js"]]);
  assert.ok(x.uncertain.some((u) => u.includes('"footer"')), x.uncertain.join("\n"));
});

test("stale contract evidence is not presented as proof; a contract that doesn't name the symbol isn't either", () => {
  // user-api moved to v2 after T-web was planned on v1: the contract can't vouch for anything.
  const s = scenario({ "api/users.js": RENAMED });
  s.relay.proposeContract("user-api", "getUser(id) -> { id, fullName, plan }", HUMAN);
  s.relay.acceptContract("user-api", 2, HUMAN);
  const stale = s.relay.checkIntegration(["T-api", "T-web"], s.repo, ["node --test"]);
  assert.ok(stale.gaps.some((g) => g.includes("built against user-api v1; current is v2")));
  const c = stale.explanation!.causes[0]!;
  assert.equal(c.contracts[0]!.status, "stale");
  assert.ok(c.uncertain.some((u) => /older version of user-api/.test(u)));
  assert.doesNotMatch(stale.explanation!.summary, /contract user-api/);

  const u = scenario({ "api/users.js": RENAMED }, { contract: "orders(id) -> { total }" });
  const cu = u.relay.checkIntegration(["T-api", "T-web"], u.repo, ["node --test"]).explanation!.causes[0]!;
  assert.equal(cu.contracts[0]!.status, "unrelated");
  assert.ok(!cu.evidence.some((e) => e.includes("orders")), "an unrelated contract is not listed as evidence");
});

test("multiple possible causes: one failing test reaches two removed fields; Relay says likely and does not choose", () => {
  const both = RENAMED.replace("email: 'ada@example.com'", "mail: 'ada@example.com'");
  const files = {
    "web/greeting.js": "import { getUser, getAccount } from '../api/index.js';\n\nexport function greet(id) {\n  return 'Hi ' + getUser(id).name + ' <' + getAccount(id).email + '>';\n}\n\nexport const footer = 'bye';\n",
    "web/greeting.test.js": `${TEST_HEAD}import { greet } from './greeting.js';\ntest('greets by name', () => assert.equal(greet(1), 'Hi Ada <ada@example.com>'));\n`,
  };
  const { repo, relay } = scenario({ "api/users.js": both }, { files });
  const x = relay.checkIntegration(["T-api", "T-web"], repo, ["node --test"]).explanation!;
  assert.equal(x.verdict, "likely", JSON.stringify(x, null, 2));
  assert.deepEqual(x.causes.map((c) => [c.provider.symbol, c.consumer.read, c.confidence]).sort(), [["getAccount", "email", "likely"], ["getUser", "name", "likely"]]);
  assert.ok(x.causes.every((c) => c.uncertain.some((u) => u.includes("can't tell which one"))));
  assert.ok(x.uncertain.includes("2 possible causes; Relay does not choose between them"));
  assert.match(x.summary, /^Likely cause \(not confirmed\)/);
});

test("a combined change that passes has no explanation, and the explanation never decides the status", () => {
  const fixed = BASE["web/greeting.js"]!.replace("u.name", "u.fullName");
  const { repo, relay } = scenario({ "api/users.js": RENAMED, "web/greeting.js": fixed });
  const integ = relay.checkIntegration(["T-api", "T-web"], repo, ["node --test"]);
  assert.equal(integ.status, "passed", integ.gaps.join("\n"));
  assert.equal(integ.explanation, null);
  assert.equal(relay.approveIntegration(integ.id, HUMAN, repo).status, "approved");
});

test("TAP parsing: failing tests with files relative to the checked tree; non-TAP output keeps an excerpt", () => {
  const out = "TAP version 13\nnot ok 1 - greets\n  ---\n  location: '/w/x/src/a.test.js:4:1'\n  error: |-\n    Expected values to be strictly equal:\n  ...\nok 2 - other\n";
  assert.deepEqual(parseFailures("node --test", out, "/w/x").tests, [{ name: "greets", file: "src/a.test.js", line: 4, message: "Expected values to be strictly equal:" }]);
  const tsc = parseFailures("tsc", "src/ui.ts(4,10): error TS2339: Property 'name' does not exist", "/w/x");
  assert.deepEqual(tsc.tests, []);
  assert.match(tsc.excerpt, /TS2339/);
});

test("a database created before explanations existed gets the column, and old integrations read back with none", () => {
  const path = tempDb();
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE integrations (id TEXT PRIMARY KEY, tasks TEXT NOT NULL, base_commit TEXT, tree TEXT NOT NULL, contracts TEXT NOT NULL, status TEXT NOT NULL, gaps TEXT NOT NULL, results TEXT NOT NULL, created_at TEXT NOT NULL, approved_by TEXT, approved_at TEXT)");
  old.prepare("INSERT INTO integrations VALUES ('i1','[]',NULL,'t','{}','blocked','[]','[]','2026-01-01',NULL,NULL)").run();
  old.close();
  const relay = new Relay(path);
  assert.equal(relay.getIntegration("i1")!.explanation, null);
});
