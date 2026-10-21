// The clay page in Chromium: turn Recast on, carry Maya from one tab to another, press her into the restaurant, choose where
// the object goes in the glass module (or carry it to a calendar slot), review, place, undo. Mouse, keyboard only, touch
// (long press), reduced motion, refusals, taking an ingredient out, a calendar that does not answer, and Recast off.
// The calendar and the drafts are in-page stand-ins for the registry's Google Calendar and Gmail contracts.
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
async function open(o: { theme?: "light" | "dark"; phone?: boolean; motion?: "reduce"; off?: boolean } = {}): Promise<{ page: Page; ctx: BrowserContext; errors: string[] }> {
  const ctx = await browser.newContext({
    ...(o.phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { viewport: { width: 1200, height: 800 } }),
    colorScheme: o.theme ?? "light", timezoneId: "Asia/Kolkata", ...(o.motion ? { reducedMotion: o.motion } : {}),
  });
  const page = await ctx.newPage(); const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`${base}/clay.html?${Q}`);
  if (!o.off) await page.locator("#recast-trigger").click();   // Recast starts off: turn it on, as a person would
  return { page, ctx, errors };
}
const st = (p: Page) => p.evaluate(() => (globalThis as any).recast.state);
const centre = async (p: Page, sel: string) => { const b = (await p.locator(sel).first().boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
const objectSel = (id: string) => `.clay-item[data-id="${id}"]`;
/** The Recast trigger: Control pressed and released twice (Ctrl on Windows and Linux). */
const controlTwice = async (p: Page) => { await p.keyboard.press("Control"); await p.keyboard.press("Control"); };
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
    // It sits in the module's well; the facts are written under it there.
    expect(await label.getAttribute("aria-label")).toBe("Meet Maya at Dakshin, made of 3 pieces");
    expect(await page.locator(".rg").getAttribute("data-mode")).toBe("composed");
    expect(await page.locator(".rg-title").innerText()).toBe("Ready to place");
    await page.getByRole("button", { name: /Choose where it goes/ }).click();
    expect(await page.locator(".rg-facts").innerText()).toMatch(/^Maya Rao\s+Dakshin\s+Fri, 23 Oct, 7:30 PM$/);   // the dots between them are drawn by CSS
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
    expect(await page.locator(".rg-title").innerText()).toBe("Calendar: review");
    expect(await page.locator("[data-placed='event']").count()).toBe(0);
    expect(await page.locator(".rg-body").innerText()).toMatch(/Title[\s\S]*nothing captured reads as a title/);
    await page.getByRole("button", { name: "Use “Meet Maya at Dakshin”" }).click();
    const body = await page.locator(".rg-body").innerText();
    expect(body).toMatch(/Where\s*Dakshin, 12 MG Road, Bengaluru\s*from the page/); expect(body).toMatch(/Notes\s*With Maya Rao\s*from the page/); expect(body).toMatch(/Title\s*Meet Maya at Dakshin\s*you/);
    await page.getByRole("button", { name: "Add to calendar" }).click();
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "succeeded");
    expect(await page.locator(".rg-title").innerText()).toBe("Added to Calendar");
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
    await atRest(page, objectSel(target)); const b = await centre(page, objectSel(target)); await page.mouse.move(b.x, b.y, { steps: 6 });
    expect(await page.locator("#hint").innerText()).toMatch(/^Won't combine: Gift card · ₹2,000 can be carried and placed on its own/);
    // The class is redrawn on the next animation frame, after the hint: wait for it rather than read it once.
    await page.waitForFunction((sel) => document.querySelector(sel)?.classList.contains("mode-refuses"), objectSel(target), { timeout: 2000 });
    await page.mouse.up(); await settled(page);
    const s = await st(page); expect(s.desk).toHaveLength(2); expect(s.objects[target].ingredients).toHaveLength(2);
    await ctx.close();
  });
  it("opening an object shows each ingredient and where it came from; taking one out gives it back", async () => {
    const { page, ctx } = await open();
    const id = await makeDinner(page);
    await page.locator(objectSel(id)).click();
    expect(await page.locator(".rg-title").innerText()).toBe("Inside this object");
    expect(await page.locator(".rg-ingredients").innerText()).toMatch(/person\s*Maya Rao\s*from Maya Rao · Profile · sure 90%/i);
    await page.getByRole("button", { name: "Take Maya Rao out" }).click();
    const s = await st(page); expect(s.desk).toHaveLength(2); expect(s.objects[id].ingredients.map((f: any) => f.text)).toEqual(["Dakshin", "Friday, 7:30 PM"]);
    expect(await page.locator(objectSel(id)).getAttribute("aria-label")).toMatch(/^Meet at Dakshin, /);
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
    expect(await page.locator(".rg-body").innerText()).toMatch(/did not answer in time\. It may or may not have been added\. Recast does not send it again/);
    await page.getByRole("button", { name: "Check Calendar" }).click();
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
    await key("Tab"); expect(await page.evaluate(() => document.activeElement!.id)).toBe("recast-trigger");   // the Recast button sits in the bar
    await key("Enter"); expect((await st(page)).phase).toBe("carrying");                                       // and leaves a carry alone
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
    // The module opens full width less the gutters, inside the screen.
    const box = (await page.locator(".rg").boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(15); expect(box.x + box.width).toBeLessThanOrEqual(390 - 15); expect(box.y).toBeGreaterThan(0);
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
    expect((await st(page)).phase).toBe("composed");
    await page.getByRole("button", { name: /Choose where it goes/ }).click();
    expect((await st(page)).phase).toBe("choosing");
    await expect.poll(() => page.locator(".clay-item").count()).toBe(1);
    await ctx.close();
  });
  for (const theme of ["light", "dark"] as const) it(`no serious or critical axe findings: pill, module, selector, inspection, review (${theme})`, async () => {
    const { page, ctx } = await open({ theme });
    const axe = async (when: string) => { const r = await new AxeBuilder({ page }).analyze(); expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${when} ${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]); };
    await axe("pill");
    const id = await makeDinner(page);
    await axe("module");
    await page.getByRole("button", { name: /Choose where it goes/ }).click(); await axe("selector");
    await page.getByRole("button", { name: "Open" }).click(); await axe("review");
    await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
    await page.locator(objectSel(id)).click(); await axe("inspection");
    await ctx.close();
  });
});

