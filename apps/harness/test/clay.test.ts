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
async function open(o: { theme?: "light" | "dark"; phone?: boolean; motion?: "reduce"; off?: boolean; clipboard?: boolean } = {}): Promise<{ page: Page; ctx: BrowserContext; errors: string[] }> {
  const ctx = await browser.newContext({
    ...(o.clipboard ? { permissions: ["clipboard-read", "clipboard-write"] } : {}),
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

describe("context reconciliation: three sources, one conflict, a verified placement", () => {
  it("the invite, the chat and the planning doc become one event; the time conflict names its sources; the person settles it; the calendar is read back", async () => {
    const { page, ctx, errors } = await open();
    // 1. Invite: the title pressed into the invite's time.
    await page.locator("#tab-invite").click();
    await drag(page, "#invite-title", "#invite-time");
    let s = await st(page); expect(s.desk).toHaveLength(1);
    // 2. Chat: the object carried over and pressed into Maya's time. 3. Plan: pressed into the venue.
    // (Pressed into a piece on a page, the piece is the base, so the object's id is read again after each press.)
    await drag(page, objectSel((await st(page)).desk[0]), "#chat-time", "#tab-chat");
    await drag(page, objectSel((await st(page)).desk[0]), "#plan-venue", "#tab-plan");
    s = await st(page); expect(s.desk).toHaveLength(1); const id = s.desk[0] as string;
    expect(s.objects[id].ingredients.map((f: any) => `${f.kind} from ${f.source.title}`).sort()).toEqual(["place from Design review · planning doc", "time from Invitation: Design review", "time from Maya Rao · Chat", "title from Invitation: Design review"]);
    // 4. To the calendar: the review will not guess. It shows both times and says where each came from.
    if ((await st(page)).phase !== "composed") await page.locator("#recast-trigger").click();
    await page.getByRole("button", { name: /Choose where it goes/ }).click();
    await expect.poll(async () => page.locator("#rg-opt-calendar").getAttribute("aria-disabled")).toBe("false");
    await page.locator(".rg-actions [data-act=open]").click();
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "previewing");
    const chips = page.locator("[data-choose=start]");
    expect((await chips.allInnerTexts()).sort()).toEqual(["Thursday, 3:00 PM\nInvitation: Design review", "Thursday, 4:00 PM\nMaya Rao · Chat"]);
    expect(await page.locator(".rg-actions button", { hasText: "Add to calendar" }).count()).toBe(0);   // nothing to place until settled
    expect((await st(page)).placement.op).toBeUndefined();
    // 5. The person picks the chat's time. Every value now says where it came from, and the choice says what it overruled.
    await chips.filter({ hasText: "Maya Rao · Chat" }).click();
    const body = await page.locator(".rg-body").innerText();
    expect(body).toMatch(/Title\s*Design review\s*from Invitation: Design review/);
    expect(body).toMatch(/Where\s*Dakshin, 12 MG Road, Bengaluru\s*from Design review · planning doc/);
    expect(body).toMatch(/When\s*Thu, Oct 22, 4:00 PM\s*read from (Maya Rao · Chat \+ Invitation: Design review|Invitation: Design review \+ Maya Rao · Chat)/);   // both said Thursday
    expect(body).toMatch(/you chose “Thursday, 4:00 PM” from Maya Rao · Chat over “Thursday, 3:00 PM” from Invitation: Design review/);
    // The review says what happens after: the calendar will be read back.
    expect(await page.locator(".rg-after").innerText()).toBe("After it is placed, Recast reads it back from Google Calendar to check it.");
    // 6. Placed, then read back from the calendar: verified only on the calendar's own answer.
    await page.getByRole("button", { name: "Add to calendar" }).click();
    await page.waitForFunction(() => { const p = (globalThis as any).recast.state.placement; return p?.verification && p.verification !== "checking"; });
    expect((await st(page)).placement.verification).toMatchObject({ ok: true });
    expect(await page.locator(".rg-verify").innerText()).toMatch(/^Read back from Calendar: (\d+) of \1 fields match\.$/);
    expect(await page.locator("#cal-other [data-placed=event]").innerText()).toMatch(/^Design review · Thu, (Oct 22|22 Oct), 4:00 PM · Dakshin, 12 MG Road, Bengaluru$/);
    // 7. Undo; then someone edits the event right after it lands: the read-back says exactly what differs.
    await page.getByRole("button", { name: "Undo" }).click();
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "idle");
    await page.locator("#tab-calendar").click(); await page.locator("#drift").check();
    await page.locator("#recast-trigger").click(); if ((await st(page)).phase !== "composed") await page.locator("#recast-trigger").click();
    await page.getByRole("button", { name: /Choose where it goes/ }).click();
    await expect.poll(async () => page.locator("#rg-opt-calendar").getAttribute("aria-disabled")).toBe("false");
    await page.locator(".rg-actions [data-act=open]").click();
    await page.getByRole("button", { name: "Add to calendar" }).click();
    await page.waitForFunction(() => { const p = (globalThis as any).recast.state.placement; return p?.verification && p.verification !== "checking"; });
    expect((await st(page)).placement.verification.ok).toBe(false);
    expect((await page.locator(".rg-verify").innerText()).replace(/\s+/g, " ")).toBe("Calendar differs from what was planned. Title: planned “Design review”, now “Design review (edited)”");
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);
});

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
    expect(body).toMatch(/Where\s*Dakshin, 12 MG Road, Bengaluru\s*from Dakshin · Restaurant/); expect(body).toMatch(/Notes\s*With Maya Rao\s*from Maya Rao · Profile/); expect(body).toMatch(/Title\s*Meet Maya at Dakshin\s*you/);
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
    // The verdict follows the pointer's last move; on a busy machine it lands a frame later: wait for it, the same words.
    await expect.poll(() => page.locator("#hint").innerText()).toMatch(/^Won't combine: Gift card · ₹2,000 can be carried and placed on its own/);
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
  it("inside an object each piece can be moved, replaced by typing (marked as typed), and the whole object discarded after asking; nothing is written", async () => {
    const { page, ctx, errors } = await open();
    const id = await makeDinner(page);
    await page.locator(objectSel(id)).click();
    await page.getByRole("button", { name: "Move Friday, 7:30 PM up" }).click();
    expect((await st(page)).objects[id].ingredients.map((f: any) => f.text)).toEqual(["Dakshin", "Friday, 7:30 PM", "Maya Rao"]);
    // The time was misread: Replace, type it, Enter. It sits where the old one was, read as a time, "from typed by you".
    await page.getByRole("button", { name: "Replace Friday, 7:30 PM" }).click();
    await page.getByRole("textbox", { name: /What it should say instead of Friday, 7:30 PM/ }).fill("Saturday 8 PM");
    await page.keyboard.press("Enter");
    const f = (await st(page)).objects[id].ingredients[1];
    expect(f).toMatchObject({ kind: "time", text: "Saturday 8 PM", source: { title: "typed by you" } });
    expect(await page.locator(".rg-ingredients").innerText()).toMatch(/time\s*Saturday 8 PM\s*from typed by you/i);
    // Discard asks once; Keep keeps; Discard removes it from the desk and nothing is sent anywhere.
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await page.getByRole("button", { name: "Keep" }).click();
    expect((await st(page)).desk).toEqual([id]);
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    expect(await page.locator(".rg-discard").innerText()).toMatch(/nothing is written anywhere/);
    await page.locator("[data-act=discardOk]").click();
    const s = await st(page); expect(s.desk).toEqual([]); expect(s.objects).toEqual({});
    expect(errors).toEqual([]);
    await ctx.close();
  });
  it("Copy as data: the object, its fields and every piece with its page, as JSON on the clipboard; refused, it is shown to copy by hand", async () => {
    const { page, ctx, errors } = await open({ clipboard: true });
    const id = await makeDinner(page);
    await page.locator(objectSel(id)).click();
    await page.getByRole("button", { name: "Copy as data" }).click();
    await expect.poll(() => page.getByRole("button", { name: "Copied as data" }).count()).toBe(1);
    const data = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
    expect(data).toMatchObject({ format: "recast.object/1", type: "Event", fields: { location: "Dakshin, 12 MG Road, Bengaluru", start: "2026-10-23T19:30" }, missing: ["title"] });
    expect(data.pieces.map((p: any) => p.text)).toEqual(["Dakshin", "Maya Rao", "Friday, 7:30 PM"]);
    expect(data.pieces[1].source).toMatchObject({ title: expect.stringMatching(/Maya Rao/) });
    await ctx.close();
    // Where the page may not write to the clipboard, nothing is claimed: the data is there to select and copy.
    const b = await open();
    const id2 = await makeDinner(b.page);
    await b.page.locator(objectSel(id2)).click();
    await b.page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("denied")) } }); });
    await b.page.getByRole("button", { name: "Copy as data" }).click();
    await expect.poll(() => b.page.locator(".rg-data").count()).toBe(1);
    expect(await b.page.getByRole("button", { name: "Copied as data" }).count()).toBe(0);
    expect(JSON.parse(await b.page.locator(".rg-data").inputValue())).toMatchObject({ type: "Event" });
    expect([...errors, ...b.errors]).toEqual([]);
    await b.ctx.close();
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
    // What the place will do, and what it declares it can do afterwards (D45).
    await expect.poll(() => page.locator(".rg-reason").innerText()).toBe("Google Calendar: add to calendar. Read back after placing · Undo. A local stand-in: nothing reaches the real service");
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
    expect(await page.locator(".rg-body").innerText()).toMatch(/^Calendar confirmed it \(stand-in\)\.\s+(Checking Calendar…|Read back from Calendar: (\d+) of \2 fields match\.)\s+Save as workflow$/);
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
    await expect.poll(() => page.locator(".rg-opt.on .rg-label").innerText()).toBe("Google Maps"); await page.waitForTimeout(150); await maps.click();
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

