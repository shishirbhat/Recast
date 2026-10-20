import { spawn, type ChildProcess } from "node:child_process";
import { createServer as netServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthError, Recast } from "@recast/sdk";
import { checkResponse } from "@recast/api-core/contract";

const KEY = "sk_test_e2e_00000001"; let proc: ChildProcess, base: string;
beforeAll(async () => {
  const port = await new Promise<number>((ok, fail) => { const s = netServer(); s.once("error", fail); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); });
  proc = spawn("npx", ["next", "start", "-p", String(port)], { env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", RECAST_API_KEYS: `${KEY}:t_e2e:pro:private` }, stdio: "ignore", detached: true });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 450; i++) { try { if ((await fetch(base + "/v1/health")).ok) return; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 200)); }
  throw new Error("server did not start");
});
afterAll(() => { try { if (proc?.pid) process.kill(-proc.pid, "SIGTERM"); } catch { /* gone */ } });

describe("the built Next.js API (what Vercel would run)", () => {
  it("health is open; the landing page renders", async () => {
    expect((await fetch(base + "/v1/health")).status).toBe(200);
    expect(await (await fetch(base)).text()).toContain("Turn any screen object into a typed, routed action");
  });
  it("the SDK resolves and routes through it", async () => {
    const r = await new Recast({ apiKey: KEY, baseUrl: base }).resolve({ raw: "Meera Iyer, meera@x.com", target: { destination: "gmail" } });
    if (r.status !== "resolved") throw new Error(JSON.stringify(r));
    expect(r.routing).toMatchObject({ action: "Create a draft to this person", bridgeReliability: "official_api" });
  });
  it("an unknown key is a 401 with a WWW-Authenticate header, and the SDK raises AuthError", async () => {
    const raw = await fetch(base + "/v1/resolve", { method: "POST", headers: { authorization: "Bearer sk_nobody_nobody_1", "content-type": "application/json" }, body: "{}" });
    expect(raw.status).toBe(401); expect(raw.headers.get("www-authenticate")).toBe("Bearer"); expect(raw.headers.get("x-powered-by")).toBeNull();
    await expect(new Recast({ apiKey: "sk_nobody_nobody_1", baseUrl: base }).resolve({ raw: "x" })).rejects.toBeInstanceOf(AuthError);
  });
  it("headers: schema version, no-store, quota", async () => {
    const r = await fetch(base + "/v1/resolve", { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ input: { raw: "Launch dinner 2026-11-14" } }) });
    expect(r.status).toBe(200); expect(r.headers.get("recast-schema-version")).toBe("1.0.0"); expect(r.headers.get("cache-control")).toBe("no-store"); expect(r.headers.get("x-recast-quota-limit")).toBe("50000");
  });
  it("every answer of the built server matches the published contract, including errors", async () => {
    const auth = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
    const cases: [string, string, Record<string, string>, string | undefined][] = [
      ["GET", "/v1/health", {}, undefined], ["GET", "/v1/capabilities", auth, undefined], ["GET", "/v1/openapi.json", auth, undefined], ["GET", "/v1/bridges", auth, undefined],
      ["POST", "/v1/resolve", auth, JSON.stringify({ input: { raw: "Meera Iyer, meera@x.com" }, target: { destination: "gmail" } })],
      ["POST", "/v1/resolve", auth, JSON.stringify({ input: { raw: "hmm" } })],
      ["POST", "/v1/resolve/batch", auth, JSON.stringify({ items: [{ input: { raw: "Launch dinner 2026-11-14" } }, { input: { raw: "" } }] })],
      ["POST", "/v1/resolve", auth, "{bad json"], ["POST", "/v1/resolve", { ...auth, "content-type": "text/plain" }, "{}"], ["POST", "/v1/resolve", { ...auth, authorization: "Bearer sk_nobody_nobody_1" }, "{}"],
      ["POST", "/v1/place", auth, JSON.stringify({ input: { raw: "x" }, target: { destination: "gmail" } })],   // private cohort: not released
      ["POST", "/v1/corrections", auth, JSON.stringify({ object_id: "x", kind: "undo" })],                    // not opted in
    ];
    const statuses: number[] = [];
    for (const [method, path, headers, body] of cases) {
      const r = await fetch(base + path, { method, headers, ...(body !== undefined ? { body } : {}) }); statuses.push(r.status);
      expect(checkResponse(method, path, r.status, await r.json()), `${method} ${path} -> ${r.status}`).toEqual([]);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 400, 415, 401, 403, 403]);
  });
});
