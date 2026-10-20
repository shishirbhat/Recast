// Cross-tab carry in real Chromium with the extension loaded: the clump state lives in the service worker, each tab
// rebuilds the carried object from it, and placement runs in the tab that owns the destination. Fixture pages are local.
import { chromium, type BrowserContext, type Page, type Worker } from "playwright-core";
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ext = path.join(root, "dist-test");
let server: Server, ctx: BrowserContext, base: string, sw: Worker;
const chromiumPath = () => process.env.RECAST_CHROMIUM ?? (existsSync("/opt/pw-browsers/chromium") && !existsSync("/opt/pw-browsers/chromium/chrome") ? "/opt/pw-browsers/chromium" : undefined);

beforeAll(async () => {
  server = createServer((req, res) => { const f = path.join(root, "test/fixtures", (req.url ?? "/").replace(/^\/+/, "").split("?")[0]!); if (!existsSync(f)) { res.writeHead(404).end(); return; } res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(f)); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const profile = path.join(root, "dist-test/.profile-clay"); rmSync(profile, { recursive: true, force: true });
  ctx = await chromium.launchPersistentContext(profile, { executablePath: chromiumPath(), headless: false, timezoneId: "Asia/Kolkata", viewport: { width: 1200, height: 800 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--headless=new", "--no-first-run"] });
  sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker");
});
afterAll(async () => { await ctx?.close(); server?.close(); });

/** What the person does with the shortcut (Alt+Shift+R) or the toolbar button: bring Recast into this tab. */
async function openTab(fixture: string): Promise<Page> {
  const page = await ctx.newPage(); await page.goto(`${base}/${fixture}`);
  await sw.evaluate(async (u) => { const t = (await chrome.tabs.query({ url: u })).sort((a, b) => b.id! - a.id!)[0]; await (globalThis as any).recastClay.activate(t!.id); }, `${base}/${fixture}`);
  await page.locator("recast-clay").waitFor({ state: "attached", timeout: 10000 });
  return page;
}
const stored = () => sw.evaluate(async () => (await chrome.storage.session.get("clay"))["clay"]) as Promise<any>;
const centre = async (p: Page, sel: string) => { const b = (await p.locator(sel).first().boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
const item = (id: string) => `recast-clay >> .clay-item[data-id="${id}"]`;
async function until(fn: () => Promise<boolean>, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error("timed out"); }
async function atRest(p: Page, sel: string) { let prev = ""; for (let i = 0; i < 40; i++) { const k = JSON.stringify(await p.locator(sel).first().boundingBox()); if (k === prev) return; prev = k; await p.waitForTimeout(60); } }
async function drag(p: Page, from: string, to: string) {
  await atRest(p, from); const a = await centre(p, from); await p.mouse.move(a.x, a.y); await p.mouse.down(); await p.mouse.move(a.x + 10, a.y + 10, { steps: 3 });
  const b = await centre(p, to); await p.mouse.move(b.x, b.y, { steps: 10 }); await p.mouse.move(b.x + 1, b.y + 1); await p.waitForTimeout(150); await p.mouse.up();
}
async function altDrag(p: Page, from: string, to: string) {
  const a = await centre(p, from); await p.mouse.move(a.x, a.y); await p.keyboard.down("Alt"); await p.mouse.down(); await p.keyboard.up("Alt");
  await p.mouse.move(a.x + 10, a.y + 10, { steps: 3 }); const b = await centre(p, to); await p.mouse.move(b.x, b.y, { steps: 10 }); await p.mouse.move(b.x + 1, b.y + 1); await p.waitForTimeout(150); await p.mouse.up();
}

describe("cross-tab carry in the browser extension", () => {
  it("Maya, lifted in one tab and carried to another, is pressed into the restaurant; closing her tab loses nothing; the time joins; the calendar page takes it", async () => {
    // 1. Profile tab: Alt + press on Maya's name lifts her. The button is still held when the person switches tabs.
    const profile = await openTab("profile.html");
    const m = await centre(profile, "#maya"); await profile.mouse.move(m.x, m.y); await profile.keyboard.down("Alt"); await profile.mouse.down(); await profile.keyboard.up("Alt");
    await profile.mouse.move(m.x + 30, m.y + 20, { steps: 4 });
    await until(async () => (await stored())?.carried === "obj-1");
    expect((await stored()).objects["obj-1"].ingredients[0]).toMatchObject({ kind: "person", text: "Maya Rao", value: { name: "Maya Rao" }, source: { title: "Maya Rao · Profile" } });

    // 2. Restaurant tab: Recast rebuilds the object in hand from the worker's state; drag it onto the restaurant's name.
    const restaurant = await openTab("restaurant.html"); await restaurant.bringToFront();
    await restaurant.locator(item("obj-1")).waitFor();
    expect(await restaurant.locator("recast-clay >> .hint").innerText()).toBe("In hand: Maya Rao. Drag it onto something on this page.");
    await drag(restaurant, item("obj-1"), "#dakshin");
    await until(async () => { const s = await stored(); return s.phase === "idle" && s.desk.length === 1 && !s.carried; });
    let s = await stored(); const id = s.desk[0];
    expect(s.objects[id].ingredients.map((f: any) => [f.kind, f.text])).toEqual([["place", expect.stringContaining("Dakshin")], ["person", "Maya Rao"]]);
    await until(async () => (await restaurant.locator("recast-clay >> .clay-item").count()) === 1);

    // 3. The tab Maya came from closes; the object never belonged to it.
    await profile.close(); await new Promise((r) => setTimeout(r, 300));
    expect((await stored()).objects[id].ingredients).toHaveLength(2);

    // 4. The time on the restaurant page, Alt-dragged onto the object in the tray, joins it.
    await altDrag(restaurant, "#table-time", item(id));
    await until(async () => (await stored()).objects[id]?.ingredients.length === 3 && (await stored()).phase === "idle");
    expect(await restaurant.locator(item(id)).getAttribute("aria-label")).toMatch(/^Meet Maya at Dakshin, .*made of 3 pieces$/);

    // 5. Calendar tab: the object is in the tray there too; dropping it on a slot opens a review in that tab, nothing written.
    const cal = await openTab("calendar.html"); await cal.bringToFront();
    await cal.locator(item(id)).waitFor();
    await drag(cal, item(id), "#slot-fri");
    await until(async () => (await stored()).phase === "previewing");
    expect(await cal.locator("#events li").count()).toBe(0);
    await cal.locator("recast-clay >> button", { hasText: "Use “Meet Maya at Dakshin”" }).click();
    await cal.locator("recast-clay >> button", { hasText: "Add to calendar" }).click();
    await until(async () => (await stored()).phase === "succeeded");
    expect(await cal.locator("#events li").innerText()).toBe("Meet Maya at Dakshin · 2026-10-23T19:30 · Dakshin, 12 MG Road, Bengaluru 560001");
    s = await stored(); expect(s.placement.destinationId).toMatch(/^\d+:week$/);
    await cal.locator("recast-clay >> button", { hasText: "Undo" }).click();
    await until(async () => (await cal.locator("#events li").count()) === 0);
    await restaurant.close(); await cal.close();
  }, 120_000);

  it("the state is only in session storage, so a restarted worker carries on; a closed destination tab cancels its open review", async () => {
    // The tabs from the first test have closed; the worker forgets their destinations as it hears about it.
    await until(async () => (await stored())?.destinations.length === 0);
    const s = await stored(); expect(s).toBeTruthy();
    // The worker keeps nothing in memory between events: every event loads from storage.session and saves back.
    const fresh = await sw.evaluate(async () => (globalThis as any).recastClay.load()); expect(fresh).toEqual(s);
    const cal = await openTab("calendar.html"); await cal.bringToFront();
    const id = s.desk[0]; await cal.locator(item(id)).waitFor();
    await drag(cal, item(id), "#slot-sat");
    await until(async () => (await stored()).phase === "previewing");
    await cal.close();
    await until(async () => { const x = await stored(); return x.phase === "idle" && !x.destinations.length; });
    expect((await stored()).desk).toEqual([id]);
  }, 60_000);
});
