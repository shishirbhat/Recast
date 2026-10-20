import { describe, expect, it } from "vitest";
import { DemoRuntimeClient, HttpRuntimeClient, RuntimeError, runtimeClientFromEnv } from "../src";

const TENANT = "11111111-1111-1111-1111-111111111111";
const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function http(handler: (url: string, init: RequestInit) => Response) { const calls: { url: string; init: RequestInit }[] = []; const f = (async (u: string, i: RequestInit) => { calls.push({ url: u, init: i }); return handler(u, i); }) as unknown as typeof fetch; return { calls, c: new HttpRuntimeClient({ baseUrl: "http://rt/", adminToken: "tok-tok-tok", tenantId: TENANT, fetch: f }) }; }

describe("HttpRuntimeClient", () => {
  it("sends the admin token and the tenant on every call, and the token never appears in a URL", async () => {
    const { c, calls } = http(() => res(200, { agents: [], approvals: [], total: 0, entries: [], verification: { ok: true, entries: 0 } }));
    await c.listAgents(); await c.listApprovals(); await c.audit(5);
    expect(calls.map((x) => x.url)).toEqual([`http://rt/admin/agents?tenant=${TENANT}`, `http://rt/admin/approvals?tenant=${TENANT}`, `http://rt/admin/audit?tenant=${TENANT}&limit=5`]);
    for (const x of calls) { expect((x.init.headers as Record<string, string>).authorization).toBe("Bearer tok-tok-tok"); expect(x.url).not.toContain("tok-tok-tok"); }
  });
  it("decide posts the person and the decision, and url-encodes the id", async () => {
    const { c, calls } = http(() => res(200, {})); await c.decide("apr_abc", true, "usr_meera");
    expect(calls[0]!.url).toBe("http://rt/admin/approvals/apr_abc/decide"); expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ tenant: TENANT, approve: true, by: "usr_meera" });
    await c.decide("a/../b", false, "x"); expect(calls[1]!.url).toBe("http://rt/admin/approvals/a%2F..%2Fb/decide");
  });
  it("maps approvals and audit entries to the view shape, dropping fields the page does not need", async () => {
    const { c } = http((u) => res(200, u.includes("approvals") ? { approvals: [{ id: "apr_1", agentId: "agt_1", tool: "gmail", action: "send", createdAt: 5, requestHash: "secret-hash", status: "pending" }] } : { total: 1, verification: { ok: true, entries: 1 }, entries: [{ seq: 1, at: "t", agentId: "agt_1", tool: "gmail", action: "send", result: "allowed", humanApproved: true, hash: "h", params: { to: "private" }, signature: "s" }] }));
    expect(await c.listApprovals()).toEqual([{ id: "apr_1", agentId: "agt_1", tool: "gmail", action: "send", createdAt: 5 }]);
    const r = await c.audit(); expect(r.entries[0]).toEqual({ seq: 1, at: "t", agentId: "agt_1", tool: "gmail", action: "send", result: "allowed", humanApproved: true, hash: "h" });   // parameters never go to the page
  });
  it("turns a runtime error into a RuntimeError with its status and message", async () => {
    const { c } = http(() => res(404, { error: { message: "no pending approval" } })); await expect(c.decide("apr_x", true, "u")).rejects.toMatchObject({ name: "RuntimeError", status: 404, message: "no pending approval" });
    const { c: c2 } = http(() => new Response("<html>", { status: 502 })); await expect(c2.listAgents()).rejects.toMatchObject({ status: 502 });
  });
});

describe("DemoRuntimeClient", () => {
  it("a decision removes the request, appends to the log, and cannot be repeated", async () => {
    const d = new DemoRuntimeClient(); expect((await d.listApprovals()).map((a) => a.id)).toEqual(["apr_demo00000001"]);
    await d.decide("apr_demo00000001", true, "demo-user"); expect(await d.listApprovals()).toEqual([]);
    const r = await d.audit(); expect(r.total).toBe(5); expect(r.entries.at(-1)).toMatchObject({ result: "allowed", humanApproved: true, reason: "approved by demo-user" });
    await expect(d.decide("apr_demo00000001", true, "demo-user")).rejects.toBeInstanceOf(RuntimeError);
  });
  it("a rejection is logged as a refusal", async () => {
    const d = new DemoRuntimeClient(); await d.decide("apr_demo00000001", false, "demo-user"); expect((await d.audit()).entries.at(-1)).toMatchObject({ result: "denied", reason: "rejected by demo-user" });
  });
});

describe("runtimeClientFromEnv", () => {
  it("uses the real runtime only when all three settings are present", () => {
    expect(runtimeClientFromEnv({})).toBeInstanceOf(DemoRuntimeClient); expect(runtimeClientFromEnv({ RUNTIME_URL: "http://x", RUNTIME_ADMIN_TOKEN: "t" })).toBeInstanceOf(DemoRuntimeClient);
    expect(runtimeClientFromEnv({ RUNTIME_URL: "http://x", RUNTIME_ADMIN_TOKEN: "t", RUNTIME_TENANT_ID: TENANT })).toBeInstanceOf(HttpRuntimeClient);
  });
});
