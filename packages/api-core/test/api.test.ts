import { beforeEach, describe, expect, it } from "vitest";
import { createResolver } from "@recast/resolve";
import { MemoryCorrectionStore, MemoryKeyStore, MemoryUsageStore, createApi, TIERS } from "../src";

const FREE = "sk_test_free_00000001", PRO = "sk_test_pro_000000002", OPT = "sk_test_optin_0000003";
let clock = Date.parse("2026-10-15T10:00:00Z");
let keys: MemoryKeyStore, usage: MemoryUsageStore, corr: MemoryCorrectionStore;
const mk = (extra = {}) => createApi({ resolver: createResolver({ now: () => new Date(clock) }), keys, usage, corrections: corr, now: () => clock, ...extra });
beforeEach(async () => {
  clock = Date.parse("2026-10-15T10:00:00Z");
  keys = new MemoryKeyStore(); usage = new MemoryUsageStore(); corr = new MemoryCorrectionStore();
  await keys.add(FREE, { tenantId: "t_free", tier: "free" }); await keys.add(PRO, { tenantId: "t_pro", tier: "pro" }); await keys.add(OPT, { tenantId: "t_opt", tier: "pro", correctionsOptIn: true });
});
const call = (api: ReturnType<typeof mk>, path: string, body?: unknown, h: Record<string, string> = {}, key: string | null = FREE, method = body === undefined ? "GET" : "POST") =>
  api.handle(new Request("http://x" + path, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...h }, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) }));
const body = { input: { raw: "Meera Iyer, meera@x.com" }, target: { destination: "google_calendar" } };

describe("auth", () => {
  it("health needs no key; everything else needs a valid one", async () => {
    const api = mk();
    expect((await call(api, "/v1/health", undefined, {}, null)).status).toBe(200);
    for (const key of [null, "sk_nope_nope_nope1", "not-a-key"]) { const r = await call(api, "/v1/resolve", body, {}, key); expect(r.status).toBe(401); expect(r.headers.get("www-authenticate")).toBe("Bearer"); }
  });
  it("a revoked key stops working at once", async () => {
    const api = mk(); expect((await call(api, "/v1/resolve", body)).status).toBe(200);
    await keys.revoke(FREE); expect((await call(api, "/v1/resolve", body)).status).toBe(401);
  });
  it("keys are stored hashed, never in plain text", async () => {
    expect(JSON.stringify([...(keys as any).byHash.keys()])).not.toContain("sk_test_free");
  });
});

