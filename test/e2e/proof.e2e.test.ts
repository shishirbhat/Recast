/**
 * Proof and failures in the browser IDE's task view, in a real browser: the changeset downloads and says which checks
 * ran on exactly this change; a failing check is rerun on its exact files (reproduced) and an investigation starts
 * from it; viewers see why they can't. Agents are simulated. Skipped unless RELAY_E2E=1.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import { COMPATIBLE, twoAgentTasks } from "../together-fixture.ts";
import { verifyChangeset } from "../../src/analysis/changeset.ts";

const STATIC = resolve(import.meta.dirname, "../../ide/web/out");
const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const SHOTS = process.env.RELAY_SHOTS;
const skip = process.env.RELAY_E2E !== "1" || !existsSync(STATIC);
let s: Awaited<ReturnType<typeof twoAgentTasks>>;
let browser: Browser;

before(async () => {
  if (skip) return;
  // T-ui follows a rename that T-api's worktree doesn't have: T-ui's own check fails there.
  s = await twoAgentTasks(COMPATIBLE, undefined, { staticDir: STATIC });
  browser = await chromium.launch({ executablePath: CHROME });
});
after(async () => {
  if (skip) return;
  await browser.close();
  await s.server.close();
});

async function openTask(role: "owner" | "viewer", id: string): Promise<Page> {
  const { token } = s.server.members.invite(`${role} ${Math.random().toString(36).slice(2, 5)}`, role);
  const p = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })).newPage();
  await p.goto(`${s.server.url}/join#${token}`);
  await p.waitForURL(`${s.server.url}/`);
  await p.getByTestId("activity-relay").click();
  await p.getByTestId(`task-${id}`).click();
  await p.getByTestId("proof").locator("summary").click();
  await p.getByTestId("proof-checks").waitFor({ timeout: 30_000 });
  return p;
}

test("a failing agent check: rerun on the same files reproduces it, an investigation starts from it, the changeset downloads", { skip, timeout: 120_000 }, async () => {
  const p = await openTask("owner", "T-ui");
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(e.message));
  assert.match(await p.getByTestId("proof-checks").innerText(), /✕ node --test src\/ui\.test\.js on exactly this change/);
  const f = p.getByTestId("failure");
  await f.getByTestId("reproducibility").waitFor();
  assert.match(await f.getByTestId("reproducibility").innerText(), /Failing: greets the user by name\. Reproducibility: not rerun yet\./);
  await f.getByRole("button", { name: "Rerun on the same files" }).click();
  await p.getByTestId("toast").filter({ hasText: "reproduced on the same files" }).waitFor({ timeout: 60_000 });
  await f.getByTestId("reproducibility").filter({ hasText: "Reproducibility: reproduced on the same files." }).waitFor();
  await f.getByRole("button", { name: "Start investigation" }).click();
  await p.getByTestId("toast").filter({ hasText: /Started investigation INV-/ }).waitFor();
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/proof-failure.png` });

  const dl = p.waitForEvent("download");
  await p.getByRole("button", { name: "Download changeset" }).click();
  const file = await (await dl).path();
  const cs = JSON.parse(readFileSync(file!, "utf8"));
  assert.equal(cs.task.id, "T-ui");
  assert.equal(verifyChangeset(cs, s.repo).tree, "matches", "the downloaded file rebuilds to the tree it claims");
  assert.deepEqual(errors, []);
});

test("viewers can read the proof but can't rerun or investigate, and are told why", { skip, timeout: 60_000 }, async () => {
  const v = await openTask("viewer", "T-ui");
  const f = v.getByTestId("failure");
  for (const name of ["Rerun on the same files", "Start investigation"]) {
    const b = f.getByRole("button", { name });
    assert.equal(await b.isDisabled(), true);
    assert.equal(await b.getAttribute("title"), "Viewers can't run checks or start investigations");
  }
});
