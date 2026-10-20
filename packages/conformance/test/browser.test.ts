import { chromium, type Browser } from "playwright-core";
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CORE_DIST, OUT } from "../src/paths.js";
import { CASES } from "../src/run-cases.js";
import { golden } from "./shared.js";

// Strict, MV3-like CSP: scripts only from our own origin, no unsafe-eval, no inline.
const CSP = "default-src 'none'; script-src 'self'; connect-src 'none'";
const files: Record<string, [string, string]> = {
  "/": ["text/html", `<!doctype html><meta charset="utf-8"><title>conformance</title><script src="/probe.js"></script><script src="/core.js"></script><script src="/conformance.js"></script>`],
};
// Runs as a normal page script (so the CSP applies). page.evaluate() goes through the debugger and would bypass it.
const PROBE = `try { new Function("return 1")(); window.__evalProbe = "allowed"; } catch (e) { window.__evalProbe = "blocked"; }`;
let server: Server, browser: Browser, url: string;

function chromiumPath(): string | undefined {
  if (process.env.RECAST_CHROMIUM) return process.env.RECAST_CHROMIUM;
  return existsSync("/opt/pw-browsers/chromium") && !existsSync("/opt/pw-browsers/chromium/chrome") ? "/opt/pw-browsers/chromium" : undefined;
}

beforeAll(async () => {
  files["/probe.js"] = ["text/javascript", PROBE];
  files["/core.js"] = ["text/javascript", readFileSync(path.join(CORE_DIST, "recast-core.iife.js"), "utf8")];
  files["/conformance.js"] = ["text/javascript", readFileSync(path.join(OUT, "conformance.iife.js"), "utf8")];
  server = createServer((req, res) => {
    const f = files[req.url ?? ""];
    if (!f) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": f[0], "content-security-policy": CSP }).end(f[1]);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const executablePath = chromiumPath();
  browser = await chromium.launch(executablePath ? { executablePath } : {});
});
afterAll(async () => { await browser?.close(); server?.close(); });

describe("conformance: Chromium (IIFE bundle under a strict CSP)", () => {
  it("the CSP really forbids eval and new Function (so a pass below is meaningful)", async () => {
    const page = await browser.newPage();
    await page.goto(url);
    const r = await page.evaluate(() => (globalThis as unknown as { __evalProbe: string }).__evalProbe);
    expect(r).toBe("blocked");
    await page.close();
  });

  it(`runs all ${CASES.length} fixture cases with byte-identical canonical output`, async () => {
    const page = await browser.newPage();
    const violations: string[] = [];
    page.on("console", (m) => { if (/content security policy/i.test(m.text())) violations.push(m.text()); });
    page.on("pageerror", (e) => violations.push(e.message));
    await page.goto(url);
    const results = await page.evaluate(async () => {
      const g = globalThis as unknown as { RecastCore: unknown; RecastConformance: { run(c: unknown): Promise<{ name: string; canonical: string; mismatches: string[] }[]> } };
      return g.RecastConformance.run(g.RecastCore);
    });
    expect(violations).toEqual([]);
    expect(results.map((r) => r.name)).toEqual(CASES.map((c) => c.name));
    for (const r of results) {
      expect(r.mismatches, `${r.name}: hand-written expectations`).toEqual([]);
      expect(r.canonical, `${r.name}: canonical output vs golden`).toBe(golden(r.name));
    }
    await page.close();
  });
});
