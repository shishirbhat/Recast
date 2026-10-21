/**
 * Workbench structure in a real browser: pane toggling and resizing, narrow windows, the eight activities,
 * the command palette (keyboard, disabled commands, focus restore), menus, the integrated terminal, save.
 * Skipped unless RELAY_E2E=1.
 */
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { testServer } from "../collab-helpers.ts";
import type { RelayServer } from "../../src/server/server.ts";
import { SHOP_FILES, seed } from "./fixture.ts";

const RUN = process.env.RELAY_E2E === "1";
const STATIC = resolve(import.meta.dirname, "../../ide/web/out");
const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const skip = !RUN || !existsSync(STATIC);

let server: RelayServer;
let browser: Browser;
const contexts: BrowserContext[] = [];

before(async () => {
  if (skip) return;
  server = (await testServer(SHOP_FILES, { staticDir: STATIC })).server;
  seed(server);
  browser = await chromium.launch({ executablePath: CHROME });
});
// Each test gets fresh browser sessions; leftover sessions would show up as live collaborators in later tests.
afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});
after(async () => {
  if (skip) return;
  await browser.close();
  await server.close();
});

async function signIn(role: "owner" | "editor" | "viewer", width = 1440): Promise<Page> {
  const { token } = server.members.invite(`${role} ${Math.random().toString(36).slice(2, 6)}`, role);
  const ctx = await browser.newContext({ viewport: { width, height: 860 } });
  contexts.push(ctx);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  (page as Page & { errors: string[] }).errors = errors;
  await page.goto(`${server.url}/join#${token}`);
  await page.waitForURL(`${server.url}/`);
  await page.getByTestId("welcome").waitFor();
  return page;
}
/** xterm pads rows with spaces, so poll the terminal's text rather than matching elements exactly. */
const termHas = (p: Page, text: string) => p.waitForFunction((t) => document.querySelector("[data-testid=terminal]:not(.hidden)")?.textContent?.includes(t) ?? false, text, { timeout: 5000 });
const width = (p: Page, testId: string) => p.getByTestId(testId).evaluate((el) => Math.round(el.getBoundingClientRect().width));
const visible = (p: Page, testId: string) => p.getByTestId(testId).isVisible().catch(() => false);
async function openFile(p: Page, path: string) {
  const explorerOpen = await p.getByTestId("activity-explorer").getAttribute("aria-selected");
  if (explorerOpen !== "true") await p.getByTestId("activity-explorer").click();
  await p.getByTestId(`file-${path}`).click();
  await p.locator(".cm-content").waitFor();
}

test("panes: toggle both side bars and the panel; resize with the keyboard; editor takes the rest", { skip }, async () => {
  const p = await signIn("owner");
  await openFile(p, "src/ui.js");
  const editor0 = await width(p, "editor-group");
  await p.keyboard.press("Control+B");
  assert.equal(await visible(p, "primary-sidebar"), false);
  assert.ok((await width(p, "editor-group")) > editor0, "editor grows when the primary side bar closes");
  await p.keyboard.press("Control+B");
  assert.equal(await visible(p, "primary-sidebar"), true);
  assert.equal(await visible(p, "secondary-sidebar"), false, "the Relay side bar starts closed: the editor comes first");
  await p.keyboard.press("Control+Alt+B");
  assert.equal(await visible(p, "secondary-sidebar"), true);
  await p.keyboard.press("Control+Alt+B");
  assert.equal(await visible(p, "secondary-sidebar"), false);
  await p.keyboard.press("Control+J");
  assert.equal(await visible(p, "bottom-panel"), true);
  await p.keyboard.press("Control+J");
  assert.equal(await visible(p, "bottom-panel"), false);
  // Keyboard resize of the primary side bar.
  const before = await width(p, "primary-sidebar");
  await p.getByTestId("sash-primary-side-bar-width").focus();
  await p.keyboard.press("Shift+ArrowRight");
  assert.equal(await width(p, "primary-sidebar"), before + 48);
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no horizontal page scroll");
});

