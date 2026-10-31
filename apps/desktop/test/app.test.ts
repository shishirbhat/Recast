// The desktop app, launched for real (Electron, its main process, its keyboard hook, its local program), on a virtual
// screen, next to a real browser window standing in for the app the person is in (YouTube, a chat, a document). The keys
// and the mouse are real X11 input (xdotool): Ctrl tapped twice, text selected by dragging and clicking, clicks that must
// pass through Recast's overlay to the page underneath. Google is a stand-in inside the main process
// (test/fake-google.mjs); the real Google run is by hand (docs/REAL_TEST_PLAN.md, K).
import { chromium, _electron as electron, type Browser, type ElectronApplication, type Page } from "playwright-core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  await p.bringToFront();
  // The window manager may still be placing and decorating the window: wait until it stops moving.
  let last = "";
  for (let i = 0; i < 30; i++) {
    await sleep(200);
    const g = JSON.stringify(await p.evaluate(() => [window.screenX, window.screenY, window.outerWidth, window.outerHeight, window.innerWidth, window.innerHeight]));
    if (g === last) break; last = g;
  }
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
  // As a person does: triple click, and look. If the page did not take the clicks (the machine was busy), click again.
  for (let attempt = 0; attempt < 3; attempt++) {
    const c = await onScreen(p, selector);
    // Click only once the window really receives the pointer there: a freshly opened window on a cold machine can be
    // mapped and drawn but not yet taking input, and clicks sent then are lost.
    await p.evaluate((s) => { (window as any).__over = false; document.querySelector(s)!.addEventListener("mousemove", () => { (window as any).__over = true; }, { once: true }); }, selector);
    for (let i = 0; i < 25 && !(await p.evaluate(() => (window as any).__over)); i++) { xdo("mousemove", String(c.x + (i % 2)), String(c.y)); await sleep(200); }
    xdo("mousemove", String(c.x), String(c.y)); await sleep(120);
    xdo("click", "--repeat", "3", "--delay", "70", "1"); await sleep(350);
    const want = await p.evaluate((s) => document.querySelector(s)!.textContent!.trim(), selector);
    if ((await p.evaluate(() => getSelection()!.toString())).trim() === want) return;
    // A highlight over the words takes the click instead (that is Recast working): the page then has no selection.
    if (await p.evaluate(() => !getSelection()!.toString())) await sleep(400);
  }
}
async function dragOnto(overlay: Page, from: string, to: string) {
  const box = async (t: string) => { const b = (await overlay.locator(".clay-item", { hasText: t }).first().boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  await overlay.waitForTimeout(400);   // objects spring into place
  const a = await box(from), b = await box(to);
  await overlay.mouse.move(a.x, a.y); await overlay.mouse.down(); await overlay.mouse.move(a.x + 12, a.y + 12, { steps: 3 });
  await overlay.mouse.move(b.x, b.y, { steps: 10 }); await overlay.mouse.move(b.x + 1, b.y, { steps: 1 }); await overlay.mouse.up();
}
/** The whole screen as a person sees it (the other app with Recast on top), taken by the system, not by a page. */
async function screenShot(name: string) {
  const png = await app!.evaluate(async ({ desktopCapturer, screen }) => {
    const d = screen.getPrimaryDisplay(); const [src] = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: d.size });
    return src!.thumbnail.toPNG().toString("base64");
  });
  writeFileSync(path.join(root, "test", "shots", `${name}.png`), Buffer.from(png, "base64"));
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
    await expect.poll(isOn, { timeout: 5000 }).toBe(true);
    await expect.poll(() => blobs(overlay).count(), { timeout: 8000 }).toBe(1);
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
    await tapTwice(); await expect.poll(isOn, { timeout: 5000 }).toBe(true);
    await selectWithMouse(other, "#what");
    await expect.poll(() => blobs(overlay).count(), { timeout: 8000 }).toBe(1);
    await selectWithMouse(other, "#when");
    await expect.poll(() => blobs(overlay).count(), { timeout: 8000 }).toBe(2);
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
    // Read back from Google through the program, with the event's link; the event is still there afterwards
    // (a read-back must never be mistaken for anything else, such as an undo).
    await expect.poll(() => overlay.locator(".rg-verify").innerText().catch(() => "")).toMatch(/^Read back from Google Calendar: (\d+) of \1 fields match\. Open in Google Calendar$/);
    expect((Object.values((await fake()).events)[0] as any).status).toBe("confirmed");
    // The library keeps the calendar's own link to the event, read back with it.
    await expect.poll(() => library.locator("a.placed").first().getAttribute("href").catch(() => null)).toMatch(/^https:\/\//);
    await overlay.getByRole("button", { name: "Undo" }).click();
    await expect.poll(async () => (Object.values((await fake()).events)[0] as any).status).toBe("cancelled");
    // The library (still closed) has both pieces, with where they went.
    expect(await visible("library.html")).toBe(false);
    await expect.poll(() => library.locator(".entry").count()).toBe(2);
    expect(await library.locator(".entry").allInnerTexts()).toEqual([expect.stringContaining("Friday 1:00 PM"), expect.stringContaining("Lunch with Arjun")]);
    // Undone, it says so, and the link to what is no longer there is gone.
    await expect.poll(() => library.locator(".placed").first().innerText()).toBe("→ Google Calendar (undone)");
    expect(await library.locator("a.placed").count()).toBe(0);
    expect(errors).toEqual([]);
  });

  it("on: what is likely to be picked up is highlighted in place (a time, an email address, an error); a click makes it a blob, a drag presses it into one", async () => {
    const { overlay, errors } = await launch(profile("dark"), false);
    const other = await otherApp(`<h1 style="margin:30px 40px;font-size:30px">Team notes</h1>
      <p style="margin:24px 40px;font-size:34px">Lunch with Arjun on Friday 1:00 PM if that works</p>
      <p style="margin:24px 40px;font-size:34px">Write to arjun.mehta@example.com</p>
      <p style="margin:24px 40px;font-size:30px;font-family:monospace">TypeError: Cannot read properties of undefined</p>
      <p style="margin:24px 40px;font-size:34px">The quick brown fox jumps over the lazy dog</p>`);
    await tapTwice();
    await expect.poll(isOn, { timeout: 5000 }).toBe(true);
    // Read off the screen (OCR), here on the machine: highlights fade in a moment after Recast turns on.
    await expect.poll(() => overlay.locator(".spot").count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
    const spots = await overlay.locator(".spot").evaluateAll((els) => els.map((e) => ({ kind: (e as HTMLElement).dataset["kind"], label: e.getAttribute("aria-label") })));
    expect(spots.map((x) => x.kind).sort()).toEqual(expect.arrayContaining(["error", "person", "time"]));
    expect(spots.find((x) => x.kind === "time")!.label).toMatch(/Friday 1:00 PM/);
    expect(spots.find((x) => x.kind === "person")!.label).toMatch(/arjun\.mehta@example\.com/);
    expect(spots.every((x) => !/quick brown fox/.test(x.label ?? ""))).toBe(true);   // prose is not highlighted
    // The highlight sits on the words themselves, on the screen.
    const t = (await overlay.locator(".spot[data-kind=time]").boundingBox())!;
    const line = await other.evaluate(() => { const p = [...document.querySelectorAll("p")][0]!.getBoundingClientRect(); return { top: window.screenY + window.outerHeight - window.innerHeight + p.top, bottom: window.screenY + window.outerHeight - window.innerHeight + p.bottom }; });
    expect(t.y + t.height / 2).toBeGreaterThan(line.top - 6); expect(t.y + t.height / 2).toBeLessThan(line.bottom + 6);
    await shot(overlay, "overlay-highlights-dark");
    await screenShot("screen-highlights");
    // A real click on the time's highlight: it becomes a blob beside it (the overlay takes this click, not the page).
    xdo("mousemove", String(Math.round(t.x + t.width / 2)), String(Math.round(t.y + t.height / 2))); await sleep(200); xdo("click", "1");
    await expect.poll(() => blobs(overlay).count(), { timeout: 8000 }).toBe(1);
    expect(await blobs(overlay).first().getAttribute("data-kind")).toBe("time");
    expect(await blobs(overlay).first().innerText()).toContain("Friday 1:00 PM");
    // Dragging the email address's highlight onto the blob presses them together.
    const p = (await overlay.locator(".spot[data-kind=person]").boundingBox())!; const b = (await blobs(overlay).first().boundingBox())!;
    await overlay.mouse.move(p.x + p.width / 2, p.y + p.height / 2); await overlay.mouse.down();
    await overlay.mouse.move(p.x + p.width / 2 + 14, p.y + p.height / 2 + 10, { steps: 3 });
    await overlay.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 }); await overlay.mouse.move(b.x + b.width / 2 + 1, b.y + b.height / 2); await overlay.mouse.up();
    await expect.poll(() => blobs(overlay).count(), { timeout: 8000 }).toBe(1);
    await expect.poll(() => blobs(overlay).first().getAttribute("data-kind")).toBe("event");
    expect(errors).toEqual([]);
  });

  it("Esc turns Recast off (the overlay goes away, clicks reach the app); the blobs come back when it is on again", async () => {
    const { overlay } = await launch(profile("dark"), false);
    const other = await otherApp(PAGE);
    await selectWithMouse(other, "#who");
    await tapTwice();
    await expect.poll(() => blobs(overlay).count(), { timeout: 8000 }).toBe(1);
    expect(await blobs(overlay).first().getAttribute("data-kind")).toBe("person");
    xdo("key", "Escape");
    await expect.poll(isOn).toBe(false);
    expect(await visible("overlay.html")).toBe(false);
    await tapTwice();
    await expect.poll(isOn, { timeout: 5000 }).toBe(true);
    await expect.poll(() => blobs(overlay).count(), { timeout: 8000 }).toBe(1);   // the same selection is not lifted twice
  });

  it("the app keeps the keyboard: hovering a blob takes nothing; the keys shortcut moves it onto Recast (Space, arrows, Enter press two together, Enter opens the wheel); Esc steps back and hands it back", async () => {
    const { overlay, errors } = await launch(profile("dark"), false);
    const other = await otherApp(PAGE);
    await tapTwice(); await expect.poll(isOn, { timeout: 5000 }).toBe(true);
    await selectWithMouse(other, "#what");
    await expect.poll(() => blobs(overlay).count(), { timeout: 8000 }).toBe(1);
    await selectWithMouse(other, "#when");
    await expect.poll(() => blobs(overlay).count(), { timeout: 8000 }).toBe(2);
    // The pointer resting on a blob (the overlay takes the mouse there) leaves the keyboard with the app.
    const b = (await blobs(overlay).first().boundingBox())!;
    xdo("mousemove", String(Math.round(b.x + b.width / 2)), String(Math.round(b.y + b.height / 2))); await sleep(600);
    expect(await app!.evaluate(() => (globalThis as any).__recastOverlayInteractive())).toBe(true);
    expect(await other.evaluate(() => document.hasFocus())).toBe(true);
    expect(await app!.evaluate(() => (globalThis as any).__recastHoldsKeys())).toBe(false);
    xdo("mousemove", "5", "5"); await sleep(300);
    // The keys shortcut (Ctrl+Shift+Enter): the keyboard is on the first blob, and the line at the bottom says how to go on.
    xdo("key", "ctrl+shift+Return");
    await expect.poll(() => app!.evaluate(() => (globalThis as any).__recastHoldsKeys()), { timeout: 5000 }).toBe(true);
    await expect.poll(() => overlay.evaluate(() => document.activeElement?.classList.contains("clay-item"))).toBe(true);
    await expect.poll(() => overlay.locator("#toast").innerText()).toMatch(/^Keyboard on Recast/);
    // Space picks it up, an arrow moves to the other, Enter presses them together: an event.
    xdo("key", "space"); await expect.poll(() => overlay.locator(".clay-item.mode-carried").count()).toBe(1);
    xdo("key", "Right");
    await expect.poll(() => overlay.evaluate(() => document.activeElement?.matches(".clay-item.mode-rest"))).toBe(true);
    xdo("key", "Return");
    await expect.poll(() => blobs(overlay).count(), { timeout: 8000 }).toBe(1);
    await expect.poll(() => blobs(overlay).first().getAttribute("data-kind")).toBe("event");
    // Enter on it opens the wheel beside it; Escape closes the wheel and the keyboard is back on the blob.
    await expect.poll(() => overlay.evaluate(() => document.activeElement?.classList.contains("clay-item"))).toBe(true);
    xdo("key", "Return");
    await expect.poll(() => overlay.locator(".rg").isVisible()).toBe(true);
    xdo("key", "Escape");
    await expect.poll(() => overlay.evaluate(() => document.activeElement?.classList.contains("clay-item"))).toBe(true);
    // Escape at rest hands the keys back to the app; Recast stays on until Escape is pressed again, in the app.
    xdo("key", "Escape");
    await expect.poll(() => app!.evaluate(() => (globalThis as any).__recastHoldsKeys())).toBe(false);
    await expect.poll(() => other.evaluate(() => document.hasFocus()), { timeout: 5000 }).toBe(true);
    expect(await isOn()).toBe(true);
    xdo("key", "Escape");
    await expect.poll(isOn).toBe(false);
    expect(errors).toEqual([]);
  });

  it("Ctrl twice with nothing selected: Recast is on and says so; no blob, no window", async () => {
    const { app: a, overlay } = await launch(profile("dark"), false);
    await a.evaluate(({ clipboard }) => clipboard.selection?.writeText(""));
    await otherApp(PAGE);
    await tapTwice();
    await expect.poll(isOn, { timeout: 5000 }).toBe(true);
    await expect.poll(() => overlay.locator("#toast").innerText()).toMatch(/^Recast is on/);
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
    await expect.poll(() => blobs(overlay).count(), { timeout: 8000 }).toBe(1);
    await expect.poll(() => library.locator(".entry").count()).toBe(1);
    await library.waitForTimeout(400);
    await app!.close(); app = null;
    ({ library, overlay } = await launch(dir));
    await expect.poll(() => library.locator(".entry").count()).toBe(1);
    expect(await library.locator(".entry .text").innerText()).toBe("maya.rao@example.com");
    await expect.poll(() => blobs(overlay).count(), { timeout: 8000 }).toBe(1);               // and the blob is still in hand
    await shot(library, "library-dark");
    expect(await library.locator(".placed.waiting").innerText()).toBe("not placed yet");
    // Put on screen: already on the desk, it is that blob (not a second one); the library does not list it twice.
    await library.getByRole("button", { name: "Put on screen" }).click();
    await expect.poll(() => app!.evaluate(() => (globalThis as any).__recastOn())).toBe(true);
    await overlay.waitForTimeout(400);
    expect(await blobs(overlay).count()).toBe(1); expect(await library.locator(".entry").count()).toBe(1);
    await library.getByRole("button", { name: "Remove" }).click();
    await expect.poll(() => library.locator(".entry").count()).toBe(0);
    // Removed means gone from this computer, not hidden: the text is no longer in the file.
    await expect.poll(() => readFileSync(path.join(dir, "history.json"), "utf8")).not.toContain("maya.rao@example.com");
    // Clear all asks first, then deletes everything.
    for (const t of ["first note", "second note"]) { await app!.evaluate(({ clipboard }, x) => clipboard.selection?.writeText(x), t); await app!.evaluate(() => (globalThis as any).__recastGrab()); await sleep(300); }
    await expect.poll(() => library.locator(".entry").count()).toBe(2);
    await library.getByRole("button", { name: "Clear all" }).click();
    expect(await library.locator(".entry").count()).toBe(2);
    await library.getByRole("button", { name: "Delete all" }).click();
    await expect.poll(() => library.locator(".entry").count()).toBe(0);
    expect(readFileSync(path.join(dir, "history.json"), "utf8")).toBe("[]");
    expect(await overlay.evaluate(() => (window as any).recastDesktop.historyClear())).toBe(false);   // only the library may
  });

  it("a recipe runs both steps against the person's own Google (Calendar and Tasks), each with its own result", async () => {
    const { app: a, overlay, errors } = await launch(profile("dark"));
    for (const t of ["Dinner at Dakshin", "Friday 7:30 PM"]) { await a.evaluate(({ clipboard }, x) => clipboard.selection?.writeText(x), t); await a.evaluate(() => (globalThis as any).__recastGrab()); await sleep(300); }
    await expect.poll(() => blobs(overlay).count(), { timeout: 8000 }).toBe(2);
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

  it("a saved workflow is read from its own private file and checked; it runs on new information against the stand-in Google, read back; a delete is stored", async () => {
    const dir = profile("dark");
    const wf = { id: "wf_dinner1", version: 1, name: "Dinner plan", description: "An event → Google Calendar", origin: "saved", needs: "Event", limitations: [],
      steps: [{ id: "place", label: "Place it in Google Calendar", targetKind: "Calendar", destination: "google-calendar.calendar", app: "Google Calendar" }] };
    writeFileSync(path.join(dir, "workflows.json"), JSON.stringify([wf, { ...wf, id: "wf_old", version: 3, name: "From the future" }]));
    const { app: a, library, overlay, errors } = await launch(dir);
    // Only the overlay may store workflows.
    expect(await library.evaluate(() => (window as any).recastDesktop.saveWorkflows([]))).toBe(false);
    for (const t of ["Lunch at Toit", "Saturday 1 PM"]) { await a.evaluate(({ clipboard }, x) => clipboard.selection?.writeText(x), t); await a.evaluate(() => (globalThis as any).__recastGrab()); await sleep(300); }
    await expect.poll(() => blobs(overlay).count(), { timeout: 8000 }).toBe(2);
    await dragOnto(overlay, "Saturday 1 PM", "Lunch at Toit");
    await overlay.locator(".rg-mine .rg-recipe", { hasText: "Dinner plan" }).click();
    await expect.poll(() => overlay.locator(".rg-title").innerText()).toBe("Recipe: Dinner plan");
    expect(Object.keys((await fake()).events)).toHaveLength(0);                // the review wrote nothing
    await overlay.getByRole("button", { name: "Run 1 step" }).click();
    await expect.poll(() => overlay.locator(".rg-title").innerText()).toBe("Dinner plan: all 1 done");
    await expect.poll(() => overlay.locator(".rg-steps li").innerText()).toMatch(/Read back from Google Calendar: \d+ of \d+ fields match/);
    expect(Object.values((await fake()).events)).toEqual([expect.objectContaining({ summary: "Lunch at Toit" })]);
    await overlay.getByRole("button", { name: "Done" }).click();
    // Manage: the unusable one says why; deleting it is stored, in a file only this user can read.
    for (const t of ["Dinner at Dakshin", "Friday 7:30 PM"]) { await a.evaluate(({ clipboard }, x) => clipboard.selection?.writeText(x), t); await a.evaluate(() => (globalThis as any).__recastGrab()); await sleep(300); }
    await dragOnto(overlay, "Friday 7:30 PM", "Dinner at Dakshin");
    await overlay.getByRole("button", { name: "Manage" }).click();
    const old = overlay.locator(".rg-wf", { hasText: "From the future" });
    expect(await old.innerText()).toMatch(/Cannot be used: it was saved by a different version of Recast/);
    await old.getByRole("button", { name: "Delete" }).click(); await old.getByRole("button", { name: "Delete" }).click();
    await expect.poll(() => JSON.parse(readFileSync(path.join(dir, "workflows.json"), "utf8")).map((x: any) => x.id)).toEqual(["wf_dinner1"]);
    expect(statSync(path.join(dir, "workflows.json")).mode & 0o777).toBe(0o600);
    expect(errors).toEqual([]);
  });

  it("Todoist from the desktop: a copied link to a PDF is a document; Tasks → Todoist; added, read back with its link, undone", async () => {
    const dir = profile("dark");
    writeFileSync(path.join(dir, "secrets", "todoist.json"), JSON.stringify({ token: "d".repeat(40), connected_at: "test" }));
    const { app: a, overlay, errors } = await launch(dir);
    await a.evaluate(({ clipboard }, x) => clipboard.selection?.writeText(x), "https://example.com/files/Q3-board-report.pdf"); await a.evaluate(() => (globalThis as any).__recastGrab());
    await expect.poll(() => blobs(overlay).count(), { timeout: 8000 }).toBe(1);
    expect(await blobs(overlay).first().innerText()).toContain("Q3 board report (PDF)");
    await overlay.waitForTimeout(400); await blobs(overlay).first().click();
    // A single piece opens inside first ("Choose where it goes" there), then the module's own button opens the wheel.
    for (let i = 0; i < 3 && !(await overlay.locator(".rg-drum").count()); i++) { await overlay.getByRole("button", { name: /Choose where it goes/ }).first().click(); await overlay.waitForTimeout(300); }
    await expect.poll(() => overlay.locator(".rg-drum").getAttribute("aria-activedescendant")).toBe("rg-opt-tasks");
    await overlay.waitForTimeout(300);
    await overlay.getByRole("button", { name: "Open" }).click();
    await expect.poll(() => overlay.locator(".rg-title").innerText()).toMatch(/^(Tasks: which one\?|Todoist: review)$/);
    if ((await overlay.locator(".rg-title").innerText()) === "Tasks: which one?") {
      const o = overlay.locator(".rg-opt", { hasText: "Todoist" }); await o.click(); await overlay.waitForTimeout(200);
      if ((await overlay.locator(".rg-title").innerText()) === "Tasks: which one?") await o.click();
    }
    await expect.poll(() => overlay.locator(".rg-title").innerText()).toBe("Todoist: review");
    expect(Object.keys((await fake()).todoist)).toHaveLength(0);             // the review writes nothing
    await overlay.getByRole("button", { name: "Add a task" }).click();
    await expect.poll(() => overlay.locator(".rg-title").innerText()).toBe("Added to Todoist");
    expect(Object.values((await fake()).todoist)).toEqual([expect.objectContaining({ content: "Q3 board report (PDF)", description: "https://example.com/files/Q3-board-report.pdf" })]);
    await expect.poll(() => overlay.locator(".rg-verify").innerText().catch(() => "")).toMatch(/^Read back from Todoist: 2 of 2 fields match\. Open in Todoist$/);
    await overlay.getByRole("button", { name: "Undo" }).click();
    await expect.poll(async () => Object.keys((await fake()).todoist).length).toBe(0);
    expect(errors).toEqual([]);
  });

  it("the pages cannot reach Node, links to anything but the web are refused, and each write comes only from the window that owns it", async () => {
    const { library, overlay } = await launch(profile("dark"));
    for (const p of [library, overlay]) {
      expect(await p.evaluate(() => typeof (globalThis as any).require)).toBe("undefined");
      expect(await p.evaluate(() => (window as any).recastDesktop.openExternal("file:///etc/passwd"))).toBe(false);
      expect(await p.evaluate(() => (window as any).recastDesktop.openExternal("javascript:alert(1)"))).toBe(false);
    }
    expect(await overlay.evaluate(() => (window as any).recastDesktop.act("commit", { destination: "anything" }))).toMatchObject({ status: 400 });
    expect(await library.evaluate(() => (window as any).recastDesktop.interactive(true, []))).toBe(false);
    // Each write only from the window that owns it (D61): the library cannot place, rewrite the inbox, or add history.
    expect(await library.evaluate(() => (window as any).recastDesktop.act("commit", { destination: "calendar" }))).toMatchObject({ status: 403 });
    expect(await library.evaluate(() => (window as any).recastDesktop.saveInbox({ state: {} }))).toBe(false);
    expect(await library.evaluate(() => (window as any).recastDesktop.historyAdd({ id: "x", text: "planted" }))).toBe(false);
    expect(await overlay.evaluate(() => (window as any).recastDesktop.historyRemove("x"))).toBe(false);
  });
});
