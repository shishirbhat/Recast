/**
 * The ten everyday workflows from the simplification brief, run end to end in a real browser against a real server.
 * Agents here are the SIMULATED agent (test/fixtures/simulated-agent): they prove Relay's orchestration and the
 * interface, not any provider's behaviour. Outside edits are real file writes, reconciled through the same code the
 * file watcher calls. Skipped unless RELAY_E2E=1.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import { testServer, until } from "../collab-helpers.ts";
import { HUMAN } from "../helpers.ts";
import type { RelayServer } from "../../src/server/server.ts";
import { SHOP_FILES } from "./fixture.ts";

const STATIC = resolve(import.meta.dirname, "../../ide/web/out");
const SIM = resolve(import.meta.dirname, "../fixtures/simulated-agent");
const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const skip = process.env.RELAY_E2E !== "1" || !existsSync(STATIC);
let server: RelayServer;
let repo: string;
let browser: Browser;
let p: Page & { errors: string[] };

before(async () => {
  if (skip) return;
  process.env.RELAY_SIM_EDITS = JSON.stringify({ "T-greet": { "src/ui.js": [["Welcome back", "Welcome home"]] } });
  process.env.RELAY_SIM_FAIL = "T-build";
  process.env.RELAY_SIM_DELAY_MS = "2500";
  ({ server, repo } = await testServer(SHOP_FILES, { staticDir: STATIC, claudeBin: SIM }));
  server.relay.createTask({ id: "T-greet", objective: "Warmer greeting", scope: ["src/ui.js"], verify: ["node --check src/ui.js"] }, HUMAN);
  server.relay.createTask({ id: "T-build", objective: "Fix the build", scope: ["src/server.js"] }, HUMAN);
  for (const t of ["T-greet", "T-build"]) server.relay.transition(t, "queued", HUMAN);
  browser = await chromium.launch({ executablePath: CHROME });
  const { token } = server.members.invite("Maya", "owner");
  p = (await (await browser.newContext({ viewport: { width: 1440, height: 880 } })).newPage()) as Page & { errors: string[] };
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(e.message));
  await p.goto(`${server.url}/join#${token}`);
  await p.waitForURL(`${server.url}/`);
  await p.getByTestId("empty-editor").waitFor();
});
after(async () => {
  if (skip) return;
  for (const k of ["RELAY_SIM_EDITS", "RELAY_SIM_FAIL", "RELAY_SIM_DELAY_MS"]) delete process.env[k];
  await browser.close();
  await server.close();
});

/** RELAY_SHOTS=<dir> saves a screenshot at each workflow's key moment, for design review. */
const shot = async (name: string) => process.env.RELAY_SHOTS && (await p.screenshot({ path: join(process.env.RELAY_SHOTS, `${name}.png`) }));
const shared = (path: string) => server.docs.get(path)?.text.toString() ?? "";
const caret = async () => (await p.locator("footer").getByTitle("Go to Line").innerText()).trim();
const inEditor = () => p.evaluate(() => !!document.activeElement?.closest(".cm-editor"));

test("1-2 · open the project, move between files, and edit for a while", { skip, timeout: 60_000 }, async () => {
  await p.keyboard.press("Control+P");
  await p.keyboard.type("server");
  await p.keyboard.press("Enter");
  await p.locator(".cm-line", { hasText: "getUser" }).first().waitFor();
  await p.getByTestId("file-README.md").click();
  await p.locator(".cm-line", { hasText: "Corner Shop" }).waitFor();
  await p.keyboard.press("Control+Alt+ArrowLeft");
  await p.locator("[data-testid='tab-src/server.js'][aria-selected=true]").waitFor();
  await p.keyboard.press("Control+Alt+ArrowRight");
  await p.locator("[data-testid='tab-README.md'][aria-selected=true]").waitFor();

  // A sustained edit: forty lines typed key by key, all of it reaching the shared document intact.
  await p.locator(".cm-content").click();
  await p.keyboard.press("Control+End");
  const lines = Array.from({ length: 40 }, (_, i) => `Note ${i + 1}: the shop opens at ${8 + (i % 4)}am.`);
  for (const l of lines) {
    await p.keyboard.press("Enter");
    await p.keyboard.type(l, { delay: 2 });
  }
  await until(() => shared("README.md").includes(lines.at(-1)!), 5000, "typed text synced");
  assert.equal(shared("README.md").split("\n").filter((l) => /^Note \d+: the shop opens at \d+am\.$/.test(l)).length, 40);
  assert.deepEqual(p.errors, []);
});

