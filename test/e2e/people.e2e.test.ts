/**
 * Two real browsers on one project: live typing and cursors, presence in People, jump and follow, per-person
 * contribution history with exact diffs, line authorship, and syntax diagnostics. Skipped unless RELAY_E2E=1.
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

const STATIC = resolve(import.meta.dirname, "../../ide/web/out");
const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const skip = process.env.RELAY_E2E !== "1" || !existsSync(STATIC);
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

async function signIn(name: string, role: "owner" | "editor"): Promise<Page & { errors: string[] }> {
  const { token } = server.members.invite(name, role);
  const page = (await (await browser.newContext({ viewport: { width: 1440, height: 860 } })).newPage()) as Page & { errors: string[] };
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.goto(`${server.url}/join#${token}`);
  await page.waitForURL(`${server.url}/`);
  await page.getByTestId("welcome").waitFor();
  return page;
}
async function openFile(p: Page, path: string) {
  if ((await p.getByTestId("activity-explorer").getAttribute("aria-selected")) !== "true") await p.getByTestId("activity-explorer").click();
  await p.getByTestId(`file-${path}`).click();
  await p.locator(".cm-content").waitFor();
}

test("two people: live typing, cursors, presence, go to, follow, contributions, authorship and diagnostics", { skip, timeout: 120_000 }, async () => {
  const ada = await signIn("Ada", "owner");
  const bo = await signIn("Bo", "editor");
  const boId = server.members.list().find((m) => m.name === "Bo")!.id;
  await openFile(ada, "src/ui.js");
  await openFile(bo, "src/ui.js");

  // Bo types at the end of the file; Ada sees the text, Bo's labelled caret, and "Bo typing" while it happens.
  await bo.locator(".cm-content").click();
  await bo.keyboard.press("Control+End");
  await bo.keyboard.type("\nexport const fromBo = 'live';", { delay: 25 });
  await ada.locator(".cm-line", { hasText: "fromBo = 'live'" }).waitFor({ timeout: 5000 });
  await ada.locator(".cm-ySelectionInfo", { hasText: "Bo" }).waitFor({ timeout: 5000 });
  await ada.getByText("Bo typing").waitFor({ timeout: 3000 });

  // People: Bo is active in src/ui.js; Go to puts Ada's selection on Bo's line.
  await ada.getByTestId("activity-community").click();
  await ada.getByTestId(`person-${boId}`).getByText(/active · src\/ui\.js/).waitFor({ timeout: 5000 });
  await ada.locator(".cm-content").click();
  await ada.keyboard.press("Control+Home");
  await ada.getByLabel("Go to Bo").click();
  await ada.waitForFunction(() => document.querySelector(".cm-activeLine")?.textContent?.includes("fromBo") ?? false, null, { timeout: 5000 });

  // Follow: when Bo moves to another file, Ada's editor goes with him; Esc stops following.
  await ada.getByLabel("Follow Bo").click();
  await ada.getByTestId("following").waitFor();
  await openFile(bo, "README.md");
  await ada.getByTestId("tab-README.md").waitFor({ timeout: 5000 });
  await ada.waitForFunction(() => document.querySelector("[data-testid^='tab-'][aria-selected=true]")?.textContent?.includes("README.md") ?? false, null, { timeout: 5000 });
  await ada.keyboard.press("Escape");
  await ada.getByTestId("following").waitFor({ state: "detached" });

  // Contributions: Bo's history shows what he inserted, the line that is still his, and the exact diff.
  server.docs.closeSessions();
  await ada.getByTestId(`person-${boId}`).getByRole("button", { name: /Bo/ }).first().click();
  await ada.getByTestId("person-detail").waitFor();
  const detail = ada.getByTestId("person-detail");
  await detail.getByText("src/ui.js").first().waitFor();
  const theirs = await detail.getByText(/theirs:/).innerText();
  const uiLines = (await server.docs.get("src/ui.js")!.text.toString()).split("\n");
  const boLine = uiLines.findIndex((l) => l.includes("fromBo")) + 1;
  assert.match(theirs, new RegExp(`\\b${boLine}\\b`), `Bo's surviving line ${boLine} is listed: ${theirs}`);
  await detail.getByRole("button", { name: /\+\d+ −\d+/ }).first().click();
  await detail.getByTestId("session-diff").getByText("export const fromBo = 'live';").waitFor();

  // Line authorship in the editor is on by default: Bo's line carries his marker.
  await openFile(ada, "src/ui.js");
  await ada.locator(".relay-author[title='Bo']").first().waitFor({ timeout: 5000 });

  // Syntax diagnostics from the shared text, visible to both people.
  await openFile(bo, "src/ui.js");
  await bo.locator(".cm-content").click();
  await bo.keyboard.press("Control+End");
  await bo.keyboard.type("\nconst broken = ;");
  await ada.locator(".cm-lintRange-error").first().waitFor({ timeout: 6000 });
  assert.deepEqual([...ada.errors, ...bo.errors], []);
});
