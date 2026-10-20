// The clay page in Chromium: carry Maya from one tab to another, press her into the restaurant, press a time in, carry the
// object to a calendar slot, review, place, undo. Mouse, keyboard only, touch (long press), reduced motion, refusals,
// taking an ingredient out, and a calendar that does not answer. The calendar is an in-page stand-in.
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
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
  server = createServer((q, r) => { const u = (q.url ?? "/").split("?")[0]!; const f = path.join(dist, u === "/" ? "clay.html" : u); if (!existsSync(f)) { r.writeHead(404).end(); return; } r.writeHead(200, { "content-type": MIME[path.extname(f)] ?? "application/octet-stream" }).end(readFileSync(f)); });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch(chromiumPath() ? { executablePath: chromiumPath()! } : {});
});
afterAll(async () => { await browser?.close(); server?.close(); });

// Monday 19 Oct 2026, 09:00 UTC: "Friday" is the 23rd, and so is the calendar's first slot.
const Q = "now=2026-10-19T09:00:00Z&tz=Asia/Kolkata";
async function open(o: { theme?: "light" | "dark"; phone?: boolean; motion?: "reduce" } = {}): Promise<{ page: Page; ctx: BrowserContext; errors: string[] }> {
  const ctx = await browser.newContext({
    ...(o.phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { viewport: { width: 1200, height: 800 } }),
    colorScheme: o.theme ?? "light", timezoneId: "Asia/Kolkata", ...(o.motion ? { reducedMotion: o.motion } : {}),
  });
  const page = await ctx.newPage(); const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`${base}/clay.html?${Q}`);
  return { page, ctx, errors };
}
const st = (p: Page) => p.evaluate(() => (globalThis as any).recast.state);
const centre = async (p: Page, sel: string) => { const b = (await p.locator(sel).first().boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
const objectSel = (id: string) => `.clay-item[data-id="${id}"]`;
const settled = (p: Page) => p.waitForFunction(() => { const s = (globalThis as any).recast.state; return s.phase !== "merging" && s.phase !== "executing"; });

/** Press on a piece or object, travel (optionally pausing over a tab to open it), and let go over a target. */
/** Objects spring into place; press one only once it has come to rest, as a person would. */
async function atRest(p: Page, sel: string) {
  let prev = ""; for (let i = 0; i < 40; i++) { const b = await p.locator(sel).first().boundingBox(); const k = JSON.stringify(b); if (k === prev) return; prev = k; await p.waitForTimeout(60); }
}
async function drag(p: Page, from: string, to: string, via?: string) {
  await atRest(p, from); const a = await centre(p, from); await p.mouse.move(a.x, a.y); await p.mouse.down();
  await p.mouse.move(a.x + 12, a.y + 12, { steps: 3 });
  if (via) { const t = await centre(p, via); await p.mouse.move(t.x, t.y, { steps: 6 }); await p.waitForFunction((v) => document.querySelector(v)!.getAttribute("aria-selected") === "true", via, { timeout: 3000 }); }
  const b = await centre(p, to); await p.mouse.move(b.x, b.y, { steps: 8 }); await p.mouse.move(b.x + 1, b.y, { steps: 1 });
  await p.mouse.up(); await settled(p);
}

/** Maya pressed into Dakshin across tabs, then the time pressed into that object. Returns the object's id. */
async function makeDinner(p: Page) {
  await drag(p, "#maya", "#dakshin", "#tab-restaurant");
  let s = await st(p); expect(s.desk).toHaveLength(1);
  const id = s.desk[0];
  await drag(p, "#dakshin-time", objectSel(id));
  s = await st(p); expect(s.desk).toEqual([id]);
  return id as string;
}

describe("pressing pieces into one object (mouse)", () => {
  it("Maya, carried to another tab and pressed into the restaurant, becomes one object; a time joins it", async () => {
    const { page, ctx, errors } = await open();
    const id = await makeDinner(page);
    const s = await st(page);
    expect(s.objects[id].ingredients.map((f: any) => [f.kind, f.text, f.source.title])).toEqual([["place", "Dakshin", "Dakshin · Restaurant"], ["person", "Maya Rao", "Maya Rao · Profile"], ["time", "Friday, 7:30 PM", "Dakshin · Restaurant"]]);
    // One blob on screen, labelled as the composition, showing it is made of three pieces.
    await expect.poll(() => page.locator(".clay-item").count()).toBe(1);
    const label = page.locator(objectSel(id));
    expect(await label.getAttribute("aria-label")).toBe("Meet Maya at Dakshin, Maya Rao · Dakshin · Fri, 23 Oct, 7:30 PM, made of 3 pieces");
    expect(await label.getAttribute("class")).toContain("composed");
    expect(await page.locator("#hint").innerText()).toBe("Now one object: Meet Maya at Dakshin");
    expect(errors).toEqual([]);
    await ctx.close();
  });
  it("carried to a calendar slot it opens a review; nothing is added until confirmed; then undo removes it", async () => {
    const { page, ctx, errors } = await open();
    const id = await makeDinner(page);
    await drag(page, objectSel(id), "[data-slot='fri-1930']", "#tab-calendar");
    expect((await st(page)).phase).toBe("previewing");
    expect(await page.locator("#sheet-title").innerText()).toBe("Add to Calendar?");
    expect(await page.locator("[data-placed='event']").count()).toBe(0);
    expect(await page.locator("#sheet-body").innerText()).toMatch(/Title[\s\S]*nothing captured reads as a title/);
    await page.getByRole("button", { name: "Use “Meet Maya at Dakshin”" }).click();
    const body = await page.locator("#sheet-body").innerText();
    expect(body).toMatch(/Where\s*Dakshin, 12 MG Road, Bengaluru\s*from the page/); expect(body).toMatch(/Notes\s*With Maya Rao\s*from the page/); expect(body).toMatch(/Title\s*Meet Maya at Dakshin\s*you/);
    await page.getByRole("button", { name: "Add to calendar" }).click();
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "succeeded");
    expect(await page.locator("#sheet-title").innerText()).toBe("Added to Calendar");
    expect(await page.locator("[data-slot='fri-1930'] [data-placed='event']").innerText()).toBe("Meet Maya at Dakshin · Dakshin");
    await page.getByRole("button", { name: "Undo" }).click();
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "idle");
    expect(await page.locator("[data-placed='event']").count()).toBe(0);
    expect(errors).toEqual([]); await ctx.close();
  });
  it("a gift card won't combine: the reason is shown, and both objects stay whole", async () => {
    const { page, ctx } = await open();
    await drag(page, "#maya", "#dakshin", "#tab-restaurant");
    const before = await st(page); const target = before.desk[0];
    const a = await centre(page, "#giftcard"); await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(a.x + 10, a.y + 10, { steps: 3 });
    const b = await centre(page, objectSel(target)); await page.mouse.move(b.x, b.y, { steps: 6 });
    expect(await page.locator("#hint").innerText()).toMatch(/^Won't combine: Gift card · ₹2,000 can be carried and placed on its own/);
    expect(await page.locator(objectSel(target)).getAttribute("class")).toContain("mode-refuses");
    await page.mouse.up(); await settled(page);
    const s = await st(page); expect(s.desk).toHaveLength(2); expect(s.objects[target].ingredients).toHaveLength(2);
    await ctx.close();
  });
  it("opening an object shows each ingredient and where it came from; taking one out gives it back", async () => {
    const { page, ctx } = await open();
    const id = await makeDinner(page);
    await page.locator(objectSel(id)).click();
    expect(await page.locator(".ingredients").innerText()).toMatch(/person\s*Maya Rao\s*from Maya Rao · Profile/i);
    await page.getByRole("button", { name: "Take Maya Rao out" }).click();
    const s = await st(page); expect(s.desk).toHaveLength(2); expect(s.objects[id].ingredients.map((f: any) => f.text)).toEqual(["Dakshin", "Friday, 7:30 PM"]);
    expect(await page.locator("#sheet-title").innerText()).toBe("Meet at Dakshin (proposed)");
    await ctx.close();
  });
  it("when the calendar does not answer, Recast asks it instead of adding twice", async () => {
    const { page, ctx } = await open();
    const id = await makeDinner(page);
    await page.locator("#tab-calendar").click(); await page.locator("#silent").check();
    await drag(page, objectSel(id), "[data-slot='fri-1930']");
    await page.getByRole("button", { name: "Use “Meet Maya at Dakshin”" }).click();
    await page.getByRole("button", { name: "Add to calendar" }).click();
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "unknown");
    expect(await page.locator("#sheet-body").innerText()).toMatch(/did not answer in time\. It may or may not have been added\. Recast does not send it again/);
    await page.getByRole("button", { name: "Check the calendar" }).click();
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "succeeded");
    expect(await page.locator("[data-placed='event']").count()).toBe(1);
    await ctx.close();
  });
  it("Maya + a sentence is a message; the calendar refuses it and the mail drafts take it", async () => {
    const { page, ctx } = await open();
    await drag(page, "#maya", "#maya-line");
    const id = (await st(page)).desk[0];
    expect(await page.locator(objectSel(id)).getAttribute("aria-label")).toMatch(/^Message Maya/);
    await drag(page, objectSel(id), "[data-slot='fri-1930']", "#tab-calendar");
    expect((await st(page)).last.text).toMatch(/Not placed: Calendar takes events; this is a message/);
    await drag(page, objectSel(id), "[data-dest='mail']", "#tab-mail");
    await page.getByRole("button", { name: "Save as draft" }).click();
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "succeeded");
    expect(await page.locator("[data-placed='draft']").innerText()).toMatch(/To maya\.rao@example\.com\s*Free for dinner this week\?/);
    await ctx.close();
  });
});