describe("the trigger", () => {
  it("with Recast off the page is just a page: text selects, nothing is picked up, nothing floats over it", async () => {
    const { page, ctx, errors } = await open({ off: true });
    expect(await page.locator("#maya").getAttribute("tabindex")).toBe("-1"); expect(await page.locator("#maya").getAttribute("role")).toBeNull();
    await page.locator("#maya").click({ clickCount: 3 });
    expect(await page.evaluate(() => getSelection()!.toString())).toMatch(/Maya/);
    await drag(page, "#maya", "#maya-line");
    expect(Object.keys((await st(page)).objects)).toEqual([]); expect(await page.locator(".clay-item").count()).toBe(0);
    expect(await page.locator(".rg").isHidden()).toBe(true);
    expect(await page.locator("#recast-trigger").getAttribute("aria-pressed")).toBe("false");
    expect(errors).toEqual([]); await ctx.close();
  });
  it("Control twice turns it on and Control once turns it off; Ctrl+C and a held Control do neither; the button and Escape too; one module", async () => {
    const { page, ctx } = await open({ off: true });
    expect(await page.locator(".trigger-kbd").innerText()).toMatch(/^(Ctrl Ctrl|⌃ ⌃)$/);
    await page.keyboard.press("Control+c"); await page.keyboard.press("Control+c");
    await page.keyboard.down("Control"); await page.waitForTimeout(450); await page.keyboard.up("Control"); await page.keyboard.press("Control");
    expect((await st(page)).armed).toBe(false);
    await page.waitForTimeout(450); await controlTwice(page);
    expect((await st(page)).armed).toBe(true); expect(await page.locator(".rg").getAttribute("data-mode")).toBe("pill");
    expect(await page.locator("#recast-trigger").getAttribute("aria-pressed")).toBe("true");
    expect(await page.locator(".trigger-kbd").innerText()).toMatch(/^(Ctrl|⌃)$/);                  // on: the hint says once
    await page.keyboard.press("Control+c"); expect((await st(page)).armed).toBe(true);           // a shortcut does not turn it off
    await page.waitForTimeout(450); await page.keyboard.press("Control"); expect((await st(page)).armed).toBe(false); expect(await page.locator(".rg").isHidden()).toBe(true);
    await page.keyboard.press("Control"); expect((await st(page)).armed).toBe(false);            // a habitual second press leaves it off
    await page.waitForTimeout(450);
    await page.locator("#recast-trigger").click(); expect((await st(page)).armed).toBe(true);
    await page.keyboard.press("Escape"); expect((await st(page)).armed).toBe(false);
    await page.locator("#recast-trigger").click(); await page.locator("#recast-trigger").click(); await page.locator("#recast-trigger").click();
    expect(await page.locator(".rg").count()).toBe(1);
    await ctx.close();
  });
});

