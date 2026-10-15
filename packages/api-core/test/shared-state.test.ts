// Limits and idempotent replays must hold across server instances: the same contract runs against memory and Postgres,
// and two API instances share one database.
import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { as, A, freshDb } from "@recast/store/testing";
import { createResolver, type Resolver } from "@recast/resolve";
import { MemoryIdempotencyStore, RateLimiter, SqlIdempotencyStore, SqlKeyStore, SqlRateLimiter, SqlUsageStore, createApi, hashKey, type IdempotencyStore, type Limiter } from "../src";

let db: PGlite; let tenant: string; let clock = 1_000_000;
beforeEach(async () => { db = await freshDb(); clock = 1_000_000; tenant = (await db.query<{ id: string }>(`insert into tenants(name, tier) values ('Acme','free') returning id`)).rows[0]!.id; });

const limiters: Record<string, () => Limiter> = { memory: () => new RateLimiter(() => clock), sql: () => new SqlRateLimiter(db, () => clock) };
for (const [name, make] of Object.entries(limiters)) describe(`Limiter contract: ${name}`, () => {
  it("allows the burst, refuses the next with Retry-After, refills at the rate", async () => {
    const l = make(); const res = []; for (let i = 0; i < 6; i++) res.push(await l.take("t", 2, 5));
    expect(res.slice(0, 5).map((r) => r.ok)).toEqual([true, true, true, true, true]);
    expect(res[0]).toEqual({ ok: true, remaining: 4 }); expect(res[5]).toEqual({ ok: false, retryAfterSec: 1 });
    clock += 500; expect(await l.take("t", 2, 5)).toEqual({ ok: true, remaining: 0 });
    expect(await l.take("other", 2, 5)).toMatchObject({ ok: true, remaining: 4 });
  });
  it("concurrent requests never spend more than the burst", async () => {
    const l = make(); const res = await Promise.all(Array.from({ length: 30 }, () => l.take("t", 1, 10)));
    expect(res.filter((r) => r.ok)).toHaveLength(10);
  });
  it("a clock that steps backwards does not mint tokens", async () => {
    const l = make(); for (let i = 0; i < 3; i++) await l.take("t", 1, 3);
    clock -= 60_000; expect((await l.take("t", 1, 3)).ok).toBe(false);
  });
});

const idems: Record<string, () => IdempotencyStore> = { memory: () => new MemoryIdempotencyStore(), sql: () => new SqlIdempotencyStore(db) };
for (const [name, make] of Object.entries(idems)) describe(`IdempotencyStore contract: ${name}`, () => {
  const rec = (json: unknown) => ({ bodyHash: "h1", status: 200, json, at: clock });
  it("claim, then replay; a different body is a mismatch; keys are per tenant", async () => {
    const s = make(); const other = name === "sql" ? (await db.query<{ id: string }>(`insert into tenants(name) values ('B') returning id`)).rows[0]!.id : "t2"; const t = name === "sql" ? tenant : "t1";
    expect(await s.begin(t, "k", "h1", clock)).toEqual({ state: "new" });
    expect(await s.begin(t, "k", "h1", clock)).toEqual({ state: "in_progress" });
    await s.complete(t, "k", rec({ a: 1 }));
    expect(await s.begin(t, "k", "h1", clock + 1)).toEqual({ state: "replay", record: { bodyHash: "h1", status: 200, json: { a: 1 }, at: clock } });
    expect(await s.begin(t, "k", "h2", clock + 1)).toEqual({ state: "mismatch" });
    expect(await s.begin(other, "k", "h2", clock + 1)).toEqual({ state: "new" });
  });
  it("of many concurrent claims exactly one wins", async () => {
    const s = make(); const t = name === "sql" ? tenant : "t1";
    const res = await Promise.all(Array.from({ length: 12 }, () => s.begin(t, "race", "h1", clock)));
    expect(res.filter((r) => r.state === "new")).toHaveLength(1); expect(res.filter((r) => r.state === "in_progress")).toHaveLength(11);
  });
  it("abort frees the key; abandoned claims expire after a minute, records after a day", async () => {
    const s = make(); const t = name === "sql" ? tenant : "t1";
    await s.begin(t, "a", "h1", clock); await s.abort(t, "a"); expect(await s.begin(t, "a", "h1", clock)).toEqual({ state: "new" });
    expect(await s.begin(t, "a", "h1", clock + 59_000)).toEqual({ state: "in_progress" });
    expect(await s.begin(t, "a", "h1", clock + 61_000)).toEqual({ state: "new" });
    await s.complete(t, "a", rec(1)); await s.abort(t, "a");   // abort never removes a completed record
    expect((await s.begin(t, "a", "h1", clock + 62_000)).state).toBe("replay");
    expect((await s.begin(t, "a", "h1", clock + 61_000 + 24 * 3600_000 + 1)).state).toBe("new");
  });
});

