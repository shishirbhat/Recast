/**
 * Screenshots of a theme, in a real browser against a real server: editor with a collaborator, command palette,
 * coordination. Usage: node scripts/theme-shots.ts <theme: dark|light|oled> <out-dir>
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { testServer } from "../test/collab-helpers.ts";
import { SHOP_FILES, seed } from "../test/e2e/fixture.ts";

const theme = process.argv[2] ?? "oled";
const out = resolve(process.argv[3] ?? `docs/evidence/${theme}`);
mkdirSync(out, { recursive: true });
const { server } = await testServer(SHOP_FILES, { staticDir: resolve(import.meta.dirname, "../ide/web/out") });
seed(server);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
try {
  const open = async (name: string) => {
    const { token } = server.members.invite(name, "owner");
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme === "light" ? "light" : "dark" });
    await ctx.addInitScript((t) => localStorage.setItem("relay.theme", t), theme);
    const p = await ctx.newPage();
    await p.goto(`${server.url}/join#${token}`);
    await p.waitForURL(`${server.url}/`);
    await p.getByTestId("welcome").waitFor();
    await p.getByTestId("file-src/ui.js").click();
    await p.waitForFunction(() => (document.querySelector(".cm-content")?.textContent ?? "").length > 0);
    return p;
  };
  const maya = await open("Maya");
  const bo = await open("Bo");
  await bo.locator(".cm-line").nth(5).click();
  await bo.keyboard.press("End");
  await bo.keyboard.type(" // Bo is here");
  await maya.locator(".cm-line").nth(3).click();
  await maya.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("Bo is here"));
  await maya.waitForTimeout(400);
  await maya.screenshot({ path: join(out, `01-editor-${theme}.png`) });
  await maya.keyboard.press("Control+Shift+P");
  await maya.keyboard.type("theme");
  await maya.waitForTimeout(200);
  await maya.screenshot({ path: join(out, `02-palette-${theme}.png`) });
  await maya.keyboard.press("Escape");
  await maya.keyboard.press("Control+Alt+C");
  await maya.getByTestId("coord-answers").waitFor();
  await maya.waitForTimeout(300);
  await maya.screenshot({ path: join(out, `03-coordination-${theme}.png`) });
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
  await server.close();
}
