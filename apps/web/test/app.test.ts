import { chromium, type Browser, type Page } from "playwright-core";
import AxeBuilder from "@axe-core/playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let browser: Browser;
const servers: ChildProcess[] = [];
let nextPort = 3400 + Math.floor(Math.random() * 400);

function chromiumPath() {
  if (process.env.RECAST_CHROMIUM) return process.env.RECAST_CHROMIUM;
  return existsSync("/opt/pw-browsers/chromium") && !existsSync("/opt/pw-browsers/chromium/chrome") ? "/opt/pw-browsers/chromium" : undefined;
}
/** A fresh production server per test, so demo data starts identical every time. */
async function server() {
  const port = nextPort++;
  const p = spawn("npx", ["next", "start", "-p", String(port)], { env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" }, stdio: "ignore" });
  servers.push(p);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 450; i++) { try { if ((await fetch(base)).ok) return base; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 200)); }
  throw new Error("server did not start");
}
beforeAll(async () => { const executablePath = chromiumPath(); browser = await chromium.launch(executablePath ? { executablePath } : {}); });
afterAll(async () => { await browser?.close(); servers.forEach((s) => s.kill()); });

async function open(opts: { theme?: "light" | "dark" } = {}): Promise<{ page: Page; base: string; errors: string[] }> {
  const base = await server();
  const ctx = await browser.newContext({ colorScheme: opts.theme ?? "light", viewport: { width: 1100, height: 800 }, acceptDownloads: true });
  const page = await ctx.newPage(); const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(base); return { page, base, errors };
}
const SECTIONS = [["Objects", "/", "Meera Iyer"], ["Relationships", "/relationships", "attendee"], ["Integrations", "/integrations", "Google Calendar"], ["Permissions", "/permissions", "Create and edit events"], ["History", "/history", "Learned"], ["Privacy", "/privacy", "Export everything"]] as const;

describe("control center (production build, demo data)", () => {
  it("every section renders its content and the nav marks the current page", async () => {
    const { page, errors } = await open();
    for (const [label, href, text] of SECTIONS) {
      if (href !== "/") await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: label }).click();   // already on Objects at start
      await page.waitForURL((u) => u.pathname === href);
      await page.getByText(text).first().waitFor();
      expect(await page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: label }).getAttribute("aria-current")).toBe("page");
    }
    expect(errors).toEqual([]);
  });

  it("relationships read as sentences", async () => {
    const { page } = await open(); await page.goto(new URL("/relationships", page.url()).href);
    expect(await page.getByRole("listitem").filter({ hasText: "Meera Iyer" }).innerText()).toMatch(/Meera Iyer is an attendee of Launch dinner/);
  });

  it("integrations show a plain reliability label and can be switched off and on", async () => {
    const { page } = await open(); await page.goto(new URL("/integrations", page.url()).href);
    const cal = page.getByRole("listitem").filter({ hasText: "Google Calendar" });
    expect(await cal.innerText()).toMatch(/Reliable/);
    expect(await page.getByRole("listitem").filter({ hasText: "Legacy CRM" }).innerText()).toMatch(/Best effort[\s\S]*Off/);
    await page.getByRole("button", { name: "Turn off Google Calendar" }).click();
    await page.getByRole("button", { name: "Turn on Google Calendar" }).waitFor();
    await page.goto(new URL("/history", page.url()).href);
    expect(await page.getByRole("listitem").first().innerText()).toMatch(/Turned off\s+google-calendar/);
  });

  it("revoking a permission shows Revoked, removes the button, and is logged", async () => {
    const { page } = await open(); await page.goto(new URL("/permissions", page.url()).href);
    await page.getByRole("button", { name: /Revoke Google Calendar/ }).click();
    await page.getByText("Revoked").waitFor();
    expect(await page.getByRole("button", { name: /Revoke Google Calendar/ }).count()).toBe(0);
    await page.goto(new URL("/history", page.url()).href);
    expect(await page.getByRole("listitem").first().innerText()).toMatch(/Revoked\s+grant-gcal/);
  });

  it("forgetting an object also removes its relationships", async () => {
    const { page } = await open();
    await page.getByRole("button", { name: "Forget Meera Iyer" }).click();
    await page.waitForFunction(() => !document.body.innerText.includes("Meera Iyer"));
    await page.goto(new URL("/relationships", page.url()).href);
    expect(await page.getByRole("listitem").count()).toBe(1);
    expect(await page.getByRole("listitem").first().innerText()).toMatch(/Toit is a location of Launch dinner/);
  });

  it("export downloads valid JSON containing the data and the audit log", async () => {
    const { page } = await open(); await page.goto(new URL("/privacy", page.url()).href);
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download JSON" }).click()]);
    expect(dl.suggestedFilename()).toBe("recast-export.json");
    const { readFileSync } = await import("node:fs");
    const json = JSON.parse(readFileSync((await dl.path())!, "utf8"));
    expect(json.version).toBe(1); expect(json.objects.map((o: { title: string }) => o.title)).toContain("Meera Iyer");
    expect(json.audit.length).toBeGreaterThan(0);
  });

  it("delete everything needs the word DELETE; a wrong word deletes nothing, the right one deletes all and logs it", async () => {
    const { page } = await open(); await page.goto(new URL("/privacy", page.url()).href);
    await page.getByLabel("Type DELETE to confirm").fill("delete please");
    await page.getByRole("button", { name: "Delete everything" }).click();
    await page.locator("#err").waitFor();
    expect(await page.locator("#err").innerText()).toMatch(/Nothing was deleted/);
    await page.goto(new URL("/", page.url()).href); await page.getByText("Meera Iyer").waitFor();
    await page.goto(new URL("/privacy", page.url()).href);
    await page.getByLabel("Type DELETE to confirm").fill("DELETE");
    await page.getByRole("button", { name: "Delete everything" }).click();
    await page.getByRole("status").waitFor();
    await page.goto(new URL("/", page.url()).href);
    await page.getByText("Nothing here yet").waitFor();
    await page.goto(new URL("/history", page.url()).href);
    expect(await page.getByRole("listitem").first().innerText()).toMatch(/Deleted all data/);
  });

  it("keyboard only: Tab reaches the skip link first, then every nav link in order", async () => {
    const { page } = await open();
    await page.keyboard.press("Tab"); expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Skip to content");
    for (const [label] of SECTIONS) { await page.keyboard.press("Tab"); expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe(label); }
  });

  for (const theme of ["light", "dark"] as const) it(`axe: no serious or critical issues on any section (${theme})`, async () => {
    const { page, base } = await open({ theme });
    for (const [, href] of SECTIONS) {
      await page.goto(base + href);
      const bad = (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(bad.map((v) => `${href}: ${v.id} ${v.nodes[0]?.html}`)).toEqual([]);
    }
  });

  it("is usable on a phone-width screen with no sideways scroll", async () => {
    const { page, base } = await open(); await page.setViewportSize({ width: 375, height: 700 });
    for (const [, href] of SECTIONS) { await page.goto(base + href); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); }
  });
});