describe("two API instances on one database", () => {
  const KEY = "sk_test_shared_state_01";
  async function instances(resolver: Resolver = createResolver()) {
    await new SqlKeyStore(db).add(tenant, await hashKey(KEY));
    const make = () => createApi({ resolver, keys: new SqlKeyStore(db), usage: new SqlUsageStore(db), limiter: new SqlRateLimiter(db, () => clock), idempotency: new SqlIdempotencyStore(db), now: () => clock });
    return [make(), make()] as const;
  }
  const call = (api: { handle(r: Request): Promise<Response> }, body: unknown, headers: Record<string, string> = {}) =>
    api.handle(new Request("http://x/v1/resolve", { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));

  it("share one rate limit (free: burst 20)", async () => {
    const [a, b] = await instances(); const statuses: number[] = [];
    for (let i = 0; i < 22; i++) statuses.push((await call(i % 2 ? a : b, { input: { raw: "Launch dinner 2026-11-14" } })).status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(20); expect(statuses.slice(20)).toEqual([429, 429]);
  });
  it("replay each other's idempotent responses and count usage once", async () => {
    const [a, b] = await instances(); const body = { input: { raw: "Meera Iyer, meera@x.com" } };
    const r1 = await call(a, body, { "idempotency-key": "order-1" }); const r2 = await call(b, body, { "idempotency-key": "order-1" });
    expect(r1.status).toBe(200); expect(r2.status).toBe(200); expect(r2.headers.get("idempotent-replay")).toBe("true");
    expect(await r2.json()).toEqual(await r1.json());
    expect(await new SqlUsageStore(db).get(tenant, new Date(clock).toISOString().slice(0, 7))).toBe(1);
    expect((await call(b, { input: { raw: "other" } }, { "idempotency-key": "order-1" })).status).toBe(422);
  });
  it("a request still running on one instance is a 409 on the other; a failed request frees its key", async () => {
    let release!: () => void; const gate = new Promise<void>((ok) => { release = ok; }); const inner = createResolver();
    let fail = false; const slow: Resolver = { resolve: async (i) => { await gate; if (fail) throw new Error("boom"); return inner.resolve(i); } } as Resolver;
    const [a, b] = await instances(slow); const body = { input: { raw: "Meera Iyer, meera@x.com" } };
    const first = call(a, body, { "idempotency-key": "k-409" });
    await new Promise((r) => setTimeout(r, 50));
    const second = await call(b, body, { "idempotency-key": "k-409" });
    expect(second.status).toBe(409); expect(second.headers.get("retry-after")).toBe("1");
    release(); expect((await first).status).toBe(200);
    fail = true; expect((await call(a, body, { "idempotency-key": "k-fail" })).status).toBe(500);
    fail = false; expect((await call(b, body, { "idempotency-key": "k-fail" })).status).toBe(200);
  });
});

describe("shared state is server-only", () => {
  it("a signed-in tenant member cannot read or write buckets or idempotency records", async () => {
    await db.query(`insert into tenant_members(tenant_id, user_id, role) values ($1, $2, 'owner')`, [tenant, A]);
    await new SqlIdempotencyStore(db).begin(tenant, "k", "h", clock); await new SqlRateLimiter(db).take(tenant, 1, 1);
    await as(db, A, async () => {
      expect((await db.query(`select * from api_idempotency`)).rows).toEqual([]);
      expect((await db.query(`select * from api_rate_buckets`)).rows).toEqual([]);
      await expect(db.query(`insert into api_idempotency(tenant_id, key, body_hash, created_ms) values ($1,'x','h',1)`, [tenant])).rejects.toThrow();
    });
  });
  it("purge_api_state drops expired records and idle buckets", async () => {
    await new SqlIdempotencyStore(db).begin(tenant, "old", "h", clock); await new SqlRateLimiter(db, () => clock).take("b", 1, 1);
    await db.query(`select purge_api_state($1::bigint)`, [clock + 25 * 3600_000]);
    expect(Number((await db.query<{ n: number }>(`select count(*)::int as n from api_idempotency`)).rows[0]!.n) + Number((await db.query<{ n: number }>(`select count(*)::int as n from api_rate_buckets`)).rows[0]!.n)).toBe(0);
  });
});
