import { describe, expect, it } from "vitest";
import { AuthError, CircuitOpenError, NetworkError, QuotaError, RateLimitError, Recast, ServerError, ValidationError } from "../src";

const resolved = { status: "resolved", object: { id: "rc_1", type: "Person", fields: { name: "Meera Iyer" }, confidence: 0.72, trust: "medium", provenance: [{ field: "name", source: "rules", confidence: 0.72 }] }, routing: null, alternatives: [], degraded: false, meta: { stage: "rules", schema_version: "1.0.0", degraded: false } };
const res = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function scripted(...steps: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = []; let i = 0;
  const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); const s = steps[Math.min(i++, steps.length - 1)]!; if (s instanceof Error) throw s; return s.clone(); }) as unknown as typeof fetch;
  return { f, calls };
}
const mk = (f: typeof fetch, extra = {}) => { const sleeps: number[] = []; return { sdk: new Recast({ apiKey: "sk_test_0000000000", baseUrl: "http://api.test/", fetch: f, sleep: async (ms) => { sleeps.push(ms); }, ...extra }), sleeps }; };

describe("requests", () => {
  it("sends the key, snake_case body and an Idempotency-Key; returns camelCase results", async () => {
    const { f, calls } = scripted(res(200, resolved)); const { sdk } = mk(f);
    const r = await sdk.resolve({ raw: "Meera Iyer, meera@x.com", sourceUrl: "https://x.com", target: { destination: "google_calendar" }, options: { confidenceThreshold: 0.6, includeProvenance: false } });
    expect(calls[0]!.url).toBe("http://api.test/v1/resolve");
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer sk_test_0000000000"); expect(h["idempotency-key"]).toMatch(/\S{8,}/);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ input: { raw: "Meera Iyer, meera@x.com", source_url: "https://x.com" }, target: { destination: "google_calendar" }, options: { confidence_threshold: 0.6, include_provenance: false } });
    expect(r.status === "resolved" && r.object.fields.name).toBe("Meera Iyer"); expect(r.status === "resolved" && r.meta.schemaVersion).toBe("1.0.0");
  });
  it("status narrows the type: an unresolved result has a reason and no object", async () => {
    const { f } = scripted(res(200, { status: "unresolved", reason: "nothing recognisable", degraded: false, meta: { stage: "rules", schema_version: "1.0.0", degraded: false } }));
    const r = await mk(f).sdk.resolve({ raw: "hello" });
    if (r.status === "unresolved") expect(r.reason).toBe("nothing recognisable"); else throw new Error("wrong status");
    expect("object" in r).toBe(false);
  });
  it("the fluent builder builds the same request", async () => {
    const { f, calls } = scripted(res(200, resolved));
    await mk(f).sdk.from("Launch dinner 2026-11-14").as("Event").to("google_calendar").threshold(0.8).withoutProvenance().run();
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ input: { raw: "Launch dinner 2026-11-14" }, target: { type: "Event", destination: "google_calendar" }, options: { confidence_threshold: 0.8, include_provenance: false } });
  });
  it("requires an api key", () => { expect(() => new Recast({ apiKey: "", baseUrl: "https://api.test" })).toThrow(/apiKey/); });
  it("requires a base URL: a key is never sent to a guessed host", () => { expect(() => new Recast({ apiKey: "sk_test_x_000000000001" } as never)).toThrow(/baseUrl is required/); });
});

