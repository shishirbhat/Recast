/**
 * The flight recorder and the attention inbox's seen marks, in a real browser. Agents are simulated. Skipped unless
 * RELAY_E2E=1.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import { BREAKING, twoAgentTasks } from "../together-fixture.ts";
import { api, join as joinAs } from "../collab-helpers.ts";

const STATIC = resolve(import.meta.dirname, "../../ide/web/out");
const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const SHOTS = process.env.RELAY_SHOTS;
const skip = process.env.RELAY_E2E !== "1" || !existsSync(STATIC);
let s: Awaited<ReturnType<typeof twoAgentTasks>>;
let browser: Browser;

before(async () => {
  if (skip) return;
  s = await twoAgentTasks(BREAKING, undefined, { staticDir: STATIC });
  const own = await joinAs(s.server, "Setup", "owner");
  await api(s.server, own.cookie, "POST", "/api/integrations/check", { tasks: ["T-api", "T-ui"] });
  browser = await chromium.launch({ executablePath: CHROME });
});
after(async () => {
  if (skip) return;
  await browser.close();
  await s.server.close();
});

async function signIn(name: string): Promise<Page> {
  const { token } = s.server.members.invite(name, "owner");
  const p = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await p.goto(`${s.server.url}/join#${token}`);
  await p.waitForURL(`${s.server.url}/`);
  await p.getByTestId("welcome").waitFor();
  return p;
}

test("flight recorder: the project's history newest first, searchable, filterable by kind and task", { skip, timeout: 90_000 }, async () => {
  const p = await signIn("Ada");
  await p.keyboard.press("Control+Shift+P");
  await p.keyboard.type("Show Flight Recorder");
  await p.keyboard.press("Enter");
  const entries = p.getByTestId("timeline-entry");
  await entries.first().waitFor();
  const all = await p.getByTestId("timeline-entries").innerText();
  assert.match(all, /Checked T-api, T-ui together: blocked \(cause confirmed\)/);
  assert.match(all, /Agent \(claude-code\) started from snapshot/);
  await p.getByRole("button", { name: "Agents", exact: true }).click();
  await p.waitForFunction(() => [...document.querySelectorAll("[data-testid=timeline-entry]")].every((e) => e.getAttribute("data-kind") === "agent"));
  await p.getByRole("button", { name: "Agents", exact: true }).click();
  await p.getByTestId("timeline-search").fill("together");
  await p.waitForFunction(() => {
    const rows = [...document.querySelectorAll("[data-testid=timeline-entry]")];
    return rows.length > 0 && rows.every((e) => /together/i.test(e.textContent ?? ""));
  });
  await p.getByTestId("timeline-search").fill("");
  await p.getByTestId("timeline-task").fill("T-ui");
  // The task's own history: its creation, its agent run and the combined check that named it, and nothing of T-api's alone.
  await p.waitForFunction(() => {
    const rows = [...document.querySelectorAll("[data-testid=timeline-entry]")].map((e) => e.textContent ?? "");
    return rows.length > 5 && rows.every((t) => t.includes("T-ui")) && rows.some((t) => t.includes("Task created")) && rows.some((t) => t.includes("Checked T-api, T-ui together"));
  });
  assert.match(await p.getByTestId("timeline-entries").innerText(), /Checked T-api, T-ui together: blocked \(cause confirmed\)\nRelay\n/);
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/flight-recorder.png` });
});

test("needs-you: marking an item seen moves it out of the count for this person only, and it can be unmarked", { skip, timeout: 60_000 }, async () => {
  const p = await signIn("Bo");
  const button = p.getByTestId("attention");
  await p.waitForFunction(() => /need/.test(document.querySelector("[data-testid=attention]")?.textContent ?? ""));
  const before = Number(/(\d+)/.exec(await button.innerText())![1]);
  await button.click();
  const radar = p.getByTestId("attention-item").filter({ hasText: "T-api changed getUser()" });
  assert.match(await radar.innerText(), /Confirmed by checking them together|Known:/);
  assert.match(await radar.innerText(), /Owners integrate this work/);
  await radar.getByRole("button", { name: "Mark seen" }).click();
  await p.waitForFunction((n) => (document.querySelector("[data-testid=attention]")?.textContent ?? "").includes(n === 1 ? "All clear" : `${n - 1} need`), before);
  await p.getByTestId("attention-seen-toggle").click();
  const seen = p.locator('[data-testid="attention-item"][data-seen="true"]');
  assert.equal(await seen.count(), 1);
  await seen.getByRole("button", { name: "Mark unseen" }).click();
  await p.waitForFunction((n) => (document.querySelector("[data-testid=attention]")?.textContent ?? "").includes(`${n} need`), before);
  // Another owner's inbox is untouched by Bo's marks.
  const ada = await signIn("Cy");
  await ada.waitForFunction((n) => (document.querySelector("[data-testid=attention]")?.textContent ?? "").includes(`${n} need`), before);
});
