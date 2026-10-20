/**
 * Screenshots of the running IDE for design review. Starts a real server on the demo fixture, signs in, opens a file,
 * and captures a few states at several window sizes.  node scripts/shots.ts <outdir> [label]
 */
import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { chromium } from "playwright-core";
import { testServer } from "../test/collab-helpers.ts";
import { SHOP_FILES, seed } from "../test/e2e/fixture.ts";

const out = resolve(process.argv[2] ?? "shots");
const label = process.argv[3] ?? "now";
mkdirSync(out, { recursive: true });
const STATIC = resolve(import.meta.dirname, "../ide/web/out");
const { server } = await testServer(SHOP_FILES, { staticDir: STATIC });
seed(server);
import type { Page } from "playwright-core";
const palette = async (p: Page, cmd: string) => {
  await p.keyboard.press("Control+Shift+P");
  await p.keyboard.type(cmd);
  await p.keyboard.press("Enter");
};
const extra: Record<string, (p: Page) => Promise<void>> = {
  attention: (p) => p.getByTestId("attention").click(),
  tasks: async (p) => (await p.keyboard.press("Escape"), await palette(p, "Relay Tasks")),
  task: (p) => p.getByTestId("task-T-api").click(),
  agents2: (p) => palette(p, "Agents"),
  problems: (p) => palette(p, "Problems"),
  scm: (p) => palette(p, "Source Control"),
  people: (p) => palette(p, "People"),
};
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
try {
  for (const [w, h] of [[1440, 900], [1100, 720], [820, 640]] as const) {
    const { token } = server.members.invite(`Maya${w}`, "owner");
    const page = await (await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })).newPage();
    await page.goto(`${server.url}/join#${token}`);
    await page.waitForURL(`${server.url}/`);
    await page.getByTestId("empty-editor").waitFor();
    await page.screenshot({ path: join(out, `${label}-${w}-empty.png`) });
    await page.getByTestId("file-src/ui.js").click().catch(() => {});
    await page.locator(".cm-content").waitFor({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(out, `${label}-${w}-file.png`) });
    if (w === 1440) {
      for (const [name, act] of Object.entries(extra)) {
        await act(page).catch((e) => console.log(name, String(e).slice(0, 200)));
        await page.waitForTimeout(500);
        await page.screenshot({ path: join(out, `${label}-${w}-${name}.png`) });
      }
    }
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
