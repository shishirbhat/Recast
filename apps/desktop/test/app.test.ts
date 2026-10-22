// The desktop app, launched for real (Electron, its main process, its local program), on a virtual screen. Google is a
// stand-in inside the main process (test/fake-google.mjs); the real Google run is by hand (docs/REAL_TEST_PLAN.md, K).
import { chromium, _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The "other app" for the grab test: a Chromium build the machine already has (the CI image's, or RECAST_CHROMIUM).
const otherBrowser = process.env["RECAST_CHROMIUM"] ?? (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronBin = path.join(root, "node_modules/electron/dist", process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "electron.exe" : "electron");
const SCOPES = ["calendar.events", "gmail.compose", "tasks"].map((s) => `https://www.googleapis.com/auth/${s}`).join(" ");
let app: ElectronApplication | null = null;
afterEach(async () => { await app?.close(); app = null; });

/** A fresh data folder (or the one given), already signed in to the stand-in Google, with the chosen theme. */
function profile(theme: "dark" | "light" | "system" = "dark", dir?: string) {
  const d = dir ?? mkdtempSync(path.join(tmpdir(), "recast-desktop-"));
  mkdirSync(path.join(d, "secrets"), { recursive: true });
  writeFileSync(path.join(d, "settings.json"), JSON.stringify({ theme, keepOnTop: false }));
  writeFileSync(path.join(d, "secrets", "google-token.json"), JSON.stringify({ access_token: "AT-desktop", refresh_token: "RT", expires_at: Date.now() + 3_600_000, scope: SCOPES, token_type: "Bearer", connected_at: "test" }));
  return d;
}
async function launch(dir: string): Promise<{ app: ElectronApplication; win: Page; errors: string[] }> {
  app = await electron.launch({ executablePath: electronBin, args: [...(process.platform === "linux" ? ["--no-sandbox"] : []), root],
    env: { ...process.env, RECAST_TEST: "1", RECAST_USER_DATA: dir, RECAST_TEST_FETCH: path.join(root, "test/fake-google.mjs") } });
  const win = await app.firstWindow(); const errors: string[] = [];
  win.on("pageerror", (e) => errors.push(e.message)); win.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await win.waitForSelector("#top"); await win.waitForFunction(() => !!document.documentElement.dataset["theme"]);
  return { app, win, errors };
}
const fake = () => app!.evaluate(() => (globalThis as any).__recastFake ?? { events: {}, tasks: {} });
/** Type a piece (opening the panel first when the capsule is a pill). */
const add = async (win: Page, text: string) => {
  if (await win.evaluate(() => document.body.classList.contains("compact"))) await win.locator("#btn-expand").click();
  await win.locator("#say").fill(text); await win.locator("#say").press("Enter");
};
const objects = (win: Page) => win.locator(".clay-item");
async function dragOnto(win: Page, from: string, to: string) {
  const box = async (t: string) => { const b = (await win.locator(".clay-item", { hasText: t }).first().boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  await win.waitForTimeout(400);   // objects spring into place
  const a = await box(from), b = await box(to);
  await win.mouse.move(a.x, a.y); await win.mouse.down(); await win.mouse.move(a.x + 12, a.y + 12, { steps: 3 });
  await win.mouse.move(b.x, b.y, { steps: 10 }); await win.mouse.move(b.x + 1, b.y, { steps: 1 }); await win.mouse.up();
}
/** A screenshot once the module has finished changing shape and the objects have come to rest. */
async function shot(win: Page, name: string) {
  await win.waitForFunction(() => !document.querySelector(".rg")?.getAnimations().length); await win.waitForTimeout(700);
  await win.screenshot({ path: path.join(root, "test", "shots", `${name}.png`) });
}

describe("Recast desktop", () => {
  it("opens dark when dark is chosen (no white anywhere), and light when light is", async () => {
    let { win, errors } = await launch(profile("dark"));
    expect(await win.evaluate(() => document.documentElement.dataset["theme"])).toBe("dark");
    expect(await win.evaluate(() => getComputedStyle(document.querySelector("#shell")!).backgroundColor)).toBe("rgb(20, 19, 17)");
    expect(await win.evaluate(() => getComputedStyle(document.querySelector("#say")!).backgroundColor)).toBe("rgb(29, 27, 25)");
    // Opened by the person, Recast is the panel (not a pill in a corner, which reads as nothing having opened).
    expect(await win.evaluate(() => document.body.classList.contains("compact"))).toBe(false);
    await shot(win, "empty-dark"); expect(errors).toEqual([]);
    await app!.close(); app = null;
    ({ win, errors } = await launch(profile("light")));
    expect(await win.evaluate(() => getComputedStyle(document.querySelector("#shell")!).backgroundColor)).toBe("rgb(250, 249, 246)");
    await shot(win, "empty-light"); expect(errors).toEqual([]);
  });

  it("typed pieces become objects; pressed together they are an event; Google Calendar gets it after the review; Undo removes it", async () => {
    const { win, errors } = await launch(profile("dark"));
    await add(win, "Dinner with Maya"); await add(win, "Friday 7:30 PM");
    await expect.poll(() => objects(win).count()).toBe(2);
    expect(await objects(win).allInnerTexts()).toEqual([expect.stringContaining("Dinner with Maya"), expect.stringContaining("Friday 7:30 PM")]);
    await dragOnto(win, "Friday 7:30 PM", "Dinner with Maya");
    await win.getByRole("button", { name: /Choose where it goes/ }).click();
    await expect.poll(() => win.locator(".rg-drum").getAttribute("aria-activedescendant")).toBe("rg-opt-calendar");
    await win.waitForTimeout(300);
    await win.getByRole("button", { name: "Open" }).click();
    await expect.poll(() => win.locator(".rg-title").innerText()).toBe("Google Calendar: review");
    expect(await win.locator(".rg-body").innerText()).not.toMatch(/stand-in/i);
    await shot(win, "review-dark");
    expect(Object.keys((await fake()).events)).toHaveLength(0);              // the review writes nothing
    await win.getByRole("button", { name: "Add to calendar" }).click();
    await expect.poll(() => win.locator(".rg-title").innerText()).toBe("Added to Google Calendar");
    const ev = Object.values((await fake()).events)[0] as Record<string, any>;
    expect(ev.summary).toBe("Dinner with Maya"); expect(ev.start.dateTime).toMatch(/T19:30:00$/);
    await shot(win, "receipt-dark");
    await win.getByRole("button", { name: "Undo" }).click();
    await expect.poll(async () => (Object.values((await fake()).events)[0] as any).status).toBe("cancelled");
    expect(errors).toEqual([]);
  });

  it("what you copied anywhere becomes a piece, read for what it is (an error here)", async () => {
    const { win, errors } = await launch(profile("dark"));
    await app!.evaluate(({ clipboard }) => clipboard.writeText("TypeError: Cannot read properties of undefined (reading 'id')"));
    await win.locator("#paste").click();
    await expect.poll(() => objects(win).count()).toBe(1);
    expect(await objects(win).first().innerText()).toMatch(/TypeError/);
    expect(await objects(win).first().getAttribute("data-kind")).toBe("error");
    expect(errors).toEqual([]);
  });

  it("a recipe runs both steps against the person's own Google (Calendar and Tasks), each with its own result", async () => {
    const { win, errors } = await launch(profile("dark"));
    await add(win, "Dinner at Dakshin"); await add(win, "Friday 7:30 PM");
    await expect.poll(() => objects(win).count()).toBe(2);
    await dragOnto(win, "Friday 7:30 PM", "Dinner at Dakshin");
    await win.locator(".rg-recipe[data-recipe='plan-and-prepare']").click();
    await expect.poll(() => win.locator(".rg-title").innerText()).toBe("Recipe: Plan and prepare");
    await shot(win, "recipe-dark");
    await win.getByRole("button", { name: "Run 2 steps" }).click();
    await expect.poll(() => win.locator(".rg-title").innerText()).toBe("Plan and prepare: all 2 done");
    const f = await fake();
    expect(Object.values(f.tasks)).toEqual([expect.objectContaining({ title: "Prepare: Dinner at Dakshin" })]);
    expect(Object.keys(f.events)).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it("the inbox survives a restart: objects are still there after quitting and opening again", async () => {
    const dir = profile("dark");
    let { win } = await launch(dir);
    await add(win, "maya.rao@example.com");
    await expect.poll(() => objects(win).count()).toBe(1);
    await win.waitForTimeout(500);   // the inbox is written a moment after a change
    await app!.close(); app = null;
    ({ win } = await launch(dir));
    await expect.poll(() => objects(win).count()).toBe(1);
    expect(await objects(win).first().getAttribute("data-kind")).toBe("person");
  });

  it("the windows cannot reach Node, and links to anything but the web are refused", async () => {
    const { win } = await launch(profile("dark"));
    expect(await win.evaluate(() => typeof (globalThis as any).require)).toBe("undefined");
    expect(await win.evaluate(() => (window as any).recastDesktop.openExternal("file:///etc/passwd"))).toBe(false);
    expect(await win.evaluate(() => (window as any).recastDesktop.openExternal("javascript:alert(1)"))).toBe(false);
    expect(await win.evaluate(() => (window as any).recastDesktop.act("commit", { destination: "anything" }))).toMatchObject({ status: 400 });
  });

  it("grab: text selected in another app lifts into Recast with the app it came from; the capsule opens from a pill, without taking the keyboard", async () => {
    const { app: a, win, errors } = await launch(profile("dark"));
    const bounds = () => a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === "Recast")!.getBounds());
    await expect.poll(bounds).toMatchObject({ width: 440, height: 640 });         // opened: the panel
    await win.locator("#btn-hide").click();                                          // put away: grabs start from a pill
    await expect.poll(bounds).toMatchObject({ width: 420, height: 64 });
    // Another app: a real browser window on the same screen, with text selected by mouse (the X11 PRIMARY selection).
    const browser = await chromium.launch({ headless: false, ...(otherBrowser ? { executablePath: otherBrowser } : {}), args: ["--no-sandbox"] });
    try {
      const other = await browser.newPage();
      await other.setContent(`<p id="t" style="font: 20px sans-serif; margin: 40px">Lunch with Arjun on Friday 1:00 PM, if that works.</p>`);
      const r = await other.evaluate(() => {
        const n = document.getElementById("t")!.firstChild!; const i = n.textContent!.indexOf("Friday 1:00 PM");
        const range = document.createRange(); range.setStart(n, i); range.setEnd(n, i + "Friday 1:00 PM".length);
        const rects = [...range.getClientRects()]; return { x1: rects[0]!.left + 1, x2: rects.at(-1)!.right - 1, y: rects[0]!.top + rects[0]!.height / 2 };
      });
      await other.mouse.move(r.x1, r.y); await other.mouse.down(); await other.mouse.move(r.x2, r.y, { steps: 8 }); await other.mouse.up();
      const selected = await other.evaluate(() => getSelection()!.toString());
      expect(selected).toBe("Friday 1:00 PM");
      const result = await a.evaluate(() => (globalThis as any).__recastGrab()) as { ok: boolean };
      expect(result.ok).toBe(true);
      await expect.poll(() => objects(win).count()).toBe(1);
      expect(await objects(win).first().innerText()).toContain("Friday 1:00 PM");
      expect(await objects(win).first().getAttribute("data-kind")).toBe("time");
      await expect.poll(bounds).toMatchObject({ width: 440, height: 640 });         // something to do: the panel
      expect(await win.locator("#status").innerText()).toMatch(/^Grabbed from/);
      await shot(win, "grabbed-dark");
    } finally { await browser.close(); }
    expect(errors).toEqual([]);
  });

  it("grab with nothing selected says so, and adds nothing", async () => {
    const { app: a, win } = await launch(profile("dark"));
    await a.evaluate(({ clipboard }) => clipboard.selection?.writeText(""));
    const result = await a.evaluate(() => (globalThis as any).__recastGrab()) as { ok: boolean; reason: string };
    expect(result).toMatchObject({ ok: false, reason: "empty" });
    expect(await win.locator("#status").innerText()).toBe("Select some text first, then press the shortcut");
    expect(await objects(win).count()).toBe(0);
  });
});

