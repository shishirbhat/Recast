/**
 * Screenshots of the collaboration-reliability behaviour, in a real browser against a real server, for the evidence
 * folder: an unconfirmed edit on a dead connection, recovery, a line's history, and an agent change refused because the
 * project moved since its verification. Usage: THEME=dark|light node scripts/reliability-shots.ts <out-dir>
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Page } from "playwright-core";
import { testServer, until } from "../test/collab-helpers.ts";
import { SHOP_FILES } from "../test/e2e/fixture.ts";
import { HUMAN } from "../test/helpers.ts";
import { partitionable } from "../test/e2e/net.ts";

const out = resolve(process.argv[2] ?? "docs/evidence/reliability-2026-10-22");
const theme = process.env.THEME === "dark" ? "dark" : "light";
mkdirSync(out, { recursive: true });
process.env.RELAY_SIM_EDITS = JSON.stringify({ "T-readme": { "README.md": [["A tiny shop", "A tiny corner shop"]] } });
process.env.RELAY_SIM_DELAY_MS = "200";
const { server } = await testServer(SHOP_FILES, { staticDir: resolve(import.meta.dirname, "../ide/web/out"), claudeBin: resolve(import.meta.dirname, "../test/fixtures/simulated-agent") });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const shot = (p: Page, name: string) => p.screenshot({ path: join(out, `${name}-${theme}.png`) });

async function signIn(name: string, net?: (p: Page) => Promise<void>) {
  const { token, member } = server.members.invite(name, "owner");
  const p = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme })).newPage();
  if (net) await net(p);
  await p.goto(`${server.url}/join#${token}`);
  await p.waitForURL(`${server.url}/`);
  await p.getByTestId("welcome").waitFor();
  return { p, member };
}

try {
  // 1–2. A dead connection: the status bar stops saying Synced, then recovers once the edit is saved.
  let net!: Awaited<ReturnType<typeof partitionable>>;
  const { p: maya } = await signIn("Maya", async (pg) => void (net = await partitionable(pg)));
  await maya.getByTestId("file-src/ui.js").click();
  await maya.waitForFunction(() => (document.querySelector(".cm-content")?.textContent ?? "").length > 0);
  await maya.locator(".cm-line").nth(3).click();
  await maya.keyboard.press("End");
  net.cut();
  await maya.keyboard.type(" // typed on a dead connection");
  await maya.waitForFunction(() => document.querySelector("[data-testid=sync-status]")?.textContent === "Not saved yet", null, { timeout: 8000 });
  await shot(maya, "01-not-saved-yet");
  await net.heal();
  await until(() => server.docs.open("src/ui.js").text.toString().includes("typed on a dead connection"), 10000, "the edit saved after recovery");
  await maya.waitForFunction(() => document.querySelector("[data-testid=sync-status]")?.textContent === "Synced", null, { timeout: 8000 });
  await shot(maya, "02-synced-after-recovery");

  // 3. Line history: two people on one line, each part with its author, time and session.
  const { member: bo } = await signIn("Bo");
  const text = server.docs.open("src/ui.js").text.toString();
  const at = text.indexOf("typed on a dead connection") + "typed on a dead connection".length;
  server.docs.applyEdits("src/ui.js", [{ from: at, to: at, insert: ", reviewed by Bo" }], `member:${bo.id}`);
  await maya.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("reviewed by Bo"), null, { timeout: 5000 });
  await maya.locator(".cm-line").nth(3).click();
  await maya.getByTestId("status-line-author").click();
  await maya.getByTestId("line-history").waitFor();
  await maya.waitForFunction(() => document.querySelectorAll("[data-testid=line-origin]").length >= 2, null, { timeout: 5000 });
  await shot(maya, "03-line-history");

  // 4. An agent change verified on its own copy, refused because the project changed since: the merged result fails.
  server.relay.createTask({ id: "T-readme", objective: "Describe the shop in the README", scope: ["README.md"], verify: ["node --test"] }, HUMAN);
  server.relay.transition("T-readme", "queued", HUMAN);
  await server.runs.start("T-readme", server.members.invite("Olu", "owner").member);
  await until(() => server.runs.forTask("T-readme").at(-1)?.status === "finished" && !server.runs.forTask("T-readme").at(-1)!.checking, 30000, "the agent run and Relay's checks");
  const ui = server.docs.open("src/ui.js").text.toString();
  const w = ui.indexOf("Welcome back");
  server.docs.applyEdits("src/ui.js", [{ from: w, to: w + "Welcome back".length, insert: "Hi again" }], `member:${bo.id}`);
  await maya.getByTestId("line-history").getByRole("button", { name: "Close" }).click();
  await maya.keyboard.press("Control+Alt+C");
  await maya.getByTestId("coord-task-T-readme").getByRole("button", { name: "Apply to project" }).click();
  await maya.getByTestId("integrate-confirm").getByRole("button", { name: "Confirm" }).click();
  await maya.getByTestId("toast").filter({ hasText: "didn't pass" }).waitFor({ timeout: 30000 });
  await shot(maya, "04-apply-refused-merged-check");
  console.log(`wrote ${out}/*-${theme}.png`);
} finally {
  await browser.close();
  await server.close();
}
