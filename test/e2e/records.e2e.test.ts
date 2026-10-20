/**
 * Shared investigation in two browsers: one person opens it, another sees it live and continues it.
 * Skipped unless RELAY_E2E=1.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";
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

async function signIn(name: string, role: "owner" | "editor") {
  const { token } = server.members.invite(name, role);
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 860 } })).newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${server.url}/join#${token}`);
  await page.waitForURL(`${server.url}/`);
  await page.getByTestId("empty-editor").waitFor();
  await page.getByTestId("activity-relay").click();
  await page.getByTestId("right-tab-records").click();
  return Object.assign(page, { errors });
}

test("an investigation started in one browser is continued from another, with sources and redaction", { skip }, async () => {
  const ada = await signIn("Ada", "owner");
  const bo = await signIn("Bo", "editor");
  await ada.getByLabel("New investigation").click();
  await ada.getByLabel("Investigation title").fill("Greeting shows undefined");
  await ada.getByLabel("Description").fill("Home screen says Hi undefined after the account change.");
  await ada.getByRole("button", { name: "Start investigation" }).click();
  await ada.getByTestId("investigation-view").waitFor();
  await ada.getByLabel("Command", { exact: true }).fill("node --test src/ui.test.js");
  await ada.getByRole("button", { name: "Run" }).click();
  await ada.getByText("run by relay").waitFor({ timeout: 20000 });

  // Bo sees it appear live (event feed), opens it, adds a sourced finding with a secret in it.
  await bo.getByText("Greeting shows undefined").click();
  await bo.getByTestId("investigation-view").waitFor();
  await bo.getByText("run by relay").waitFor();
  await bo.getByLabel("Entry kind", { exact: true }).selectOption("finding");
  await bo.getByLabel("Sources", { exact: true }).fill("file:src/ui.js:6 test:src/ui.test.js");
  await bo.getByLabel("Entry", { exact: true }).fill("ui.js:6 reads user.name; token ghp_" + "c".repeat(36) + " was in my shell");
  await bo.getByRole("button", { name: "Add" }).click();
  await bo.getByText("1 secret redacted").waitFor();

  // Ada sees Bo's finding without reloading, sourced and redacted.
  await ada.getByText(/ui\.js:6 reads user\.name/).waitFor({ timeout: 5000 });
  assert.equal(await ada.getByText(/ghp_cccc/).count(), 0);
  assert.ok((await ada.getByText("sourced").count()) >= 1);
  await ada.getByRole("button", { name: "Resolve" }).click();
  await ada.getByText(/· resolved ·/).waitFor();
  assert.deepEqual([...ada.errors, ...bo.errors], []);
});