describe("keyboard only", () => {
  it("pick up, switch tabs while carrying, press in, add the time, carry to a slot, review and place", async () => {
    const { page, ctx, errors } = await open();
    const key = (k: string) => page.keyboard.press(k);
    await page.locator("#maya").focus(); await key("Enter");
    expect((await st(page)).phase).toBe("carrying");
    await page.locator("#tab-profile").focus(); await key("ArrowRight");
    expect(await page.locator("#tab-restaurant").getAttribute("aria-selected")).toBe("true");
    await key("Tab"); expect(await page.evaluate(() => document.activeElement!.id)).toBe("dakshin");
    expect(await page.locator("#hint").innerText()).toMatch(/^Let go to press Maya Rao into Dakshin/);
    await key("Enter"); await settled(page);
    const id = (await st(page)).desk[0];
    await page.locator("#dakshin-time").focus(); await key("Enter");
    await page.locator(objectSel(id)).focus(); await key("Enter"); await settled(page);
    expect((await st(page)).objects[id].ingredients).toHaveLength(3);
    await page.locator(objectSel(id)).focus(); await key(" ");
    await page.locator("#tab-restaurant").focus(); await key("ArrowRight");
    await page.locator("[data-slot='fri-1930']").focus(); await key("Enter");
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "previewing");
    await page.getByRole("button", { name: "Use “Meet Maya at Dakshin”" }).focus(); await key("Enter");
    await page.getByRole("button", { name: "Add to calendar" }).focus(); await key("Enter");
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "succeeded");
    expect(await page.locator("[data-placed='event']").count()).toBe(1);
    expect(errors).toEqual([]); await ctx.close();
  });
  it("Escape puts a carried object back and closes a review without adding anything", async () => {
    const { page, ctx } = await open();
    await page.locator("#maya").focus(); await page.keyboard.press("Enter"); await page.keyboard.press("Escape");
    expect(await st(page)).toMatchObject({ phase: "idle", carried: null, last: { text: "Put back; nothing changed" } });
    expect((await st(page)).desk).toHaveLength(1);
    await ctx.close();
  });
});

