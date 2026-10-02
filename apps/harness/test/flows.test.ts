import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import AxeBuilder from "@axe-core/playwright";
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
let server: Server, browser: Browser, base: string;

function chromiumPath() {
  if (process.env.RECAST_CHROMIUM) return process.env.RECAST_CHROMIUM;
  return existsSync("/opt/pw-browsers/chromium") && !existsSync("/opt/pw-browsers/chromium/chrome") ? "/opt/pw-browsers/chromium" : undefined;
}
beforeAll(async () => {
  server = createServer((q, r) => {
    const u = (q.url ?? "/").split("?")[0]!; const f = path.join(dist, u === "/" ? "index.html" : u);
    if (!existsSync(f)) { r.writeHead(404).end(); return; }
    r.writeHead(200, { "content-type": MIME[path.extname(f)] ?? "application/octet-stream" }).end(readFileSync(f));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const executablePath = chromiumPath();
  browser = await chromium.launch(executablePath ? { executablePath } : {});
});
afterAll(async () => { await browser?.close(); server?.close(); });

type H = { page: Page; ctx: BrowserContext };
async function open(opts: { theme?: "light" | "dark"; reducedMotion?: "reduce" | "no-preference" } = {}): Promise<H> {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 760 }, reducedMotion: opts.reducedMotion ?? "no-preference", colorScheme: opts.theme ?? "light" });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  (page as unknown as { _errors: string[] })._errors = errors;
  await page.goto(`${base}/?theme=${opts.theme ?? "light"}`);
  return { page, ctx };
}
const errorsOf = (p: Page) => (p as unknown as { _errors: string[] })._errors;
const phase = (p: Page) => p.evaluate(() => (globalThis as any).__recast.state().phase as string);
const waitPhase = (p: Page, ph: string) => p.waitForFunction((x) => (globalThis as any).__recast.state().phase === x, ph, { timeout: 5000 });
const centre = async (p: Page, sel: string) => { const b = (await p.locator(sel).boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
const chipCentre = (p: Page, i = 0) => p.evaluate((k) => { const r = (globalThis as any).__recast.state().chips[k].rect; return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; }, i);
const overlay = (p: Page, sel: string) => p.locator(`recast-overlay >> ${sel}`);
const text = (p: Page, sel: string) => p.locator(sel).innerText();

/** Lift `from`, carry it over `dest`, and rest on chip `i`. */
async function carryTo(p: Page, from: string, dest: string, i = 0) {
  const s = await centre(p, from);
  await p.keyboard.down("Alt"); await p.mouse.move(s.x, s.y); await p.waitForFunction(() => (globalThis as any).__recast.state().hovered, null, { timeout: 5000 });
  await p.mouse.down();
  const d = await p.locator(dest).boundingBox(); await p.mouse.move(d!.x + 80, d!.y + 120, { steps: 8 });
  await p.waitForFunction(() => (globalThis as any).__recast.state().chips.length > 0, null, { timeout: 5000 });
  const c = await chipCentre(p, i); await p.mouse.move(c.x, c.y, { steps: 6 });
  return c;
}

describe("real pointer flows in Chromium (classifier -> engine -> overlay -> destination)", () => {
  it("lift mode outlines what can be lifted, with its type glyph, and says so for screen readers", async () => {
    const { page, ctx } = await open();
    const s = await centre(page, "#meera");
    await page.keyboard.down("Alt"); await page.mouse.move(s.x, s.y);
    await overlay(page, "[data-testid=lift-outline]").waitFor();
    expect(await overlay(page, "[data-testid=lift-outline]").innerText()).toBe("P");
    expect(await overlay(page, "[data-testid=live]").textContent()).toMatch(/Meera Iyer, Person\. Click to lift\./);
    // the plain note is not a confident reading: no outline, calm by default
    const n = await centre(page, "#notes"); await page.mouse.move(n.x, n.y); await page.waitForTimeout(100);
    expect(await overlay(page, "[data-testid=lift-outline]").count()).toBe(0);
    expect(errorsOf(page)).toEqual([]); await ctx.close();
  });

  it("medium risk: Person to calendar shows only 'attendee', previews, asks once, places a real row, and Undo removes it", async () => {
    const { page, ctx } = await open();
    const c = await carryTo(page, "#meera", "#calendar");
    await waitPhase(page, "previewing");
    expect(await overlay(page, "[data-testid=chip]").allInnerTexts()).toEqual(["Attendee"]);   // not "location"
    await overlay(page, "[data-testid=ghost]").waitFor();
    expect(await overlay(page, "[data-testid=ghost]").innerText()).toMatch(/meera@example\.com/);
    await page.mouse.up(); await waitPhase(page, "confirming");
    expect(await text(page, "#attendees")).toBe("");                                              // nothing has happened yet
    await page.mouse.down(); await page.mouse.up();
    await overlay(page, "[data-testid=toast]").waitFor();
    expect(await text(page, "#attendees")).toBe("Meera Iyer <meera@example.com>");
    expect(await overlay(page, "[data-testid=toast]").innerText()).toMatch(/Added as attendee\s+Undo/);
    await overlay(page, "[data-testid=toast] button").click();
    await page.waitForFunction(() => !document.querySelector("#attendees li"));
    expect(await text(page, "#attendees")).toBe("");
    void c; expect(errorsOf(page)).toEqual([]); await ctx.close();
  });

  it("low risk: a venue the page publishes as structured data lifts as a confident object and is placed on release, and Undo restores it", async () => {
    const { page, ctx } = await open();
    await carryTo(page, "#venue-name", "#calendar");
    expect(await page.evaluate(() => (globalThis as any).__recast.state().chips[0].tier)).toBe("low");
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector("#location")!.textContent !== "");
    expect(await text(page, "#location")).toBe("Toit");
    await overlay(page, "[data-testid=toast]").waitFor();
    await overlay(page, "[data-testid=toast] button").click();
    await page.waitForFunction(() => document.querySelector("#location")!.textContent === "");
    await ctx.close();
  });

  it("a guessed address is at least 'medium': it asks for one light confirmation instead of placing on release", async () => {
    const { page, ctx } = await open();
    await carryTo(page, "#office-address", "#calendar");
    expect(await page.evaluate(() => (globalThis as any).__recast.state().chips[0].tier)).toBe("medium");
    await page.mouse.up(); await waitPhase(page, "confirming");
    expect(await text(page, "#location")).toBe("");
    await page.mouse.down(); await page.mouse.up();
    await page.waitForFunction(() => document.querySelector("#location")!.textContent !== "");
    expect(await text(page, "#location")).toBe("12 MG Road, Bengaluru 560001");
    await ctx.close();
  });

  it("high risk: sending needs a real hold; letting go early places nothing; a full hold places and says 'Sent'", async () => {
    const { page, ctx } = await open();
    const c = await carryTo(page, "#meera", "#mail");
    await page.mouse.up(); await waitPhase(page, "confirming");
    expect(await overlay(page, "[data-testid=chip]").first().innerText()).toMatch(/Hold to confirm/);
    await page.mouse.down(); await page.waitForTimeout(300); await page.mouse.up();
    await page.waitForTimeout(150);
    expect(await text(page, "#to")).toBe(""); expect(await phase(page)).toBe("confirming");
    await page.mouse.down(); await page.waitForTimeout(800);
    await overlay(page, "[data-testid=toast]").waitFor();
    expect(await text(page, "#to")).toBe("meera@example.com");
    expect(await overlay(page, "[data-testid=toast]").innerText()).toMatch(/Sent/);
    void c; await ctx.close();
  });

  it("Escape at any moment cancels, changes nothing, and leaves no token behind", async () => {
    const { page, ctx } = await open();
    await carryTo(page, "#meera", "#calendar"); await waitPhase(page, "previewing");
    await page.keyboard.press("Escape");
    await waitPhase(page, "idle");
    await page.mouse.up();
    expect(await overlay(page, "[data-testid=token]").count()).toBe(0);
    expect(await overlay(page, "[data-testid=chip]").count()).toBe(0);
    expect(await text(page, "#attendees")).toBe("");
    expect(await overlay(page, "[data-testid=live]").textContent()).toMatch(/Cancelled\. Nothing changed\./);
    await ctx.close();
  });

  it("an unsure reading is not offered by default, is offered with Shift, and its blocked chip explains itself", async () => {
    const { page, ctx } = await open();
    const s = await centre(page, "#priya");
    await page.keyboard.down("Alt"); await page.mouse.move(s.x, s.y); await page.waitForTimeout(150);
    expect(await page.evaluate(() => (globalThis as any).__recast.state().hovered)).toBeNull();
    await page.keyboard.down("Shift"); await page.mouse.move(s.x + 2, s.y + 1); await page.waitForFunction(() => (globalThis as any).__recast.state().hovered, null, { timeout: 5000 });
    await page.mouse.down();
    const d = await page.locator("#calendar").boundingBox(); await page.mouse.move(d!.x + 80, d!.y + 120, { steps: 6 });
    await page.waitForFunction(() => (globalThis as any).__recast.state().chips.length > 0);
    const c = await chipCentre(page); await page.mouse.move(c.x, c.y, { steps: 5 });
    await overlay(page, "[data-testid=note]").waitFor();
    expect(await overlay(page, "[data-testid=note]").innerText()).toBe("Can't: needs email");
    expect(await overlay(page, "[data-testid=chip]").first().getAttribute("data-status")).toBe("blocked");
    await page.mouse.up(); await waitPhase(page, "idle");
    expect(await text(page, "#attendees")).toBe("");
    await ctx.close();
  });

  it("keyboard only: lift, Tab through every place it could go, Enter to place", async () => {
    const { page, ctx } = await open();
    await page.keyboard.press("Control+Shift+L");
    await waitPhase(page, "lifting");
    await page.waitForFunction(() => (globalThis as any).__recast.state().hovered);
    expect(await overlay(page, "[data-testid=live]").textContent()).toMatch(/Enter to lift/);
    // Tab to Meera (first confident candidate), lift her
    for (let i = 0; i < 6; i++) { const n = await page.evaluate(() => (globalThis as any).__recast.state().hovered?.object.properties.name); if (n === "Meera Iyer") break; await page.keyboard.press("Tab"); }
    await page.keyboard.press("Enter"); await waitPhase(page, "previewing");
    expect(await overlay(page, "[data-testid=live]").textContent()).toMatch(/attendee\..*Add attendee: Meera Iyer/);
    await page.keyboard.press("Enter"); await waitPhase(page, "confirming");
    await page.keyboard.press("Enter");
    await overlay(page, "[data-testid=toast]").waitFor();
    expect(await text(page, "#attendees")).toBe("Meera Iyer <meera@example.com>");
    await ctx.close();
  });

  it("works with reduced motion on (no springs, same result)", async () => {
    const { page, ctx } = await open({ reducedMotion: "reduce" });
    await carryTo(page, "#venue-name", "#calendar");
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector("#location")!.textContent !== "");
    expect(errorsOf(page)).toEqual([]); await ctx.close();
  });

  it("the overlay lives in a shadow root: page styles cannot restyle it", async () => {
    const { page, ctx } = await open();
    await page.addStyleTag({ content: "div, span, button { color: red !important; font-size: 40px !important; }" });
    await carryTo(page, "#meera", "#calendar");
    const size = await overlay(page, "[data-testid=token] span >> nth=1").evaluate((e) => getComputedStyle(e).fontSize);
    expect(size).toBe("13px");
    await ctx.close();
  });
});

