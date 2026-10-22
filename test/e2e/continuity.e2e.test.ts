/**
 * Editor continuity when someone else renames the file you're working in, in real browsers against the real server:
 * the same shared document follows the new path, so focus, caret, undo history and every keystroke survive, including
 * keys typed while the rename is happening. Skipped unless RELAY_E2E=1.
 */
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { partitionable } from "./net.ts";
import type { Partition } from "./net.ts";
import { api, join as joinAs, testServer, until } from "../collab-helpers.ts";
import type { RelayServer } from "../../src/server/server.ts";

const RUN = process.env.RELAY_E2E === "1";
const STATIC = resolve(import.meta.dirname, "../../ide/web/out");
const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const skip = !RUN || !existsSync(STATIC);
const FILES: Record<string, string> = {
  "src/a.js": "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
  "src/other.js": "export const other = true;\n",
  "src/rapid.js": "// rapid\n",
  "src/split.js": "// split\n",
  "src/typing.js": "// typing\n",
  "src/fail.js": "// fail\n",
  "src/undo.js": "// shared baseline\n",
  "src/doomed.js": "// doomed\n",
  "src/away.js": "// away\n",
};
let server: RelayServer;
let repo: string;
let browser: Browser;
let bo: { cookie: string };
const contexts: BrowserContext[] = [];

before(async () => {
  if (skip) return;
  ({ server, repo } = await testServer(FILES, { staticDir: STATIC }));
  browser = await chromium.launch({ executablePath: CHROME });
  bo = await joinAs(server, "Bo", "editor");
});
afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});
after(async () => {
  if (skip) return;
  await browser.close();
  await server.close();
});

async function signIn(net?: (p: Page) => Promise<void>): Promise<Page> {
  const { token } = server.members.invite(`Ada ${Math.random().toString(36).slice(2, 6)}`, "owner");
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  contexts.push(ctx);
  const p = await ctx.newPage();
  if (net) await net(p);
  await p.goto(`${server.url}/join#${token}`);
  await p.waitForURL(`${server.url}/`);
  await p.getByTestId("welcome").waitFor();
  return p;
}
async function open(p: Page, path: string) {
  await p.getByTestId(`file-${path}`).click();
  await p.waitForFunction(() => (document.querySelector(".cm-content")?.textContent ?? "").length > 0);
}
const rename = (from: string, to: string) => api(server, bo.cookie, "POST", "/api/files/rename", { from, to });
const editorFocused = (p: Page) => p.evaluate(() => !!document.activeElement?.closest(".cm-editor"));
const shared = (path: string) => server.docs.open(path).text.toString();

test("a remote rename keeps the editor: focus, caret, undo and the next keystroke all carry over", { skip }, async () => {
  const p = await signIn();
  await open(p, "src/a.js");
  await p.locator(".cm-line").nth(1).click({ position: { x: 200, y: 5 } });
  await p.keyboard.press("End");
  await p.keyboard.type(" // mine");
  await until(() => shared("src/a.js").includes("// mine"), 5000, "the edit to reach the server");

  assert.equal((await rename("src/a.js", "src/renamed.js")).status, 200);
  await p.getByTestId("tab-src/renamed.js").waitFor();
  assert.equal(await p.getByTestId("tab-src/a.js").count(), 0, "the old tab is gone, not duplicated");
  assert.equal(await editorFocused(p), true, "keyboard focus stayed in the editor");
  // Typing continues at the same caret, without a click.
  await p.keyboard.type("!");
  await until(() => shared("src/renamed.js").includes("2; // mine!"), 5000, "the next keystroke to land in the renamed file");
  // Undo still knows the edits made before the rename.
  await p.keyboard.press("Control+Z");
  await p.keyboard.press("Control+Z");
  await until(() => !shared("src/renamed.js").includes("// mine"), 5000, "undo across the rename");
  await p.keyboard.press("Control+Shift+Z");
  await until(() => shared("src/renamed.js").includes("// mine"), 5000, "redo across the rename");
  assert.ok(!existsSync(join(repo, "src/a.js")), "the old path is never written back");
  assert.match(await p.getByTestId("sync-status").innerText(), /Synced/);
});

