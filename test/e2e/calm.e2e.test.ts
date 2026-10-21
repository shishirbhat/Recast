/**
 * The simplified workspace in a real browser: the editor comes first, one "Needs you" list answers what is blocking
 * and what to do next, the open file names its task, new situations raise one dismissible notice, the review opens
 * with its decision summary, typefaces are switchable, and nothing in the UI is set in shouted uppercase.
 * Skipped unless RELAY_E2E=1.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import { testServer } from "../collab-helpers.ts";
import { HUMAN } from "../helpers.ts";
import type { RelayServer } from "../../src/server/server.ts";
import { SHOP_FILES, seed } from "./fixture.ts";

const STATIC = resolve(import.meta.dirname, "../../ide/web/out");
const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const skip = process.env.RELAY_E2E !== "1" || !existsSync(STATIC);
let server: RelayServer;
let browser: Browser;

before(async () => {
  if (skip) return;
  server = (await testServer(SHOP_FILES, { staticDir: STATIC })).server;
  seed(server);
  browser = await chromium.launch({ executablePath: CHROME });
});
after(async () => {
  if (skip) return;
  await browser.close();
  await server.close();
});

async function signIn(name: string, width = 1440, height = 860): Promise<Page & { errors: string[] }> {
  const { token } = server.members.invite(name, "owner");
  const page = (await (await browser.newContext({ viewport: { width, height } })).newPage()) as Page & { errors: string[] };
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(`${server.url}/join#${token}`);
  await page.waitForURL(`${server.url}/`);
  await page.getByTestId("welcome").waitFor();
  return page;
}

test("needs-you list: real blockers with causes and one next action; the review opens on its decision summary", { skip, timeout: 60_000 }, async () => {
  const p = await signIn("Ada");
  assert.equal(await p.getByTestId("secondary-sidebar").isVisible().catch(() => false), false, "editor first");
  // Seeded state: T-api and T-ui are built on user-api v1 after v2 was accepted; T-docs waits for an owner.
  assert.equal((await p.getByTestId("attention").innerText()).trim(), "3 need you");
  await p.keyboard.press("Control+Shift+A");
  const list = p.getByTestId("attention-list");
  await list.waitFor();
  const rows = await list.locator("li").allInnerTexts();
  assert.equal(rows.length, 3);
  assert.match(rows[0]!, /T-api is built on user-api v1, but v2 is accepted/);
  assert.match(rows[2]!, /T-docs is waiting for approval to start/);
  await p.keyboard.press("Escape");
  assert.equal(await list.isVisible().catch(() => false), false, "Escape closes it");

  await p.getByTestId("attention").click();
  await list.locator("li").first().getByRole("button", { name: "Open task" }).click();
  const summary = p.getByTestId("review-summary");
  await summary.waitFor();
  assert.match(await summary.innerText(), /Built on user-api v1, but v2 is accepted/);
  assert.match(await p.getByTestId("review-tests").innerText(), /No verification command is set/, "nothing claims tests passed that never ran");
  assert.deepEqual(p.errors, []);
});

test("the open file names its task; a new review request raises one dismissible notice", { skip, timeout: 60_000 }, async () => {
  const p = await signIn("Bo");
  await p.getByTestId("file-src/ui.js").click();
  await p.locator(".cm-content").waitFor();
  const ctx = p.getByTestId("file-task");
  assert.match(await ctx.innerText(), /T-ui\s*Greeting shows the full name\s*Queued/);
  await ctx.click();
  await p.getByTestId("review-summary").waitFor();

  // A task moves to review elsewhere: one notice with a direct action, dismissible, and the list grows.
  server.relay.createTask({ id: "T-new", objective: "Small copy fix", scope: ["README.md"] }, HUMAN);
  server.relay.transition("T-new", "queued", HUMAN);
  server.relay.transition("T-new", "running", HUMAN);
  server.relay.transition("T-new", "review_required", HUMAN);
  const toast = p.getByTestId("toast").filter({ hasText: "T-new is ready for review" });
  await toast.waitFor({ timeout: 10_000 });
  assert.equal(await toast.getByRole("button", { name: "Review" }).count(), 1);
  await toast.getByRole("button", { name: "Dismiss" }).click();
  await toast.waitFor({ state: "detached" });
  assert.match(await p.getByTestId("attention").innerText(), /4 need you/);
  assert.deepEqual(await p.getByTestId("toast").allInnerTexts(), [], "routine activity raised no other notices");
  assert.deepEqual(p.errors, []);
});

test("calm type: switchable faces, no uppercase labels, and a comfortable editor in a small window", { skip, timeout: 60_000 }, async () => {
  const p = await signIn("Cy", 1024, 700);
  await p.getByTestId("file-src/ui.js").click();
  await p.locator(".cm-content").waitFor();
  const font = (sel: string) => p.locator(sel).first().evaluate((el) => getComputedStyle(el).fontFamily);
  assert.match(await font("body"), /Figtree/);
  assert.match(await font(".cm-content"), /IBM Plex Mono/);
  const shouted = await p.evaluate(() => [...document.querySelectorAll("body *")].filter((el) => getComputedStyle(el).textTransform === "uppercase" && (el as HTMLElement).innerText?.trim()).map((el) => (el as HTMLElement).innerText.slice(0, 30)));
  assert.deepEqual(shouted, [], "no label is set in uppercase");
  const editor = await p.getByTestId("editor-group").evaluate((el) => el.getBoundingClientRect().width);
  assert.ok(editor >= 480, `editor is ${editor}px wide at 1024`);

  // Keys typed the instant after the palette shortcut go to the palette, never into the code behind it.
  await p.locator(".cm-content").click();
  const code = await p.locator(".cm-content").innerText();
  for (let i = 0; i < 5; i++) {
    await p.keyboard.press("Control+Shift+P");
    await p.keyboard.type("Wrap", { delay: 0 });
    await p.keyboard.press("Escape");
  }
  assert.equal(await p.locator(".cm-content").innerText(), code, "no stray characters in the file");

  await p.keyboard.press("Control+Comma");
  await p.getByTestId("pref-codeFont").selectOption("jetbrains");
  await p.waitForFunction(() => getComputedStyle(document.querySelector(".cm-content")!).fontFamily.includes("JetBrains"));
  await p.reload();
  await p.getByTestId("welcome").waitFor();
  assert.match(await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--code-font")), /JetBrains/, "the choice persists");
  assert.deepEqual(p.errors, []);
});