describe("POST /v1/resolve", () => {
  it("returns the wire shape with routing, provenance, versions and quota headers", async () => {
    const r = await call(mk(), "/v1/resolve", body); expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(j).toMatchObject({ status: "resolved", object: { type: "Person", fields: { name: "Meera Iyer" } }, routing: { destination: "google_calendar", bridge_reliability: "official_api", requires_confirmation: true }, meta: { stage: "rules", schema_version: "1.0.0" } });
    expect(r.headers.get("recast-schema-version")).toBe("1.0.0"); expect(r.headers.get("x-recast-quota-used")).toBe("1"); expect(r.headers.get("x-recast-quota-limit")).toBe("1000");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
  it("include_provenance: false drops provenance", async () => {
    const j = await (await call(mk(), "/v1/resolve", { ...body, options: { include_provenance: false } })).json() as any;
    expect(j.object.provenance).toBeUndefined();
  });
  it("bad requests get a clear 400 naming the field", async () => {
    const api = mk();
    for (const [b, msg] of [[{}, /input\.raw/], [{ input: { raw: 5 } }, /input\.raw/], [{ input: { raw: "x" }, target: { type: "Spaceship" } }, /target\.type/], [{ input: { raw: "x" }, options: { confidence_threshold: "high" } }, /confidence_threshold/]] as const) {
      const r = await call(api, "/v1/resolve", b); expect(r.status).toBe(400); expect(((await r.json()) as any).error.message).toMatch(msg);
    }
    expect((await call(api, "/v1/resolve", "{not json")).status).toBe(400);
    expect((await call(api, "/v1/resolve", { input: { raw: "  " } })).status).toBe(400);
    expect(((await (await call(api, "/v1/resolve", { input: { raw: "a" }, target: { destination: "hubspot" } })).json()) as any).error.code).toBe("unknown_destination");
  });
  it("wrong content type is 415; an oversized body is 413", async () => {
    const api = mk();
    const r = await api.handle(new Request("http://x/v1/resolve", { method: "POST", headers: { authorization: `Bearer ${FREE}`, "content-type": "text/plain" }, body: "hi" })); expect(r.status).toBe(415);
    const big = await call(mk({ maxBodyBytes: 200 }), "/v1/resolve", { input: { raw: "a".repeat(500) } }); expect(big.status).toBe(413);
    expect((await call(api, "/v1/resolve", { input: { raw: "a".repeat(4001) } })).status).toBe(413);
  });
  it("unknown routes are 404, errors never leak internals", async () => {
    expect((await call(mk(), "/v1/nope")).status).toBe(404); expect((await call(mk(), "/elsewhere")).status).toBe(404);
    const api = createApi({ resolver: { resolve: async () => { throw new Error("db password is hunter2"); } } as any, keys, now: () => clock });
    const r = await call(api, "/v1/resolve", body); expect(r.status).toBe(500); expect(await r.text()).not.toContain("hunter2");
  });
});

describe("batch", () => {
  it("resolves many in one call, in order, with per-item errors that don't sink the batch", async () => {
    const items = [body, { input: { raw: "Launch dinner 2026-11-14 19:30" } }, { input: { raw: "x" }, target: { destination: "hubspot" } }, { input: { raw: "hello" } }];
    const r = await call(mk(), "/v1/resolve/batch", { items }); expect(r.status).toBe(200);
    const j = (await r.json() as any).results;
    expect(j.map((x: any) => x.status)).toEqual(["resolved", "resolved", "error", "unresolved"]);
    expect(j[2]).toMatchObject({ error: { code: "unknown_destination" }, index: 2 });
    expect(r.headers.get("x-recast-quota-used")).toBe("2");           // only resolved items count
  });
  it("caps the batch at 50 items and rejects empty ones", async () => {
    const api = mk();
    expect((await call(api, "/v1/resolve/batch", { items: Array(51).fill(body) })).status).toBe(400);
    expect((await call(api, "/v1/resolve/batch", { items: [] })).status).toBe(400);
    expect((await call(api, "/v1/resolve/batch", { items: Array(50).fill(body) }, {}, PRO)).status).toBe(200);
  });
});

describe("limits", () => {
  it("rate limit: the burst passes, the next request is 429 with Retry-After, and tokens refill with time", async () => {
    const api = mk(); const burst = TIERS.free.burst;
    for (let i = 0; i < burst; i++) expect((await call(api, "/v1/bridges")).status).toBe(200);
    const r = await call(api, "/v1/bridges"); expect(r.status).toBe(429); expect(Number(r.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(((await r.json()) as any).error).toMatchObject({ code: "rate_limited" });
    clock += 1000; expect((await call(api, "/v1/bridges")).status).toBe(200);
  });
  it("limits are per tenant: one tenant's burst doesn't slow another", async () => {
    const api = mk(); for (let i = 0; i < 25; i++) await call(api, "/v1/bridges");
    expect((await call(api, "/v1/bridges", undefined, {}, PRO)).status).toBe(200);
  });
  it("monthly quota: 402 once used up, with the usage headers; resets in the next month", async () => {
    const api = mk(); await usage.add("t_free", "2026-10", TIERS.free.monthly);
    const r = await call(api, "/v1/resolve", body); expect(r.status).toBe(402);
    expect(((await r.json()) as any).error.code).toBe("quota_exceeded"); expect(r.headers.get("x-recast-quota-used")).toBe("1000");
    clock = Date.parse("2026-11-01T00:00:01Z"); expect((await call(api, "/v1/resolve", body)).status).toBe(200);
  });
  it("only resolved objects use quota: unresolved and rejected calls are free", async () => {
    const api = mk(); await call(api, "/v1/resolve", { input: { raw: "hello" } }); await call(api, "/v1/resolve", { input: { raw: "" } });
    expect(await usage.get("t_free", "2026-10")).toBe(0);
  });
});

describe("idempotency", () => {
  it("the same key and body replays the first answer and does not count twice", async () => {
    const api = mk(); const h = { "idempotency-key": "order-123" };
    const a = await call(api, "/v1/resolve", body, h); const b = await call(api, "/v1/resolve", body, h);
    expect(await b.text()).toBe(await a.text()); expect(b.headers.get("idempotent-replay")).toBe("true");
    expect(await usage.get("t_free", "2026-10")).toBe(1);
  });
  it("the same key with a different body is rejected, not silently replayed", async () => {
    const api = mk(); const h = { "idempotency-key": "k1" };
    await call(api, "/v1/resolve", body, h);
    const r = await call(api, "/v1/resolve", { input: { raw: "Launch dinner 2026-11-14" } }, h); expect(r.status).toBe(422);
  });
  it("keys are scoped per tenant and expire after 24 hours", async () => {
    const api = mk(); const h = { "idempotency-key": "same" };
    await call(api, "/v1/resolve", body, h, FREE);
    expect((await call(api, "/v1/resolve", { input: { raw: "Launch dinner 2026-11-14" } }, h, PRO)).status).toBe(200);   // another tenant: not a conflict
    clock += 25 * 3600_000; expect((await call(api, "/v1/resolve", { input: { raw: "Launch dinner 2026-11-14" } }, h, FREE)).status).toBe(200);
  });
  it("rejects a malformed key", async () => {
    expect((await call(mk(), "/v1/resolve", body, { "idempotency-key": "bad key with spaces" })).status).toBe(400);
  });
});

describe("versioning", () => {
  it("accepts the current major, rejects another, and announces deprecations in headers", async () => {
    const api = mk({ deprecated: [{ version: "1.0.0", sunset: "2027-06-01T00:00:00Z" }] });
    const dep = await call(api, "/v1/bridges", undefined, { "x-recast-version": "1.0.0" }); expect(dep.status).toBe(200);
    expect(dep.headers.get("deprecation")).toBe("true"); expect(dep.headers.get("sunset")).toBe("Tue, 01 Jun 2027 00:00:00 GMT");
    expect((await call(mk(), "/v1/bridges", undefined, { "x-recast-version": "2.0.0" })).status).toBe(400);
    expect((await call(mk(), "/v1/bridges", undefined, { "x-recast-version": "banana" })).status).toBe(400);
    const plain = await call(mk(), "/v1/bridges"); expect(plain.headers.get("deprecation")).toBeNull();
  });
});

describe("bridges and corrections", () => {
  it("lists every destination with its reliability and what it accepts", async () => {
    const j = await (await call(mk(), "/v1/bridges")).json() as any;
    expect(j.bridges.map((b: any) => b.id)).toEqual(["google_calendar", "gmail", "google_sheets", "google_tasks", "notion"]);
    expect(j.bridges[0]).toMatchObject({ name: "Google Calendar", bridge_reliability: "official_api", objects: ["Person", "Location"] });
    expect(j.bridges.find((b: any) => b.id === "notion").objects).toEqual(["Document"]);
  });
  it("corrections are stored only for accounts that opted in; otherwise 403 and nothing is saved", async () => {
    const api = mk(); const b = { object_id: "rc_1", kind: "edit", field: "name", old_value: "A", new_value: "B" };
    const no = await call(api, "/v1/corrections", b, {}, FREE); expect(no.status).toBe(403); expect(await corr.list("t_free")).toEqual([]);
    const yes = await call(api, "/v1/corrections", b, {}, OPT); expect(yes.status).toBe(201);
    expect(await corr.list("t_opt")).toHaveLength(1); expect(await corr.list("t_free")).toHaveLength(0);
    expect((await call(api, "/v1/corrections", { kind: "nope" }, {}, OPT)).status).toBe(400);
  });
});
