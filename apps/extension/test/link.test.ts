// The extension and the Recast program on this computer (apps/calendar-link), in real Chromium. Google itself is a
// stand-in here (token endpoint and Calendar API answered in-process); the real-Google run is manual (docs/REAL_TEST_PLAN.md).
// Covers: pairing with a code the person allows, a composed event placed in "Google Calendar" from the glass module,
// Undo, a lost answer (unknown, then Check finds it), and that the extension never receives the Google token.
import { chromium, type BrowserContext, type Page, type Worker } from "playwright-core";
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync, rmSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLinkServer, GMAIL_SCOPE, SCOPE, TASKS_SCOPE } from "../../calendar-link/src/server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ext = path.join(root, "dist-test");
const chromiumPath = () => process.env.RECAST_CHROMIUM ?? (existsSync("/opt/pw-browsers/chromium") && !existsSync("/opt/pw-browsers/chromium/chrome") ? "/opt/pw-browsers/chromium" : undefined);

// Stand-in Google: events kept by id like the real API; `dropNext` makes the next insert land but its answer time out.
const events = new Map<string, Record<string, unknown>>(); let dropNext = false; const drafts = new Map<string, unknown>(); const tasks = new Map<string, unknown>(); const seenByGoogle: string[] = [];
const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fakeGoogle: typeof fetch = async (u, init) => {
  const url = String(u), method = init?.method ?? "GET"; seenByGoogle.push(`${method} ${url}`);
  if ((init?.headers as Record<string, string>)?.authorization !== "Bearer AT-1") return json(401, {});
  if (url.startsWith("https://tasks.googleapis.com/")) {
    if (method === "POST") { const id = `t${tasks.size + 1}`; tasks.set(id, JSON.parse(String(init!.body))); return json(200, { id }); }
    if (method === "DELETE") { tasks.delete(url.split("/tasks/").pop()!); return json(204, null); }
  }
  if (url.includes("/gmail/")) {
    if (method === "POST") { const id = `d${drafts.size + 1}`; drafts.set(id, JSON.parse(String(init!.body))); return json(200, { id, message: { id: `m${id}` } }); }
    if (method === "DELETE") { drafts.delete(url.split("/drafts/")[1]!); return json(204, null); }
  }
  const id = decodeURIComponent(url.split("/events/")[1]?.split("?")[0] ?? "");
  if (method === "POST") { const b = JSON.parse(String(init!.body)); if (events.has(b.id)) return json(409, {}); events.set(b.id, { ...b, status: "confirmed" }); if (dropNext) { dropNext = false; return json(504, {}); } return json(200, events.get(b.id)); }
  if (method === "GET") return events.has(id) ? json(200, events.get(id)) : json(404, {});
  if (method === "PUT") { events.set(id, JSON.parse(String(init!.body))); if (dropNext) { dropNext = false; return json(504, {}); } return json(200, events.get(id)); }
  if (method === "DELETE") { events.set(id, { ...events.get(id)!, status: "cancelled" }); return json(204, null); }
  return json(400, {});
};
const live = () => [...events.values()].filter((e) => e.status !== "cancelled");