describe("accessibility (axe-core on every state, light and dark)", () => {
  const scan = async (page: Page, label: string) => {
    const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(bad.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), label).toEqual([]);
  };
  for (const theme of ["light", "dark"] as const) {
    it(`${theme}: lifting, previewing, confirming, toast`, async () => {
      const { page, ctx } = await open({ theme });
      const s = await centre(page, "#meera");
      await page.keyboard.down("Alt"); await page.mouse.move(s.x, s.y); await overlay(page, "[data-testid=lift-outline]").waitFor();
      await scan(page, `${theme}/lifting`);
      await page.mouse.down();
      const d = await page.locator("#calendar").boundingBox(); await page.mouse.move(d!.x + 80, d!.y + 120, { steps: 6 });
      await page.waitForFunction(() => (globalThis as any).__recast.state().chips.length > 0);
      const c = await chipCentre(page); await page.mouse.move(c.x, c.y, { steps: 6 });
      await overlay(page, "[data-testid=ghost]").waitFor(); await page.waitForTimeout(300);
      await scan(page, `${theme}/previewing`);
      await page.mouse.up(); await waitPhase(page, "confirming"); await scan(page, `${theme}/confirming`);
      await page.mouse.down(); await page.mouse.up(); await overlay(page, "[data-testid=toast]").waitFor(); await page.waitForTimeout(300);
      await scan(page, `${theme}/toast`);
      await ctx.close();
    });
  }
});