describe("Google Maps when the page is embedded without permission to open tabs (as a hosted artifact can be)", () => {
  it("the browser refuses the new tab: Recast says so, places nothing, and shows the address to copy; allowed, it opens and keeps the address on hand", async () => {
    const run = async (sandbox: string) => {
      const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, timezoneId: "Asia/Kolkata" });
      await ctx.route("https://www.google.com/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>Maps</title>" }));
      const page = await ctx.newPage(); const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${base}/compose.html`);
      await page.setContent(`<iframe sandbox="${sandbox}" src="${base}/clay.html?${Q}" style="width:1180px;height:780px;border:0"></iframe>`);
      const f = page.frameLocator("iframe");
      await f.locator("#recast-trigger").click();
      await f.locator("#tab-restaurant").click(); await f.locator("#dakshin").click();
      await f.locator(".clay-item").first().click();
      await f.locator(".rg-actions [data-act=placeIt]").click();
      await f.getByRole("button", { name: /Choose where it goes/ }).click();
      await page.waitForTimeout(300);
      await f.getByRole("button", { name: "Open" }).click();
      const maps = f.locator(".rg-opt", { hasText: "Google Maps" });
      await expect.poll(() => f.locator(".rg-opt.on .rg-label").innerText()).toBe("Google Maps"); await page.waitForTimeout(150); await maps.click();
      await f.locator(".rg-actions a[data-act=place]").waitFor();
      const frame = page.frames()[1]!;
      return { ctx, page, f, frame, errors };
    };
    const href = "https://www.google.com/maps/dir/?api=1&destination=Dakshin%2C%2012%20MG%20Road%2C%20Bengaluru";
    // 1. Not allowed to open tabs: nothing opens, nothing is called opened.
    const a = await run("allow-scripts allow-same-origin");
    const tabs = a.ctx.pages().length;
    await a.f.locator(".rg-actions a[data-act=place]").click();
    await a.f.locator(".rg-error").waitFor();
    expect(await a.f.locator(".rg-error").innerText()).toMatch(/did not open a new tab/);
    expect(await a.f.locator(".rg-url").inputValue()).toBe(href);
    expect(await a.frame.evaluate(() => (globalThis as any).recast.state.phase)).toBe("previewing");
    expect(a.ctx.pages().length).toBe(tabs);
    expect(a.errors).toEqual([]); await a.ctx.close();
    // 2. Allowed: it opens, and the address stays on hand in case the tab came up blank.
    const b = await run("allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox");
    const [tab] = await Promise.all([b.ctx.waitForEvent("page"), b.f.locator(".rg-actions a[data-act=place]").click()]);
    await tab.waitForLoadState(); expect(tab.url()).toBe(href);
    expect(await tab.evaluate(() => window.opener)).toBeNull();
    await b.f.locator(".rg-url").waitFor();
    expect(await b.f.locator(".rg-title").innerText()).toBe("Opened Google Maps");
    expect(await b.f.locator(".rg-url").inputValue()).toBe(href);
    expect(b.errors).toEqual([]); await b.ctx.close();
  });
});

describe("phase two: select any text, and move it as a blob", () => {
  /** Select `part` of the text inside `sel` with a real mouse drag (press at its first letter, release after its last). */
  async function mouseSelect(p: Page, sel: string, part: string) {
    const r = await p.evaluate(([sel, part]) => {
      const el = document.querySelector(sel)!; const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.textContent!.indexOf(part); if (i < 0) continue;
        const range = document.createRange(); range.setStart(n, i); range.setEnd(n, i + part.length);
        const rects = [...range.getClientRects()]; const a = rects[0]!, b = rects.at(-1)!;
        return { x1: a.left + 1, y1: a.top + a.height / 2, x2: b.right - 1, y2: b.top + b.height / 2 };
      }
      throw new Error(`no "${part}" in ${sel}`);
    }, [sel, part] as const);
    await p.mouse.move(r.x1, r.y1); await p.mouse.down(); await p.mouse.move(r.x2, r.y2, { steps: 8 }); await p.mouse.up();
  }
  it("a selected sentence shows a blob; dragging the blob onto Maya's line makes a note of both", async () => {
    const { page, ctx, errors } = await open();
    await mouseSelect(page, "#page-profile p:nth-of-type(3)", "She is in town all week and likes South Indian food.");
    const blob = page.locator(".sel-blob");
    await blob.waitFor();
    expect(await blob.locator(".sel-kind").innerText()).toBe("Text");
    expect(await page.evaluate(() => getSelection()!.toString())).toBe("She is in town all week and likes South Indian food.");
    await drag(page, ".sel-blob", "#maya-line");
    const s = await st(page);
    expect(s.phase).toBe("composed");
    expect(s.objects[s.focus].ingredients.map((f: any) => [f.kind, f.text])).toEqual([["text", "Free for dinner this week?"], ["text", "She is in town all week and likes South Indian food."]]);
    expect(s.objects[s.focus].ingredients[1].source).toMatchObject({ url: "people.example/maya-rao", title: "Maya Rao · Profile" });
    expect(await page.locator(".sel-blob").count()).toBe(0);
    expect(await page.evaluate(() => getSelection()!.toString())).toBe("");
    expect(errors).toEqual([]); await ctx.close();
  });
  it("an email address reads as a person; tapping the blob puts it on the desk", async () => {
    const { page, ctx, errors } = await open();
    await mouseSelect(page, "#page-profile .mono", "maya.rao@example.com");
    await page.locator(".sel-blob").waitFor();
    expect(await page.locator(".sel-blob .sel-kind").innerText()).toBe("Person");
    await page.locator(".sel-blob").click();
    const s = await st(page);
    expect(s.desk).toHaveLength(1);
    expect(s.objects[s.desk[0]].ingredients[0]).toMatchObject({ kind: "person", text: "maya.rao@example.com", value: { email: "maya.rao@example.com" } });
    expect(errors).toEqual([]); await ctx.close();
  });
  it("a street address in plain text reads as a place, marked as a guess: the blob says 'Place?' and the review asks first (D50)", async () => {
    const { page, ctx, errors } = await open();
    await page.locator("#tab-restaurant").click();
    await mouseSelect(page, "#page-restaurant .sub", "12 MG Road, Bengaluru");
    await page.locator(".sel-blob").waitFor();
    expect(await page.locator(".sel-blob .sel-kind").innerText()).toBe("Place?");
    await page.locator(".sel-blob").click();
    let s = await st(page);
    const id = s.desk.at(-1);
    expect(s.objects[id].ingredients[0]).toMatchObject({ kind: "place", text: "12 MG Road, Bengaluru", confidence: 0.6, value: { name: "12 MG Road", address: "12 MG Road, Bengaluru" } });
    // On its own a place goes to a map; the review says Recast is not sure of this reading.
    await atRest(page, objectSel(id)); await page.locator(objectSel(id)).click();
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "inspecting");
    await page.getByRole("button", { name: "Choose where it goes" }).click();
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "composed");
    await page.locator("[data-act=openWheel]").click();
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "choosing");
    await page.waitForFunction(() => document.querySelector(".rg")!.getAnimations().length === 0);
    expect(await page.locator(".rg-drum").getAttribute("aria-activedescendant")).toBe("rg-opt-more");
    await page.getByRole("button", { name: "Open" }).click();                 // into "More places"
    await page.locator(".rg-opt", { hasText: "Google Maps" }).click(); await page.waitForTimeout(150);
    if ((await st(page)).phase === "choosing") await page.getByRole("button", { name: "Open" }).click();
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "previewing");
    expect(await page.locator(".rg-body").innerText()).toMatch(/not sure/i);
    expect(errors).toEqual([]); await ctx.close();
  });
  it("a date in plain text reads as a time and joins an object like a highlighted one; keyboard: Tab to the blob, Enter lifts it", async () => {
    const { page, ctx, errors } = await open();
    await page.evaluate(() => { const p = document.createElement("p"); p.id = "free-time"; p.textContent = "Back in Bengaluru on Saturday at 8:30 PM, if you are around."; document.querySelector("#page-profile")!.appendChild(p); });
    await mouseSelect(page, "#free-time", "Saturday at 8:30 PM");
    await page.locator(".sel-blob").waitFor();
    expect(await page.locator(".sel-blob .sel-kind").innerText()).toBe("Time");
    await page.locator(".sel-blob").focus(); await page.keyboard.press("Enter");
    let s = await st(page); expect(s.carried).toBeTruthy();
    expect(s.objects[s.carried].ingredients[0]).toMatchObject({ kind: "time", text: "Saturday at 8:30 PM" });
    await page.keyboard.press("Escape");
    s = await st(page); expect(s.carried).toBeNull(); expect(s.desk).toHaveLength(1);
    expect(errors).toEqual([]); await ctx.close();
  });
  it("with Recast off, selecting text is just selecting text: no blob", async () => {
    const { page, ctx } = await open({ off: true });
    await mouseSelect(page, "#page-profile p:nth-of-type(3)", "She is in town all week");
    await page.waitForTimeout(200);
    expect(await page.locator(".sel-blob").count()).toBe(0);
    expect(await page.evaluate(() => getSelection()!.toString())).toBe("She is in town all week");
    await ctx.close();
  });
});

describe("a recipe: one composition, several places, each with its own result", () => {
  it("Plan and invite: finish the title in the review, run both steps, see each result, undo just the draft", async () => {
    const { page, ctx, errors } = await open();
    const id = await makeDinner(page);
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "composed");
    const chip = page.locator(".rg-recipe[data-recipe='plan-and-invite']");
    expect(await chip.isDisabled()).toBe(false);
    // Plan and prepare needs a task list: none is connected on this page, so its task step will say so.
    await chip.click();
    expect((await st(page)).phase).toBe("planning");
    expect(await page.locator(".rg-title").innerText()).toBe("Recipe: Plan and invite");
    // What it is and what it cannot do, before it runs.
    expect(await page.locator(".rg-recipe-about").innerText()).toBe("Recast recipe · version 1");
    await page.locator(".rg-limits summary").click();
    expect(await page.locator(".rg-limits").innerText()).toMatch(/saved as a draft, never sent/);
    expect(await page.locator("[data-placed='event'], [data-placed='draft']").count()).toBe(0);      // the review writes nothing
    await page.getByRole("button", { name: "Use “Meet Maya at Dakshin”" }).click();
    const steps = page.locator(".rg-steps li");
    await expect.poll(() => steps.evaluateAll((els) => els.map((e) => e.getAttribute("data-status")))).toEqual(["ready", "ready"]);
    expect(await steps.nth(0).innerText()).toMatch(/Add the event to your calendar\s+Google Calendar · stand-in\s+Uses Maya Rao, Dakshin, Fri, 23 Oct, 7:30 PM/);
    expect(await steps.nth(1).innerText()).toMatch(/Draft a message to the people in it\s+Gmail · stand-in\s+Uses Maya Rao, the event\s+Recast's wording; edit it in your drafts/);
    await page.getByRole("button", { name: "Run 2 steps" }).click();
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "ran");
    expect(await page.locator(".rg-title").innerText()).toBe("Plan and invite: all 2 done");
    expect(await steps.evaluateAll((els) => els.map((e) => e.getAttribute("data-status")))).toEqual(["done", "done"]);
    expect(await page.locator("[data-slot='fri-1930'] [data-placed='event']").innerText()).toBe("Meet Maya at Dakshin · Dakshin");
    await page.locator("#tab-mail").click();
    expect(await page.locator("[data-placed='draft']").innerText()).toMatch(/To maya\.rao@example\.com\s+Hi Maya, are you free for Meet Maya at Dakshin on Friday 23 October at 7:30 PM\?/);
    await page.locator(".rg-steps li[data-step-id='invite'] [data-undo-step]").click();
    await page.waitForFunction(() => (globalThis as any).recast.state.run.steps[1].status === "undone");
    expect(await page.locator("[data-placed='draft']").count()).toBe(0);
    expect(await page.locator("[data-placed='event']").count()).toBe(1);
    await page.getByRole("button", { name: "Done" }).click();
    const s = await st(page);
    expect(s.phase).toBe("idle"); expect(s.desk).toEqual([id]);   // not everything stands (the draft was undone): the object stays
    expect(errors).toEqual([]); await ctx.close();
  });
  it("a recipe whose places are not all connected says which step cannot run, and runs the rest", async () => {
    const { page, ctx, errors } = await open();
    await makeDinner(page);
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "composed");
    await page.locator(".rg-recipe[data-recipe='plan-and-prepare']").click();
    await page.getByRole("button", { name: "Use “Meet Maya at Dakshin”" }).click();
    const prep = page.locator(".rg-steps li[data-step-id='prepare']");
    await expect.poll(() => prep.getAttribute("data-status")).toBe("blocked");
    expect(await prep.innerText()).toMatch(/A task list is not connected here/);
    expect(await prep.locator("input").isDisabled()).toBe(true);
    await page.getByRole("button", { name: "Run 1 step" }).click();
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "ran");
    expect(await page.locator(".rg-title").innerText()).toBe("Plan and prepare: all 1 done");
    expect(errors).toEqual([]); await ctx.close();
  });
});

describe("a personal saved workflow (stand-ins; kept in this browser's storage)", () => {
  it("place once, save it with a name, reload, run it on new information with its own review and read-back; rename; delete", async () => {
    const { page, ctx, errors } = await open();
    await makeDinner(page);
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "composed");
    expect(await page.locator(".rg-mine").count()).toBe(0);                 // nothing saved yet
    await page.getByRole("button", { name: /Choose where it goes/ }).click();
    await page.waitForFunction(() => document.querySelector(".rg")!.getAnimations().length === 0);
    await page.getByRole("button", { name: "Open" }).click();
    expect((await st(page)).phase).toBe("previewing");
    // Save is offered in the review; pressing it asks for a name and saves nothing yet.
    await page.getByRole("button", { name: "Save as workflow" }).click();
    expect(await page.evaluate(() => localStorage.getItem("recast.workflows"))).toBeNull();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect(await page.locator(".rg-error").innerText()).toBe("Give it a name");
    await page.getByLabel("Name for this workflow").fill("Dinner plan");
    await page.getByLabel("Name for this workflow").press("Enter");
    expect(await page.locator(".rg-saved").innerText()).toMatch(/^Saved "Dinner plan"/);
    expect((await st(page)).phase).toBe("previewing");                       // saving placed nothing
    expect(await page.locator("[data-placed='event']").count()).toBe(0);
    const stored = (await page.evaluate(() => localStorage.getItem("recast.workflows")))!;
    expect(JSON.parse(stored)).toEqual([expect.objectContaining({ name: "Dinner plan", needs: "Event", steps: [expect.objectContaining({ id: "place", destination: "google-calendar.calendar" })] })]);
    for (const secret of ["Maya", "Dakshin", "dakshin.example", "7:30", "people.example"]) expect(stored).not.toContain(secret);

    // A new page (the same browser): the workflow is read back and checked; new information goes through it.
    await page.reload(); await page.locator("#recast-trigger").click();
    await drag(page, "#arjun", "#dakshin", "#tab-restaurant");
    let s = await st(page); const id = s.desk[0];
    await drag(page, "#dakshin-time", objectSel(id));
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "composed");
    const chip = page.locator(".rg-mine .rg-recipe", { hasText: "Dinner plan" });
    expect(await chip.isDisabled()).toBe(false);
    await chip.click();
    expect((await st(page)).phase).toBe("planning");
    expect(await page.locator(".rg-title").innerText()).toBe("Recipe: Dinner plan");
    expect(await page.locator("[data-placed='event']").count()).toBe(0);    // the review writes nothing
    // What is missing is asked here, as in any review.
    const step = page.locator(".rg-steps li[data-step-id='place']");
    expect(await step.getAttribute("data-status")).toBe("blocked");
    await page.getByRole("button", { name: "Use “Meet Arjun at Dakshin”" }).click();
    await expect.poll(() => step.getAttribute("data-status")).toBe("ready");
    expect(await step.innerText()).toMatch(/Place it in Google Calendar\s+Google Calendar · stand-in\s+Uses Arjun Mehta, Dakshin/);
    expect(await page.getByRole("button", { name: "Save as workflow" }).count()).toBe(0);   // it already is one
    await page.getByRole("button", { name: "Run 1 step" }).click();
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "ran");
    await expect.poll(() => step.innerText()).toMatch(/Read back from Google Calendar: \d+ of \d+ fields match/);
    expect(await page.locator("[data-slot='fri-1930'] [data-placed='event']").innerText()).toBe("Meet Arjun at Dakshin · Dakshin");
    await page.getByRole("button", { name: "Done" }).click();

    // Manage: rename (refusing a name already taken), then delete after asking once more.
    await page.locator("#tab-profile").click();
    await drag(page, "#maya", "#dakshin", "#tab-restaurant");
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "composed");
    await page.getByRole("button", { name: "Manage" }).click();
    expect(await page.locator(".rg-title").innerText()).toBe("Your workflows");
    await page.getByRole("button", { name: "Rename" }).click();
    await page.getByLabel("New name for Dinner plan").fill("Plan and invite");
    await page.getByRole("button", { name: "Rename" }).click();
    expect(await page.locator(".rg-error").innerText()).toMatch(/already a workflow called "Plan and invite"/);
    await page.getByLabel("New name for Dinner plan").fill("Friday dinners");
    await page.getByLabel("New name for Dinner plan").press("Enter");
    await expect.poll(() => page.locator(".rg-wf .rg-step-label").innerText()).toBe("Friday dinners");
    expect(JSON.parse((await page.evaluate(() => localStorage.getItem("recast.workflows")))!)[0].name).toBe("Friday dinners");
    await page.getByRole("button", { name: "Delete" }).click();
    expect(await page.locator(".rg-wf").innerText()).toMatch(/Delete “Friday dinners”\? Nothing it already placed is changed/);
    await page.getByRole("button", { name: "Delete" }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("recast.workflows"))).toBe("[]");
    expect(await page.locator(".rg-title").innerText()).toBe("Ready to place");          // nothing left to manage
    expect(await page.locator("[data-slot='fri-1930'] [data-placed='event']").count()).toBe(1);   // what it placed stands
    expect(errors).toEqual([]); await ctx.close();
  });
  it("a stored workflow that is outdated or names a destination Recast does not have is shown with the reason, never run", async () => {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, timezoneId: "Asia/Kolkata" });
    await ctx.addInitScript(() => { try { if (!sessionStorage.getItem("seeded")) { sessionStorage.setItem("seeded", "1"); localStorage.setItem("recast.workflows", JSON.stringify([
      { id: "wf_old", version: 7, name: "From the future", description: "", origin: "saved", needs: "Event", steps: [{ id: "place", label: "x", targetKind: "Calendar" }], limitations: [] },
      { id: "wf_gone", version: 1, name: "Old notes", description: "An event → Evernote", origin: "saved", needs: "Event", steps: [{ id: "place", label: "Place it in Evernote", targetKind: "Calendar", destination: "evernote.notes", app: "Evernote" }], limitations: [] },
    ])); } } catch { /* storage blocked: nothing to seed */ } });
    const page = await ctx.newPage(); const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/clay.html?${Q}`); await page.locator("#recast-trigger").click();
    await makeDinner(page);
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "composed");
    expect(await page.locator(".rg-mine .rg-recipe").count()).toBe(0);         // neither is offered to run
    await page.getByRole("button", { name: "Manage" }).click();
    const rows = page.locator(".rg-wf");
    expect(await rows.nth(0).innerText()).toMatch(/From the future\s+Cannot be used: it was saved by a different version of Recast/);
    expect(await rows.nth(1).innerText()).toMatch(/Old notes\s+Cannot be used: it goes to evernote\.notes, which Recast cannot place in any more/);
    expect(await rows.nth(0).getByRole("button", { name: "Rename" }).count()).toBe(0);
    await rows.nth(1).getByRole("button", { name: "Delete" }).click();
    await rows.nth(1).getByRole("button", { name: "Delete" }).click();
    await expect.poll(async () => JSON.parse((await page.evaluate(() => localStorage.getItem("recast.workflows")))!).map((x: any) => x.id)).toEqual(["wf_old"]);
    expect(errors).toEqual([]); await ctx.close();
  });
});