describe("phone (touch)", () => {
  /** A real touch sequence: press, hold, move, release (Chromium's touch emulation through the DevTools protocol). */
  async function touchDrag(p: Page, from: string, to: string, opts: { holdMs?: number; via?: string } = {}) {
    const cdp = await p.context().newCDPSession(p); const a = await centre(p, from);
    const t = (type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    await t("touchStart", a.x, a.y); await p.waitForTimeout(opts.holdMs ?? 420);
    for (let i = 1; i <= 4; i++) await t("touchMove", a.x + i * 3, a.y + i * 3);
    if (opts.via) { const v = await centre(p, opts.via); await t("touchMove", v.x, v.y); await t("touchMove", v.x + 1, v.y); await p.waitForFunction((s) => document.querySelector(s)!.getAttribute("aria-selected") === "true", opts.via, { timeout: 3000 }); }
    const b = await centre(p, to); for (let i = 1; i <= 6; i++) await t("touchMove", b.x, b.y + 64 * (i / 6) + 0);
    await t("touchMove", b.x, b.y + 64); await t("touchEnd", b.x, b.y + 64); await settled(p);
  }
  it("press and hold lifts; the object rides above the finger; dropping on the restaurant presses them together", async () => {
    const { page, ctx, errors } = await open({ phone: true });
    await touchDrag(page, "#maya", "#dakshin", { via: "#tab-restaurant" });
    const s = await st(page); expect(s.desk).toHaveLength(1); expect(s.objects[s.desk[0]].ingredients).toHaveLength(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]); await ctx.close();
  });
  it("a quick tap picks a piece onto the desk instead of starting a drag (so pages still scroll)", async () => {
    const { page, ctx } = await open({ phone: true });
    await page.locator("#maya").tap();
    const s = await st(page); expect(s).toMatchObject({ phase: "idle", carried: null }); expect(s.desk).toHaveLength(1);
    await ctx.close();
  });
});

describe("motion and accessibility", () => {
  it("with reduced motion the merge still happens, without travel, and settles at once", async () => {
    const { page, ctx } = await open({ motion: "reduce" });
    const t0 = Date.now(); await drag(page, "#maya", "#dakshin", "#tab-restaurant");
    expect(Date.now() - t0).toBeLessThan(4000);
    expect((await st(page)).phase).toBe("idle");
    await expect.poll(() => page.locator(".clay-item").count()).toBe(1);
    await ctx.close();
  });
  for (const theme of ["light", "dark"] as const) it(`no serious or critical axe findings with an object and a review open (${theme})`, async () => {
    const { page, ctx } = await open({ theme });
    const id = await makeDinner(page);
    await page.locator(objectSel(id)).click();
    const r = await new AxeBuilder({ page }).analyze();
    expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
    await ctx.close();
  });
});