test("3-4 · agents run while editing: panels open and close, focus stays in the code, routine activity stays quiet", { skip, timeout: 90_000 }, async () => {
  await p.getByTestId("file-README.md").click();
  await p.locator(".cm-content").click();
  await p.keyboard.press("Control+End");
  const before = await caret();
  // Panels: open and close everything around the editor; the caret is where it was.
  for (const chord of ["Control+J", "Control+Alt+B", "Control+B", "Control+J", "Control+Alt+B", "Control+B"]) await p.keyboard.press(chord);
  assert.equal(await caret(), before, "caret survives panel toggles");

  // Start two agents (one from the task's own button, one from the API) and keep typing.
  await p.getByTestId("activity-relay").click();
  await p.getByTestId("task-T-greet").click();
  await p.getByRole("button", { name: "Run with Claude Code" }).click();
  await server.runs.start("T-build", server.members.list().find((m) => m.role === "owner")!);
  await p.locator(".cm-content").click();
  await p.keyboard.press("Control+End");
  await p.getByTestId("secondary-sidebar").getByRole("tab", { name: "Agents" }).click();
  await p.locator(".cm-content").click();
  await p.keyboard.press("Control+End");
  const overview = p.getByTestId("agent-overview");
  await overview.getByTestId("agent-row-T-greet").filter({ hasText: "Working" }).waitFor();
  await overview.getByTestId("agent-row-T-build").filter({ hasText: "Working" }).waitFor();
  assert.deepEqual((await p.getByTestId("toast").allInnerTexts()).filter((t) => !/started in its own worktree/.test(t)), [], "agents working is routine: the only notice confirms the user's own click");
  for (let i = 0; i < 12; i++) await p.keyboard.type(`while agents work ${i}. `, { delay: 3 });
  assert.ok(await inEditor(), "agent activity never took focus from the editor");
  await shot("wf-agents-working");
  await until(() => shared("README.md").includes("while agents work 11."), 5000, "edits during agent runs synced");
  // Both runs end: one asks for review, one failed. Each raises one notice; focus is still in the code.
  await p.getByTestId("toast").filter({ hasText: "The agent on T-build failed" }).waitFor({ timeout: 20_000 });
  await p.getByTestId("toast").filter({ hasText: "T-greet is ready for review" }).waitFor({ timeout: 20_000 });
  assert.ok(await inEditor(), "notices don't steal focus");
  await shot("wf-agents-done");
  assert.equal(await overview.getByTestId("agent-row-T-build").locator("text=Failed").count(), 1);
  assert.equal(await overview.getByTestId("agent-row-T-greet").locator("text=Needs review").count(), 1);
  assert.deepEqual(p.errors, []);
});

test("5 · investigate an agent failure from the notice", { skip, timeout: 60_000 }, async () => {
  await p.getByTestId("toast").filter({ hasText: "The agent on T-build failed" }).getByRole("button", { name: "Investigate" }).click();
  const log = p.getByTestId("agent-log");
  await log.waitFor();
  assert.equal(await log.getAttribute("open"), "", "a failed run's log opens by itself");
  assert.match(await log.innerText(), /simulated failure: the build step exited with code 2/);
  assert.match(await log.innerText(), /Bash/);
  assert.match(await p.getByTestId("review-failure").innerText(), /^Last run\s+Failed: simulated failure: the build step exited with code 2/, "the failure leads the summary");
  await shot("wf-failure");
  assert.deepEqual(p.errors, []);
});

