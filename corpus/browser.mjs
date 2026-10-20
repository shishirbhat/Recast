import { chromium } from "playwright-core";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const dir = path.dirname(fileURLToPath(import.meta.url));
export const manifest = () => JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")).filter((e) => e.ok);
export const html = (e) => readFileSync(path.join(dir, "pages", `${e.id}.html`), "utf8");

export async function launch() {
  const p = process.env.RECAST_CHROMIUM ?? (existsSync("/opt/pw-browsers/chromium") && !existsSync("/opt/pw-browsers/chromium/chrome") ? "/opt/pw-browsers/chromium" : undefined);
  return chromium.launch(p ? { executablePath: p } : {});
}

/** Loads a stored page as a static snapshot: page scripts are blocked by CSP, and no network is allowed. */
export async function openSnapshot(browser, entry) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const body = html(entry);
  await page.route("**/*", (route) => {
    if (route.request().url() === entry.url && route.request().resourceType() === "document") {
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body, headers: { "content-security-policy": "script-src 'none'; connect-src 'none'" } });
    }
    return route.abort();
  });
  await page.goto(entry.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  return { ctx, page };
}