test("narrow windows collapse panes instead of crushing the editor", { skip }, async () => {
  const p = await signIn("owner", 1440);
  await openFile(p, "src/ui.js");
  await p.keyboard.press("Control+Alt+B");
  assert.equal(await visible(p, "secondary-sidebar"), true, "both side bars fit beside a comfortable editor at 1440");
  for (const w of [1100, 900, 700, 560]) {
    await p.setViewportSize({ width: w, height: 760 });
    await p.waitForTimeout(150);
    const editor = await width(p, "editor-group");
    assert.ok(editor >= (w >= 900 ? 480 : 300), `editor is ${editor}px at ${w}px`);
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no horizontal scroll at ${w}`);
  }
  assert.equal(await visible(p, "secondary-sidebar"), false, "the Relay side bar hides first");
  await p.setViewportSize({ width: 1440, height: 860 });
  await p.waitForTimeout(150);
  assert.equal(await visible(p, "secondary-sidebar"), true, "and comes back when there is room (the preference was never overwritten)");
});

test("every activity opens its own view, and switching keeps open editors", { skip }, async () => {
  const p = await signIn("owner");
  await openFile(p, "src/ui.js");
  const expected: [string, RegExp][] = [
    ["search", /^search$/i],
    ["scm", /^source control$/i],
    ["run", /^run$/i],
    ["extensions", /^extensions$/i],
    ["community", /^people$/i],
    ["account", /^account$/i],
    ["settings", /^settings$/i],
    ["explorer", /^explorer$/i],
  ];
  for (const [id, title] of expected) {
    await p.getByTestId(`activity-${id}`).click();
    const header = (await p.getByTestId("primary-sidebar").locator("span").first().innerText()).trim();
    assert.match(header, title, `${id} view header`);
    assert.equal(await visible(p, "tab-src/ui.js"), true, `editor tab survives switching to ${id}`);
  }
  // Relay's tasks live in one place, the Relay side bar; its activity opens and closes that bar.
  await p.getByTestId("activity-relay").click();
  await p.getByTestId("secondary-sidebar").getByRole("tab", { name: "Tasks", selected: true }).waitFor();
  await p.getByTestId("activity-relay").click();
  assert.equal(await visible(p, "secondary-sidebar"), false);
  // Clicking the active activity again collapses the side bar, as in VS Code.
  await p.getByTestId("activity-explorer").click();
  assert.equal(await visible(p, "primary-sidebar"), false);
  await p.getByTestId("activity-explorer").click();
  // Distinct, real destinations.
  await p.getByTestId("activity-community").click();
  await p.getByTestId("people-view").waitFor();
  await p.getByTestId("activity-extensions").click();
  await p.getByText("JavaScript & TypeScript").waitFor();
  await p.getByTestId("activity-run").click();
  await p.getByText("test", { exact: true }).waitFor(); // the fixture's package.json script
});

test("command palette: keyboard navigation, disabled commands explain themselves, Escape restores focus", { skip }, async () => {
  const p = await signIn("owner");
  await openFile(p, "src/ui.js");
  await p.locator(".cm-content").click();
  await p.keyboard.press("Control+Shift+P");
  await p.getByTestId("palette-input").fill(">toggle panel");
  await p.keyboard.press("Enter");
  assert.equal(await visible(p, "bottom-panel"), true);
  await p.keyboard.press("Control+Shift+P");
  await p.getByTestId("palette-input").fill(">start debugging");
  await p.keyboard.press("Enter");
  await p.getByRole("alert").filter({ hasText: "debug adapter" }).waitFor();
  await p.keyboard.press("Escape");
  // Escape restores focus to where the palette was opened from.
  await p.locator(".cm-content").click();
  await p.keyboard.press("Control+Shift+P");
  await p.getByTestId("palette-input").waitFor();
  await p.keyboard.press("Escape");
  await p.waitForTimeout(100);
  assert.equal(await p.evaluate(() => !!document.activeElement?.closest(".cm-editor")), true, "focus is back in the editor");
  // Quick open by file name, then keyboard selection among several results.
  await p.keyboard.press("Control+P");
  await p.getByTestId("palette-input").fill("js");
  await p.keyboard.press("ArrowDown");
  const selected = await p.locator("[role=option][aria-selected=true]").innerText();
  await p.keyboard.press("Enter");
  const name = selected.split("\n")[0]!.trim();
  await p.getByTestId(new RegExp(`tab-.*${name.replace(".", "\\.")}$`)).waitFor();
});

test("menus run registry commands and show unavailable ones as disabled", { skip }, async () => {
  const p = await signIn("owner");
  await p.getByRole("menuitem", { name: "View" }).click();
  await p.getByRole("menuitem", { name: /Toggle Panel/ }).click();
  assert.equal(await visible(p, "bottom-panel"), true);
  await p.getByRole("menuitem", { name: "Run" }).click();
  const debug = p.getByRole("menuitem", { name: /Start Debugging/ });
  assert.equal(await debug.getAttribute("aria-disabled"), "true");
  await p.keyboard.press("Escape");
});

test("terminal: real shell, survives closing and reopening the panel; viewers see why it's unavailable", { skip }, async () => {
  const p = await signIn("owner");
  await p.keyboard.press("Control+`");
  await p.getByTestId("terminal").locator(".xterm-rows").waitFor();
  await p.waitForTimeout(600);
  await p.keyboard.type("echo relay-$((20+22))\n");
  await termHas(p, "relay-42");
  await p.keyboard.press("Control+J"); // close the panel
  assert.equal(await visible(p, "bottom-panel"), false);
  await p.keyboard.press("Control+`"); // reopen on the terminal
  await termHas(p, "relay-42"); // same session, scrollback intact
  await p.waitForTimeout(200);
  await p.keyboard.type("echo still-$((3*7))\n");
  await termHas(p, "still-21"); // output differs from what was typed, so this proves the shell ran it

  const v = await signIn("viewer");
  await v.keyboard.press("Control+`");
  await v.getByText("Terminal unavailable").waitFor();
  await v.getByText(/Only project owners can open a terminal/).waitFor();
});

test("save writes the shared document to disk and reports it; no page errors anywhere", { skip }, async () => {
  const p = await signIn("owner");
  await openFile(p, "README.md");
  await p.locator(".cm-content").click();
  await p.keyboard.press("Control+End");
  await p.keyboard.type("\nSaved from the browser.");
  await p.keyboard.press("Control+S");
  await p.getByText("Saved README.md to disk.").first().waitFor();
  assert.deepEqual((p as Page & { errors: string[] }).errors, []);
});
