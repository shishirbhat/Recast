// Forward compatibility: the API may add fields and values within v1 (docs/18-api-compatibility.md). This SDK version must keep
// working, and must never read an unknown answer as success.
import { describe, expect, it } from "vitest";
import { Recast } from "../src";

const stub = (body: unknown, status = 200): typeof fetch => (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
const meta = { stage: "rules", schema_version: "1.4.0", degraded: false, future_flag: true };

describe("an older SDK against a newer v1 API", () => {
  it("ignores fields it does not know", async () => {
    const r = await new Recast({ apiKey: "sk_test_compat_00001", baseUrl: "https://api.test", fetch: stub({ status: "resolved", object: { id: "rc_1", type: "Person", fields: { name: "Meera" }, confidence: 0.9, trust: "high", new_field: 1 }, routing: null, alternatives: [], degraded: false, meta, explanation: "new" }), cacheTtlMs: 0 }).resolve({ raw: "Meera" });
    expect(r).toMatchObject({ status: "resolved", object: { id: "rc_1", fields: { name: "Meera" } } });
  });
  it("reads an unknown resolve status as unresolved, so nothing acts on it", async () => {
    const r = await new Recast({ apiKey: "sk_test_compat_00001", baseUrl: "https://api.test", fetch: stub({ status: "needs_review", reason: "new state", degraded: false, meta }), cacheTtlMs: 0 }).resolve({ raw: "x" });
    expect(r.status).toBe("unresolved");
  });
  it("never reports an unknown placement status as placed", async () => {
    const r = await new Recast({ apiKey: "sk_test_compat_00001", baseUrl: "https://api.test", fetch: stub({ status: "queued", action_id: "rc_r_" + "a".repeat(32) }, 201), sleep: async () => {} }).place({ raw: "x", destination: "gmail" });
    expect(r).toMatchObject({ status: "outcome_unknown", actionId: "rc_r_" + "a".repeat(32) }); expect((r as { message: string }).message).toMatch(/upgrade @recast\/sdk/);
  });
});
