/**
 * Project setup in a real browser: proposals with citations, Try it on a copy of the files, an owner accepting, and a
 * new task starting with the accepted check. Skipped unless RELAY_E2E=1.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";
import { testServer } from "../collab-helpers.ts";
import type { RelayServer } from "../../src/server/server.ts";

const STATIC = resolve(import.meta.dirname, "../../ide/web/out");
const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const SHOTS = process.env.RELAY_SHOTS;
const skip = process.env.RELAY_E2E !== "1" || !existsSync(STATIC);
let server: RelayServer;
let browser: Browser;

before(async () => {
  if (skip) return;
  server = (await testServer({
    "package.json": JSON.stringify({ name: "shop", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
    ".github/workflows/ci.yml": "jobs:\n  t:\n    steps:\n      - run: npm test\n",
    "src/a.js": "export const a = 1;\n",
    "src/a.test.js": "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { a } from './a.js';\ntest('a', () => assert.equal(a, 1));\n",
  }, { staticDir: STATIC })).server;
  browser = await chromium.launch({ executablePath: CHROME });
});
after(async () => {
  if (skip) return;
  await browser.close();
  await server.close();
});

test("project setup: a cited proposal is tried, accepted by an owner, and becomes a new task's check", { skip, timeout: 90_000 }, async () => {
  const { token } = server.members.invite("Ola", "owner");
  const p = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await p.goto(`${server.url}/join#${token}`);
  await p.waitForURL(`${server.url}/`);
  await p.getByTestId("welcome").waitFor();
  await p.keyboard.press("Control+Shift+P");
  await p.keyboard.type("Show Project Setup");
  await p.keyboard.press("Enter");
  const npmTest = p.getByTestId("proposal").filter({ hasText: "Check with npm test" });
  await npmTest.waitFor();
  assert.match(await npmTest.innerText(), /package\.json:5[\s\S]*\.github\/workflows\/ci\.yml:4/);
  await npmTest.getByRole("button", { name: "Try it" }).click();
  await npmTest.getByTestId("trial").waitFor({ timeout: 60_000 });
  assert.match(await npmTest.getByTestId("trial").innerText(), /Tried by Ola: worked in/);
  await npmTest.getByRole("button", { name: "Accept" }).click();
  await p.locator('[data-testid="proposal"][data-status="accepted"]').filter({ hasText: "Check with npm test" }).waitFor();
  // Automatic rechecks: off by default, an owner turns them on, and the server says so.
  const auto = p.getByTestId("auto-recheck").getByRole("checkbox");
  assert.equal(await auto.isChecked(), false);
  await auto.check();
  await p.getByTestId("toast").filter({ hasText: "Automatic rechecks are on." }).waitFor();
  const settings = await (await fetch(`${server.url}/api/settings`, { headers: { cookie: (await p.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; "), "x-relay": "1" } })).json();
  assert.equal(settings.autoRecheck, true);
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/project-setup.png` });

  await p.keyboard.press("Control+Shift+P");
  await p.keyboard.type("New Task");
  await p.keyboard.press("Enter");
  const verify = p.locator('textarea[name="verify"]');
  await verify.waitFor();
  await p.waitForFunction(() => (document.querySelector<HTMLTextAreaElement>('textarea[name="verify"]')?.value ?? "") === "npm test");
});