describe("the glass module and the destination selector", () => {
  it("acceptance: Maya pressed into Dakshin; a compact glass module holds the object; scroll through places; Calendar; review; place; undo", async () => {
    const { page, ctx, errors } = await open();
    await drag(page, "#maya", "#dakshin", "#tab-restaurant");
    const s = await st(page); const id = s.focus;
    expect(s).toMatchObject({ phase: "composed", armed: true }); expect(s.objects[id].ingredients).toHaveLength(2);
    // Compact: a fraction of the screen, frosted, and the one object sits in it.
    const box = (await page.locator(".rg").boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(360); expect(box.height).toBeLessThanOrEqual(800 * 0.4);
    expect(await page.locator(".rg").evaluate((el) => getComputedStyle(el).backdropFilter)).toMatch(/blur/);
    await atRest(page, objectSel(id)); const o = await centre(page, objectSel(id));
    expect(o.x).toBeGreaterThan(box.x); expect(o.x).toBeLessThan(box.x + box.width); expect(o.y).toBeGreaterThan(box.y); expect(o.y).toBeLessThan(box.y + box.height);
    expect(await page.locator(".clay-item").count()).toBe(1);
    // The selector: scrolling moves the choice and writes nothing.
    await page.getByRole("button", { name: /Choose where it goes/ }).click();
    expect((await st(page)).phase).toBe("choosing"); expect(await page.locator(".rg-drum").getAttribute("aria-activedescendant")).toBe("rg-opt-calendar");
    // The module reveals its new outline over 200 ms (a clip); pointer events land only once it is in place, as for a person.
    await page.waitForFunction(() => document.querySelector(".rg")!.getAnimations().length === 0);
    const d = await centre(page, ".rg-drum"); await page.mouse.move(d.x, d.y);
    await page.mouse.wheel(0, 100); await expect.poll(async () => (await st(page)).choice).toBe("mail");
    expect(await page.locator(".rg-reason").innerText()).toBe("Gmail takes messages; this is an event");
    await page.waitForTimeout(120); await page.mouse.wheel(0, 100); await expect.poll(async () => (await st(page)).choice).toBe("tasks");
    expect(await page.locator("#rg-opt-tasks").getAttribute("aria-disabled")).toBe("true");
    expect(await page.locator(".rg-reason").innerText()).toBe("Google Tasks takes documents (a page or a file); this is an event");
    expect(await page.locator(".rg-actions [data-act=open]").isDisabled()).toBe(true);
    await page.waitForTimeout(120); await page.mouse.wheel(0, -100); await page.waitForTimeout(120); await page.mouse.wheel(0, -100);
    await expect.poll(async () => (await st(page)).choice).toBe("calendar");
    expect((await st(page)).phase).toBe("choosing"); expect(await page.locator("[data-placed='event']").count()).toBe(0);
    // Open: the same module becomes the review. Still nothing written.
    await page.getByRole("button", { name: "Open" }).click();
    expect((await st(page)).phase).toBe("previewing"); expect(await page.locator(".rg-title").innerText()).toBe("Calendar: review");
    expect(await page.locator(".rg-body").innerText()).toMatch(/Stand-in: Google Calendar here is a local stand-in/);
    await page.getByRole("button", { name: "Use “Meet Maya at Dakshin”" }).click();
    await page.locator("#rg-in-start").fill("2026-10-23T19:30"); await page.locator("#rg-in-start").press("Enter");
    expect(await page.locator("[data-placed='event']").count()).toBe(0);
    await page.getByRole("button", { name: "Add to calendar" }).click();
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "succeeded");
    expect(await page.locator(".rg-title").innerText()).toBe("Added to Calendar");
    expect(await page.locator(".rg-body").innerText()).toBe("Calendar confirmed it (stand-in).");
    expect(await page.locator("[data-slot='fri-1930'] [data-placed='event']").innerText()).toBe("Meet Maya at Dakshin · Dakshin");
    await page.getByRole("button", { name: "Undo" }).click();
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "idle");
    expect(await page.locator("[data-placed='event']").count()).toBe(0);
    expect(errors).toEqual([]); await ctx.close();
  });
  it("keyboard: arrows choose, Enter on an unavailable place explains and does nothing, Escape steps back, the command reopens", async () => {
    const { page, ctx, errors } = await open();
    const key = (k: string) => page.keyboard.press(k);
    await drag(page, "#maya", "#dakshin", "#tab-restaurant");
    await page.getByRole("button", { name: /Choose where it goes/ }).focus(); await key("Enter");
    await expect.poll(() => page.evaluate(() => document.activeElement?.className)).toBe("rg-drum");
    await key("ArrowDown"); expect((await st(page)).choice).toBe("mail");
    await key("Enter"); expect((await st(page)).phase).toBe("choosing");
    await key("ArrowUp"); await key("Enter"); expect((await st(page)).phase).toBe("previewing");
    const steps: string[] = [];
    for (let i = 0; i < 3; i++) { await key("Escape"); steps.push((await st(page)).phase); }
    expect(steps).toEqual(["choosing", "composed", "idle"]);
    expect(await page.locator(".rg").getAttribute("data-mode")).toBe("pill");
    expect(await page.locator(".rg-title").innerText()).toBe("Meet Maya at Dakshin is ready");
    await page.locator("#recast-trigger").click(); expect((await st(page)).phase).toBe("composed");   // the button reopens it
    await page.locator("#recast-trigger").click(); expect((await st(page)).phase).toBe("composed");   // again: no second module
    expect(await page.locator(".rg").count()).toBe(1);
    await key("Control"); expect((await st(page)).armed).toBe(false);              // on: Control once turns it off
    expect((await st(page)).focus).not.toBeNull();                                // and the composition is kept
    await page.waitForTimeout(450); await controlTwice(page); expect(await st(page)).toMatchObject({ armed: true, phase: "composed" });   // twice: on, reopened
    expect(errors).toEqual([]); await ctx.close();
  });
  it("More lists the rest of the registry, each with its reason; nothing that is not in the registry appears", async () => {
    const { page, ctx } = await open();
    await drag(page, "#maya", "#dakshin", "#tab-restaurant");
    await page.getByRole("button", { name: /Choose where it goes/ }).click();
    await page.locator(".rg-drum").focus(); await page.keyboard.press("End"); expect((await st(page)).choice).toBe("more");
    expect(await page.locator(".rg-reason").innerText()).toBe("Nothing else Recast connects to takes an event");
    await page.keyboard.press("Enter");
    expect(await page.locator(".rg-title").innerText()).toBe("More places");
    const opts = await page.locator(".rg-opt").evaluateAll((els) => els.map((e) => [e.querySelector(".rg-label")!.textContent, e.getAttribute("aria-disabled")]));
    expect(opts).toEqual([["Google Calendar", "true"], ["Gmail", "true"], ["Google Sheets", "true"], ["Google Maps", "true"], ["Apple Maps", "true"], ["Back", "false"]]);
    expect(await page.locator(".rg-reason").innerText()).toBe("Google Calendar takes people or places; this is an event");
    await ctx.close();
  });
  it("the wheel: trackpad scrolling turns the cylinder and it snaps to a row; clicking a neighbour selects it, never opens it", async () => {
    const { page, ctx } = await open();
    await drag(page, "#maya", "#dakshin", "#tab-restaurant");
    await page.getByRole("button", { name: /Choose where it goes/ }).click();
    await page.waitForFunction(() => document.querySelector(".rg")!.getAnimations().length === 0);
    const d = await centre(page, ".rg-drum"); await page.mouse.move(d.x, d.y);
    // Small deltas every frame, as a trackpad sends them: ≈1.2 rows in all.
    await page.evaluate(async () => { const el = document.querySelector(".rg-drum")!; for (let i = 0; i < 6; i++) { el.dispatchEvent(new WheelEvent("wheel", { deltaY: 9, bubbles: true, cancelable: true })); await new Promise((r) => setTimeout(r, 16)); } });
    await expect.poll(async () => (await st(page)).choice).toBe("mail");
    expect(await page.locator(".rg-opt.on .rg-label").innerText()).toBe("Mail");
    await page.locator("#rg-opt-calendar").click();
    await expect.poll(async () => (await st(page)).choice).toBe("calendar");
    expect((await st(page)).phase).toBe("choosing");                   // a click on a neighbour only turns the wheel
    await page.locator("#rg-opt-calendar").click();
    expect((await st(page)).phase).toBe("previewing");                 // a click on the chosen one opens it
    await ctx.close();
  });
  it("the sign in the photo is a piece: pressed into Maya, the object remembers it came from the photo", async () => {
    const { page, ctx } = await open();
    await drag(page, "#maya", "#dakshin-sign", "#tab-restaurant");
    const s = await st(page);
    expect(s.objects[s.focus].ingredients.map((f: any) => [f.kind, f.text, f.source.title])).toEqual([["place", "Dakshin", "Photo of the storefront · Dakshin"], ["person", "Maya Rao", "Maya Rao · Profile"]]);
    await ctx.close();
  });
  it("with reduced transparency the module is solid, and still works", async () => {
    const { page, ctx } = await open();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
    await drag(page, "#maya", "#dakshin", "#tab-restaurant");
    const style = await page.locator(".rg").evaluate((el) => { const c = getComputedStyle(el); return { blur: c.backdropFilter, bg: c.backgroundColor, img: c.backgroundImage }; });
    expect(style.blur).toBe("none"); expect(style.img).toBe("none"); expect(style.bg).toBe("rgb(244, 241, 234)");
    await page.getByRole("button", { name: /Choose where it goes/ }).click(); expect((await st(page)).phase).toBe("choosing");
    await ctx.close();
  });
  it("once placed and the receipt is closed, the object is gone from Your objects; undone, it stays", async () => {
    const { page, ctx } = await open();
    const id = await makeDinner(page);
    await page.getByRole("button", { name: /Choose where it goes/ }).click();
    await page.getByRole("button", { name: "Open" }).click();
    await page.getByRole("button", { name: "Use “Meet Maya at Dakshin”" }).click();
    await page.getByRole("button", { name: "Add to calendar" }).click();
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "succeeded");
    expect(await page.locator(objectSel(id)).count()).toBe(1);                    // still there while the receipt shows (Undo)
    await page.getByRole("button", { name: "Done" }).click();
    const s = await st(page); expect(s.desk).toEqual([]); expect(s.objects[id]).toBeUndefined();
    await expect.poll(() => page.locator(".clay-item").count()).toBe(0);
    expect(await page.locator("#desk-empty").isVisible()).toBe(true);
    expect(await page.locator("[data-placed='event']").count()).toBe(1);        // the event itself is in the calendar
    await ctx.close();
  });
});