let pages: Server, link: Server, ctx: BrowserContext, base: string, sw: Worker;
const dir = mkdtempSync(path.join(tmpdir(), "recast-link-ext-")); const tokenFile = path.join(dir, ".secrets", "google-token.json");
beforeAll(async () => {
  pages = createServer((req, res) => { const f = path.join(root, "test/fixtures", (req.url ?? "/").replace(/^\/+/, "").split("?")[0]!); if (!existsSync(f)) { res.writeHead(404).end(); return; } res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(f)); });
  await new Promise<void>((r) => pages.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${(pages.address() as { port: number }).port}`;
  // Already signed in (the sign-in itself is tested in apps/calendar-link).
  mkdirSync(path.dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, JSON.stringify({ access_token: "AT-1", refresh_token: "RT-1", expires_at: Date.now() + 3_600_000, scope: `${SCOPE} ${GMAIL_SCOPE} ${TASKS_SCOPE}`, token_type: "Bearer", connected_at: "test" }));
  link = createLinkServer({ clientId: "abc.apps.googleusercontent.com", clientSecret: "SECRET-x", port: 8787, tokenFile, fetch: fakeGoogle, tokenUrl: "https://google.test/token" });
  await new Promise<void>((r) => link.listen(8787, "127.0.0.1", r));
  const profile = path.join(root, "dist-test/.profile-link"); rmSync(profile, { recursive: true, force: true });
  ctx = await chromium.launchPersistentContext(profile, { executablePath: chromiumPath(), headless: false, timezoneId: "Asia/Kolkata", viewport: { width: 1200, height: 800 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--headless=new", "--no-first-run"] });
  sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker");
});
afterAll(async () => { await ctx?.close(); pages?.close(); link?.close(); });

const tabIdOf = (u: string) => sw.evaluate(async (u) => (await chrome.tabs.query({ url: u })).sort((a, b) => b.id! - a.id!)[0]!.id!, u);
const command = async (p: Page) => { const id = await tabIdOf(p.url()); await sw.evaluate((id) => (globalThis as any).recastClay.invoke(id), id); };
async function openTab(fixture: string) { const p = await ctx.newPage(); await p.goto(`${base}/${fixture}`); await command(p); await p.locator("recast-clay").waitFor({ state: "attached", timeout: 10000 }); return p; }
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
  await p.mouse.move(a.x + 10, a.y + 10, { steps: 3 }); await atRest(p, to); const b = await centre(p, to); await p.mouse.move(b.x, b.y, { steps: 10 }); await p.mouse.move(b.x + 1, b.y + 1); await p.waitForTimeout(150); await p.mouse.up();
}
async function chooseCalendar(p: Page) {
  await command(p); await until(async () => (await stored()).phase === "composed");
  await p.locator("recast-clay >> button", { hasText: "Choose where it goes" }).click();
  await until(async () => (await p.locator("recast-clay >> #rg-opt-calendar").getAttribute("aria-disabled")) === "false");
  await p.locator("recast-clay >> button", { hasText: "Open" }).click();
  await until(async () => (await stored()).phase === "previewing");
  const title = p.locator("recast-clay >> button", { hasText: "Use “Meet Maya at Dakshin”" });
  if (await title.count()) await title.click();
}

describe("the extension places in the real Google Calendar through the Recast program on this computer (Google stand-in)", () => {
  it("pairs only after the person allows the code; until then Calendar is not offered", async () => {
    const extId = new URL(sw.url()).host;
    const popup = await ctx.newPage(); await popup.goto(`chrome-extension://${extId}/popup.html?tabId=1`);
    // The test build already holds localhost (no permission prompt can be clicked here), so the popup asks the program
    // at once; in production that happens when the person presses "Connect the real Google Calendar".
    await popup.locator("#link-text .code").waitFor();
    const code = await popup.locator("#link-text .code").innerText(); expect(code).toMatch(/^\d{4}$/);
    expect((await stored())?.destinations ?? []).toHaveLength(0);
    // The program's page shows the same code; the person allows it there.
    const home = await ctx.newPage(); await home.goto("http://localhost:8787/");
    await expect(home.locator("body").innerText()).resolves.toContain(code);
    await home.getByRole("button", { name: "Allow" }).click();
    await popup.getByRole("button", { name: "I allowed it" }).click();
    await until(async () => /Connected\. Placing in Calendar adds a real event/.test(await popup.locator("#link-text").innerText()));
    expect((await stored()).destinations.map((d: any) => [d.id, d.label, !!d.standIn])).toEqual([["link:google-calendar", "Google Calendar", false], ["link:gmail-drafts", "Gmail drafts", false], ["link:google-tasks", "Google Tasks", false]]);
    expect(await popup.locator("#link-text").innerText()).toMatch(/Mail saves a real Gmail draft \(never sent\)/);
    expect(await popup.locator("#link-text").innerText()).toMatch(/Tasks adds a page to Google Tasks/);
    await popup.close(); await home.close();
  });

  it("a composed event goes to Google Calendar from the module, Undo removes it, a lost answer is checked, never resent", async () => {
    const profile = await openTab("profile.html");
    const m = await centre(profile, "#maya"); await profile.mouse.move(m.x, m.y); await profile.keyboard.down("Alt"); await profile.mouse.down(); await profile.keyboard.up("Alt");
    await profile.mouse.move(m.x + 30, m.y + 20, { steps: 4 });
    await until(async () => (await stored())?.carried === "obj-1");
    const restaurant = await openTab("restaurant.html"); await restaurant.bringToFront();
    await restaurant.locator(item("obj-1")).waitFor();
    await drag(restaurant, item("obj-1"), "#dakshin");
    await until(async () => { const s = await stored(); return s.phase === "composed" && s.desk.length === 1; });
    const id = (await stored()).desk[0]; await profile.close();
    await altDrag(restaurant, "#table-time", item(id));
    await until(async () => (await stored()).objects[id]?.ingredients.length === 3);

    // The review is in this tab (Google Calendar is not a tab), and says nothing about a stand-in.
    await chooseCalendar(restaurant);
    expect(await restaurant.locator("recast-clay").evaluate((h) => h.shadowRoot!.textContent)).not.toMatch(/stand-in/i);
    expect(live()).toHaveLength(0);                                        // reviewing writes nothing
    await restaurant.locator("recast-clay >> button", { hasText: "Add to calendar" }).click();
    await until(async () => (await stored()).phase === "succeeded");
    expect(live()).toHaveLength(1);
    expect(live()[0]).toMatchObject({ summary: "Meet Maya at Dakshin", start: { dateTime: "2026-10-23T19:30:00", timeZone: expect.stringMatching(/^Asia\/(Kolkata|Calcutta)$/) }, end: { dateTime: "2026-10-23T20:30:00" } });
    // The Google token stays in the program: nothing the extension holds contains it.
    expect(JSON.stringify(await stored())).not.toContain("AT-1");
    await restaurant.locator("recast-clay >> button", { hasText: "Undo" }).click();
    await until(async () => (await stored()).phase === "idle");
    expect(live()).toHaveLength(0);

    // Google takes the write but its answer is lost: unknown. Check asks Google and finds it; nothing was sent twice.
    dropNext = true; const writesBefore = seenByGoogle.filter((x) => !x.startsWith("GET")).length;
    await chooseCalendar(restaurant);
    await restaurant.locator("recast-clay >> button", { hasText: "Add to calendar" }).click();
    await until(async () => (await stored()).phase === "unknown");
    expect(live()).toHaveLength(1);
    await restaurant.locator("recast-clay >> button[data-act=reconcile]").click();
    await until(async () => (await stored()).phase === "succeeded");
    expect(seenByGoogle.filter((x) => !x.startsWith("GET")).length - writesBefore).toBe(2);   // restore after the earlier undo (POST 409 → PUT), once
    expect(live()).toHaveLength(1);
    // The receipt from the check can be undone too.
    await restaurant.locator("recast-clay >> button", { hasText: "Undo" }).click();
    await until(async () => (await stored()).phase === "idle");
    expect(live()).toHaveLength(0);
  }, 120_000);

  it("Maya + a sentence is a message: Mail saves a real Gmail draft (never sent), Undo deletes it", async () => {
    const page = await openTab("message.html");
    // A plain sentence is picked up by selecting it and Alt-dragging it; dropped on Maya, the two make a message.
    await page.evaluate(() => { const r = document.createRange(); r.selectNodeContents(document.getElementById("line")!); getSelection()!.removeAllRanges(); getSelection()!.addRange(r); });
    await altDrag(page, "#line", "#maya");
    await until(async () => { const s = await stored(); return s.phase === "composed" && s.objects[s.focus]?.ingredients.length === 2; });
    await page.locator("recast-clay >> button", { hasText: "Choose where it goes" }).click();
    await until(async () => (await page.locator("recast-clay >> #rg-opt-mail").getAttribute("aria-disabled")) === "false");
    // A message fits only Mail, so the drum rests on it.
    await until(async () => (await page.locator("recast-clay >> .rg-drum").getAttribute("aria-activedescendant")) === "rg-opt-mail");
    await page.locator("recast-clay >> button[data-act=open]").click();
    await until(async () => (await stored()).phase === "previewing");
    expect(drafts.size).toBe(0);
    // The page gives no address next to her name: the review asks, and the person types it.
    await page.locator("recast-clay >> input[data-field=to]").fill("maya.rao@example.com");
    await page.locator("recast-clay >> button[data-submit=to]").click();
    await page.locator("recast-clay >> button", { hasText: "Save as draft" }).click();
    await until(async () => (await stored()).phase === "succeeded");
    expect(drafts.size).toBe(1);
    const raw = Buffer.from((drafts.get("d1") as any).message.raw, "base64url").toString();
    expect(raw).toMatch(/To: maya\.rao@example\.com/); expect(raw).toContain("Free for dinner this week?");
    expect(seenByGoogle.some((x) => /messages\/send|drafts\/send/.test(x))).toBe(false);      // never sent
    await page.locator("recast-clay >> button", { hasText: "Undo" }).click();
    await until(async () => (await stored()).phase === "idle");
    expect(drafts.size).toBe(0);
  });

  it("'This page' takes the whole page as one object; Tasks adds it to Google Tasks (title, canonical link), Undo deletes it", async () => {
    const page = await openTab("article.html?utm_source=newsletter");
    await page.locator("recast-clay >> button[data-act=takePage]").click();
    await until(async () => (await stored()).phase === "composed");
    const s = await stored(); const v = s.objects[s.focus];
    expect(v.ingredients).toHaveLength(1); expect(v.ingredients[0]).toMatchObject({ kind: "page", text: "Q3 planning notes", value: { url: `${base}/article.html` } });
    await page.locator("recast-clay >> button", { hasText: "Choose where it goes" }).click();
    // A page fits only Tasks (Notion is not connected), so the drum rests on it; Calendar and Mail say why not.
    await until(async () => (await page.locator("recast-clay >> .rg-drum").getAttribute("aria-activedescendant")) === "rg-opt-tasks");
    expect(await page.locator("recast-clay >> #rg-opt-calendar").getAttribute("aria-disabled")).toBe("true");
    await page.locator("recast-clay >> button[data-act=open]").click();
    await until(async () => (await stored()).phase === "previewing");
    const review = await page.locator("recast-clay").evaluate((h) => h.shadowRoot!.textContent!);
    expect(review).toContain("Q3 planning notes"); expect(review).toContain(`${base}/article.html`); expect(review).not.toMatch(/stand-in/i);
    expect(tasks.size).toBe(0);                                             // reviewing writes nothing
    await page.locator("recast-clay >> button", { hasText: "Add a task" }).click();
    await until(async () => (await stored()).phase === "succeeded");
    expect([...tasks.values()]).toEqual([{ title: "Q3 planning notes", notes: `${base}/article.html` }]);
    await page.locator("recast-clay >> button", { hasText: "Undo" }).click();
    await until(async () => (await stored()).phase === "idle");
    expect(tasks.size).toBe(0);
  });

  it("how much Recast asks: chosen once in the popup; 'Only when it matters' places a complete event right away, with Undo", async () => {
    const extId = new URL(sw.url()).host;
    const popup = await ctx.newPage(); await popup.goto(`chrome-extension://${extId}/popup.html?tabId=1`);
    await until(async () => (await popup.locator(".ask").getAttribute("class"))?.includes("first") ?? false);   // never chosen yet: asked
    expect(await popup.locator("#ask-first").isVisible()).toBe(true);
    await popup.getByLabel(/Only when it matters/).check();
    await until(async () => (await stored()).confirm === "none");
    expect(await sw.evaluate(async () => (await chrome.storage.local.get(null)))).toEqual({ confirmLevel: "none" });   // the only thing kept
    await popup.reload(); await until(async () => popup.getByLabel(/Only when it matters/).isChecked());
    expect(await popup.locator("#ask-first").isVisible()).toBe(false);
    await popup.close();

    const restaurant = await openTab("restaurant.html");
    const before = live().length;
    const dinnerId = Object.entries((await stored()).objects).find(([, o]: any) => o.ingredients.length === 3)![0];
    const openWith = async (id: string) => { await sw.evaluate((id) => (globalThis as any).recastClay.dispatch({ type: "openModule", id }), id); await until(async () => { const v = await stored(); return v.phase === "composed" && v.focus === id; }); };
    const toCalendar = async () => {
      await restaurant.locator("recast-clay >> button", { hasText: "Choose where it goes" }).click();
      await until(async () => (await restaurant.locator("recast-clay >> #rg-opt-calendar").getAttribute("aria-disabled")) === "false");
      await restaurant.locator("recast-clay >> button[data-act=open]").click();
    };
    // Chosen in the module, which showed every value: with "Only when it matters" that choice is the confirmation,
    // even though Maya's name was read at 60%. Placed at once; Undo is kept.
    await openWith(dinnerId); await toCalendar();
    await until(async () => (await stored()).phase === "succeeded");
    expect(live().length).toBe(before + 1);
    await restaurant.locator("recast-clay >> button", { hasText: "Undo" }).click();
    await until(async () => (await stored()).phase === "idle");
    expect(live().length).toBe(before);
    const eventId = dinnerId;

    // Back to "Every time": the same composition gets a review again.
    const p2 = await ctx.newPage(); await p2.goto(`chrome-extension://${extId}/popup.html?tabId=1`);
    await p2.getByLabel(/Every time/).check(); await until(async () => (await stored()).confirm === "high"); await p2.close();
    await openWith(eventId); await toCalendar();
    await until(async () => (await stored()).phase === "previewing");
    expect(live().length).toBe(before);
    await restaurant.locator("recast-clay >> button", { hasText: "Cancel" }).click();
  });

  it("a web page cannot use the program: wrong Origin is refused, an unpaired extension origin only gets a pending code", async () => {
    const r = await fetch("http://localhost:8787/ext/commit", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(403);
    const r2 = await fetch("http://localhost:8787/ext/commit", { method: "POST", headers: { origin: `chrome-extension://${"b".repeat(32)}`, "content-type": "application/json" }, body: "{}" });
    expect(r2.status).toBe(403);
  });
});
