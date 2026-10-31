/**
 * Coverage of a passing check ("assurance") and the dependency-map fixes it relies on. Real git repositories.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo } from "./helpers.ts";
import { DependencyGraph } from "../src/analysis/depgraph.ts";
import { relevantTests } from "../src/analysis/relevant.ts";
import { assurance } from "../src/analysis/assurance.ts";
import { listProjectFiles } from "../src/server/files.ts";
import { showAt } from "../src/git.ts";

const T = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n";
const FILES = {
  "src/greeting.js": "export function greet() {\n  return 'hi';\n}\n",
  "src/greeting.test.js": `${T}import { greet } from './greeting.js';\ntest('g', () => assert.equal(greet(), 'hi'));\n`,
  "src/config.js": "export const config = { port: 3000, timeoutMs: 5000 };\n",
  "src/settings.js": "import { config } from './config.js';\n\nexport function setting(key) {\n  return config[key];\n}\n\nexport function port() {\n  return config.port;\n}\n",
  "src/lonely.js": "export const lonely = 1;\n",
};
const head = (dir: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
const graphOf = (dir: string) => {
  const g = new DependencyGraph(dir);
  g.refresh(listProjectFiles(dir));
  return g;
};

test("a module and its own test changed together: the test is still found to reach the module (was reported as uncovered)", () => {
  const dir = makeRepo(FILES);
  const rel = relevantTests(graphOf(dir), ["src/greeting.js", "src/greeting.test.js"]);
  assert.deepEqual(rel.unreached, []);
  assert.deepEqual(rel.reachedBy, { "src/greeting.js": ["src/greeting.test.js"] });
});

test("an exported object loses a key someone reads: a found break; a computed-key read is a declared gap", () => {
  const dir = makeRepo(FILES);
  const base = head(dir);
  writeFileSync(join(dir, "src/config.js"), "export const config = { timeoutMs: 5000 };\n");
  const imp = graphOf(dir).impact(base, ["src/config.js"], (p) => showAt(dir, base, p));
  const change = imp.interfaces.find((i) => i.symbol === "config")!;
  assert.equal(change.change, "shape");
  assert.deepEqual(change.removedKeys, ["port"]);
  const consumer = imp.consumers.find((c) => c.file === "src/settings.js")!;
  assert.deepEqual(consumer.breaks.map((b) => b.reason), ["reads .port, which config no longer has"]);
  assert.ok(graphOf(dir).module("src/settings.js")!.gaps.some((g) => /settings\.js:4 reads config\[key\] from config: which keys it uses can't be determined statically/.test(g)));
});

test("assurance: verified when every changed file is reached by a test that ran; otherwise each gap is named", () => {
  const dir = makeRepo(FILES);
  const base = head(dir);
  writeFileSync(join(dir, "src/greeting.js"), "export function greet() {\n  return 'hi';\n}\n// tidy\n");
  assert.deepEqual(assurance(dir, base, ["node --test"]), { level: "verified", gaps: [], covering: ["src/greeting.test.js"] });
  const narrow = assurance(dir, base, ["node --check src/greeting.js"]);
  assert.equal(narrow.level, "verified-with-gaps");
  assert.match(narrow.gaps.join("\n"), /Tests that reach the change but no check ran: src\/greeting\.test\.js/);
  writeFileSync(join(dir, "src/lonely.js"), "export const lonely = 2;\n");
  writeFileSync(join(dir, "notes.py"), "print(1)\n");
  const gaps = assurance(dir, base, ["node --test"]).gaps;
  assert.ok(gaps.includes("No test reaches src/lonely.js, which changed"));
  assert.ok(gaps.includes("Not analysed (only JavaScript and TypeScript are): notes.py"));
});