describe("a place on its own → Google Maps (open and prefill, the real Google Maps)", () => {
  it("pick up Dakshin, look inside, choose where it goes, Google Maps under More; the review is a real link; done says opened, never added", async () => {
    const { page, ctx, errors } = await open();
    const opened: string[] = [];
    // The test never reaches Google: the new tab's request is answered here, and its address is what is checked.
    await ctx.route("https://www.google.com/**", (r) => { opened.push(r.request().url()); return r.fulfill({ status: 200, contentType: "text/html", body: "<title>Maps</title>" }); });
    await page.locator("#tab-restaurant").click();
    await page.locator("#dakshin").click();
    let s = await st(page); expect(s.desk).toHaveLength(1); const id = s.desk[0];
    await atRest(page, objectSel(id)); await page.locator(objectSel(id)).click();
    expect((await st(page)).phase).toBe("inspecting");
    await page.locator(".rg-actions [data-act=placeIt]").click();
    expect((await st(page)).phase).toBe("composed");
    await page.getByRole("button", { name: /Choose where it goes/ }).click();
    s = await st(page); expect(s.phase).toBe("choosing"); expect(await page.locator(".rg-drum").getAttribute("aria-activedescendant")).toBe("rg-opt-more");
    expect(await page.locator("#rg-opt-calendar").getAttribute("aria-disabled")).toBe("true");
    await page.waitForFunction(() => document.querySelector(".rg")!.getAnimations().length === 0);
    await page.getByRole("button", { name: "Open" }).click();                         // into More
    const maps = page.locator(".rg-opt", { hasText: "Google Maps" });
    await maps.click(); await page.waitForTimeout(150); await maps.click();
    s = await st(page); expect(s.phase).toBe("previewing");
    expect(await page.locator(".rg-title").innerText()).toBe("Google Maps: review");
    expect(await page.locator(".rg-body").innerText()).toMatch(/Opens Google Maps in a new tab with this filled in\. Recast saves nothing; you finish there\./);
    expect(await page.locator(".rg-body").innerText()).not.toMatch(/Stand-in/);
    const link = page.locator(".rg-actions a[data-act=place]");
    expect(await link.getAttribute("href")).toBe("https://www.google.com/maps/dir/?api=1&destination=Dakshin%2C%2012%20MG%20Road%2C%20Bengaluru");
    expect(await link.getAttribute("rel")).toBe("noopener noreferrer");
    const [tab] = await Promise.all([ctx.waitForEvent("page"), link.click()]);
    await tab.waitForLoadState();
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "succeeded");
    expect(opened).toEqual(["https://www.google.com/maps/dir/?api=1&destination=Dakshin%2C%2012%20MG%20Road%2C%20Bengaluru"]);
    expect(await page.locator(".rg-title").innerText()).toBe("Opened Google Maps");
    expect(await page.locator(".rg-body").innerText()).toMatch(/Recast cannot see what you do there/);
    expect(await page.getByRole("button", { name: "Undo" }).count()).toBe(0);
    expect(errors).toEqual([]); await ctx.close();
  });
});