test("6 · review the change and its real test evidence, then approve", { skip, timeout: 60_000 }, async () => {
  await p.getByTestId("attention").click();
  await p.getByTestId("attention-list").locator("li", { hasText: "T-greet is ready for review" }).getByRole("button", { name: "Review" }).click();
  const summary = p.getByTestId("review-summary");
  await summary.waitFor();
  await summary.getByTestId("changed-files").getByText("src/ui.js").waitFor();
  const tests = await p.getByTestId("review-tests").innerText();
  // The agent's check passed on its own copy; the person kept typing in README.md meanwhile, so the summary says so
  // instead of claiming the pass covers the current shared files.
  assert.match(tests, /^Passed\. 1 passed on this exact workspace\. The shared files changed since; see Re-check\.$/, `tests line: ${tests}`);
  assert.match(await p.getByTestId("review-rechecks").innerText(), /changed since verification ran: node --check src\/ui\.js/);
  assert.match(await p.getByTestId("review-consequence").innerText(), /applies the agent's changes to 1 file to the shared project/);
  await shot("wf-review");
  await summary.getByTestId("changed-files").getByText("src/ui.js").click();
  await p.getByTestId("diff-view").locator(".cm-changedLine", { hasText: "Welcome home" }).first().waitFor();
  await p.getByRole("button", { name: "Approve & apply" }).click();
  await until(() => shared("src/ui.js").includes("Welcome home"), 5000, "applied to the shared copy");
  assert.deepEqual(p.errors, []);
});

test("7 · resolve a conflicting outside edit without losing either version", { skip, timeout: 60_000 }, async () => {
  const path = "src/server.js";
  const entry = server.docs.open(path);
  server.docs.applyText(path, shared(path).replace("'Ada Lovelace'", "'Ada King'"), "disk");
  await until(() => shared(path).includes("Ada King"), 3000, "shared edit");
  const outside = shared(path).replace("'Ada King'", "'Augusta Ada'");
  writeFileSync(join(repo, path), outside);
  // The watcher's own path: an overlapping change to a line the shared copy also changed since the last write.
  (entry as { lastWritten: string | null }).lastWritten = shared(path).replace("'Ada King'", "'Ada Lovelace'");
  assert.equal(server.docs.reconcile(entry, outside), "conflict");

  await p.getByTestId("toast").filter({ hasText: "An outside edit to src/server.js conflicted" }).waitFor({ timeout: 10_000 });
  await p.getByTestId("attention").click();
  await p.getByTestId("attention-list").locator("li", { hasText: "src/server.js conflicted" }).getByRole("button", { name: "Resolve" }).click();
  const bar = p.getByTestId("conflict-bar");
  await bar.waitFor();
  await p.getByTestId("diff-view").getByText("Outside edit (from disk)").waitFor();
  await shot("wf-conflict");
  await bar.getByRole("button", { name: "Use outside version" }).click();
  await until(() => shared(path).includes("Augusta Ada"), 5000, "outside version taken");
  await until(() => server.docs.conflicts().length === 0, 3000, "conflict settled");
  assert.ok(server.docs.conflict(server.relay.events().filter((e) => e.type === "doc.conflict_resolved").at(-1)!.data.conflictId as string)!.theirs.includes("Augusta Ada"), "outside version still recorded");
  await p.waitForFunction(() => !document.querySelector("[data-testid=attention-list]") && !/conflicted/.test(document.body.innerText.split("Notifications")[0] ?? ""));
  assert.deepEqual(p.errors, []);
});

test("8 · a smaller window keeps the code usable and nothing overlaps", { skip, timeout: 60_000 }, async () => {
  await p.setViewportSize({ width: 900, height: 620 });
  await p.waitForTimeout(200);
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no horizontal scroll");
  const editor = await p.getByTestId("editor-group").evaluate((el) => el.getBoundingClientRect().width);
  assert.ok(editor >= 480, `editor ${editor}px`);
  await p.getByTestId("attention").click();
  const box = (await p.getByTestId("attention-list").boundingBox())!;
  await shot("wf-small");
  assert.ok(box.x >= 0 && box.x + box.width <= 900 && box.y + box.height <= 620, `list fits: ${JSON.stringify(box)}`);
  await p.keyboard.press("Escape");
  await p.setViewportSize({ width: 1440, height: 880 });
});

test("9-10 · keyboard only, and coming back to the code after several side trips", { skip, timeout: 60_000 }, async () => {
  await p.getByTestId("file-README.md").click();
  await p.locator(".cm-content").click();
  await p.keyboard.press("Control+Home");
  await p.keyboard.press("ArrowDown");
  await p.keyboard.press("ArrowDown");
  await p.keyboard.press("End");
  const spot = await caret();

  // Needs-you by keyboard: focus lands on the first action, Escape returns to the editor.
  await p.keyboard.press("Control+Shift+A");
  await p.waitForFunction(() => document.activeElement?.closest("[data-testid=attention-list]") !== null);
  await p.keyboard.press("Escape");
  assert.ok(await inEditor(), "focus back in the editor");

  // Side trips: people, tests, a task, a diff, settings.
  await p.keyboard.press("Control+Shift+P");
  await p.keyboard.type("Show People");
  await p.keyboard.press("Enter");
  await p.getByTestId("people-view").waitFor();
  await p.keyboard.press("Control+Shift+P");
  await p.keyboard.type("Show Tests");
  await p.keyboard.press("Enter");
  await p.getByTestId("tests-panel").waitFor();
  await p.keyboard.press("Control+Shift+P");
  await p.keyboard.type("Relay Tasks");
  await p.keyboard.press("Enter");
  await p.getByTestId("task-T-build").click();
  await p.keyboard.press("Control+Shift+G");
  await p.getByTestId("activity-explorer").click();
  // Back to the code: close what was opened; the file, caret and text are as they were.
  await p.keyboard.press("Control+J");
  await p.keyboard.press("Control+Alt+B");
  await p.getByTestId("tab-README.md").click();
  assert.equal(await caret(), spot, "caret restored");
  assert.ok(shared("README.md").includes("while agents work 11."));
  assert.equal(await p.getByTestId("secondary-sidebar").isVisible().catch(() => false), false);
  assert.deepEqual(p.errors, []);
});
