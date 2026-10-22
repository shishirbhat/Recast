// The developer docs are tested: every curl example on /docs is sent to the built server and must answer as the page says, the
// SDK example on the page is run as written, and the error table must cover every code the server can send.
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkResponse } from "@recast/api-core/contract";
import { ERROR_CODES, EXAMPLES, curl } from "../lib/examples";
import { example } from "../lib/sdk-example";

const KEY = "sk_test_docs_000000001"; let proc: ChildProcess, base: string;
beforeAll(async () => {
  const port = await new Promise<number>((ok, fail) => { const s = netServer(); s.once("error", fail); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); });
  proc = spawn("npx", ["next", "start", "-p", String(port)], { env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", RECAST_API_KEYS: `${KEY}:t_docs:pro:private` }, stdio: "ignore", detached: true });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 450; i++) { try { if ((await fetch(base + "/v1/health")).ok) return; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 200)); }
  throw new Error("server did not start");
});
afterAll(() => { try { if (proc?.pid) process.kill(-proc.pid, "SIGTERM"); } catch { /* gone */ } });

const send = (e: (typeof EXAMPLES)[number]) => fetch(base + e.path, {
  method: e.method,
  headers: { Authorization: `Bearer ${KEY}`, ...(e.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(e.headers ?? {}) },
  ...(e.body !== undefined ? { body: JSON.stringify(e.body) } : {}),
});

describe("/docs", () => {
  it.each(EXAMPLES.map((e) => [e.id, e] as const))("example '%s' answers as documented, and inside the contract", async (_id, e) => {
    const r = await send(e); const j = await r.json() as any;
    expect(r.status).toBe(e.expect.status);
    if (e.expect.code) expect(j.error.code).toBe(e.expect.code);
    if (e.expect.header) expect(r.headers.get(e.expect.header[0])).toBe(e.expect.header[1]);
    expect(checkResponse(e.method, e.path, r.status, j)).toEqual([]);
  });
  it("the retry example really replays: same key, same body, first answer again", async () => {
    const e = EXAMPLES.find((x) => x.id === "idempotency")!; await send(e);
    const again = await send(e); expect(again.headers.get("idempotent-replay")).toBe("true");
  });
  it("the SDK example on the page runs as written", async () => {
    const r = await example(KEY, base);
    expect(r).toMatchObject({ status: "resolved", object: { type: "Person" } });
  });
  it("the page renders every example, the SDK code and the error table, with no secrets", async () => {
    const r = await fetch(base + "/docs"); expect(r.status).toBe(200); const html = await r.text();
    const text = html.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    for (const e of EXAMPLES) { expect(text).toContain(e.title); expect(text).toContain(curl(e).split("\n")[0]!); }
    expect(text).toContain("export async function example(apiKey: string");
    for (const [c] of ERROR_CODES) expect(text).toContain(c);
    expect(html).not.toMatch(/sk_(live|test)_[0-9a-f]{20,}/);
  });
  it("the error table covers every code the server and the resolver can send", () => {
    const src = ["../../packages/api-core/src/api.ts", "../../packages/resolve/src/engine.ts"].map((f) => readFileSync(new URL(f, import.meta.url.replace(/test\/docs\.test\.ts$/, "")), "utf8")).join("\n");
    const sent = new Set([...src.matchAll(/HttpError\(\d{3}, "([a-z_]+)"/g), ...src.matchAll(/ResolveInputError\(.*, "([a-z_]+)"\);/g), ...src.matchAll(/"((?:destination|internal)_[a-z_]+)"/g)].map((m) => m[1]!));
    sent.add("already_undone"); sent.add("undo_in_progress");   // chosen by a conditional in api.ts
    expect(sent.size).toBeGreaterThanOrEqual(36);   // the extraction itself is checked, so a regex that stops matching cannot pass silently
    const documented = new Set(ERROR_CODES.map(([c]) => c));
    expect([...sent].filter((c) => !documented.has(c)).sort()).toEqual([]);
  });
});
