/**
 * Conflict Radar in the browser IDE, in a real browser: an agent changed an interface another task still reads. The
 * radar shows it collapsed as one line marked Suspected, its evidence on request, and Check Together runs the real
 * combined check from the alert (owners and editors; viewers see why they can't). The ownership map lists both files.
 * Agents are simulated. Skipped unless RELAY_E2E=1.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import { BREAKING, projectState, twoAgentTasks } from "../together-fixture.ts";

const STATIC = resolve(import.meta.dirname, "../../ide/web/out");
const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const SHOTS = process.env.RELAY_SHOTS;
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

async function as(role: "owner" | "viewer", theme: "dark" | "light" = "dark"): Promise<Page> {
  const { token } = s.server.members.invite(`${role} ${Math.random().toString(36).slice(2, 5)}`, role);
  const p = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme })).newPage();
  await p.goto(`${s.server.url}/join#${token}`);
  await p.waitForURL(`${s.server.url}/`);
  await p.getByTestId("activity-coordination").click();
  await p.getByTestId("radar-alert").first().waitFor({ timeout: 30_000 });
  return p;
}

test("the radar shows a suspected interface break with its evidence; Check Together from the alert runs the real check", { skip, timeout: 120_000 }, async () => {
  const before = projectState(s.repo);
  const p = await as("owner");
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(e.message));
  const alert = p.locator('[data-testid="radar-alert"][data-kind="interface-changed"]');
  assert.equal(await alert.count(), 1);
  assert.equal(await alert.getAttribute("data-certainty"), "suspected");
  assert.match(await alert.innerText(), /T-api changed getUser\(\); T-ui's src\/ui\.js still reads \.name\s+Suspected\s+High/);
  assert.equal(await alert.getByTestId("radar-evidence").isVisible(), false, "evidence is collapsed until asked for");
  await alert.locator("summary").click();
  const ev = await alert.getByTestId("radar-evidence").innerText();
  assert.match(ev, /static analysis\s+src\/ui\.js:\d+ reads \.name from getUser\(\)/);
  assert.match(ev, /agent run\s+T-api's agent changed src\/server\.js: getUser no longer returns name/);
  if (SHOTS) (mkdirSync(SHOTS, { recursive: true }), await p.screenshot({ path: `${SHOTS}/radar-dark.png`, fullPage: false }));

  // Ownership map: both files, the scope owner and the agent that changed each.
  await p.getByTestId("ownership").locator("summary").click();
  assert.match(await p.getByTestId("owned-src/ui.js").innerText(), /T-ui[\s\S]*agent claude-code/);

  await alert.getByRole("button", { name: "Check T-api and T-ui together" }).click();
  await p.getByTestId("toast").filter({ hasText: "are blocked together" }).waitFor({ timeout: 60_000 });
  // The real check settles what was suspected: the alert now says Known, with the check as evidence.
  await p.locator('[data-testid="radar-alert"][data-kind="interface-changed"][data-certainty="known"]').waitFor({ timeout: 15_000 });
  assert.match(await alert.getByTestId("radar-evidence").innerText(), /Relay's records\s+Checked together .*: blocked/);
  assert.equal(projectState(s.repo), before, "the check applies nothing");
  assert.deepEqual(errors, []);
});

test("viewers see the radar but its checks are disabled with the reason", { skip, timeout: 60_000 }, async () => {
  const v = await as("viewer", "light");
  const alert = v.locator('[data-testid="radar-alert"][data-kind="interface-changed"]');
  await alert.locator("summary").click();
  const btn = alert.getByRole("button", { name: "Check T-api and T-ui together" });
  assert.equal(await btn.isDisabled(), true);
  assert.equal(await btn.getAttribute("title"), "Viewers can't run checks");
  assert.match(await alert.innerText(), /Viewers can't run checks/);
  if (SHOTS) await v.screenshot({ path: `${SHOTS}/radar-light-viewer.png`, fullPage: false });
});
