/**
 * The browser IDE's "Check with …" on a coupled agent task, in a real browser: the combined check runs on the server,
 * the panel says it is not ready to integrate, shows the failing check, and the evidence-based cause, with no approve
 * button, and the shared project is unchanged. Agents are simulated. Skipped unless RELAY_E2E=1.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";
import { BREAKING, projectState, twoAgentTasks } from "../together-fixture.ts";

const STATIC = resolve(import.meta.dirname, "../../ide/web/out");
const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const skip = process.env.RELAY_E2E !== "1" || !existsSync(STATIC);
let s: Awaited<ReturnType<typeof twoAgentTasks>>;
let browser: Browser;

before(async () => {
  if (skip) return;
  s = await twoAgentTasks(BREAKING, undefined, { staticDir: STATIC });
  browser = await chromium.launch({ executablePath: CHROME });
});
after(async () => {
  if (skip) return;
  await browser.close();
  await s.server.close();
});

test("Check with partners: blocked, the failing check and the confirmed cause are shown, nothing to approve, nothing applied", { skip, timeout: 90_000 }, async () => {
  const before = projectState(s.repo);
  const { token } = s.server.members.invite("Ola", "owner");
  const p = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${s.server.url}/join#${token}`);
  await p.waitForURL(`${s.server.url}/`);
  await p.getByTestId("activity-relay").click();
  await p.getByTestId("task-T-ui").click();
  await p.getByRole("button", { name: /Check with T-api/ }).click();
  const x = p.getByTestId("integration-explanation");
  await x.waitFor({ timeout: 30_000 });
  const text = await x.innerText();
  assert.match(text, /^Cause \(confirmed\): T-api changed getUser in src\/server\.js/);
  assert.match(text, /T-ui still reads `name` from getUser\(\) at src\/ui\.js:4/);
  assert.match(await p.getByText("Not ready to integrate").innerText(), /Not ready to integrate/);
  assert.equal(await p.getByRole("button", { name: /Approve all/ }).count(), 0, "a blocked check offers no approval");
  await x.getByText("Evidence").click();
  assert.match(await x.innerText(), /src\/ui\.js:4 reads \.name, which getUser\(\) no longer returns/);
  assert.equal(projectState(s.repo), before);
  assert.deepEqual(errors, []);
});
