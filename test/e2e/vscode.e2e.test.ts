/**
 * VS Code parity in a real browser: editor surfaces (minimap, indent guides, line numbers), Format Document through
 * Prettier as minimal shared edits, editor chords that must run exactly once, language and indentation quick picks.
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
  server = (await testServer({ ...SHOP_FILES, "src/messy.js": "const a = {b:1,\n      c:'two'}\nexport default a\n", "src/hello.js": "console.log('hello from ' + 'relay');\n" }, { staticDir: STATIC })).server;
  seed(server);
  browser = await chromium.launch({ executablePath: CHROME });
});
afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});
after(async () => {
  if (skip) return;
  await browser.close();
  await server.close();
});

async function signIn(role: "owner" | "editor" | "viewer"): Promise<Page> {
  const { token } = server.members.invite(`${role} ${Math.random().toString(36).slice(2, 6)}`, role);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 } });
  contexts.push(ctx);
  const page = await ctx.newPage();
  await page.goto(`${server.url}/join#${token}`);
  await page.waitForURL(`${server.url}/`);
  await page.getByTestId("welcome").waitFor();
  return page;
}
async function openFile(p: Page, path: string) {
  if ((await p.getByTestId("activity-explorer").getAttribute("aria-selected")) !== "true") await p.getByTestId("activity-explorer").click();
  await p.getByTestId(`file-${path}`).click();
  await p.locator(".cm-content").waitFor();
  await p.waitForFunction(() => (document.querySelector(".cm-content")?.textContent ?? "").length > 0);
}
const docText = (p: Page) => p.locator(".cm-content").evaluate((el) => [...el.querySelectorAll(".cm-line")].map((l) => l.textContent).join("\n"));
async function runCommand(p: Page, title: string) {
  await p.keyboard.press("Control+Shift+P");
  await p.keyboard.type(title);
  await p.keyboard.press("Enter");
}

test("editor surfaces: minimap, indent guides and line numbers, each toggled from the palette", { skip }, async () => {
  const p = await signIn("owner");
  await openFile(p, "src/ui.js");
  await p.locator(".cm-minimap-gutter").waitFor();
  assert.ok((await p.locator(".cm-indent-markers").count()) > 0, "indent guides drawn");
  assert.ok((await p.locator(".cm-lineNumbers").count()) > 0);
  await runCommand(p, "Toggle Minimap");
  await p.locator(".cm-minimap-gutter").waitFor({ state: "detached" });
  await runCommand(p, "Toggle Line Numbers");
  await p.locator(".cm-lineNumbers").waitFor({ state: "detached" });
  await runCommand(p, "Toggle Line Numbers");
  await runCommand(p, "Toggle Minimap");
  await p.locator(".cm-minimap-gutter").waitFor();
});

test("Format Document runs Prettier and writes the result into the shared document", { skip }, async () => {
  const p = await signIn("owner");
  await openFile(p, "src/messy.js");
  await p.locator(".cm-content").click();
  await p.keyboard.press("Shift+Alt+F");
  await p.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes('c: "two"'));
  assert.equal(await docText(p), 'const a = { b: 1, c: "two" };\nexport default a;\n');
  // The shared document (what every collaborator and the disk flush see) has the formatted text.
  for (let i = 0; i < 50 && !server.docs.get("src/messy.js")?.text.toString().includes('c: "two"'); i++) await p.waitForTimeout(100);
  assert.equal(server.docs.get("src/messy.js")?.text.toString(), 'const a = { b: 1, c: "two" };\nexport default a;\n');
});

test("editor chords run once: Alt+Down moves a line by one, Ctrl+L selects the line, Ctrl+/ comments", { skip }, async () => {
  const p = await signIn("owner");
  await openFile(p, "src/server.js");
  const before = (await docText(p)).split("\n");
  await p.locator(".cm-line").first().click();
  await p.keyboard.press("Alt+ArrowDown");
  const moved = (await docText(p)).split("\n");
  assert.equal(moved[1], before[0], "moved down exactly one line");
  assert.equal(moved[0], before[1]);
  await p.keyboard.press("Alt+ArrowUp");
  assert.deepEqual((await docText(p)).split("\n"), before);
  await p.keyboard.press("Control+L");
  const sel = await p.evaluate(() => getSelection()?.toString() ?? "");
  assert.ok(sel.includes(before[0]!.slice(0, 20)), "Ctrl+L selected the line instead of reaching the browser");
  await p.locator(".cm-line").nth(1).click();
  await p.keyboard.press("Control+/");
  assert.equal((await docText(p)).split("\n")[1], `// ${before[1]}`, "commented once, not toggled twice");
  await p.keyboard.press("Control+Z");
  await p.waitForFunction((l) => [...document.querySelectorAll(".cm-line")][1]?.textContent === l, before[1]);
});

test("language and indentation quick picks from the status bar", { skip }, async () => {
  const p = await signIn("owner");
  await openFile(p, "src/ui.js");
  assert.equal(await p.getByTestId("status-language").textContent(), "JavaScript");
  await p.getByTestId("status-language").click();
  await p.getByTestId("palette-input").fill("plain");
  await p.keyboard.press("Enter");
  await p.getByTestId("status-language").filter({ hasText: "Plain Text" }).waitFor({ timeout: 3000 });
  await p.getByTestId("status-indent").click();
  await p.getByTestId("palette-input").fill("4");
  await p.keyboard.press("Enter");
  await p.getByTestId("status-indent").filter({ hasText: "Spaces: 4" }).waitFor({ timeout: 3000 });
});

test("viewers see editing commands disabled with a reason", { skip }, async () => {
  const p = await signIn("viewer");
  await openFile(p, "src/ui.js");
  await p.keyboard.press("Control+Shift+P");
  await p.keyboard.type("Format Document");
  const row = p.getByRole("option").filter({ hasText: "Format Document" });
  assert.equal(await row.getAttribute("aria-disabled"), "true");
  assert.match((await row.textContent()) ?? "", /Viewers can't change the project/);
});

const termHas = (p: Page, text: string) => p.waitForFunction((t) => document.querySelector("[data-testid=terminal]:not(.hidden)")?.textContent?.includes(t) ?? false, text, { timeout: 8000 });

test("menus: every item either works or says why not; toggles show their state", { skip }, async () => {
  const p = await signIn("owner");
  await openFile(p, "src/ui.js");
  const names = ["File", "Edit", "Selection", "View", "Go", "Run", "Terminal", "Help"];
  for (const name of names) {
    await p.getByRole("menubar").getByRole("menuitem", { name, exact: true }).click();
    const menu = p.getByRole("menu", { name });
    const rows = menu.locator("[role=menuitem], [role=menuitemcheckbox]");
    const n = await rows.count();
    assert.ok(n >= 3, `${name} has items`);
    for (let i = 0; i < n; i++) {
      const row = rows.nth(i);
      if ((await row.getAttribute("aria-disabled")) === "true") assert.ok(((await row.getAttribute("title")) ?? "").length > 8, `disabled "${await row.textContent()}" in ${name} explains why`);
    }
    await p.keyboard.press("Escape");
  }
  await p.getByRole("menubar").getByRole("menuitem", { name: "View", exact: true }).click();
  const minimap = p.getByRole("menuitemcheckbox", { name: /Toggle Minimap/ });
  assert.equal(await minimap.getAttribute("aria-checked"), "true");
  await minimap.click();
  await p.locator(".cm-minimap-gutter").waitFor({ state: "detached" });
  await p.getByRole("menubar").getByRole("menuitem", { name: "View", exact: true }).click();
  assert.equal(await p.getByRole("menuitemcheckbox", { name: /Toggle Minimap/ }).getAttribute("aria-checked"), "false");
  await p.keyboard.press("Escape");
  await p.getByRole("menubar").getByRole("menuitem", { name: "Run", exact: true }).click();
  assert.match((await p.getByRole("menuitem", { name: /Toggle Breakpoint/ }).getAttribute("title")) ?? "", /debug adapter/);
});

test("palette prefixes: line, symbol in file, symbol in workspace, help; Back returns", { skip }, async () => {
  const p = await signIn("owner");
  await openFile(p, "src/ui.js");
  await p.keyboard.press("Control+Shift+P");
  await p.getByTestId("palette-input").fill(":5");
  await p.keyboard.press("Enter");
  await p.waitForFunction(() => /Ln 5,/.test(document.querySelector("footer")?.textContent ?? ""));

  await p.keyboard.press("Control+Shift+O");
  await p.getByRole("option").filter({ hasText: "greet" }).waitFor();
  await p.keyboard.type("badge");
  await p.keyboard.press("Enter");
  await p.waitForFunction(() => /Ln 9,/.test(document.querySelector("footer")?.textContent ?? ""));

  await p.keyboard.press("Control+T");
  await p.keyboard.type("getUser");
  await p.getByRole("option").filter({ hasText: "src/server.js:2" }).waitFor();
  await p.keyboard.press("Enter");
  await p.getByTestId("tab-src/server.js").waitFor();
  await p.waitForFunction(() => /Ln 2,/.test(document.querySelector("footer")?.textContent ?? ""));

  await p.keyboard.press("Control+Alt+-");
  await p.waitForFunction(() => document.querySelector("[aria-label='Breadcrumbs']")?.textContent?.includes("ui.js"));
  await p.waitForFunction(() => /Ln 9,/.test(document.querySelector("footer")?.textContent ?? ""));
  await p.keyboard.press("Control+Shift+-");
  await p.waitForFunction(() => document.querySelector("[aria-label='Breadcrumbs']")?.textContent?.includes("server.js"));

  await p.keyboard.press("Control+P");
  await p.keyboard.type("?");
  assert.ok((await p.getByRole("option").count()) >= 5, "help lists the prefixes");
  await p.getByRole("option").filter({ hasText: "Go to Symbol in Workspace" }).click();
  assert.equal(await p.getByTestId("palette-input").inputValue(), "#");
  await p.keyboard.press("Escape");
});

test("Run Active File and Run Task use the real terminal", { skip }, async () => {
  const p = await signIn("owner");
  await openFile(p, "src/hello.js");
  await runCommand(p, "Run Active File");
  await termHas(p, "hello from relay");
  await runCommand(p, "Run Task");
  await p.getByRole("option").filter({ hasText: "npm run test" }).waitFor();
  await p.keyboard.press("Escape");
});

test("replace in files: preview, confirm, and the open editor updates", { skip }, async () => {
  const p = await signIn("owner");
  p.on("dialog", (d) => void d.accept());
  await openFile(p, "src/server.js");
  await p.keyboard.press("Control+Shift+H");
  await p.getByTestId("search-input").fill("Ada Lovelace");
  await p.getByTestId("replace-input").fill("Grace Hopper");
  await p.locator("ins").filter({ hasText: "Grace Hopper" }).first().waitFor();
  await p.getByTestId("replace-all").click();
  await p.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("Grace Hopper"));
  assert.match(server.docs.get("src/server.js")!.text.toString(), /Grace Hopper/);
  // Regex mode with a group, via the toggle.
  await p.getByTestId("search-regex").click();
  await p.getByTestId("search-input").fill("(Grace) Hopper");
  await p.getByTestId("replace-input").fill("$1 Murray Hopper");
  await p.locator("ins").filter({ hasText: "Grace Murray Hopper" }).first().waitFor();
  await p.getByTestId("replace-all").click();
  await p.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("Grace Murray Hopper"));
});

test("explorer: new file and folder, rename and delete from the context menu; a collaborator's editor follows", { skip }, async () => {
  const ada = await signIn("owner");
  const bo = await signIn("editor");
  for (const p of [ada, bo]) p.on("dialog", (d) => void d.accept());
  // New folder, then a new file inside it, both from the context menu.
  await ada.getByTestId("folder-src").click({ button: "right" });
  await ada.getByRole("menuitem", { name: "New Folder…" }).click();
  await ada.getByTestId("tree-name-input").fill("lib");
  await ada.keyboard.press("Enter");
  await ada.getByTestId("folder-src/lib").waitFor();
  await ada.getByTestId("folder-src/lib").click({ button: "right" });
  await ada.getByRole("menuitem", { name: "New File…" }).click();
  await ada.getByTestId("tree-name-input").fill("tool.js");
  await ada.keyboard.press("Enter");
  await ada.getByTestId("tab-src/lib/tool.js").waitFor();
  await ada.keyboard.type("export const tool = 1;\n");

  // Bo opens it; Ada renames it with F2. Bo's editor moves to the new name, with a notice.
  await bo.getByTestId("folder-src/lib").click();
  await openFile(bo, "src/lib/tool.js");
  await bo.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("tool = 1"));
  await ada.getByTestId("file-src/lib/tool.js").focus();
  await ada.keyboard.press("F2");
  await ada.getByTestId("tree-name-input").fill("helper.js");
  await ada.keyboard.press("Enter");
  await bo.getByTestId("tab-src/lib/helper.js").waitFor();
  await bo.getByTestId("toast").filter({ hasText: "renamed src/lib/tool.js to src/lib/helper.js" }).waitFor();
  await bo.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("tool = 1"));
  await bo.locator(".cm-line").first().click({ position: { x: 2, y: 5 } });
  await bo.keyboard.type("// Bo\n");
  for (let i = 0; i < 50 && !server.docs.get("src/lib/helper.js")?.text.toString().includes("// Bo"); i++) await bo.waitForTimeout(100);
  assert.match(server.docs.get("src/lib/helper.js")!.text.toString(), /\/\/ Bo/, "edits after the rename land in the renamed file");

  // Delete from the context menu: Bo's editor closes, and the file stays gone.
  await ada.getByTestId("file-src/lib/helper.js").click({ button: "right" });
  await ada.getByRole("menuitem", { name: "Delete" }).click();
  await bo.getByTestId("tab-src/lib/helper.js").waitFor({ state: "detached" });
  await bo.getByTestId("toast").filter({ hasText: "deleted src/lib/helper.js" }).waitFor();
  await ada.waitForTimeout(500);
  assert.equal(server.docs.get("src/lib/helper.js"), undefined);
});

test("viewers see file actions disabled with a reason", { skip }, async () => {
  const v = await signIn("viewer");
  await v.getByTestId("file-README.md").click({ button: "right" });
  const del = v.getByRole("menuitem", { name: "Delete" });
  assert.equal(await del.getAttribute("aria-disabled"), "true");
  assert.match((await del.getAttribute("title")) ?? "", /Viewers can't change files/);
});

test("split editor: two groups on one shared document, files open in the focused group, groups close", { skip }, async () => {
  const p = await signIn("owner");
  await openFile(p, "src/ui.js");
  await p.keyboard.press("Control+Backslash");
  await p.getByTestId("g1-editor-pane").waitFor();
  assert.equal(await p.locator(".cm-editor").count(), 2, "the file shows in both groups");
  // Typing in the right group reaches the left one: it's one shared document.
  await p.getByTestId("g1-editor-pane").locator(".cm-line").first().click({ position: { x: 2, y: 5 } });
  await p.keyboard.type("// both sides\n");
  await p.waitForFunction(() => [...document.querySelectorAll(".cm-content")].every((c) => c.textContent?.includes("// both sides")));
  // A file opened now goes to the focused (right) group; the left keeps ui.js.
  await p.getByTestId("file-src/server.js").click();
  await p.getByTestId("g1-tab-src/server.js").waitFor();
  assert.equal(await p.getByTestId("tab-src/server.js").count(), 0);
  assert.equal(await p.getByTestId("editor-pane").getByRole("tab", { selected: true }).getAttribute("data-testid"), "tab-src/ui.js");
  // Splitting again is refused with a reason, not silently ignored.
  assert.match((await p.getByTestId("split-editor").getAttribute("title")) ?? "", /up to two editor groups/);
  await p.getByRole("button", { name: "Close editor group 2" }).click();
  await p.getByTestId("g1-editor-pane").waitFor({ state: "detached" });
  assert.equal(await p.locator(".cm-editor").count(), 1);
  await p.locator(".cm-line").first().click({ position: { x: 2, y: 5 } });
  await p.keyboard.press("Control+Z");
});
