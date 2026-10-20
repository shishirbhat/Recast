/**
 * Browser end-to-end: two real Chromium sessions (two signed-in people) edit one file through the built IDE.
 * Skipped unless RELAY_E2E=1 (needs a Chromium build and `ide/web/out`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import { testServer, until } from "../collab-helpers.ts";
import { SHOP_FILES, seed } from "./fixture.ts";

const RUN = process.env.RELAY_E2E === "1";
const STATIC = resolve(import.meta.dirname, "../../ide/web/out");
const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const SHOTS = process.env.RELAY_SCREENSHOTS;

async function signIn(browser: Browser, url: string, token: string, theme: "light" | "dark"): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 880 }, deviceScaleFactor: 2, colorScheme: theme });
  const page = await ctx.newPage();
  await page.goto(`${url}/join#${token}`);
  await page.waitForURL(`${url}/`, { timeout: 10_000 });
  await page.getByTestId("file-src/ui.js").waitFor();
  return page;
}

test("two people edit the same file in the browser and see each other live", { skip: !RUN || !existsSync(STATIC) }, async () => {
  const { server, repo } = await testServer(SHOP_FILES, { staticDir: STATIC });
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    seed(server);
    const maya = server.members.invite("Maya Rao", "owner");
    const kai = server.members.invite("Kai Chen", "editor");
    const a = await signIn(browser, server.url, maya.token, "light");
    const b = await signIn(browser, server.url, kai.token, "light");

    await a.getByTestId("file-src/ui.js").click();
    await b.getByTestId("file-src/ui.js").click();
    await a.locator(".cm-content").waitFor();
    await b.locator(".cm-content").waitFor();
    await until(() => true, 10);

    // Kai types inside the function body; Maya selects a word on another line.
    await b.locator(".cm-line", { hasText: "const user = getUser(id);" }).click();
    await b.keyboard.press("End");
    await b.keyboard.type("\n  if (!user) return 'Welcome';");
    const line = a.locator(".cm-line", { hasText: "Pro users get a small violet badge" });
    await line.click();
    await a.keyboard.press("Home");
    await a.keyboard.press("Shift+End");

    await a.locator(".cm-line", { hasText: "if (!user) return 'Welcome';" }).waitFor({ timeout: 5000 });
    await a.locator(".cm-ySelectionInfo", { hasText: "Kai Chen" }).waitFor({ timeout: 5000 });
    await b.locator(".cm-ySelectionInfo", { hasText: "Maya Rao" }).waitFor({ timeout: 5000 });

    // The shared document and, after the flush, the file on disk carry Kai's edit.
    await until(() => readFileSync(join(repo, "src/ui.js"), "utf8").includes("if (!user) return 'Welcome';"), 4000, "disk");
    // Document text as rendered, minus the collaborator name flags (decorations, not content).
    const docText = (p: Page) =>
      p.evaluate(() =>
        [...document.querySelectorAll(".cm-content .cm-line")]
          .map((l) => {
            const c = l.cloneNode(true) as HTMLElement;
            c.querySelectorAll(".cm-ySelectionInfo").forEach((x) => x.remove());
            return (c.textContent ?? "").replace(/\u2060/g, "");
          })
          .join("\n"),
      );
    const textA = await docText(a);
    assert.equal(textA, await docText(b));
    assert.equal(textA, server.docs.get("src/ui.js")!.text.toString());

    // IDE structure works for real: quick open, project search, the panel.
    await a.keyboard.press("Control+P");
    await a.getByTestId("palette-input").fill("serv");
    await a.keyboard.press("Enter");
    await a.getByTestId("tab-src/server.js").waitFor();
    await a.keyboard.press("Control+Shift+F");
    await a.getByTestId("search-input").fill("getUser");
    await a.getByText(/results in 2 files/).waitFor({ timeout: 5000 });
    await a.keyboard.press("Control+Shift+P");
    await a.getByTestId("palette-input").fill(">problems");
    await a.keyboard.press("Enter");
    await a.getByText("T-api is built on user-api v1; the accepted contract is v2").waitFor();

    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await a.getByTestId("tab-src/ui.js").locator("button").first().click();
      await a.getByTestId("right-tab-tasks").click();
      await a.getByTestId("task-T-ui").click();
      await a.waitForTimeout(600);
      await a.screenshot({ path: join(SHOTS, "ide-light.png") });
      await a.keyboard.press("Control+Shift+P");
      await a.getByTestId("palette-input").fill(">relay");
      await a.waitForTimeout(300);
      await a.screenshot({ path: join(SHOTS, "ide-palette.png") });
      await a.keyboard.press("Escape");
      await b.screenshot({ path: join(SHOTS, "ide-light-kai.png") });
      const dark = await signIn(browser, server.url, server.members.invite("Lena Park", "viewer").token, "dark");
      await dark.evaluate(() => localStorage.setItem("relay.theme", "dark"));
      await dark.reload();
      await dark.getByTestId("file-src/ui.js").click();
      await dark.locator(".cm-content").waitFor();
      await dark.locator(".cm-ySelectionInfo").first().waitFor({ timeout: 5000 });
      await dark.getByTestId("right-tab-contracts").click();
      await dark.keyboard.press("Control+Shift+F");
      await dark.getByTestId("search-input").fill("user");
      await dark.getByText(/results in/).waitFor();
      await dark.waitForTimeout(600);
      await dark.screenshot({ path: join(SHOTS, "ide-dark.png") });
      const fresh = await browser.newContext({ viewport: { width: 1440, height: 880 }, deviceScaleFactor: 2 });
      const joinPage = await fresh.newPage();
      await joinPage.goto(`${server.url}/join#not-a-real-token`);
      await joinPage.getByText("didn't work").waitFor();
      await joinPage.screenshot({ path: join(SHOTS, "join-error.png") });
    }
  } finally {
    await browser.close();
    await server.close();
  }
});
