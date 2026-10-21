/**
 * Source control and review in the browser: edit, see the diff (side by side and inline), stage, commit credited to
 * the person, create and switch a branch, and review a task's changed file with a revision-pinned comment.
 * Skipped unless RELAY_E2E=1.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import { testServer } from "../collab-helpers.ts";
import { HUMAN, git } from "../helpers.ts";
import type { RelayServer } from "../../src/server/server.ts";
import { SHOP_FILES } from "./fixture.ts";

const STATIC = resolve(import.meta.dirname, "../../ide/web/out");
const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const skip = process.env.RELAY_E2E !== "1" || !existsSync(STATIC);
let server: RelayServer;
let repo: string;
let browser: Browser;

before(async () => {
  if (skip) return;
  ({ server, repo } = await testServer(SHOP_FILES, { staticDir: STATIC }));
  browser = await chromium.launch({ executablePath: CHROME });
});
after(async () => {
  if (skip) return;
  await browser.close();
  await server.close();
});

async function signIn(name: string, role: "owner" | "editor" | "viewer"): Promise<Page & { errors: string[] }> {
  const { token } = server.members.invite(name, role);
  const page = (await (await browser.newContext({ viewport: { width: 1440, height: 860 } })).newPage()) as Page & { errors: string[] };
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(`${server.url}/join#${token}`);
  await page.waitForURL(`${server.url}/`);
  await page.getByTestId("welcome").waitFor();
  return page;
}

test("edit, diff, stage, commit, branch; task diff with a revision-pinned review comment", { skip, timeout: 120_000 }, async () => {
  server.relay.createTask({ id: "T-ui", objective: "Greeting", scope: ["src/ui.js"], baseCommit: git(repo, "rev-parse", "HEAD") }, HUMAN);
  const p = await signIn("Maya", "owner");
  await p.getByTestId("file-src/ui.js").click();
  await p.locator(".cm-content").waitFor();
  await p.locator(".cm-line", { hasText: "Welcome back" }).click();
  await p.keyboard.press("End");
  await p.keyboard.type(" // greeting");

  await p.getByTestId("activity-scm").click();
  await p.getByTestId("scm-unstaged-src/ui.js").waitFor({ timeout: 5000 });
  await p.getByTestId("scm-unstaged-src/ui.js").getByTitle("Show working-tree diff").click();
  await p.getByTestId("diff-view").locator(".cm-mergeView").waitFor();
  await p.getByTestId("diff-view").locator(".cm-changedLine", { hasText: "// greeting" }).first().waitFor();
  await p.getByRole("radio", { name: "Inline" }).click();
  await p.getByTestId("diff-view").locator(".cm-deletedChunk").first().waitFor();

  await p.getByLabel("Stage src/ui.js").click();
  await p.getByTestId("scm-staged-src/ui.js").waitFor();
  await p.getByTestId("commit-message").fill("Comment the greeting");
  await p.getByTestId("commit").click();
  await p.getByText(/Committed [0-9a-f]{7}/).first().waitFor();
  assert.equal(git(repo, "log", "-1", "--format=%an|%s"), "Maya|Comment the greeting");

  await p.getByRole("button", { name: "New", exact: true }).click();
  await p.getByLabel("New branch name").fill("feature/badge");
  await p.getByRole("button", { name: "Create + switch" }).click();
  await p.getByText("Created and switched to feature/badge.").first().waitFor();
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "feature/badge");

  // Review a task's change: changed files open as a diff with revision-pinned comments.
  await p.getByRole("tab", { name: "src/ui.js" }).first().click().catch(() => {});
  await p.locator(".cm-content").click();
  await p.keyboard.press("Control+End");
  await p.keyboard.type("\nexport const reviewed = true;");
  await p.getByTestId("activity-relay").click();
  await p.getByTestId("task-T-ui").click();
  await p.getByTestId("changed-files").getByText("src/ui.js").click();
  const diff = p.getByTestId("diff-view");
  await diff.getByText(/base [0-9a-f]{7}/).waitFor();
  await diff.getByLabel("Line").fill("1");
  await diff.getByLabel("Comment", { exact: true }).fill("Keep the import first");
  await diff.getByRole("button", { name: "Comment", exact: true }).click();
  await p.getByTestId("review-comments").getByText("Keep the import first").waitFor();
  assert.deepEqual(p.errors, []);
});

test("viewers can read diffs but can't stage, commit or switch", { skip }, async () => {
  const v = await signIn("Vi", "viewer");
  await v.getByTestId("activity-scm").click();
  await v.getByTestId("scm-view").waitFor();
  assert.equal(await v.getByTestId("commit").count(), 0);
  assert.equal(await v.getByTestId("branch-select").isDisabled(), true);
});

test("tests panel: a real run with per-test results, open a failure at its line, rerun failed, out of date after an edit", { skip, timeout: 120_000 }, async () => {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  mkdirSync(join(repo, "test"), { recursive: true });
  writeFileSync(join(repo, "test/math.test.mjs"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("adds", () => assert.equal(1 + 1, 2));\ntest("breaks", () => {\n  assert.equal(1 + 1, 3);\n});\n');
  const p = await signIn("Tess", "owner");
  await p.keyboard.press("Control+Shift+P");
  await p.keyboard.type("Run All Tests");
  await p.keyboard.press("Enter");
  const panel = p.getByTestId("tests-panel");
  await panel.getByTestId("tests-summary").filter({ hasText: /^Failed · \d+ passed, 1 failed$/ }).waitFor({ timeout: 30_000 });
  assert.ok((await panel.getByTestId("test-pass").count()) >= 2, "the project's own test and the new one both pass");
  await panel.getByTestId("test-fail").click();
  await panel.getByRole("button", { name: "test/math.test.mjs:4" }).click();
  await p.locator("[data-testid^='tab-'][aria-selected=true]", { hasText: "math.test.mjs" }).waitFor();
  assert.equal(await p.getByTestId("panel-tab-tests").locator("span").first().textContent(), "1", "failure count on the tab");

  await panel.getByTestId("tests-rerun-failed").click();
  await panel.getByTestId("tests-summary").filter({ hasText: /^Failed · 0 passed, 1 failed$/ }).waitFor({ timeout: 30_000 });
  assert.match(await panel.innerText(), /node --test test\/math\.test\.mjs\n/, "only the failing file is rerun");

  writeFileSync(join(repo, "test/math.test.mjs"), 'import { test } from "node:test";\ntest("adds", () => {});\n');
  await p.reload();
  await p.getByTestId("welcome").waitFor();
  await p.keyboard.press("Control+Shift+P");
  await p.keyboard.type("Show Tests");
  await p.keyboard.press("Enter");
  await p.getByTestId("tests-stale").waitFor({ timeout: 10_000 });
  assert.deepEqual(p.errors, []);
});
