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
  ctx = await chromium.launchPersistentContext(profile, { executablePath: chromiumPath(), headless: false, timezoneId: "Asia/Kolkata",
    // timezoneId covers pages only, and reaches the extension's service worker only sometimes (not under load). TZ sets the
    // zone for every browser process, the worker included, so dates are read in Asia/Kolkata everywhere.
    env: { ...process.env, TZ: "Asia/Kolkata" }, viewport: { width: 1200, height: 800 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--headless=new", "--no-first-run"] });
  sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker");
});
afterAll(async () => { await ctx?.close(); server?.close(); });

const tabIdOf = (u: string) => sw.evaluate(async (u) => (await chrome.tabs.query({ url: u })).sort((a, b) => b.id! - a.id!)[0]!.id!, u);
/** What the person does to bring Recast into a tab (the toolbar, or Alt+Shift+R): the worker's command handler, for this tab. */
const command = async (p: Page) => { const id = await tabIdOf(p.url()); await sw.evaluate((id) => (globalThis as any).recastClay.invoke(id), id); };
/** Open a page and invoke Recast there: brought in (and turned on if it was off). */
async function openTab(fixture: string): Promise<Page> {
  const page = await ctx.newPage(); await page.goto(`${base}/${fixture}`);
  await command(page);
  await page.locator("recast-clay").waitFor({ state: "attached", timeout: 10000 });
  return page;
}
/** Destinations held by tabs or the local program; Google Maps (open and prefill) is always there and needs neither. */
const held = (x: any) => (x?.destinations ?? []).filter((d: any) => d.id !== "open:google-maps");
const stored = () => sw.evaluate(async () => (await chrome.storage.session.get("clay"))["clay"]) as Promise<any>;
const centre = async (p: Page, sel: string) => { const b = (await p.locator(sel).first().boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
const item = (id: string) => `recast-clay >> .clay-item[data-id="${id}"]`;
async function until(fn: () => Promise<boolean>, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } const x = await stored().catch(() => undefined); throw new Error(`timed out (phase ${x?.phase}, armed ${x?.armed}, carried ${x?.carried}, last ${JSON.stringify(x?.last?.text)})`); }
async function atRest(p: Page, sel: string) { let prev = ""; for (let i = 0; i < 40; i++) { const k = JSON.stringify(await p.locator(sel).first().boundingBox()); if (k === prev) return; prev = k; await p.waitForTimeout(60); } }
async function drag(p: Page, from: string, to: string) {
  await atRest(p, from); const a = await centre(p, from); await p.mouse.move(a.x, a.y); await p.mouse.down(); await p.mouse.move(a.x + 10, a.y + 10, { steps: 3 });
  const b = await centre(p, to); await p.mouse.move(b.x, b.y, { steps: 10 }); await p.mouse.move(b.x + 1, b.y + 1); await p.waitForTimeout(150); await p.mouse.up();
}
async function altDrag(p: Page, from: string, to: string) {
  const a = await centre(p, from); await p.mouse.move(a.x, a.y); await p.keyboard.down("Alt"); await p.mouse.down(); await p.keyboard.up("Alt");
  await p.mouse.move(a.x + 10, a.y + 10, { steps: 3 }); await atRest(p, to); const b = await centre(p, to); await p.mouse.move(b.x, b.y, { steps: 10 }); await p.mouse.move(b.x + 1, b.y + 1); await p.waitForTimeout(150); await p.mouse.up();
}

describe("cross-tab carry in the browser extension", () => {
  it("Maya, lifted in one tab and carried to another, is pressed into the restaurant; closing her tab loses nothing; the time joins; the calendar page takes it", async () => {
    // 1. Profile tab: Alt + press on Maya's name lifts her. The button is still held when the person switches tabs.
    const profile = await openTab("profile.html");
    expect((await stored()).armed).toBe(true);
    const m = await centre(profile, "#maya"); await profile.mouse.move(m.x, m.y); await profile.keyboard.down("Alt"); await profile.mouse.down(); await profile.keyboard.up("Alt");
    await profile.mouse.move(m.x + 30, m.y + 20, { steps: 4 });
    await until(async () => (await stored())?.carried === "obj-1");
    expect((await stored()).objects["obj-1"].ingredients[0]).toMatchObject({ kind: "person", text: "Maya Rao", value: { name: "Maya Rao" }, source: { title: "Maya Rao · Profile" } });

    // 2. Restaurant tab: Recast rebuilds the object in hand from the worker's state; drag it onto the restaurant's name.
    const restaurant = await openTab("restaurant.html"); await restaurant.bringToFront();
    await restaurant.locator(item("obj-1")).waitFor();
    expect(await restaurant.locator("recast-clay >> .hint").innerText()).toBe("In hand: Maya Rao. Drag it onto something on this page.");
    await drag(restaurant, item("obj-1"), "#dakshin");
    // Two things pressed together: the composition exists and the glass module opens on it.
    await until(async () => { const s = await stored(); return s.phase === "composed" && s.desk.length === 1 && !s.carried; });
    let s = await stored(); const id = s.desk[0];
    expect(s.objects[id].ingredients.map((f: any) => [f.kind, f.text])).toEqual([["place", expect.stringContaining("Dakshin")], ["person", "Maya Rao"]]);
    await until(async () => (await restaurant.locator("recast-clay >> .clay-item").count()) === 1);
    expect(await restaurant.locator("recast-clay >> .rg").getAttribute("data-mode")).toBe("composed");

    // 3. The tab Maya came from closes; the object never belonged to it.
    await profile.close(); await new Promise((r) => setTimeout(r, 300));
    expect((await stored()).objects[id].ingredients).toHaveLength(2);

    // 4. The time on the restaurant page, Alt-dragged onto the object in the tray, joins it.
    await altDrag(restaurant, "#table-time", item(id));
    await until(async () => (await stored()).objects[id]?.ingredients.length === 3 && (await stored()).phase === "composed");
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
    // The stand-in calendar page is read back, too: the receipt never stays on "checking".
    await until(async () => { const v = (await stored()).placement?.verification; return !!v && v !== "checking"; });
    expect((await stored()).placement.verification).toMatchObject({ ok: true });
    s = await stored(); expect(s.placement.destinationId).toMatch(/^\d+:week$/);
    await cal.locator("recast-clay >> button", { hasText: "Undo" }).click();
    await until(async () => (await cal.locator("#events li").count()) === 0);
    await restaurant.close(); await cal.close();
  }, 120_000);

  it("the module's selector: Calendar is unavailable until a calendar is open; chosen, Recast brings its tab to the front; then off, the page is just a page", async () => {
    await until(async () => held(await stored()).length === 0);
    const restaurant = await openTab("restaurant.html");
    const id = (await stored()).focus as string;
    expect((await stored()).phase).toBe("idle");                       // brought along: on, with the composition ready
    expect(await restaurant.locator("recast-clay >> .rg-title").innerText()).toBe("Meet Maya at Dakshin is ready");
    await command(restaurant); await until(async () => (await stored()).phase === "composed");
    await command(restaurant); expect((await stored()).phase).toBe("composed");          // again: no second module
    expect(await restaurant.locator("recast-clay").count()).toBe(1); expect(await restaurant.locator("recast-clay >> .rg").count()).toBe(1);
    await restaurant.locator("recast-clay >> button", { hasText: "Choose where it goes" }).click();
    await until(async () => (await stored()).phase === "choosing");
    expect(await restaurant.locator("recast-clay >> #rg-opt-calendar").getAttribute("aria-disabled")).toBe("true");
    expect(await restaurant.locator("recast-clay >> .rg-reason").innerText()).toBe("Google Calendar or Outlook Calendar is not connected here");
    // A calendar page with Recast in it connects a (stand-in) calendar; the selector in the restaurant tab sees it.
    const cal = await openTab("calendar.html"); await restaurant.bringToFront();
    await until(async () => (await restaurant.locator("recast-clay >> #rg-opt-calendar").getAttribute("aria-disabled")) === "false");
    expect(await restaurant.locator("recast-clay >> .rg-reason").innerText()).toMatch(/^Google Calendar: add to calendar\. Read back after placing · Undo\. A local stand-in/);
    await restaurant.locator("recast-clay >> button", { hasText: "Open" }).click();
    await until(async () => (await stored()).phase === "previewing");
    const calTab = await tabIdOf(cal.url());
    await until(() => sw.evaluate(async (id) => { const t = await chrome.tabs.get(id); return t.active && (await chrome.windows.get(t.windowId)).focused; }, calTab));
    expect(await cal.locator("#events li").count()).toBe(0);           // choosing and reviewing write nothing
    await cal.locator("recast-clay >> button", { hasText: "Add to calendar" }).click();
    await until(async () => (await stored()).phase === "succeeded");
    expect(await cal.locator("#events li").count()).toBe(1);
    // Undo (not Done): an undone placement keeps its object, which the rest of this test and the next one use. Done would
    // retire it from the desk (machine and clay-page tests cover that).
    await cal.locator("recast-clay >> button", { hasText: "Undo" }).click();
    await until(async () => (await stored()).phase === "idle");
    expect(await cal.locator("#events li").count()).toBe(0); expect((await stored()).desk).toContain(id);
    // Escape with nothing open turns Recast off; Alt + press on the page then does nothing.
    await restaurant.bringToFront(); await restaurant.keyboard.press("Escape");
    await until(async () => (await stored()).armed === false);
    const before = Object.keys((await stored()).objects).length;
    const t = (await restaurant.locator("#table-time").boundingBox())!;
    await restaurant.keyboard.down("Alt"); await restaurant.mouse.click(t.x + 5, t.y + 5); await restaurant.keyboard.up("Alt");
    await new Promise((r) => setTimeout(r, 300));
    expect(Object.keys((await stored()).objects).length).toBe(before);
    expect(await restaurant.locator("recast-clay >> .rg").isHidden()).toBe(true);
    expect((await stored()).objects[id]).toBeTruthy();                 // off, and the composition is kept for the session
    // Control twice, in a tab Recast is in: on again. A Ctrl+C in between does not count.
    await restaurant.keyboard.press("Control+c"); await restaurant.keyboard.press("Control"); await restaurant.keyboard.press("Control");
    await until(async () => { const x = await stored(); return x.armed === true && x.phase === "composed"; });   // on, and the composition reopened
    await restaurant.keyboard.press("Control"); await until(async () => (await stored()).armed === false);      // once: off
    expect((await stored()).focus).toBe(id);                                                                  // composition kept
    // The popup's button does what the shortcut does.
    const extId = new URL(sw.url()).host; const tabId = await tabIdOf(restaurant.url());
    const popup = await ctx.newPage(); await popup.goto(`chrome-extension://${extId}/popup.html?tabId=${tabId}`);
    // Where things are kept, said every time the popup opens.
    expect(await popup.locator("#data-note").innerText()).toMatch(/stays in this browser while it is open.*cleared when the browser closes/);
    await popup.getByRole("button", { name: /Clump things on this page/ }).click();
    await until(async () => (await stored()).armed === true);
    await restaurant.close(); await cal.close();
  }, 120_000);

  it("the time zone is where the browser is now: a state kept from another zone reads dates in the current one", async () => {
    const zone = await sw.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(zone).toMatch(/^Asia\/(Kolkata|Calcutta)$/);
    // As if the session started elsewhere (before a flight, or before a system change).
    // Through the worker's own queue, like every real event, so this never races the worker's other saves.
    // What that event saved (any later event moves it back, which is the behaviour under test).
    const saved = await sw.evaluate(() => (globalThis as any).recastClay.dispatch({ type: "setTimezone", timezone: "Europe/Lisbon" })) as any;
    expect(saved.state.timezone).toBe("Europe/Lisbon");
    const loaded = await sw.evaluate(() => (globalThis as any).recastClay.load()) as any;
    expect(loaded.timezone).toBe(zone);
    // Leave the session in the zone the browser is in, as the next event would.
    await sw.evaluate((zone) => (globalThis as any).recastClay.dispatch({ type: "setTimezone", timezone: zone }), zone);
  });

  it("the state is only in session storage, so a restarted worker carries on; a closed destination tab cancels its open review", async () => {
    // The tabs from the first test have closed; the worker forgets their destinations as it hears about it.
    await until(async () => held(await stored()).length === 0);
    const s = await stored(); expect(s).toBeTruthy();
    // The worker keeps nothing in memory between events: every event loads from storage.session and saves back.
    const fresh = await sw.evaluate(async () => (globalThis as any).recastClay.load()); expect(fresh).toEqual(s);
    const cal = await openTab("calendar.html"); await cal.bringToFront();
    const id = s.desk[0]; await cal.locator(item(id)).waitFor();
    await drag(cal, item(id), "#slot-sat");
    await until(async () => (await stored()).phase === "previewing");
    await cal.close();
    await until(async () => { const x = await stored(); return x.phase === "idle" && !held(x).length; });
    expect((await stored()).desk).toEqual([id]);
  }, 60_000);

  it("survives a real worker stop, a destination tab closing mid-write (unknown, never resent), and a tab reload; a retired object stays retired", async () => {
    // 1. A real worker restart. Chromium stops the extension's worker (DevTools Target.closeTarget); the next message wakes
    //    a fresh one, which knows only what is in storage.session.
    const restaurant = await openTab("restaurant.html");
    const id = (await stored()).focus as string; expect(id).toBeTruthy();
    const restaurantTab = await tabIdOf(restaurant.url());
    const before = await stored();
    await sw.evaluate(() => { (globalThis as any).__alive = "before-restart"; });
    const cdp = await ctx.newCDPSession(restaurant);
    const { targetInfos } = await cdp.send("Target.getTargets");
    await cdp.send("Target.closeTarget", { targetId: targetInfos.find((t: any) => t.type === "service_worker")!.targetId });
    const extId = new URL(sw.url()).host;
    const popup = await ctx.newPage(); await popup.goto(`chrome-extension://${extId}/popup.html?tabId=${restaurantTab}`);
    await popup.getByRole("button", { name: /Clump things on this page/ }).click();      // wakes the worker
    await until(async () => { for (const w of ctx.serviceWorkers()) { try { if ((await w.evaluate(() => (globalThis as any).__alive ?? "fresh")) === "fresh") { sw = w; return true; } } catch { /* the stopped one */ } } return false; });
    expect((await stored()).desk).toEqual(before.desk);                                   // nothing lost
    await until(async () => (await stored()).phase === "composed");                        // the command still works
    await popup.close();

    // 2. The calendar tab closes while its write is in flight: Recast cannot know whether it landed. Unknown, not failed,
    //    not succeeded; the check is refused while the calendar is not open; "Check later" remembers the doubt.
    const cal = await openTab("calendar.html");
    await cal.evaluate(() => { document.querySelector<HTMLElement>("#cal")!.dataset["recastDelay"] = "4000"; });
    await restaurant.bringToFront();
    await restaurant.locator("recast-clay >> button", { hasText: "Choose where it goes" }).click();
    await until(async () => (await stored()).phase === "choosing");
    await until(async () => (await restaurant.locator("recast-clay >> #rg-opt-calendar").getAttribute("aria-disabled")) === "false");
    await restaurant.locator("recast-clay >> button", { hasText: "Open" }).click();
    await until(async () => (await stored()).phase === "previewing");
    await cal.locator("recast-clay >> button", { hasText: "Add to calendar" }).click();
    await until(async () => (await stored()).phase === "executing");
    await cal.close();
    await until(async () => (await stored()).phase === "unknown");
    expect((await stored()).placement.message).toBe("Calendar closed before it answered");
    await restaurant.bringToFront();
    await restaurant.locator("recast-clay >> button[data-act=reconcile]").click();
    await until(async () => /is not open here/.test(await restaurant.locator("recast-clay >> .rg-error").innerText().catch(() => "")));
    expect((await stored()).phase).toBe("unknown");
    await restaurant.locator("recast-clay >> button", { hasText: "Check later" }).click();
    await until(async () => (await stored()).phase === "idle");
    expect(Object.keys((await stored()).uncertain)).toEqual([id]);

    // 3. A new calendar tab. Choosing Calendar again goes to the check, not to a second write; the closed tab's write
    //    never happened, so the check says so and only then may it be placed again.
    const cal2 = await openTab("calendar.html"); await restaurant.bringToFront();
    await command(restaurant); await until(async () => (await stored()).phase === "composed");
    await restaurant.locator("recast-clay >> button", { hasText: "Choose where it goes" }).click();
    await until(async () => (await restaurant.locator("recast-clay >> #rg-opt-calendar").getAttribute("aria-disabled")) === "false");
    await restaurant.locator("recast-clay >> button", { hasText: "Open" }).click();
    await until(async () => (await stored()).phase === "unknown");
    expect(await cal2.locator("#events li").count()).toBe(0);
    await restaurant.locator("recast-clay >> button[data-act=reconcile]").click();
    await until(async () => (await stored()).phase === "failed");
    expect((await stored()).last.text).toMatch(/was not added to Calendar\. It is safe to place again/);
    await restaurant.locator("recast-clay >> button", { hasText: "Close" }).click();
    await until(async () => { const x = await stored(); return x.phase === "idle" && Object.keys(x.uncertain).length === 0; });

    // 4. Now placed for real, and the receipt closed: the object retires. Reloading the tab and bringing Recast back does
    //    not resurrect it.
    await command(restaurant); await until(async () => (await stored()).phase === "composed");
    await restaurant.locator("recast-clay >> button", { hasText: "Choose where it goes" }).click();
    await until(async () => (await restaurant.locator("recast-clay >> #rg-opt-calendar").getAttribute("aria-disabled")) === "false");
    await restaurant.locator("recast-clay >> button", { hasText: "Open" }).click();
    await until(async () => (await stored()).phase === "previewing");
    await cal2.locator("recast-clay >> button", { hasText: "Add to calendar" }).click();
    await until(async () => (await stored()).phase === "succeeded");
    expect(await cal2.locator("#events li").count()).toBe(1);
    await cal2.locator("recast-clay >> button", { hasText: "Done" }).click();
    await until(async () => { const x = await stored(); return x.phase === "idle" && !x.objects[id]; });
    await restaurant.reload();
    expect(await restaurant.locator("recast-clay").count()).toBe(0);                     // a reload removes the layer (activeTab)
    await command(restaurant); await restaurant.locator("recast-clay").waitFor({ state: "attached" });
    await new Promise((r) => setTimeout(r, 300));
    expect((await stored()).objects[id]).toBeUndefined(); expect(await restaurant.locator("recast-clay >> .clay-item").count()).toBe(0);
    await restaurant.close(); await cal2.close();
  }, 120_000);
});

describe("a place on a real page → Google Maps (open and prefill)", () => {
  it("Alt-press the restaurant, put it down, look inside, choose Google Maps under More: the review is a link to directions; done says opened, no Undo", async () => {
    const opened: string[] = [];
    await ctx.route("https://www.google.com/**", (r) => { opened.push(r.request().url()); return r.fulfill({ status: 200, contentType: "text/html", body: "<title>Maps</title>" }); });
    const restaurant = await openTab("restaurant.html");
    // Objects left by the tests above (bringing Recast here reopens one) would catch the drop; clear the desk first.
    await until(async () => (await stored()).armed);
    await new Promise((r) => setTimeout(r, 300));
    for (const old of (await stored()).desk as string[]) await sw.evaluate((id) => (globalThis as any).recastClay.dispatch({ type: "discard", id }), old);
    await until(async () => { const x = await stored(); return x.desk.length === 0 && x.phase === "idle" && !x.focus; });
    const a = await centre(restaurant, "#dakshin");
    await restaurant.mouse.move(a.x, a.y); await restaurant.keyboard.down("Alt"); await restaurant.mouse.down(); await restaurant.keyboard.up("Alt");
    await until(async () => !!(await stored()).carried);
    const id = (await stored()).carried as string;
    expect((await stored()).objects[id].ingredients[0]).toMatchObject({ kind: "place", value: { name: "Dakshin", address: "12 MG Road, Bengaluru 560001" } });
    await restaurant.mouse.move(1100, 600, { steps: 5 }); await restaurant.mouse.up();   // empty page, away from the time and the module
    await until(async () => { const x = await stored(); return !x.carried && x.desk.includes(id); });
    await atRest(restaurant, item(id)); await restaurant.locator(item(id)).click();
    await until(async () => (await stored()).phase === "inspecting");
    await restaurant.locator("recast-clay >> .rg-actions [data-act=placeIt]").click();
    await until(async () => (await stored()).phase === "composed");
    await restaurant.locator("recast-clay >> button", { hasText: "Choose where it goes" }).click();
    await until(async () => (await stored()).phase === "choosing");
    expect(await restaurant.locator("recast-clay >> .rg-drum").getAttribute("aria-activedescendant")).toBe("rg-opt-more");
    await restaurant.locator("recast-clay >> button", { hasText: "Open" }).click();
    const maps = restaurant.locator("recast-clay >> .rg-opt", { hasText: "Google Maps" });
    await until(async () => (await restaurant.locator("recast-clay >> .rg-opt.on .rg-label").innerText()) === "Google Maps"); await restaurant.waitForTimeout(150); await maps.click();
    await until(async () => (await stored()).phase === "previewing");
    const href = "https://www.google.com/maps/dir/?api=1&destination=Dakshin%2C%2012%20MG%20Road%2C%20Bengaluru%20560001";
    const link = restaurant.locator("recast-clay >> .rg-actions a[data-act=place]");
    expect(await link.getAttribute("href")).toBe(href);
    const [tab] = await Promise.all([ctx.waitForEvent("page"), link.click()]);
    await tab.waitForLoadState();
    await until(async () => (await stored()).phase === "succeeded");
    expect(opened).toEqual([href]);
    expect((await stored()).placement).toMatchObject({ undoable: false, receipt: { destination: "google-maps.directions", bridgeRef: href } });
    expect(await restaurant.locator("recast-clay >> .rg-title").innerText()).toBe("Opened Google Maps");
    expect(await restaurant.locator("recast-clay >> button", { hasText: "Undo" }).count()).toBe(0);
    await restaurant.locator("recast-clay >> button", { hasText: "Done" }).click();
    await until(async () => (await stored()).phase === "idle");
    await tab.close(); await restaurant.close(); await ctx.unroute("https://www.google.com/**");
  }, 60_000);
});

describe("phase two in the extension: select any text on a real page, move it as a blob", () => {
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
  it("no Alt needed: a selection shows a blob; tapping puts it on the desk; dragging a second blob onto it makes one note", async () => {
    const page = await openTab("empty.html");
    const send = (e: unknown) => sw.evaluate((e) => (globalThis as any).recastClay.dispatch(e), e);
    await until(async () => (await stored()).armed);
    for (let i = 0; i < 5 && (await stored()).phase !== "idle"; i++) await send({ type: "cancel" });
    for (const old of (await stored()).desk as string[]) await send({ type: "discard", id: old });
    await until(async () => { const x = await stored(); return x.desk.length === 0 && x.phase === "idle"; });
    const blob = page.locator("recast-clay >> .sel-blob");
    await mouseSelect(page, "p", "No structured data.");
    await until(async () => await blob.isVisible());
    expect(await blob.locator(".k").innerText()).toBe("Text");
    await blob.click();
    await until(async () => (await stored()).desk.length === 1);
    const first = (await stored()).desk[0] as string;
    expect((await stored()).objects[first].ingredients[0]).toMatchObject({ kind: "text", text: "No structured data.", source: { title: "Nothing here" } });
    expect(await blob.isHidden()).toBe(true);
    await mouseSelect(page, "h1", "Just a page");
    await until(async () => await blob.isVisible());
    await atRest(page, item(first));
    const b = await centre(page, "recast-clay >> .sel-blob"), t = await centre(page, item(first));
    await page.mouse.move(b.x, b.y); await page.mouse.down(); await page.mouse.move(b.x + 20, b.y + 20, { steps: 4 });
    await until(async () => !!(await stored()).carried);
    await page.mouse.move(t.x, t.y, { steps: 10 }); await page.mouse.move(t.x + 1, t.y + 1); await page.waitForTimeout(150); await page.mouse.up();
    await until(async () => { const x = await stored(); return x.objects[first]?.ingredients.length === 2; });
    expect((await stored()).objects[first].ingredients.map((f: any) => f.text)).toEqual(["No structured data.", "Just a page"]);
    await page.close();
  }, 60_000);
  it("by keyboard alone: Alt+Enter takes a selection; Space picks an object up; Enter on another presses them together; Enter opens the module; Escape steps back", async () => {
    const page = await openTab("empty.html");
    const send = (e: unknown) => sw.evaluate((e) => (globalThis as any).recastClay.dispatch(e), e);
    await until(async () => (await stored()).armed);
    for (let i = 0; i < 5 && (await stored()).phase !== "idle"; i++) await send({ type: "cancel" });
    for (const old of (await stored()).desk as string[]) await send({ type: "discard", id: old });
    await until(async () => { const x = await stored(); return x.desk.length === 0 && x.phase === "idle"; });
    const blob = page.locator("recast-clay >> .sel-blob");
    await mouseSelect(page, "p", "No structured data.");
    await until(async () => await blob.isVisible());
    expect(await blob.getAttribute("aria-label")).toMatch(/Alt\+Enter/);
    await page.keyboard.press("Alt+Enter");
    await until(async () => (await stored()).desk.length === 1);
    const first = (await stored()).desk[0] as string;
    await mouseSelect(page, "h1", "Just a page");
    await until(async () => await blob.isVisible());
    await page.keyboard.press("Alt+Enter");
    await until(async () => (await stored()).desk.length === 2);
    const second = (await stored()).desk.find((x: string) => x !== first) as string;
    // The second object has the keyboard; Space lifts it.
    await page.locator(item(second)).focus();
    await page.keyboard.press(" ");
    await until(async () => (await stored()).carried === second);
    await page.locator(item(first)).focus();
    await page.keyboard.press("Enter");
    await until(async () => { const x = await stored(); return x.objects[first]?.ingredients.length === 2 && !x.carried && x.phase !== "merging"; });
    expect((await stored()).desk).toEqual([first]);
    // Enter on it opens the module; Escape closes it again, nothing written.
    await page.locator(item(first)).focus();
    await page.keyboard.press("Enter");
    await until(async () => (await stored()).phase === "composed");
    await page.keyboard.press("Escape");
    await until(async () => (await stored()).phase === "idle");
    expect((await stored()).desk).toEqual([first]);
    // A merge whose tab closes before its fusion has played is settled, never left "pressing together" for good.
    const src = { app: "127.0.0.1", url: page.url(), title: "Nothing here" };
    await send({ type: "capture", fragment: { id: "k9", kind: "text", text: "One more line", confidence: 0.9, evidence: [{ locator: { kind: "user", value: "selection" } }], source: src }, carry: true });
    await send({ type: "approach", target: { kind: "object", id: first } }); await send({ type: "drop" });
    await until(async () => (await stored()).phase === "merging");
    await page.close();
    await until(async () => (await stored()).phase === "composed");
    expect((await stored()).objects[first].ingredients).toHaveLength(3);
    for (let i = 0; i < 5 && (await stored()).phase !== "idle"; i++) await send({ type: "cancel" });
    await send({ type: "discard", id: first });
    await until(async () => { const x = await stored(); return x.phase === "idle" && x.desk.length === 0; });
  }, 60_000);
  it("a link to a PDF, pressed with Alt, is the file as a document: its words and its kind, the file's address", async () => {
    const page = await openTab("article.html");
    const send = (e: unknown) => sw.evaluate((e) => (globalThis as any).recastClay.dispatch(e), e);
    await until(async () => (await stored()).armed);
    for (let i = 0; i < 5 && (await stored()).phase !== "idle"; i++) await send({ type: "cancel" });
    for (const old of (await stored()).desk as string[]) await send({ type: "discard", id: old });
    await until(async () => { const x = await stored(); return x.desk.length === 0 && x.phase === "idle"; });
    const a = await centre(page, "#report");
    await page.mouse.move(a.x, a.y); await page.keyboard.down("Alt"); await page.mouse.down(); await page.keyboard.up("Alt");
    await until(async () => !!(await stored()).carried);
    const id = (await stored()).carried as string;
    expect((await stored()).objects[id].ingredients[0]).toMatchObject({ kind: "page", text: "Board report (PDF)", value: { name: "Board report (PDF)", url: `${base}/files/Q3-board-report.pdf` } });
    await page.mouse.move(40, 400, { steps: 6 }); await page.mouse.up();
    await until(async () => (await stored()).desk.includes(id));
    await send({ type: "discard", id });
    await page.close();
  }, 60_000);
  it("a selected date reads as a time; text being typed in a field never shows a blob", async () => {
    const page = await openTab("restaurant.html");
    const blob = page.locator("recast-clay >> .sel-blob");
    await mouseSelect(page, "#table-time", "Friday 23 October, 7:30 PM");
    await until(async () => await blob.isVisible());
    expect(await blob.locator(".k").innerText()).toBe("Time");
    await page.evaluate(() => { const i = document.createElement("input"); i.id = "field"; i.value = "Friday 7 PM"; document.body.appendChild(i); i.focus(); i.select(); });
    await page.waitForTimeout(250);
    expect(await blob.isHidden()).toBe(true);
    await page.close();
  });
});


describe("saved workflows in the extension: kept in chrome.storage.local, checked as they are read", () => {
  it("reads the stored list on a fresh session, sets aside an unknown destination with its reason, and stores a delete", async () => {
    const keep = await stored();
    const wf = { id: "wf_abc123", version: 1, name: "Dinner plan", description: "An event → Google Calendar", origin: "saved", needs: "Event", limitations: [],
      steps: [{ id: "place", label: "Place it in Google Calendar", targetKind: "Calendar", destination: "google-calendar.calendar", app: "Google Calendar" }] };
    const gone = { ...wf, id: "wf_gone", name: "Old notes", steps: [{ ...wf.steps[0], destination: "evernote.notes" }] };
    await sw.evaluate(async (items) => chrome.storage.local.set({ workflows: items }), [wf, gone]);
    // A new session: wait until the tabs from earlier tests have stopped writing the session state, then start fresh.
    await until(async () => held(await stored()).length === 0);
    const s = await sw.evaluate(async () => { await chrome.storage.session.remove("clay"); return (globalThis as any).recastClay.load(); });
    expect(s.workflows.map((w: any) => w.name)).toEqual(["Dinner plan"]);
    expect(s.workflowIssues).toEqual([{ id: "wf_gone", name: "Old notes", reason: "it goes to evernote.notes, which Recast cannot place in any more" }]);
    await sw.evaluate(async (s) => { await chrome.storage.session.set({ clay: s }); }, s);
    const r = await sw.evaluate(async () => (globalThis as any).recastClay.dispatch({ type: "deleteWorkflow", id: "wf_gone" }));
    expect(r.error).toBeUndefined();
    expect(await sw.evaluate(async () => (await chrome.storage.local.get("workflows"))["workflows"])).toEqual([wf]);
    // Nothing else went into local storage: no objects, no page content.
    expect(Object.keys(await sw.evaluate(async () => chrome.storage.local.get(null))).filter((k) => k !== "confirmLevel")).toEqual(["workflows"]);
    await sw.evaluate(async (k) => { await chrome.storage.local.remove("workflows"); await chrome.storage.session.set({ clay: k }); }, keep);
  });
});
