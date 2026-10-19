// Release states are checked on the server, per request, from the tenant's cohort (docs/RELEASE_STATES.md).
import { beforeEach, describe, expect, it } from "vitest";
import { createResolver } from "@recast/resolve";
import { createRelease, parseOverrides } from "@recast/release";
import { freshDb } from "@recast/store/testing";
import { MemoryKeyStore, MemoryUsageStore, SqlKeyStore, createApi as rawCreateApi, createTenant, hashKey, setTenant, type ApiDeps } from "../src";

const INTERNAL = "sk_test_cohort_internal", PRIVATE = "sk_test_cohort_private1", PUBLIC = "sk_test_cohort_public01";
let keys: MemoryKeyStore, usage: MemoryUsageStore;
beforeEach(async () => {
  keys = new MemoryKeyStore(); usage = new MemoryUsageStore();
  await keys.add(INTERNAL, { tenantId: "t_int", tier: "pro", cohort: "internal" });
  await keys.add(PRIVATE, { tenantId: "t_priv", tier: "pro", cohort: "private" });
  await keys.add(PUBLIC, { tenantId: "t_pub", tier: "pro" });   // no cohort given: public, the narrowest
});
import { guard } from "./contract-guard";
const createApi = (d: Parameters<typeof rawCreateApi>[0]) => guard(rawCreateApi(d));
const mk = (extra: Partial<ApiDeps> = {}) => createApi({ resolver: createResolver(), keys, usage, ...extra });
const call = async (api: ReturnType<typeof mk>, key: string, path: string, body?: unknown) => {
  const r = await api.handle(new Request("http://x" + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  return { status: r.status, json: await r.json() as any };
};
const resolveBody = { input: { raw: "Meera Iyer, meera@x.com" }, target: { destination: "google_calendar" } };
const placeBody = { ...resolveBody, destination_target: { calendar_id: "primary", event_id: "e1" } };
const month = new Date().toISOString().slice(0, 7);

describe("release gates on the API", () => {
  it("a public tenant cannot resolve while resolve is private, and nothing is counted against its quota", async () => {
    const api = mk();
    const r = await call(api, PUBLIC, "/v1/resolve", resolveBody);
    expect(r.status).toBe(403); expect(r.json.error.code).toBe("not_available");
    expect((await call(api, PUBLIC, "/v1/bridges")).status).toBe(403);
    expect(await usage.get("t_pub", month)).toBe(0);
    expect((await call(api, PRIVATE, "/v1/resolve", resolveBody)).status).toBe(200);
  });
  it("placement is internal: a private tenant is refused before anything runs; an internal tenant gets past the gate", async () => {
    const api = mk();
    const p = await call(api, PRIVATE, "/v1/place", placeBody); expect(p.status).toBe(403); expect(p.json.error.code).toBe("not_available");
    const i = await call(api, INTERNAL, "/v1/place", placeBody); expect(i.status).toBe(501);   // past the gate; this server has no placement stores
  });
  it("placing a complete object is gated on its own, even where text placement is opened wider", async () => {
    const api = mk({ release: createRelease(parseOverrides("api.place=private")) });
    const r = await call(api, PRIVATE, "/v1/place", { object: { type: "Event" }, target: { destination: "google_calendar_event" } });
    expect(r.status).toBe(403); expect(r.json.error.code).toBe("not_available");
  });
  it("narrowing a release never strands placements already made; only the disabled kill switch stops undo and reconcile", async () => {
    const id = "rc_r_" + "0".repeat(32);
    for (const path of ["/v1/place/undo", "/v1/place/reconcile"]) {
      const body = path.endsWith("undo") ? { receipt_id: id } : { action_id: id };
      expect((await call(mk(), PUBLIC, path, body)).status).toBe(501);   // past the gate
      expect((await call(mk({ release: createRelease(parseOverrides("api.place=disabled")) }), INTERNAL, path, body)).status).toBe(403);
    }
  });
  it("disabled means nobody, internal included; overrides open a capability per deployment", async () => {
    expect((await call(mk({ release: createRelease(parseOverrides("api.resolve=disabled")) }), INTERNAL, "/v1/resolve", resolveBody)).status).toBe(403);
    expect((await call(mk({ release: createRelease(parseOverrides("api.resolve=public")) }), PUBLIC, "/v1/resolve", resolveBody)).status).toBe(200);
  });
  it("a corrections request from an unreleased cohort is refused before the opt-in check", async () => {
    const r = await call(mk(), PUBLIC, "/v1/corrections", { object_id: "x", kind: "undo" });
    expect(r.json.error.code).toBe("not_available");
  });
  it("GET /v1/capabilities lists only what this account can use, never unreleased names", async () => {
    expect((await call(mk(), PUBLIC, "/v1/capabilities")).json.capabilities).toEqual([]);
    expect((await call(mk(), PRIVATE, "/v1/capabilities")).json.capabilities).toEqual(["api.resolve", "api.corrections", "mcp.recast-tools"]);
    const internal = (await call(mk(), INTERNAL, "/v1/capabilities")).json.capabilities as string[];
    expect(internal).toContain("api.place"); expect(internal).not.toContain("community.recipes");
  });
});

describe("cohort in Postgres", () => {
  it("new tenants start public; the operator moves them; the database refuses unknown cohorts", async () => {
    const db = await freshDb();
    const t = await createTenant(db, "Acme", "pro");
    const store = new SqlKeyStore(db); await store.add(t, await hashKey(PUBLIC));
    expect((await store.find(await hashKey(PUBLIC)))!.cohort).toBe("public");
    await setTenant(db, t, { cohort: "private" });
    expect((await store.find(await hashKey(PUBLIC)))!.cohort).toBe("private");
    await expect(db.query(`update tenants set cohort = 'everyone' where id = $1`, [t])).rejects.toThrow();
    await expect(setTenant(db, t, { cohort: "everyone" as never })).rejects.toThrow("cohort must be one of");
  });
});
