/**
 * The coordination workspace against the real engine, with the SIMULATED agent (test/fixtures/simulated-agent):
 * statuses follow engine state and change records, dependencies and contract partners show, a real verification
 * failure reads as one, and actions are only offered where the engine supports them. Skipped unless RELAY_E2E=1.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import { testServer, until } from "../collab-helpers.ts";
import type { RelayServer } from "../../src/server/server.ts";
import { HUMAN } from "../helpers.ts";
import { SHOP_FILES, seed } from "./fixture.ts";

const RUN = process.env.RELAY_E2E === "1";
const STATIC = resolve(import.meta.dirname, "../../ide/web/out");
const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const SIM = resolve(import.meta.dirname, "../fixtures/simulated-agent");
const skip = !RUN || !existsSync(STATIC);
let server: RelayServer;
let browser: Browser;

before(async () => {
  if (skip) return;
  // The agent changes the greeting the test checks, so verification fails for real.
  process.env.RELAY_SIM_EDITS = JSON.stringify({ "T-ui": { "src/ui.js": [["Welcome back", "Welcome home"]] }, "T-readme": { "README.md": [["A tiny shop", "A tiny corner shop"]] } });
  process.env.RELAY_SIM_DELAY_MS = "200";
  server = (await testServer(SHOP_FILES, { staticDir: STATIC, claudeBin: SIM })).server;
  seed(server);
  server.relay.createTask({ id: "T-release", objective: "Release notes", scope: ["CHANGELOG.md"], prerequisites: ["T-api", "T-ui"] }, HUMAN);
  server.relay.transition("T-release", "queued", HUMAN);
  // A task with no contract partners whose checks pass: it can become ready and be applied from the row.
  server.relay.createTask({ id: "T-readme", objective: "Describe the shop in the README", scope: ["README.md"], verify: ["node --test"] }, HUMAN);
  server.relay.transition("T-readme", "queued", HUMAN);
  browser = await chromium.launch({ executablePath: CHROME });
});
after(async () => {
  if (skip) return;
  for (const k of ["RELAY_SIM_EDITS", "RELAY_SIM_DELAY_MS"]) delete process.env[k];
  await browser.close();
  await server.close();
});

async function signIn(role: "owner" | "viewer"): Promise<Page> {
  const { token } = server.members.invite(`${role} ${Math.random().toString(36).slice(2, 6)}`, role);
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(`${server.url}/join#${token}`);
  await page.waitForURL(`${server.url}/`);
  await page.getByTestId("welcome").waitFor();
  return page;
}
const status = (p: Page, id: string) => p.getByTestId(`coord-task-${id}`).locator("[data-status]").first().getAttribute("data-status");

test("coordination: engine statuses, dependencies, a real verification failure, and only supported actions", { skip }, async () => {
  const p = await signIn("owner");
  await p.keyboard.press("Control+Alt+C");
  await p.getByTestId("coord-answers").waitFor();
  assert.equal(await status(p, "T-api"), "running");
  assert.equal(await status(p, "T-docs"), "proposed");
  assert.equal(await status(p, "T-release"), "waiting");
  assert.match(await p.getByTestId("coord-task-T-release").innerText(), /waits on/);
  await p.getByTestId("coord-graph").waitFor();
  assert.match(await p.getByTestId("coord-answers").innerText(), /share a contract and must integrate together/);

  // Start the agent from the row; when it finishes, Relay's own check fails and the row says so.
  await p.getByTestId("coord-task-T-ui").getByRole("button", { name: "Start agent" }).click();
  await until(() => server.runs.forTask("T-ui").at(-1)?.status === "finished", 30000, "the agent run to finish");
  await p.waitForFunction(() => document.querySelector("[data-testid='coord-task-T-ui'] [data-status]")?.getAttribute("data-status") === "verification_failed", undefined, { timeout: 15000 });
  assert.match(await p.getByTestId("coord-task-T-ui").innerText(), /failing: node --test/);
  assert.match(await p.getByTestId("coord-task-T-ui").innerText(), /\.relay\/worktrees\/T-ui-/, "the agent's worktree is named, apart from the main checkout");
  // Checks for agent work run in its worktree; the shared-workspace check is refused with the reason.
  const check = p.getByTestId("coord-task-T-ui").getByRole("button", { name: /Run checks/ });
  assert.equal(await check.isDisabled(), true);
  assert.match((await check.getAttribute("title")) ?? "", /own worktree/);
  assert.match(await p.getByTestId("coord-answers").innerText(), /Nothing is verified and unblocked yet/, "nothing is called safe");
  // The changed file opens the task's diff.
  await p.getByTestId("coord-task-T-ui").getByRole("button", { name: "ui.js" }).click();
  await p.getByRole("tab", { name: /ui\.js/ }).last().waitFor();
  // The diff counts real changed lines and shows where the change stands, read-only.
  await p.getByTestId("diff-counts").waitFor();
  assert.equal((await p.getByTestId("diff-counts").innerText()).replace(/\s+/g, " "), "+1 −1");
  await p.getByTestId("diff-review-bar").waitFor();
  assert.match(await p.getByTestId("diff-review-bar").innerText(), /tested/);
  assert.match(await p.getByTestId("diff-review-bar").innerText(), /before integration/);
});

test("coordination: viewers see it, and can't create or start", { skip }, async () => {
  const v = await signIn("viewer");
  await v.getByTestId("activity-coordination").click();
  await v.getByTestId("coord-answers").waitFor();
  assert.equal(await v.getByRole("button", { name: "New task" }).isDisabled(), true);
});

test("coordination: a verified agent change becomes ready, is applied after confirmation, and the engine confirms it", { skip }, async () => {
  const p = await signIn("owner");
  await p.keyboard.press("Control+Alt+C");
  await p.getByTestId("coord-task-T-readme").getByRole("button", { name: "Start agent" }).click();
  await until(() => server.runs.forTask("T-readme").at(-1)?.status === "finished", 30000, "the agent run to finish");
  await p.waitForFunction(() => document.querySelector("[data-testid='coord-task-T-readme'] [data-status]")?.getAttribute("data-status") === "ready", undefined, { timeout: 15000 });
  assert.match(await p.getByTestId("coord-answers").innerText(), /Safe to integrate next\?\s*T-readme/);
  // Nothing is in the shared project before a person applies it.
  assert.doesNotMatch(server.docs.open("README.md").text.toString(), /corner shop/);
  await p.getByTestId("coord-task-T-readme").getByRole("button", { name: "Apply to project" }).click();
  await p.getByTestId("integrate-confirm").getByRole("button", { name: "Confirm" }).click();
  await p.getByTestId("toast").filter({ hasText: "Applied 1 file from T-readme" }).waitFor();
  await p.waitForFunction(() => document.querySelector("[data-testid='coord-task-T-readme'] [data-status]")?.getAttribute("data-status") === "done", undefined, { timeout: 10000 });
  assert.equal(server.relay.requireTask("T-readme").state, "completed");
  // The workbench's own project state catches up too: the "ready for review" notice leaves once it's resolved.
  await p.getByTestId("toast").filter({ hasText: "T-readme is ready for review" }).waitFor({ state: "detached", timeout: 10000 });
  assert.match(server.docs.open("README.md").text.toString(), /A tiny corner shop/);
  // Applying twice (a retry) is answered by the engine as already applied, and writes nothing again.
  const again = await server.runs.apply("T-readme", server.members.invite("x", "owner").member);
  assert.equal(again.already, true);
  assert.deepEqual(again.applied, []);
  assert.equal(server.docs.open("README.md").text.toString().match(/A tiny corner shop/g)?.length, 1);
});