test("keys typed while the rename happens all arrive in the renamed file", { skip }, async () => {
  const p = await signIn();
  await open(p, "src/typing.js");
  await p.locator(".cm-line").first().click({ position: { x: 300, y: 5 } });
  await p.keyboard.press("End");
  const typing = p.keyboard.type(" abcdefghijklmnopqrstuvwxyz0123456789", { delay: 25 });
  await p.waitForTimeout(250);
  assert.equal((await rename("src/typing.js", "src/typed.js")).status, 200);
  await typing;
  await until(() => shared("src/typed.js").includes("abcdefghijklmnopqrstuvwxyz0123456789"), 8000, `every key in the renamed file (got ${JSON.stringify(shared("src/typed.js"))})`);
  server.docs.flushAll();
  assert.ok(!existsSync(join(repo, "src/typing.js")));
  assert.match(readFileSync(join(repo, "src/typed.js"), "utf8"), /abcdefghijklmnopqrstuvwxyz0123456789/);
});

test("an inactive tab is renamed in place; focus stays where the person is working", { skip }, async () => {
  const p = await signIn();
  await open(p, "src/other.js");
  await open(p, "src/rapid.js");
  await p.locator(".cm-line").first().click();
  assert.equal((await rename("src/other.js", "src/other2.js")).status, 200);
  await p.getByTestId("tab-src/other2.js").waitFor();
  assert.equal(await p.getByTestId("tab-src/rapid.js").getAttribute("aria-selected"), "true", "the active tab didn't change");
  assert.equal(await editorFocused(p), true);
  // Rapid renames of the active file: it ends at the last name, content intact.
  await p.keyboard.type("// one ");
  await until(() => shared("src/rapid.js").includes("// one"), 5000);
  assert.equal((await rename("src/rapid.js", "src/rapid2.js")).status, 200);
  assert.equal((await rename("src/rapid2.js", "src/rapid3.js")).status, 200);
  await p.getByTestId("tab-src/rapid3.js").waitFor();
  await p.keyboard.type("two");
  await until(() => shared("src/rapid3.js").includes("// one two"), 8000, `rapid renames keep the text (got ${JSON.stringify(shared("src/rapid3.js"))})`);
  assert.equal(await p.locator("[data-testid^='tab-src/rapid']").count(), 1);
});

test("both editor groups showing the file follow the rename", { skip }, async () => {
  const p = await signIn();
  await open(p, "src/split.js");
  await p.keyboard.press("Control+Backslash");
  await p.getByTestId("g1-editor-pane").waitFor();
  assert.equal((await rename("src/split.js", "src/split2.js")).status, 200);
  await p.getByTestId("tab-src/split2.js").waitFor();
  await p.getByTestId("g1-tab-src/split2.js").waitFor();
  await p.getByTestId("g1-editor-pane").locator(".cm-line").first().click();
  await p.keyboard.type("// right ");
  await p.waitForFunction(() => [...document.querySelectorAll(".cm-content")].every((c) => c.textContent?.includes("// right")));
});

test("a refused rename changes nothing in the editor", { skip }, async () => {
  const p = await signIn();
  await open(p, "src/fail.js");
  await p.locator(".cm-line").first().click();
  assert.equal((await rename("src/fail.js", "src/other2.js")).status, 409, "the target exists");
  await p.keyboard.type("// still here ");
  await until(() => shared("src/fail.js").includes("still here"), 5000);
  assert.equal(await p.getByTestId("tab-src/fail.js").count(), 1);
});

