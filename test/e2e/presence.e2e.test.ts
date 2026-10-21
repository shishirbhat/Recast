/**
 * Google Docs-style presence and line history in real browsers: everyone in the project shows at the top with their
 * own colour (you included), the card offers Go to / Follow, and any line can be traced to who wrote it, when, and the
 * edit that did it. Skipped unless RELAY_E2E=1.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import { testServer } from "../collab-helpers.ts";
import type { RelayServer } from "../../src/server/server.ts";
import { SHOP_FILES } from "./fixture.ts";

const RUN = process.env.RELAY_E2E === "1";
const STATIC = resolve(import.meta.dirname, "../../ide/web/out");
const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const skip = !RUN || !existsSync(STATIC);
let server: RelayServer;
let browser: Browser;
before(async () => {
  if (skip) return;
  server = (await testServer(SHOP_FILES, { staticDir: STATIC })).server;
  browser = await chromium.launch({ executablePath: CHROME });
});
after(async () => {
  if (skip) return;
  await browser.close();
  await server.close();
});
async function join(name: string, role: "owner" | "editor"): Promise<{ p: Page; id: string }> {
  const { token, member } = server.members.invite(name, role);
  const p = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await p.goto(`${server.url}/join#${token}`);
  await p.waitForURL(`${server.url}/`);
  await p.getByTestId("welcome").waitFor();
  return { p, id: member.id };
}

test("presence at the top, then trace a line to who wrote it, when, and the change", { skip }, async () => {
  const ada = await join("Ada Lovelace", "owner");
  // Alone, you still see yourself: the bar never disappears.
  await ada.p.getByTestId(`presence-${ada.id}`).waitFor();
  assert.match(await ada.p.getByTestId("presence-count").innerText(), /1 here/);

  const bo = await join("Bo Chen", "editor");
  await ada.p.getByTestId(`presence-${bo.id}`).waitFor();
  await ada.p.getByTestId("presence-count").filter({ hasText: "2 here" }).waitFor();
  for (const p of [ada.p, bo.p]) {
    await p.getByTestId("file-src/ui.js").click();
    await p.locator(".cm-content").waitFor();
  }
  await bo.p.locator(".cm-line").nth(5).click({ position: { x: 600, y: 5 } });
  await bo.p.keyboard.press("End");
  await bo.p.keyboard.type("\n  // Bo was here");
  // Ada sees Bo's caret with his name, and his avatar marked as typing in the file.
  await ada.p.locator(".cm-ySelectionInfo", { hasText: "Bo Chen" }).waitFor();
  assert.match((await ada.p.getByTestId(`presence-${bo.id}`).getAttribute("title")) ?? "", /Bo Chen · (typing in|in) src\/ui\.js/);
  await ada.p.getByTestId(`presence-${bo.id}`).click();
  await ada.p.getByTestId(`presence-card-${bo.id}`).getByText("src/ui.js").waitFor();
  await ada.p.getByTestId(`presence-follow-${bo.id}`).waitFor();
  await ada.p.keyboard.press("Escape");

  // Line history: click Bo's authorship bar on his new line.
  await ada.p.waitForFunction(() => document.querySelectorAll(".relay-author[title='Bo Chen']").length > 0, undefined, { timeout: 10000 });
  await ada.p.locator(".relay-author[title='Bo Chen']").first().click();
  const hist = ada.p.getByTestId("line-history");
  await hist.getByText("Bo Chen").waitFor();
  assert.match(await hist.innerText(), /Bo was here/);
  await hist.getByRole("button", { name: "Show change" }).first().click();
  await ada.p.getByRole("tab", { name: /ui\.js \(Edit session\)/ }).waitFor();
  await ada.p.getByTestId("diff-counts").waitFor();
  assert.match(await ada.p.getByTestId("diff-counts").innerText(), /\+1/);
});