describe("recovery: the calendar misbehaves (in-page stand-in, real Chromium)", () => {
  /** Maya + Dakshin + time, chosen for the calendar from the module, with its title answered: one click from placing. */
  async function readyToPlace(page: Page) {
    const id = await makeDinner(page);
    await page.getByRole("button", { name: /Choose where it goes/ }).click();
    await page.getByRole("button", { name: "Open" }).click();
    await page.getByRole("button", { name: "Use “Meet Maya at Dakshin”" }).click();
    return id;
  }
  const phase = (p: Page) => p.evaluate(() => (globalThis as any).recast.state.phase);
  const entries = (p: Page) => p.evaluate(() => (globalThis as any).recast.bridges.cal.entries.size);
  const hold = (p: Page) => p.evaluate(() => { const b = (globalThis as any).recast.bridges.cal; b.gate = new Promise<void>((r) => { (globalThis as any).release = () => { b.gate = null; r(); }; }); });
  const release = (p: Page) => p.evaluate(() => (globalThis as any).release());

  it("while a write is in flight, Escape, Control and a new pick-up change nothing, and Recast says why; then the answer lands", async () => {
    const { page, ctx, errors } = await open();
    await readyToPlace(page); await hold(page);
    await page.getByRole("button", { name: "Add to calendar" }).click();
    expect(await phase(page)).toBe("executing");
    await page.keyboard.press("Escape"); await page.keyboard.press("Control");
    expect(await phase(page)).toBe("executing"); expect((await st(page)).armed).toBe(true);
    expect(await page.locator("#hint").innerText()).toBe("Waiting for Calendar to answer. Recast stays on until it does");
    await release(page); await page.waitForFunction(() => (globalThis as any).recast.state.phase === "succeeded");
    expect(await entries(page)).toBe(1);
    expect(errors).toEqual([]); await ctx.close();
  });
  it("Undo is one step: while it is in flight nothing else happens; a refused undo says so, keeps the event and the object, and can be tried again", async () => {
    const { page, ctx } = await open();
    const id = await readyToPlace(page);
    await page.getByRole("button", { name: "Add to calendar" }).click();
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "succeeded");
    await page.evaluate(() => { (globalThis as any).recast.bridges.cal.undoFails = true; });
    await hold(page);
    await page.getByRole("button", { name: "Undo" }).click();
    expect(await phase(page)).toBe("undoing");
    expect(await page.locator(".rg-title").innerText()).toBe("Undoing in Calendar…");
    expect(await page.locator(".rg-actions button").count()).toBe(0);              // no second Undo, no Done
    await page.keyboard.press("Escape"); await page.keyboard.press("Control"); expect(await phase(page)).toBe("undoing");
    await release(page); await page.waitForFunction(() => (globalThis as any).recast.state.phase === "succeeded");
    expect(await page.locator(".rg-body").innerText()).toMatch(/^Could not undo: Google Calendar refused the delete\. It is still in Calendar\./);
    expect(await entries(page)).toBe(1); expect((await st(page)).desk).toEqual([id]);
    await page.evaluate(() => { (globalThis as any).recast.bridges.cal.undoFails = false; });
    await page.getByRole("button", { name: "Undo" }).click();
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "idle");
    expect(await entries(page)).toBe(0); expect((await st(page)).desk).toEqual([id]);  // undone: the object stays, ready again
    await ctx.close();
  });
  it("a refusal before anything is created: Not added, with the reason; nothing written; the object stays and can be placed again", async () => {
    const { page, ctx } = await open();
    const id = await readyToPlace(page);
    await page.evaluate(() => { (globalThis as any).recast.bridges.cal.refuse = true; });
    await page.getByRole("button", { name: "Add to calendar" }).click();
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "failed");
    expect(await page.locator(".rg-title").innerText()).toBe("Not added");
    expect(await page.locator(".rg-body").innerText()).toBe("Google Calendar refused it; nothing was added");
    expect(await entries(page)).toBe(0);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    expect((await st(page)).desk).toEqual([id]);
    await ctx.close();
  });
  it("the answer is lost: unknown; Check later remembers it; choosing Calendar again goes to the check, never a second write", async () => {
    const { page, ctx } = await open();
    const id = await readyToPlace(page);
    await page.evaluate(() => { (globalThis as any).recast.bridges.cal.silent = true; });
    await page.getByRole("button", { name: "Add to calendar" }).click();
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "unknown");
    expect(await entries(page)).toBe(1);                                          // it did land; Recast does not know yet
    await page.getByRole("button", { name: "Check later" }).click();
    expect(await phase(page)).toBe("idle"); expect(Object.keys((await st(page)).uncertain)).toEqual([id]);
    // On the desk it says so, rather than looking like an untouched object.
    await expect.poll(() => page.locator(objectSel(id)).getAttribute("aria-label")).toBe("Meet Maya at Dakshin, Not sure it reached Calendar: check before placing again, made of 3 pieces");
    await page.evaluate(() => { (globalThis as any).recast.bridges.cal.silent = false; });
    await page.locator("#recast-trigger").click();                                // reopen the composition
    await page.getByRole("button", { name: /Choose where it goes/ }).click();
    await page.getByRole("button", { name: "Open" }).click();
    expect(await phase(page)).toBe("unknown"); expect(await entries(page)).toBe(1);   // the check, not a second write
    await page.getByRole("button", { name: "Check Calendar" }).click();
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "succeeded");
    expect(await entries(page)).toBe(1);
    expect(await page.locator(".rg-title").innerText()).toBe("Added to Calendar");
    await ctx.close();
  });
});

