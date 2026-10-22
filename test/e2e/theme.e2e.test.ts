/**
 * Themes in a real browser: OLED Black turns every surface pure black (title bar, sidebar, editor, panels, status bar,
 * menus) while text stays readable, and the choice survives a reload. Skipped unless RELAY_E2E=1.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import { testServer } from "../collab-helpers.ts";
import type { RelayServer } from "../../src/server/server.ts";

const RUN = process.env.RELAY_E2E === "1";
const STATIC = resolve(import.meta.dirname, "../../ide/web/out");
const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const skip = !RUN || !existsSync(STATIC);
let server: RelayServer;
let browser: Browser;

before(async () => {
  if (skip) return;
  ({ server } = await testServer({ "src/app.js": "export const a = 1;\n" }, { staticDir: STATIC }));
  browser = await chromium.launch({ executablePath: CHROME });
});
after(async () => {
  if (skip) return;
  await browser.close();
  await server.close();
});

const bg = (p: Page, selector: string) => p.locator(selector).first().evaluate((el) => getComputedStyle(el).backgroundColor);

test("OLED Black: every surface is pure black, text stays readable, and the choice is remembered", { skip }, async () => {
  const { token } = server.members.invite("Ada", "owner");
  const p = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" })).newPage();
  await p.goto(`${server.url}/join#${token}`);
  await p.waitForURL(`${server.url}/`);
  await p.getByTestId("welcome").waitFor();
  await p.getByTestId("file-src/app.js").click();
  await p.waitForFunction(() => (document.querySelector(".cm-content")?.textContent ?? "").length > 0);

  // Pick it the way a person would: Color Theme… in the palette.
  await p.keyboard.press("Control+Shift+P");
  await p.keyboard.type("Color Theme");
  await p.keyboard.press("Enter");
  await p.getByRole("option", { name: "Relay OLED Black" }).click();
  await p.waitForFunction(() => document.documentElement.dataset.theme === "oled");

  const black = "rgb(0, 0, 0)";
  for (const [what, sel] of [
    ["page", "body"],
    ["title bar", "header"],
    ["status bar", "footer[aria-label='Status bar']"],
    ["editor", ".cm-editor"],
    ["sidebar", "[data-testid='primary-sidebar']"],
    ["editor tabs", "[role='tablist']"],
  ] as const) {
    // A transparent element shows what's behind it; walk up to the first painted ancestor.
    const color = await p.locator(sel).first().evaluate((el) => {
      let e: Element | null = el;
      while (e) {
        const c = getComputedStyle(e).backgroundColor;
        if (c !== "rgba(0, 0, 0, 0)" && c !== "transparent") return c;
        e = e.parentElement;
      }
      return "none";
    });
    assert.equal(color, black, `${what} is pure black`);
  }
  // Text keeps Dark's colours, so it stays readable.
  const ink = await p.locator(".cm-content").evaluate((el) => getComputedStyle(el).color);
  assert.notEqual(ink, black);
  // Menus too.
  await p.getByRole("menuitem", { name: "File" }).click();
  const menu = await bg(p, "[role='menu']");
  assert.equal(menu, black, "menus are pure black");
  await p.keyboard.press("Escape");

  await p.reload();
  await p.getByTestId("welcome").waitFor();
  assert.equal(await p.evaluate(() => document.documentElement.dataset.theme), "oled", "remembered after a reload");
  // Ctrl+Alt+T switches to Light, and back to Dark.
  await p.keyboard.press("Control+Alt+T");
  await p.waitForFunction(() => document.documentElement.dataset.theme === "light");
});
