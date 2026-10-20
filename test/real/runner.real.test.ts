/**
 * Real provider through the IDE's runner (the same path as the Agent panel): Claude Code in its own worktree, governed by
 * Relay's hook and MCP server, followed by Relay's own checks, then a person applies the result.
 * Skipped unless RELAY_REAL_PROVIDER=1. Costs real model usage; results vary run to run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { testServer, until } from "../collab-helpers.ts";
import { HUMAN, git } from "../helpers.ts";

const REAL = process.env.RELAY_REAL_PROVIDER === "1";
const FILES = {
  "package.json": '{ "type": "module", "scripts": { "test": "node --test" } }\n',
  "src/greeting.js": 'export function greet(name) {\n  return "Hello " + name;\n}\n',
  "src/greeting.test.js": 'import { test } from "node:test";\nimport assert from "node:assert";\nimport { greet } from "./greeting.js";\ntest("greets warmly", () => assert.equal(greet("Ada"), "Welcome back, Ada!"));\n',
  "README.md": "# demo\n",
};

test("real Claude Code through the runner: scoped edit in a worktree, Relay verifies, a person applies", { skip: !REAL, timeout: 600_000 }, async () => {
  const { server, repo } = await testServer(FILES, { claudeBin: "claude" });
  const evidenceDir = join(import.meta.dirname, "../../docs/evidence/claude-code-runner-2026-10-20");
  mkdirSync(evidenceDir, { recursive: true });
  try {
    const r = server.relay;
    r.createTask({ id: "T-greet", objective: 'Make greet(name) return "Welcome back, <name>!" so src/greeting.test.js passes. Do not edit the test.', scope: ["src/greeting.js"], verify: ["node --test src/greeting.test.js"], baseCommit: git(repo, "rev-parse", "HEAD") }, HUMAN);
    r.transition("T-greet", "queued", HUMAN);
    const owner = server.members.invite("Olu", "owner").member;
    assert.equal((await server.runs.provider.available()).ok, true);
    const [run] = await server.runs.start("T-greet", owner);
    await until(() => ["finished", "failed"].includes(server.runs.forTask("T-greet").at(-1)?.status ?? ""), 540_000, "real run to end");
    const done = server.runs.forTask("T-greet").at(-1)!;
    writeFileSync(join(evidenceDir, "run.json"), JSON.stringify({ run: done, task: r.requireTask("T-greet"), evidence: r.evidence("T-greet"), events: r.events("T-greet") }, null, 2));
    assert.equal(done.status, "finished", JSON.stringify(done.activity.slice(-5)));
    assert.equal(run!.provider, "claude-code");
    // The shared file is untouched until a person applies.
    assert.equal(readFileSync(join(repo, "src/greeting.js"), "utf8"), FILES["src/greeting.js"]);
    assert.deepEqual(done.changedFiles, ["src/greeting.js"]);
    const verification = r.evidence("T-greet").filter((e) => e.source === "system" && e.kind === "command");
    assert.equal(verification.at(-1)?.exitCode, 0, "Relay itself ran the test in the worktree and it passed");
    assert.equal(r.requireTask("T-greet").state, "review_required");
    server.runs.apply("T-greet", owner);
    await until(() => readFileSync(join(repo, "src/greeting.js"), "utf8").includes("Welcome back"), 5000, "applied");
  } finally {
    await server.close();
  }
});