describe("responsiveness", () => {
  it("the page stays responsive while the toast is showing and while carrying (no main-thread stalls over 100 ms)", async () => {
    const { page, ctx } = await open();
    await page.evaluate(() => { const w = globalThis as any; w.__gaps = []; let last = performance.now(); setInterval(() => { const n = performance.now(); w.__gaps.push(n - last); last = n; }, 20); });
    await carryTo(page, "#venue-name", "#calendar");
    await page.evaluate(() => { (globalThis as any).__gaps.length = 0; });
    await page.mouse.up(); await overlay(page, "[data-testid=toast]").waitFor();
    await page.waitForTimeout(2000);
    const r = await page.evaluate(() => { const g = (globalThis as any).__gaps as number[]; return { max: Math.max(...g), n: g.length }; });
    console.log(`RESPONSIVENESS while toast visible: ${r.n} timer callbacks in 2 s, worst gap ${r.max.toFixed(0)} ms`);
    expect(r.max).toBeLessThan(100); expect(r.n).toBeGreaterThan(60);
    await ctx.close();
  });
});

describe("latency budgets (measured in Chromium, reported)", () => {
  it("preview under 150 ms; placement under 1 s", async () => {
    const preview: number[] = [], place: number[] = [];
    for (let i = 0; i < 15; i++) {
      const { page, ctx } = await open();
      await carryTo(page, "#venue-name", "#calendar");
      await overlay(page, "[data-testid=ghost]").waitFor(); await page.waitForTimeout(50);
      await page.mouse.up();
      await overlay(page, "[data-testid=toast]").waitFor(); await page.waitForTimeout(50);
      const m = await page.evaluate(() => (globalThis as any).__recast.marks as Record<string, number>);
      preview.push(m["ghost-painted"]! - m["preview-start"]!); place.push(m["toast-painted"]! - m["release"]!);
      await ctx.close();
    }
    const q = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))]!.toFixed(1);
    console.log(`LATENCY preview (chip reached -> ghost painted): p50 ${q(preview, 0.5)} ms, p95 ${q(preview, 0.95)} ms | placement (release -> toast painted, in-page bridge): p50 ${q(place, 0.5)} ms, p95 ${q(place, 0.95)} ms`);
    expect(Math.max(...preview)).toBeLessThan(150);
    expect(Math.max(...place)).toBeLessThan(1000);
  });
});
