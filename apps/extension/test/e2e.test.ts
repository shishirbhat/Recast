import { chromium, type BrowserContext, type Page } from "playwright-core";
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ext = path.join(root, "dist-test");
let server: Server, ctx: BrowserContext, base: string, extId: string, profile: string;

/** Chrome derives an unpacked extension's id from its absolute path: sha256, first 16 bytes, hex mapped 0-f -> a-p. */
const idFromPath = (p: string) => [...createHash("sha256").update(p).digest("hex").slice(0, 32)].map((c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16))).join("");

function chromiumPath() {
  if (process.env.RECAST_CHROMIUM) return process.env.RECAST_CHROMIUM;
  return existsSync("/opt/pw-browsers/chromium") && !existsSync("/opt/pw-browsers/chromium/chrome") ? "/opt/pw-browsers/chromium" : undefined;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const f = path.join(root, "test/fixtures", (req.url ?? "/").replace(/^\/+/, "").split("?")[0] || "product.html");
    if (!existsSync(f)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(f));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  extId = idFromPath(ext);
  profile = path.join(root, "dist-test/.profile");
  ctx = await chromium.launchPersistentContext(profile, {
    executablePath: chromiumPath(), headless: false,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--headless=new", "--no-first-run"],
  });
});
afterEach(async () => { for (const p of ctx.pages().slice(1)) await p.close().catch(() => {}); });
afterAll(async () => { await ctx?.close(); server?.close(); });

async function open(fixture: string): Promise<{ page: Page; popup: Page; tabId: number }> {
  const page = await ctx.newPage();
  await page.goto(`${base}/${fixture}`);
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  const tabId = await popup.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]!.id!, `${base}/${fixture}`);
  await popup.goto(`chrome-extension://${extId}/popup.html?tabId=${tabId}`);
  await popup.waitForFunction(() => document.getElementById("status")!.textContent !== "Reading this page…", null, { timeout: 15000 });
  return { page, popup, tabId };
}

describe("extension end to end (real Chromium, real injection)", () => {
  it("shows the product, its source, and confidence", async () => {
    const { popup } = await open("product.html");
    const text = await popup.locator("#root").innerText();
    expect(text).toContain("Stagg EKG Electric Kettle");
    expect(text).toMatch(/Product · Page metadata \(JSON-LD\) · least sure: 85%/);
    expect(await popup.locator("#status").innerText()).toMatch(/1 about this page.*on this device/);
    await popup.close();
  });

  it("shows a paper with authors flipped to reading order, and the year", async () => {
    const { popup } = await open("paper.html");
    const text = await popup.locator("#root").innerText();
    expect(text).toContain("Kaiming He, Xiangyu Zhang");
    expect(text).toContain("2015");
    await popup.close();
  });

  it("'Show' highlights the real element on the page, and reports metadata-only sources honestly", async () => {
    const { page, popup } = await open("product.html");
    expect(await popup.locator("details.obj").first().getAttribute("open")).not.toBeNull();   // the primary object opens by default
    // name is visible in the <h1>, so it can be highlighted
    await popup.getByRole("button", { name: /Show where name came from/ }).click();
    await page.waitForSelector("[data-recast-highlight]", { timeout: 5000 });
    const box = await page.evaluate(() => { const b = document.querySelector("[data-recast-highlight]")!.getBoundingClientRect(); const h = document.querySelector("h1")!.getBoundingClientRect(); return { dx: Math.abs(b.left + 3 - h.left), dy: Math.abs(b.top + 3 - h.top) }; });
    expect(box.dx).toBeLessThan(2); expect(box.dy).toBeLessThan(2);
    // brand only exists in JSON-LD, not visibly: must say so instead of pretending
    await popup.getByRole("button", { name: /Show where price came from/ }).click();
    await popup.locator(".note:visible").first().waitFor();
    expect(await popup.locator(".note:visible").first().innerText()).toMatch(/not shown on the page/);
    await popup.close(); await page.close();
  });

  it("never runs page-controlled strings as HTML or script (XSS)", async () => {
    const { page, popup } = await open("hostile.html");
    const text = await popup.locator("#root").innerText();
    expect(text).toContain("<img src=x onerror=");                    // shown literally
    expect(await popup.evaluate(() => (globalThis as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(await page.evaluate(() => (globalThis as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(await popup.locator("#root img").count()).toBe(0);
    await popup.close(); await page.close();
  });

  it("says plainly when there is nothing reliable to show", async () => {
    const { popup } = await open("empty.html");
    expect(await popup.locator("#root").innerText()).toMatch(/does not describe anything Recast can read reliably/);
    await popup.close();
  });

  it("cannot read pages it has no permission for", async () => {
    const page = await ctx.newPage();
    await page.goto("about:blank");
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    const tabId = await popup.evaluate(async () => (await chrome.tabs.query({ url: "about:blank" }))[0]?.id ?? -1);
    await popup.goto(`chrome-extension://${extId}/popup.html?tabId=${tabId > 0 ? tabId : 999999}`);
    await popup.waitForFunction(() => document.getElementById("status")!.textContent !== "Reading this page…", null, { timeout: 15000 });
    expect(await popup.locator("#status").innerText()).toBe("Recast can't read this page.");
    await popup.close(); await page.close();
  });

  it("measures end-to-end capture latency (inject + extract + return)", async () => {
    const { page, popup, tabId } = await open("paper.html");
    const times = await popup.evaluate(async (id) => {
      const out: number[] = [];
      for (let i = 0; i < 30; i++) {
        const t0 = performance.now();
        await chrome.scripting.executeScript({ target: { tabId: id }, files: ["page.js"] });
        await chrome.scripting.executeScript({ target: { tabId: id }, func: () => (globalThis as unknown as { __recast: { capture(): unknown } }).__recast.capture() });
        out.push(performance.now() - t0);
      }
      return out;
    }, tabId);
    const s = [...times].sort((a, b) => a - b);
    const p50 = s[15]!, p95 = s[28]!;
    console.log(`END-TO-END capture (inject+extract+return), 30 runs: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${s.at(-1)!.toFixed(1)} ms`);
    expect(p95).toBeLessThan(100);   // structured capture budget
    await popup.close(); await page.close();
  });
});
