import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryKeyStore, MemoryUsageStore, createApi, TIERS } from "@recast/api-core";
import { createResolver } from "@recast/resolve";
import { AuthError, QuotaError, Recast, ValidationError } from "../src";

let server: Server, base: string; const usage = new MemoryUsageStore();
const KEY = "sk_test_integration_01", POOR = "sk_test_poor_integration";
beforeAll(async () => {
  const keys = new MemoryKeyStore(); await keys.add(KEY, { tenantId: "t1", tier: "pro", correctionsOptIn: true, cohort: "internal" }); await keys.add(POOR, { tenantId: "t2", tier: "free", cohort: "private" });
  const api = createApi({ resolver: createResolver(), keys, usage });
  server = createServer(async (q, r) => {
    const chunks: Buffer[] = []; for await (const c of q) chunks.push(c as Buffer);
    const res = await api.handle(new Request(`http://localhost${q.url}`, { method: q.method!, headers: q.headers as Record<string, string>, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }));
    r.writeHead(res.status, Object.fromEntries(res.headers)); r.end(await res.text());
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok)); base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => { server.close(); });

describe("the SDK against the real API over real HTTP", () => {
  const sdk = () => new Recast({ apiKey: KEY, baseUrl: base });
  it("resolve + route: the whole happy path", async () => {
    const r = await sdk().resolve({ raw: "Meera Iyer, meera@x.com", target: { destination: "google_calendar" } });
    if (r.status !== "resolved") throw new Error(JSON.stringify(r));
    expect(r.object.fields).toMatchObject({ name: "Meera Iyer", email: ["meera@x.com"] });
    expect(r.routing).toMatchObject({ action: "Add attendee", bridgeReliability: "official_api", consent: "confirm", requiresConfirmation: true });
    expect(r.meta).toMatchObject({ stage: "rules", degraded: false });
  });
  it("all three result shapes come through", async () => {
    const s = sdk();
    expect((await s.resolve({ raw: "Founders meetup 2026-11-14 ₹500" })).status).toBe("ambiguous");
    expect((await s.resolve({ raw: "hello" })).status).toBe("unresolved");
    const r = await s.from("Founders meetup 2026-11-14 ₹500").as("Event").to("google_calendar").run(); expect(r.status).toBe("resolved");
  });
  it("batch keeps order and turns a bad item into an error entry", async () => {
    const out = await sdk().resolveBatch([{ raw: "Meera Iyer, meera@x.com" }, { raw: "x", target: { destination: "hubspot" } }, { raw: "Launch dinner 2026-11-14" }]);
    expect(out.map((o) => o.status)).toEqual(["resolved", "error", "resolved"]);
  });
  it("bridges list", async () => {
    const b = await sdk().bridges.list(); expect(b.map((x) => x.id)).toContain("notion"); expect(b[0]).toMatchObject({ name: "Google Calendar", bridgeReliability: "official_api" });
  });
  it("a wrong key is an AuthError; a bad request is a ValidationError; corrections need opt-in", async () => {
    await expect(new Recast({ apiKey: "sk_wrong_key_000000", baseUrl: base }).resolve({ raw: "x" })).rejects.toBeInstanceOf(AuthError);
    await expect(sdk().resolve({ raw: "" })).rejects.toBeInstanceOf(ValidationError);
    await expect(sdk().corrections.create({ objectId: "rc_1", kind: "edit", field: "name", oldValue: "A", newValue: "B" })).resolves.toBeUndefined();
    await expect(new Recast({ apiKey: POOR, baseUrl: base }).corrections.create({ objectId: "rc_1", kind: "undo" })).rejects.toBeInstanceOf(ValidationError);
  });
  it("hitting the quota is a QuotaError, and lastUsage says why", async () => {
    await usage.add("t2", new Date().toISOString().slice(0, 7), TIERS.free.monthly);
    const s = new Recast({ apiKey: POOR, baseUrl: base });
    await expect(s.resolve({ raw: "Meera Iyer, meera@x.com" })).rejects.toBeInstanceOf(QuotaError);
    expect(s.lastUsage).toEqual({ used: 1000, limit: 1000 });
  });
  it("health", async () => { expect(await sdk().health()).toBe(true); expect(await new Recast({ apiKey: KEY, baseUrl: "http://127.0.0.1:1", maxRetries: 0 }).health()).toBe(false); });
});
