/**
 * Real Claude Code driven from the browser IDE, end to end: a person starts the agent from the Coordination workspace,
 * Claude Code works in its own worktree under Relay's hook and MCP server, Relay verifies the result itself, the row
 * reads "Ready to integrate", and the person applies it. Assertions are on Relay's records, git and the shared
 * documents, never on what the agent says it did.
 * Skipped unless RELAY_REAL_PROVIDER=1 and RELAY_E2E=1. Costs real model usage; results vary run to run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { testServer, until } from "../collab-helpers.ts";
import { HUMAN, git } from "../helpers.ts";

const RUN = process.env.RELAY_REAL_PROVIDER === "1" && process.env.RELAY_E2E === "1";
const STATIC = resolve(import.meta.dirname, "../../ide/web/out");
const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const FILES = {
  "package.json": '{ "type": "module", "scripts": { "test": "node --test" } }\n',
  "src/greeting.js": 'export function greet(name) {\n  return "Hello " + name;\n}\n',
  "src/greeting.test.js": 'import { test } from "node:test";\nimport assert from "node:assert";\nimport { greet } from "./greeting.js";\ntest("greets warmly", () => assert.equal(greet("Ada"), "Welcome back, Ada!"));\n',
  "README.md": "# demo\n",
};

test("real Claude Code from the IDE: start from Coordination, Relay verifies, ready, applied by a person", { skip: !RUN || !existsSync(STATIC), timeout: 900_000 }, async () => {
  const { server, repo } = await testServer(FILES, { staticDir: STATIC, claudeBin: "claude" });
  const evidenceDir = resolve(import.meta.dirname, `../../docs/evidence/claude-code-ide-${new Date().toISOString().slice(0, 10)}`);
  mkdirSync(evidenceDir, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const r = server.relay;
    r.createTask({ id: "T-greet", objective: 'Make greet(name) return "Welcome back, <name>!" so src/greeting.test.js passes. Do not edit the test.', scope: ["src/greeting.js"], verify: ["node --test src/greeting.test.js"], baseCommit: git(repo, "rev-parse", "HEAD") }, HUMAN);
    r.transition("T-greet", "queued", HUMAN);
    assert.equal((await server.runs.provider.available()).ok, true, "Claude Code is installed and signed in");

    const { token } = server.members.invite("Olu", "owner");
    const p = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" })).newPage();
    await p.goto(`${server.url}/join#${token}`);
    await p.waitForURL(`${server.url}/`);
    await p.getByTestId("welcome").waitFor();
    await p.keyboard.press("Control+Alt+C");
    await p.getByTestId("coord-task-T-greet").getByRole("button", { name: "Start agent" }).click();
    await p.getByTestId("coord-task-T-greet").locator("[data-status='running']").waitFor({ timeout: 30_000 });
    await p.screenshot({ path: join(evidenceDir, "1-running.png") });

    await until(() => ["finished", "failed"].includes(server.runs.forTask("T-greet").at(-1)?.status ?? ""), 840_000, "the real run to end");
    const run = server.runs.forTask("T-greet").at(-1)!;
    writeFileSync(join(evidenceDir, "run.json"), JSON.stringify({ run, task: r.requireTask("T-greet"), evidence: r.evidence("T-greet"), events: r.events("T-greet") }, null, 2));
    assert.equal(run.status, "finished", JSON.stringify(run.activity.slice(-5)));
    assert.equal(run.provider, "claude-code");
    assert.deepEqual(run.changedFiles, ["src/greeting.js"]);
    assert.equal(readFileSync(join(repo, "src/greeting.js"), "utf8"), FILES["src/greeting.js"], "the shared file is untouched until a person applies");
    assert.equal(r.evidence("T-greet").filter((e) => e.source === "system" && e.kind === "command").at(-1)?.exitCode, 0, "Relay itself ran the test in the worktree and it passed");

    await p.waitForFunction(() => document.querySelector("[data-testid='coord-task-T-greet'] [data-status]")?.getAttribute("data-status") === "ready", undefined, { timeout: 30_000 });
    await p.screenshot({ path: join(evidenceDir, "2-ready.png") });
    await p.getByTestId("coord-task-T-greet").getByRole("button", { name: "Apply to project" }).click();
    await p.getByTestId("integrate-confirm").getByRole("button", { name: "Confirm" }).click();
    await p.getByTestId("toast").filter({ hasText: "Applied 1 file from T-greet" }).waitFor({ timeout: 30_000 });
    await p.waitForFunction(() => document.querySelector("[data-testid='coord-task-T-greet'] [data-status]")?.getAttribute("data-status") === "done", undefined, { timeout: 15_000 });
    await p.screenshot({ path: join(evidenceDir, "3-done.png") });
    assert.equal(r.requireTask("T-greet").state, "completed");
    server.docs.flushAll();
    assert.match(readFileSync(join(repo, "src/greeting.js"), "utf8"), /Welcome back/);
    writeFileSync(join(evidenceDir, "summary.json"), JSON.stringify({ claude: (await server.runs.provider.available()), runId: run.id, costUsd: run.costUsd, changedFiles: run.changedFiles, finalState: r.requireTask("T-greet").state, greeting: readFileSync(join(repo, "src/greeting.js"), "utf8") }, null, 2));
  } finally {
    await browser.close();
    await server.close();
  }
});
