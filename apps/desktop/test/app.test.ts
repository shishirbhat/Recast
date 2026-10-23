// The desktop app, launched for real (Electron, its main process, its keyboard hook, its local program), on a virtual
// screen, next to a real browser window standing in for the app the person is in (YouTube, a chat, a document). The keys
// and the mouse are real X11 input (xdotool): Ctrl tapped twice, text selected by dragging and clicking, clicks that must
// pass through Recast's overlay to the page underneath. Google is a stand-in inside the main process
// (test/fake-google.mjs); the real Google run is by hand (docs/REAL_TEST_PLAN.md, K).
import { chromium, _electron as electron, type Browser, type ElectronApplication, type Page } from "playwright-core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The "other app": a Chromium build the machine already has (the CI image's, or RECAST_CHROMIUM).
const otherBrowser = process.env["RECAST_CHROMIUM"] ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronBin = path.join(root, "node_modules/electron/dist", process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "electron.exe" : "electron");
const SCOPES = ["calendar.events", "gmail.compose", "tasks"].map((s) => `https://www.googleapis.com/auth/${s}`).join(" ");
const hasXdotool = (() => { try { execFileSync("xdotool", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const xdo = (...args: string[]) => execFileSync("xdotool", args);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let app: ElectronApplication | null = null, browser: Browser | null = null;
afterEach(async () => { await app?.close(); app = null; await browser?.close(); browser = null; });

/** A fresh data folder (or the one given), already signed in to the stand-in Google, with the chosen theme. */
function profile(theme: "dark" | "light" | "system" = "dark", dir?: string) {
  const d = dir ?? mkdtempSync(path.join(tmpdir(), "recast-desktop-"));
  mkdirSync(path.join(d, "secrets"), { recursive: true });
  writeFileSync(path.join(d, "settings.json"), JSON.stringify({ theme }));
  writeFileSync(path.join(d, "secrets", "google-token.json"), JSON.stringify({ access_token: "AT-desktop", refresh_token: "RT", expires_at: Date.now() + 3_600_000, scope: SCOPES, token_type: "Bearer", connected_at: "test" }));
  return d;
}
/** The app, with its two pages: the library (the Recast app proper) and the overlay (Recast over other apps). */
async function launch(dir: string, showLibrary = true) {
  app = await electron.launch({ executablePath: electronBin, args: [...(process.platform === "linux" ? ["--no-sandbox"] : []), root],
    env: { ...process.env, RECAST_TEST: "1", RECAST_USER_DATA: dir, RECAST_TEST_FETCH: path.join(root, "test/fake-google.mjs"), ...(showLibrary ? {} : { RECAST_SHOW: "0" }) } });
  const errors: string[] = [];
  const page = async (file: string) => {
    let p = app!.windows().find((w) => w.url().endsWith(file));
    while (!p) { p = await app!.waitForEvent("window"); if (!p.url().endsWith(file)) { await p.waitForLoadState().catch(() => {}); p = app!.windows().find((w) => w.url().endsWith(file)); } }
    p.on("pageerror", (e) => errors.push(`${file}: ${e.message}`)); p.on("console", (m) => { if (m.type() === "error") errors.push(`${file}: ${m.text()}`); });
    await p.waitForFunction(() => !!document.documentElement.dataset["theme"]);
    return p;
  };
  const library = await page("library.html"), overlay = await page("overlay.html");
  return { app: app!, library, overlay, errors };
}
const fake = () => app!.evaluate(() => (globalThis as any).__recastFake ?? { events: {}, tasks: {} });
const visible = (file: string) => app!.evaluate(({ BrowserWindow }, f) => BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().endsWith(f) && w.isVisible()), file);
const isOn = () => app!.evaluate(() => (globalThis as any).__recastOn());
const blobs = (overlay: Page) => overlay.locator(".clay-item");

/** The other app: a real browser window at the top left of the screen, with a page like any other. */
async function otherApp(html: string) {
  browser = await chromium.launch({ headless: false, ...(otherBrowser ? { executablePath: otherBrowser } : {}), args: ["--no-sandbox", "--window-position=0,0", "--window-size=1100,760"] });
  const p = await browser.newPage();
  await p.setContent(`<body style="margin:0;font-family:sans-serif">${html}</body>`);
  await p.bringToFront(); await sleep(400);
  return p;
}
/** Where an element of the other app is on the screen (the page's origin is below the browser's own bars). */
async function onScreen(p: Page, selector: string) {
  return p.evaluate((s) => {
    const r = document.querySelector(s)!.getBoundingClientRect();
    const ox = window.screenX + (window.outerWidth - window.innerWidth) / 2, oy = window.screenY + (window.outerHeight - window.innerHeight);
    return { x: Math.round(ox + r.left + r.width / 2), y: Math.round(oy + r.top + r.height / 2), left: Math.round(ox + r.left + 4), right: Math.round(ox + r.right - 4) };
  }, selector);
}
/** The trigger, tapped twice for real (Ctrl on Linux); the app's own key feed where the machine cannot press keys. */
async function tapTwice() {
  if (hasXdotool) { xdo("key", "Control_L"); await sleep(120); xdo("key", "Control_L"); }
  else await app!.evaluate(() => { const k = (globalThis as any).__recastKey; k("Control", "keydown"); k("Control", "keyup"); k("Control", "keydown"); k("Control", "keyup"); });
}
/** Selects a paragraph of the other app with the real mouse (a triple click), as a person does. */
async function selectWithMouse(p: Page, selector: string) {
  const c = await onScreen(p, selector);
  xdo("mousemove", String(c.x), String(c.y)); await sleep(80);
  xdo("click", "--repeat", "3", "--delay", "70", "1"); await sleep(250);
}
async function dragOnto(overlay: Page, from: string, to: string) {
  const box = async (t: string) => { const b = (await overlay.locator(".clay-item", { hasText: t }).first().boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  await overlay.waitForTimeout(400);   // objects spring into place
  const a = await box(from), b = await box(to);
  await overlay.mouse.move(a.x, a.y); await overlay.mouse.down(); await overlay.mouse.move(a.x + 12, a.y + 12, { steps: 3 });
  await overlay.mouse.move(b.x, b.y, { steps: 10 }); await overlay.mouse.move(b.x + 1, b.y, { steps: 1 }); await overlay.mouse.up();
}
async function shot(p: Page, name: string) {
  await p.waitForFunction(() => !document.querySelector(".rg")?.getAnimations().length).catch(() => {}); await p.waitForTimeout(500);
  await p.screenshot({ path: path.join(root, "test", "shots", `${name}.png`) });
}
const PAGE = `<h1 style="margin:30px 40px;font-size:28px">Team video: launch plan</h1>
  <p id="when" style="margin:20px 40px;font-size:40px">Friday 1:00 PM</p>
  <p id="what" style="margin:20px 40px;font-size:40px">Lunch with Arjun</p>
  <p id="who" style="margin:20px 40px;font-size:40px">arjun.mehta@example.com</p>
  <button id="like" style="margin:20px 40px;width:300px;height:80px;font-size:24px" onclick="this.dataset.n=(+(this.dataset.n||0)+1)">Like</button>`;

describe.skipIf(process.platform !== "linux" || !hasXdotool)("Recast over another app (real keys and mouse)", () => {
  it("Ctrl twice in another app: the selection lifts into a blob right there; no Recast window opens and the app keeps working", async () => {
    const { overlay, errors } = await launch(profile("dark"), false);
    const other = await otherApp(PAGE);
    expect(await visible("library.html")).toBe(false);
    await selectWithMouse(other, "#when");
    expect((await other.evaluate(() => getSelection()!.toString())).trim()).toBe("Friday 1:00 PM");
    await tapTwice();
    await expect.poll(isOn).toBe(true);
    await expect.poll(() => blobs(overlay).count()).toBe(1);
    expect(await blobs(overlay).first().innerText()).toContain("Friday 1:00 PM");
    expect(await blobs(overlay).first().getAttribute("data-kind")).toBe("time");
    // Nothing else opened: no library, no panel; the other app still has the keyboard.
    expect(await visible("library.html")).toBe(false);
    expect(await other.evaluate(() => document.hasFocus())).toBe(true);
    // The blob sits by the selection, not in a corner: within a few hundred pixels of where the mouse let go.
    const sel = await onScreen(other, "#when"); const b = (await blobs(overlay).first().boundingBox())!;
    expect(Math.hypot(b.x + b.width / 2 - sel.x, b.y + b.height / 2 - sel.y)).toBeLessThan(320);
    // Clicks anywhere else go through to the app underneath (the overlay takes only its own blobs and wheel).
    const like = await onScreen(other, "#like");
    xdo("mousemove", String(like.x), String(like.y)); await sleep(100); xdo("click", "1"); await sleep(300);
    expect(await other.evaluate(() => document.querySelector<HTMLElement>("#like")!.dataset["n"])).toBe("1");
    await shot(overlay, "overlay-blob-dark");
    expect(errors).toEqual([]);
  });

  it("while on, each selection is a blob; pressed together they are an event; the wheel opens beside it; Google Calendar gets it; Undo; the library keeps both", async () => {
    const { overlay, library, errors } = await launch(profile("dark"), false);
    const other = await otherApp(PAGE);
    await tapTwice(); await expect.poll(isOn).toBe(true);
    await selectWithMouse(other, "#what");
    await expect.poll(() => blobs(overlay).count()).toBe(1);
    await selectWithMouse(other, "#when");
    await expect.poll(() => blobs(overlay).count()).toBe(2);
    await dragOnto(overlay, "Friday 1:00 PM", "Lunch with Arjun");
    await overlay.getByRole("button", { name: /Choose where it goes/ }).click();
    await expect.poll(() => overlay.locator(".rg-drum").getAttribute("aria-activedescendant")).toBe("rg-opt-calendar");
    // The wheel is beside the blob, on the same screen: not docked at the bottom of a window.
    const wheel = (await overlay.locator(".rg").boundingBox())!;
    expect(wheel.y + wheel.height).toBeLessThan((await overlay.evaluate(() => innerHeight)) - 8);
    await overlay.waitForTimeout(300);
    await overlay.getByRole("button", { name: "Open" }).click();
    await expect.poll(() => overlay.locator(".rg-title").innerText()).toBe("Google Calendar: review");
    expect(Object.keys((await fake()).events)).toHaveLength(0);              // the review writes nothing
    await shot(overlay, "overlay-review-dark");
    await overlay.getByRole("button", { name: "Add to calendar" }).click();
    await expect.poll(() => overlay.locator(".rg-title").innerText()).toBe("Added to Google Calendar");
    const ev = Object.values((await fake()).events)[0] as Record<string, any>;
    expect(ev.summary).toBe("Lunch with Arjun"); expect(ev.start.dateTime).toMatch(/T13:00:00$/);
    await overlay.getByRole("button", { name: "Undo" }).click();
    await expect.poll(async () => (Object.values((await fake()).events)[0] as any).status).toBe("cancelled");
    // The library (still closed) has both pieces, with where they went.
    expect(await visible("library.html")).toBe(false);
    await expect.poll(() => library.locator(".entry").count()).toBe(2);
    expect(await library.locator(".entry").allInnerTexts()).toEqual([expect.stringContaining("Friday 1:00 PM"), expect.stringContaining("Lunch with Arjun")]);
    expect(await library.locator(".placed").first().innerText()).toBe("→ Google Calendar");
    expect(errors).toEqual([]);
  });

  it("Esc turns Recast off (the overlay goes away, clicks reach the app); the blobs come back when it is on again", async () => {
    const { overlay } = await launch(profile("dark"), false);
    const other = await otherApp(PAGE);
    await selectWithMouse(other, "#who");
    await tapTwice();
    await expect.poll(() => blobs(overlay).count()).toBe(1);
    expect(await blobs(overlay).first().getAttribute("data-kind")).toBe("person");
    xdo("key", "Escape");
    await expect.poll(isOn).toBe(false);
    expect(await visible("overlay.html")).toBe(false);
    await tapTwice();
    await expect.poll(isOn).toBe(true);
    await expect.poll(() => blobs(overlay).count()).toBe(1);   // the same selection is not lifted twice
  });

  it("Ctrl twice with nothing selected: Recast is on and says so; no blob, no window", async () => {
    const { app: a, overlay } = await launch(profile("dark"), false);
    await a.evaluate(({ clipboard }) => clipboard.selection?.writeText(""));
    await otherApp(PAGE);
    await tapTwice();
    await expect.poll(isOn).toBe(true);
    await expect.poll(() => overlay.locator("#toast").innerText()).toMatch(/Select some text first|Recast is on/);
    expect(await blobs(overlay).count()).toBe(0);
    expect(await visible("library.html")).toBe(false);
  });
});

describe("the Recast app (the library)", () => {
  it("opens dark when dark is chosen (no white anywhere), and light when light is; it says how to start", async () => {
    let { library, errors } = await launch(profile("dark"));
    expect(await visible("library.html")).toBe(true);
    expect(await visible("overlay.html")).toBe(false);
    expect(await library.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(20, 19, 17)");
    expect(await library.locator("#empty").isVisible()).toBe(true);
    expect(await library.locator(".trigger").first().innerText()).toBe(process.platform === "darwin" ? "⌥ Option" : "Ctrl");
    await shot(library, "library-empty-dark"); expect(errors).toEqual([]);
    await app!.close(); app = null;
    ({ library, errors } = await launch(profile("light")));
    expect(await library.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(250, 249, 246)");
    expect(errors).toEqual([]);
  });

  it("every grab is kept: the library lists it with where it came from, after a restart too; Remove takes it out", async () => {
    const dir = profile("dark");
    let { app: a, library, overlay } = await launch(dir);
    await a.evaluate(({ clipboard }) => clipboard.selection?.writeText("maya.rao@example.com"));
    await a.evaluate(() => (globalThis as any).__recastGrab());
    await expect.poll(() => blobs(overlay).count()).toBe(1);
    await expect.poll(() => library.locator(".entry").count()).toBe(1);
    await library.waitForTimeout(400);
    await app!.close(); app = null;
    ({ library, overlay } = await launch(dir));
    await expect.poll(() => library.locator(".entry").count()).toBe(1);
    expect(await library.locator(".entry .text").innerText()).toBe("maya.rao@example.com");
    await expect.poll(() => blobs(overlay).count()).toBe(1);               // and the blob is still in hand
    await shot(library, "library-dark");
    await library.getByRole("button", { name: "Remove" }).click();
    await expect.poll(() => library.locator(".entry").count()).toBe(0);
  });

  it("a recipe runs both steps against the person's own Google (Calendar and Tasks), each with its own result", async () => {
    const { app: a, overlay, errors } = await launch(profile("dark"));
    for (const t of ["Dinner at Dakshin", "Friday 7:30 PM"]) { await a.evaluate(({ clipboard }, x) => clipboard.selection?.writeText(x), t); await a.evaluate(() => (globalThis as any).__recastGrab()); await sleep(300); }
    await expect.poll(() => blobs(overlay).count()).toBe(2);
    await dragOnto(overlay, "Friday 7:30 PM", "Dinner at Dakshin");
    await overlay.locator(".rg-recipe[data-recipe='plan-and-prepare']").click();
    await expect.poll(() => overlay.locator(".rg-title").innerText()).toBe("Recipe: Plan and prepare");
    await overlay.getByRole("button", { name: "Run 2 steps" }).click();
    await expect.poll(() => overlay.locator(".rg-title").innerText()).toBe("Plan and prepare: all 2 done");
    const f = await fake();
    expect(Object.values(f.tasks)).toEqual([expect.objectContaining({ title: "Prepare: Dinner at Dakshin" })]);
    expect(Object.keys(f.events)).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it("the pages cannot reach Node, links to anything but the web are refused, and only the overlay may set where it takes the mouse", async () => {
    const { library, overlay } = await launch(profile("dark"));
    for (const p of [library, overlay]) {
      expect(await p.evaluate(() => typeof (globalThis as any).require)).toBe("undefined");
      expect(await p.evaluate(() => (window as any).recastDesktop.openExternal("file:///etc/passwd"))).toBe(false);
      expect(await p.evaluate(() => (window as any).recastDesktop.openExternal("javascript:alert(1)"))).toBe(false);
      expect(await p.evaluate(() => (window as any).recastDesktop.act("commit", { destination: "anything" }))).toMatchObject({ status: 400 });
    }
    expect(await library.evaluate(() => (window as any).recastDesktop.interactive(true, []))).toBe(false);
  });
});