describe("an error → an issue (stand-in for GitHub issues)", () => {
  it("the note is pressed into the error; Tasks opens an issue after a confirm; everything captured is quoted; Undo closes it", async () => {
    const { page, ctx, errors } = await open();
    await page.locator("#tab-build").click();
    await drag(page, "#build-note", "#build-error");
    const s = await st(page); const id = s.focus;
    expect(s.objects[id].ingredients.map((f: any) => f.kind)).toEqual(["error", "text"]);
    await page.getByRole("button", { name: /Choose where it goes/ }).click();
    expect(await page.locator(".rg-drum").getAttribute("aria-activedescendant")).toBe("rg-opt-tasks");
    await page.waitForFunction(() => document.querySelector(".rg")!.getAnimations().length === 0);
    await page.getByRole("button", { name: "Open" }).click();
    expect(await page.locator(".rg-body").innerText()).toMatch(/Stand-in: GitHub here is a local stand-in/);
    await page.getByRole("button", { name: /^Use “TypeError/ }).click();
    await page.getByRole("button", { name: "Confirm: Open an issue" }).click();
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "succeeded");
    const issue = page.locator("[data-placed='issue']");
    expect(await issue.count()).toBe(1);
    expect(await issue.locator("strong").innerText()).toBe("TypeError: Cannot read properties of undefined (reading 'id')");
    expect(await issue.locator(".doc-body").innerText()).toContain("**Notes**\n```text\nIt started after the sign-in change.\n```");
    await page.getByRole("button", { name: "Undo" }).click();
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "idle");
    expect(await page.locator("[data-placed='issue']").count()).toBe(0);
    expect(errors).toEqual([]); await ctx.close();
  });
});