test("undo reverts only your own edits: never a collaborator's text or the file as loaded", { skip }, async () => {
  const ada = await signIn();
  const { token } = server.members.invite("Bo B", "editor");
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  contexts.push(ctx);
  const bob = await ctx.newPage();
  await bob.goto(`${server.url}/join#${token}`);
  await bob.waitForURL(`${server.url}/`);
  await bob.getByTestId("welcome").waitFor();
  await open(ada, "src/undo.js");
  await open(bob, "src/undo.js");
  await bob.locator(".cm-line").first().click();
  await bob.keyboard.press("End");
  await bob.keyboard.type("\n// from Bo");
  await until(() => shared("src/undo.js").includes("// from Bo"), 5000);
  await ada.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("// from Bo"));
  await ada.locator(".cm-line").last().click();
  await ada.keyboard.type("// from Ada");
  await until(() => shared("src/undo.js").includes("// from Ada"), 5000);
  // Far more undos than Ada made: only her text may go.
  for (let i = 0; i < 10; i++) await ada.keyboard.press("Control+Z");
  await until(() => !shared("src/undo.js").includes("// from Ada"), 5000, "Ada's edit undone");
  const after = shared("src/undo.js");
  assert.match(after, /\/\/ shared baseline/, "the file as loaded is untouched");
  assert.match(after, /\/\/ from Bo/, "the collaborator's line is untouched");
  await bob.waitForFunction(() => !document.querySelector(".cm-content")?.textContent?.includes("// from Ada"));
  assert.match((await bob.locator(".cm-content").textContent()) ?? "", /from Bo/);
  await ada.keyboard.press("Control+Shift+Z");
  await until(() => shared("src/undo.js").includes("// from Ada"), 5000, "redo restores it");
});

test("a file deleted while you had unsent text: you're told, and can keep your copy", { skip }, async () => {
  let net!: Partition;
  const p = await signIn(async (pg) => void (net = await partitionable(pg)));
  await open(p, "src/doomed.js");
  await p.locator(".cm-line").first().click();
  await p.keyboard.press("End");
  net.cut();
  await p.keyboard.type(" // typed offline");
  await p.waitForTimeout(300);
  assert.doesNotMatch(shared("src/doomed.js"), /typed offline/, "the partition really drops the edit");
  assert.equal((await api(server, bo.cookie, "POST", "/api/files/delete", { path: "src/doomed.js" })).status, 200);
  await net.heal();
  const toast = p.getByTestId("toast").filter({ hasText: "changes the server never received" });
  await toast.waitFor({ timeout: 15000 });
  assert.ok(!existsSync(join(repo, "src/doomed.js")), "the deleted file is not recreated by the stale client");
  await toast.getByRole("button", { name: /Save my copy as doomed\.recovered\.js/ }).click();
  await p.getByTestId("tab-src/doomed.recovered.js").waitFor();
  await until(() => shared("src/doomed.recovered.js").includes("// typed offline"), 5000, "the kept copy has the offline text");
});

test("renamed while you were cut off entirely: the missed rename is replayed and your offline text lands in the new file", { skip }, async () => {
  let net!: Partition;
  const p = await signIn(async (pg) => void (net = await partitionable(pg, /\/(collab|events)/)));
  await open(p, "src/away.js");
  await p.locator(".cm-line").first().click();
  await p.keyboard.press("End");
  net.cut();
  await p.keyboard.type(" // written while away");
  assert.equal((await rename("src/away.js", "src/back.js")).status, 200);
  await p.waitForTimeout(300);
  assert.doesNotMatch(shared("src/back.js"), /written while away/);
  await net.heal();
  await p.getByTestId("tab-src/back.js").waitFor({ timeout: 15000 });
  await until(() => shared("src/back.js").includes("// written while away"), 10000, `the offline text in the renamed file (got ${JSON.stringify(shared("src/back.js"))})`);
  assert.ok(!existsSync(join(repo, "src/away.js")), "the old path is not recreated");
  await p.getByTestId("sync-status").filter({ hasText: "Synced" }).waitFor({ timeout: 10000 });
});
