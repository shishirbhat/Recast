import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { freshDb } from "@recast/store/testing";
import { createResolver } from "@recast/resolve";
import { MemoryCorrectionStore, MemoryKeyStore, MemoryUsageStore, SqlCorrectionStore, SqlKeyStore, SqlUsageStore, createApi, hashKey, TIERS, type CorrectionStore, type UsageStore } from "../src";

let db: PGlite; let tenant: string, optTenant: string;
beforeEach(async () => {
  db = await freshDb();
  tenant = (await db.query<{ id: string }>(`insert into tenants(name, tier, cohort) values ('Acme','free','private') returning id`)).rows[0]!.id;
  optTenant = (await db.query<{ id: string }>(`insert into tenants(name, tier, corrections_opt_in, cohort) values ('Beta','pro', true, 'private') returning id`)).rows[0]!.id;
});

describe("SqlKeyStore", () => {
  it("finds a key by hash with its tenant, tier and consent; never stores the plain key", async () => {
    const store = new SqlKeyStore(db); const plain = "sk_test_sql_000000001";
    await store.add(tenant, await hashKey(plain), "prod");
    expect(await store.find(await hashKey(plain))).toEqual({ tenantId: tenant, tier: "free", cohort: "private", revoked: false, correctionsOptIn: false, label: "prod" });
    expect(await store.find(await hashKey("sk_other_other_0001"))).toBeNull();
    expect(JSON.stringify((await db.query(`select * from api_keys`)).rows)).not.toContain(plain);
  });
  it("revocation takes effect on the next lookup", async () => {
    const store = new SqlKeyStore(db); const h = await hashKey("sk_test_sql_000000002"); await store.add(optTenant, h);
    expect(await store.find(h)).toMatchObject({ tier: "pro", correctionsOptIn: true, revoked: false });
    await store.revoke(h); expect(await store.find(h)).toMatchObject({ revoked: true });
  });
});

const usageImpls: Record<string, () => UsageStore> = { memory: () => new MemoryUsageStore(), sql: () => new SqlUsageStore(db) };
for (const [name, make] of Object.entries(usageImpls)) describe(`UsageStore contract: ${name}`, () => {
  it("counts per tenant and month, and returns the running total", async () => {
    const u = make(); const t = name === "sql" ? tenant : "t1";
    expect(await u.get(t, "2026-10")).toBe(0);
    expect(await u.add(t, "2026-10", 3)).toBe(3); expect(await u.add(t, "2026-10", 4)).toBe(7); expect(await u.add(t, "2026-11", 1)).toBe(1);
    expect([await u.get(t, "2026-10"), await u.get(t, "2026-11")]).toEqual([7, 1]);
  });
  it("concurrent adds lose nothing", async () => {
    const u = make(); const t = name === "sql" ? tenant : "t1";
    await Promise.all(Array.from({ length: 25 }, () => u.add(t, "2026-10", 1))); expect(await u.get(t, "2026-10")).toBe(25);
  });
});

const corrImpls: Record<string, () => CorrectionStore> = { memory: () => new MemoryCorrectionStore(), sql: () => new SqlCorrectionStore(db) };
for (const [name, make] of Object.entries(corrImpls)) describe(`CorrectionStore contract: ${name}`, () => {
  it("stores and lists a tenant's corrections only", async () => {
    const c = make(); const t = name === "sql" ? optTenant : "t1"; const other = name === "sql" ? tenant : "t2";
    await c.add({ tenantId: t, objectId: "rc_1", kind: "edit", field: "name", oldValue: "A", newValue: { v: "B" }, at: "2026-10-15T10:00:00.000Z" });
    expect(await c.list(t)).toEqual([{ tenantId: t, objectId: "rc_1", kind: "edit", field: "name", oldValue: "A", newValue: { v: "B" }, at: "2026-10-15T10:00:00.000Z" }]);
    expect(await c.list(other)).toEqual([]);
  });
});
it("the database itself refuses corrections for a tenant that has not opted in", async () => {
  await expect(new SqlCorrectionStore(db).add({ tenantId: tenant, objectId: "rc_1", kind: "undo", at: new Date().toISOString() })).rejects.toThrow(/not opted in/);
});

describe("the whole API on Postgres-backed stores", () => {
  it("auth, quota, usage and corrections behave as with memory stores", async () => {
    const keys = new SqlKeyStore(db); const usage = new SqlUsageStore(db); const corrections = new SqlCorrectionStore(db);
    const FREE = "sk_test_apisql_free_01", OPT = "sk_test_apisql_opt_001";
    await keys.add(tenant, await hashKey(FREE)); await keys.add(optTenant, await hashKey(OPT));
    const clock = Date.parse("2026-10-15T10:00:00Z");
    const api = createApi({ resolver: createResolver({ now: () => new Date(clock) }), keys, usage, corrections, now: () => clock });
    const call = (path: string, body: unknown, key = FREE) => api.handle(new Request("http://x" + path, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
    const r = await call("/v1/resolve", { input: { raw: "Meera Iyer, meera@x.com" } }); expect(r.status).toBe(200); expect(r.headers.get("x-recast-quota-used")).toBe("1");
    expect(await usage.get(tenant, "2026-10")).toBe(1);
    expect((await call("/v1/resolve", { input: { raw: "x" } }, "sk_nobody_nobody_0001")).status).toBe(401);
    await usage.add(tenant, "2026-10", TIERS.free.monthly); expect((await call("/v1/resolve", { input: { raw: "Meera Iyer, meera@x.com" } })).status).toBe(402);
    expect((await call("/v1/corrections", { object_id: "rc_1", kind: "edit" }, FREE)).status).toBe(403);
    expect((await call("/v1/corrections", { object_id: "rc_1", kind: "edit", field: "name", old_value: "a", new_value: "b" }, OPT)).status).toBe(201); expect(await corrections.list(optTenant)).toHaveLength(1);
    await keys.revoke(await hashKey(FREE)); expect((await call("/v1/resolve", { input: { raw: "x" } })).status).toBe(401);
  });
});
void MemoryKeyStore;