describe("two quotes → a note → Docs (stand-in for Google Docs)", () => {
  it("Maya's line pressed into the review is a note; the review suggests a title; the Docs tab gets each quote with its page; Undo removes it", async () => {
    const { page, ctx, errors } = await open();
    await drag(page, "#maya-line", "#dakshin-review", "#tab-restaurant");
    let s = await st(page); const id = s.focus;
    expect(s).toMatchObject({ phase: "composed" }); expect(s.objects[id].ingredients.map((f: any) => f.kind)).toEqual(["text", "text"]);
    await page.getByRole("button", { name: /Choose where it goes/ }).click();
    expect(await page.locator(".rg-drum").getAttribute("aria-activedescendant")).toBe("rg-opt-documents");
    await page.waitForFunction(() => document.querySelector(".rg")!.getAnimations().length === 0);
    await page.getByRole("button", { name: "Open" }).click();
    expect((await st(page)).phase).toBe("previewing");
    expect(await page.locator(".rg-body").innerText()).toMatch(/Stand-in: Google Docs here is a local stand-in/);
    await page.getByRole("button", { name: /^Use “/ }).click();
    await page.getByRole("button", { name: "Create a document" }).click();
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "succeeded");
    await page.locator("#tab-docs").click();
    const doc = page.locator("[data-placed='doc']");
    expect(await doc.count()).toBe(1);
    expect(await doc.locator(".doc-body").innerText()).toBe("“The filter coffee alone is worth the trip.”\n— Dakshin · Restaurant, dakshin.example\n\n“Free for dinner this week?”\n— Maya Rao · Profile, people.example/maya-rao");
    s = await st(page); expect(s.objects[id]).toBeDefined();
    await page.getByRole("button", { name: "Undo" }).click();
    await page.waitForFunction(() => (globalThis as any).recast.state.phase === "idle");
    expect(await page.locator("[data-placed='doc']").count()).toBe(0);
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

