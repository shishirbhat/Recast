// The composition journey in Chromium: point at a time, lift it into a capsule, add a place and a title, preview the event,
// fill in what is missing or pick between conflicting pieces, place it in the calendar, undo. Real classifier, engine,
// overlay and an in-page calendar; Google is not involved.
import { chromium, type Browser, type Page } from "playwright-core";
import AxeBuilder from "@axe-core/playwright";
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff" };
let server: Server, browser: Browser, base: string;
const chromiumPath = () => process.env.RECAST_CHROMIUM ?? (existsSync("/opt/pw-browsers/chromium") && !existsSync("/opt/pw-browsers/chromium/chrome") ? "/opt/pw-browsers/chromium" : undefined);
beforeAll(async () => {
  server = createServer((q, r) => { const u = (q.url ?? "/").split("?")[0]!; const f = path.join(dist, u === "/" ? "compose.html" : u); if (!existsSync(f)) { r.writeHead(404).end(); return; } r.writeHead(200, { "content-type": MIME[path.extname(f)] ?? "application/octet-stream" }).end(readFileSync(f)); });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch(chromiumPath() ? { executablePath: chromiumPath()! } : {});
});
afterAll(async () => { await browser?.close(); server?.close(); });

async function open(theme: "light" | "dark" = "light") {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 760 }, colorScheme: theme });
  const page = await ctx.newPage(); const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`${base}/compose.html?tz=Asia/Kolkata&theme=${theme}`);
  return { page, ctx, errors };
}
const st = (p: Page) => p.evaluate(() => (globalThis as any).__recast.state());
const ov = (p: Page, sel: string) => p.locator(`recast-overlay >> ${sel}`);
const centre = async (p: Page, sel: string) => { const b = (await p.locator(sel).boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };

/** Alt down, point at the first piece, press to lift, release over nothing: the capsule stays. */
async function startCapsule(p: Page, sel: string) {
  const c = await centre(p, sel);
  await p.keyboard.down("Alt"); await p.mouse.move(c.x, c.y);
  await p.waitForFunction(() => (globalThis as any).__recast.state().hovered, null, { timeout: 5000 });
  await p.mouse.down(); await p.mouse.up();
}
/** With Alt still held, click another piece to add it. */
async function addPiece(p: Page, sel: string) {
  const c = await centre(p, sel); await p.mouse.move(c.x, c.y, { steps: 4 });
  await ov(p, "[data-testid=capsule-outline]").waitFor({ timeout: 3000 });
  await p.mouse.down(); await p.mouse.up();
}
async function toChip(p: Page) {
  await p.keyboard.up("Alt");
  const a = (await p.locator("#agenda").boundingBox())!; await p.mouse.move(a.x + 60, a.y + 160, { steps: 6 });
  await p.waitForFunction(() => (globalThis as any).__recast.state().chips.length > 0, null, { timeout: 5000 });
  const r = await p.evaluate(() => (globalThis as any).__recast.state().chips[0].rect); await p.mouse.move(r.x + r.w / 2, r.y + r.h / 2, { steps: 4 });
  await p.waitForFunction(() => (globalThis as any).__recast.state().phase === "previewing", null, { timeout: 5000 });
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}
const placed = (p: Page) => p.locator("#agenda-list li").evaluateAll((lis) => lis.map((li) => Object.fromEntries([...li.children].map((c) => [c.className, c.textContent]))));

describe("composing an event from pieces of a chat (Chromium)", () => {
  it("time + place + title: one capsule, a preview of the event, placed on release, undone", async () => {
    const { page, ctx, errors } = await open();
    await startCapsule(page, "#when");
    expect((await st(page)).phase).toBe("carrying");
    expect(await ov(page, "[data-testid=token-pieces]").innerText()).toBe("1");
    await addPiece(page, "#where"); await addPiece(page, "#what");
    expect(await ov(page, "[data-testid=token-pieces]").innerText()).toBe("3");
    expect(await ov(page, "[data-testid=token]").innerText()).toContain("Launch dinner");
    const chip = await toChip(page);
    expect(await ov(page, "[data-testid=chip]").allInnerTexts()).toEqual(["Entry"]);
    const ghost = await ov(page, "[data-testid=ghost]").innerText();
    expect(ghost).toMatch(/title\s*Launch dinner/); expect(ghost).toMatch(/start\s*2026-11-14T19:30/); expect(ghost).toMatch(/location\s*298 100 Feet Road/);
    await page.mouse.down(); await page.mouse.up();
    await ov(page, "[data-testid=toast]").waitFor();
    expect(await placed(page)).toEqual([{ "ev-title": "Launch dinner", "ev-start": "2026-11-14T19:30", "ev-end": "2026-11-14T20:30", "ev-location": "298 100 Feet Road, Indiranagar, Bengaluru 560038", "ev-tz": "Asia/Kolkata" }]);
    await ov(page, "button:has-text('Undo')").click();
    await page.waitForFunction(() => document.querySelectorAll("#agenda-list li").length === 0, null, { timeout: 3000 });
    void chip; expect(errors).toEqual([]); await ctx.close();
  });

  it("missing title: placing asks for it in a small card; Enter continues; the typed title lands", async () => {
    const { page, ctx } = await open();
    await startCapsule(page, "#when"); await addPiece(page, "#where");
    await toChip(page);
    expect(await ov(page, "[data-testid=ghost]").innerText()).toMatch(/title\s*needed/);
    await page.mouse.down(); await page.mouse.up();
    await ov(page, "[data-testid=completion]").waitFor();
    expect(await ov(page, "[data-testid=complete]").isDisabled()).toBe(true);
    expect(await ov(page, "[data-testid=assumptions]").innerText()).toMatch(/Ends after 60 minutes/);
    await ov(page, "[data-testid=answer-title]").fill("Dinner with Meera");
    expect(await ov(page, "[data-testid=complete]").isDisabled()).toBe(false);
    await ov(page, "[data-testid=answer-title]").press("Enter");
    await ov(page, "[data-testid=toast]").waitFor();
    expect((await placed(page))[0]).toMatchObject({ "ev-title": "Dinner with Meera", "ev-start": "2026-11-14T19:30" });
    await ctx.close();
  });

  it("two different times: the card shows both, never picks one; choosing and continuing places the chosen one", async () => {
    const { page, ctx } = await open();
    await startCapsule(page, "#when"); await addPiece(page, "#when2"); await addPiece(page, "#what");
    await toChip(page); await page.mouse.down(); await page.mouse.up();
    await ov(page, "[data-testid=completion]").waitFor();
    expect(await ov(page, "[data-testid=choice]").allInnerTexts()).toEqual(["2026-11-14", "2026-11-15"]);
    await ov(page, "[data-testid=choice] >> text=2026-11-15").click();
    await ov(page, "[data-testid=complete]").click();
    await ov(page, "[data-testid=toast]").waitFor();
    expect((await placed(page))[0]).toMatchObject({ "ev-start": "2026-11-15T19:30" });
    await ctx.close();
  });

  it("Escape in the card cancels: nothing is written and nothing is left on screen", async () => {
    const { page, ctx } = await open();
    await startCapsule(page, "#when"); await toChip(page); await page.mouse.down(); await page.mouse.up();
    await ov(page, "[data-testid=completion]").waitFor();
    await page.keyboard.press("Escape");
    await ov(page, "[data-testid=completion]").waitFor({ state: "detached" });
    expect(await placed(page)).toEqual([]); expect((await st(page)).capsule).toBeNull();
    expect(await ov(page, "[data-testid=token]").count()).toBe(0);
    await ctx.close();
  });

  it("keyboard only: Space adds pieces, Enter finishes, Enter places", async () => {
    const { page, ctx } = await open();
    await page.keyboard.press("Control+Shift+L");
    await page.waitForFunction(() => (globalThis as any).__recast.state().candidates.length >= 4, null, { timeout: 5000 });
    const tabTo = async (text: string) => { for (let i = 0; i < 10; i++) { const s = await st(page); if (s.hovered?.fragment?.text === text) return; await page.keyboard.press("Tab"); } throw new Error(`never reached ${text}`); };
    await tabTo("Sat 14 Nov 2026, 7:30 pm"); await page.keyboard.press(" ");
    await tabTo("298 100 Feet Road, Indiranagar, Bengaluru 560038"); await page.keyboard.press(" ");
    await tabTo("Launch dinner"); await page.keyboard.press(" ");
    expect((await st(page)).capsule.fragments).toHaveLength(3);
    await page.keyboard.press("Enter");
    expect((await st(page)).phase).toBe("previewing");
    await page.keyboard.press("Enter");
    await ov(page, "[data-testid=toast]").waitFor();
    expect((await placed(page))[0]).toMatchObject({ "ev-title": "Launch dinner" });
    await ctx.close();
  });

  for (const theme of ["light", "dark"] as const) it(`axe: carrying a capsule and the completion card have no serious or critical issues (${theme})`, async () => {
    const { page, ctx } = await open(theme);
    await startCapsule(page, "#when"); await addPiece(page, "#where");
    const scan = async () => (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id);
    expect(await scan()).toEqual([]);
    await toChip(page); await page.mouse.down(); await page.mouse.up(); await ov(page, "[data-testid=completion]").waitFor();
    expect(await scan()).toEqual([]);
    await ctx.close();
  });
});