describe("errors map to types, and only the right ones retry", () => {
  it("401, 402, 400 are not retried", async () => {
    for (const [status, body, Err] of [[401, { error: { code: "unauthorized", message: "bad key" } }, AuthError], [402, { error: { code: "quota_exceeded", message: "used up" } }, QuotaError], [400, { error: { code: "invalid_request", message: "nope" } }, ValidationError]] as const) {
      const { f, calls } = scripted(res(status, body)); await expect(mk(f).sdk.resolve({ raw: "x" })).rejects.toBeInstanceOf(Err); expect(calls).toHaveLength(1);
    }
  });
  it("429 waits for Retry-After then succeeds; keeps the same idempotency key", async () => {
    const { f, calls } = scripted(res(429, { error: { code: "rate_limited", message: "slow" } }, { "retry-after": "3" }), res(200, resolved)); const { sdk, sleeps } = mk(f);
    await sdk.resolve({ raw: "x" }); expect(sleeps).toEqual([3000]); expect(calls).toHaveLength(2);
    expect((calls[0]!.init.headers as any)["idempotency-key"]).toBe((calls[1]!.init.headers as any)["idempotency-key"]);
  });
  it("gives up after maxRetries on 429 with a RateLimitError carrying retryAfterSec", async () => {
    const { f, calls } = scripted(res(429, { error: { code: "rate_limited", message: "slow" } }, { "retry-after": "2" }));
    await expect(mk(f).sdk.resolve({ raw: "x" })).rejects.toMatchObject({ name: "RateLimitError", retryAfterSec: 2 }); expect(calls).toHaveLength(3);
  });
  it("5xx and network errors back off and retry, then fail with ServerError / NetworkError", async () => {
    const a = scripted(res(503, {}), res(200, resolved)); await mk(a.f).sdk.resolve({ raw: "x" }); expect(a.calls).toHaveLength(2);
    const b = scripted(res(500, {})); await expect(mk(b.f).sdk.resolve({ raw: "x" })).rejects.toBeInstanceOf(ServerError);
    const c = scripted(new TypeError("fetch failed")); await expect(mk(c.f).sdk.resolve({ raw: "x" })).rejects.toBeInstanceOf(NetworkError); expect(c.calls).toHaveLength(3);
  });
  it("RateLimitError is exported for callers to catch", () => { expect(new RateLimitError("m", 1).retryAfterSec).toBe(1); });
});

describe("circuit breaker", () => {
  it("opens after repeated failures, fails fast without calling, and tries again after the cool-down", async () => {
    let t = 0; const { f, calls } = scripted(res(500, {}), res(500, {}), res(500, {}), res(200, resolved));
    const sdk = new Recast({ apiKey: "sk_test_0000000000", baseUrl: "http://api.test", fetch: f, sleep: async () => {}, maxRetries: 0, now: () => t, circuit: { threshold: 2, cooldownMs: 1000 } });
    await expect(sdk.resolve({ raw: "a" })).rejects.toBeInstanceOf(ServerError); await expect(sdk.resolve({ raw: "b" })).rejects.toBeInstanceOf(ServerError);
    await expect(sdk.resolve({ raw: "c" })).rejects.toBeInstanceOf(CircuitOpenError); expect(calls).toHaveLength(2);
    t = 1500; await expect(sdk.resolve({ raw: "d" })).rejects.toBeInstanceOf(ServerError);   // the trial call fails: reopened
    expect(calls).toHaveLength(3);
  });
});

describe("cache and usage", () => {
  it("identical resolved requests come from the cache; bypass and expiry go to the network", async () => {
    let t = 0; const { f, calls } = scripted(res(200, resolved));
    const sdk = new Recast({ apiKey: "sk_test_0000000000", baseUrl: "http://api.test", fetch: f, now: () => t, cacheTtlMs: 1000 });
    await sdk.resolve({ raw: "x" }); await sdk.resolve({ raw: "x" }); expect(calls).toHaveLength(1);
    await sdk.resolve({ raw: "x" }, { bypassCache: true }); expect(calls).toHaveLength(2);
    t = 2000; await sdk.resolve({ raw: "x" }); expect(calls).toHaveLength(3);
  });
  it("unresolved and degraded answers are not cached", async () => {
    const unresolved = { status: "unresolved", reason: "r", degraded: false, meta: { stage: "rules", schema_version: "1.0.0", degraded: false } };
    const { f, calls } = scripted(res(200, unresolved)); const { sdk } = mk(f); await sdk.resolve({ raw: "y" }); await sdk.resolve({ raw: "y" }); expect(calls).toHaveLength(2);
    const d = scripted(res(200, { ...resolved, degraded: true })); const m = mk(d.f); await m.sdk.resolve({ raw: "z" }); await m.sdk.resolve({ raw: "z" }); expect(d.calls).toHaveLength(2);
  });
  it("a new schema version from the server clears the cache", async () => {
    const v2 = { ...resolved, meta: { ...resolved.meta, schema_version: "1.1.0" } };
    const { f, calls } = scripted(res(200, resolved), res(200, v2), res(200, v2)); const { sdk } = mk(f);
    await sdk.resolve({ raw: "a" }); await sdk.resolve({ raw: "b" });          // 'b' sees 1.1.0: 'a' is now stale
    await sdk.resolve({ raw: "a" }); expect(calls).toHaveLength(3);
  });
  it("remembers the quota headers so callers can warn before the wall", async () => {
    const { f } = scripted(res(200, resolved, { "x-recast-quota-used": "950", "x-recast-quota-limit": "1000" })); const { sdk } = mk(f);
    await sdk.resolve({ raw: "x" }); expect(sdk.lastUsage).toEqual({ used: 950, limit: 1000 });
  });
});
