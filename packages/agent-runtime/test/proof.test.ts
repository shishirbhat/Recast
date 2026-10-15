import { describe, expect, it } from "vitest";
import { AuditLog, AuthError, MemoryAgentRegistry, MemoryApprovalStore, MemoryAuditStore, MemoryReplayCache, MemoryScopeStore, MemoryVault, createAgentIdentity, createGateway, createProof, generateKeyPair, parsePolicy, signToken, verifyProof, type AgentKeyPair } from "../src";

const T0 = Date.parse("2026-10-15T10:00:00Z"); const URL_ = "https://gw.example/mcp";
const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof AuthError ? e.code : `other:${e}`));
async function agent() { const id = await createAgentIdentity("bot", "acme"); return { id, rec: { agentId: id.agentId, tenantId: "t1", name: "bot", publicJwk: id.publicJwk } }; }

describe("proof of possession", () => {
  it("a proof signed by the agent for this method, URL and token verifies, once", async () => {
    const { id, rec } = await agent(); const replay = new MemoryReplayCache();
    const p = await createProof(id.privateJwk, { agentId: id.agentId, method: "post", url: `${URL_}?x=1#f`, accessToken: "tok", now: T0 });
    expect(await verifyProof(p, { agent: rec, method: "POST", url: URL_, accessToken: "tok", replay, now: T0 })).toMatchObject({ htm: "POST", htu: URL_ });
    expect(await code(verifyProof(p, { agent: rec, method: "POST", url: URL_, accessToken: "tok", replay, now: T0 + 1000 }))).toBe("token_revoked");   // replay
  });
  it("is refused for another method, another URL, another token, a stale clock, or another key", async () => {
    const { id, rec } = await agent(); const other = await generateKeyPair(); const mk = (o = {}) => createProof(id.privateJwk, { agentId: id.agentId, method: "POST", url: URL_, accessToken: "tok", now: T0, ...o });
    const v = (p: string, o = {}) => code(verifyProof(p, { agent: rec, method: "POST", url: URL_, accessToken: "tok", replay: new MemoryReplayCache(), now: T0, ...o }));
    expect(await v(await mk(), { method: "DELETE" })).toBe("wrong_audience"); expect(await v(await mk(), { url: "https://evil.example/mcp" })).toBe("wrong_audience");
    expect(await v(await mk(), { accessToken: "stolen-token" })).toBe("bad_signature"); expect(await v(await mk(), { now: T0 + 5 * 60_000 })).toBe("expired");
    expect(await v(await createProof(other.privateJwk, { agentId: id.agentId, method: "POST", url: URL_, accessToken: "tok", now: T0 }))).toBe("bad_signature");
    expect(await v("not.a.proof")).toBe("malformed");
  });
  it("the replay cache forgets old ids after its window", async () => {
    const c = new MemoryReplayCache(1000); expect(await c.firstUse("t", "j", 0)).toBe(true); expect(await c.firstUse("t", "j", 500)).toBe(false); expect(await c.firstUse("t", "j", 2000)).toBe(true);
    expect(await c.firstUse("other-tenant", "j", 2000)).toBe(true);
  });
});

describe("the gateway with proofs required", () => {
  async function rig(proof: "required" | "optional" | "off" = "required") {
    const a = await createAgentIdentity("bot", "acme"); const reg = new MemoryAgentRegistry(); await reg.register({ agentId: a.agentId, tenantId: "t1", name: "bot", publicJwk: a.publicJwk });
    const scopes = new MemoryScopeStore(); await scopes.grant({ agentId: a.agentId, tenantId: "t1", tool: "notion", action: "create_page", maxCalls: 50, expiresAt: new Date(T0 + 3600_000).toISOString() });
    const vault = new MemoryVault(); vault.set("t1", "notion", "S"); const signer = await generateKeyPair(); let upstreamCalls = 0;
    const gw = createGateway({ audience: "gw", registry: reg, scopes, approvals: new MemoryApprovalStore(), audit: new AuditLog(new MemoryAuditStore(), { privateJwk: signer.privateJwk, keyId: "k" }), getPolicy: () => parsePolicy("rules:\n  - { tool: notion, then: allow }\n"),
      exchange: { mode: "vault", vault }, upstream: () => "http://up/mcp", forward: (async () => { upstreamCalls++; return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { headers: { "content-type": "application/json" } }); }) as typeof fetch, now: () => T0, proof, publicUrl: URL_ });
    const token = await signToken(a.privateJwk, { iss: a.agentId, sub: a.agentId, aud: "gw", now: T0 });
    const send = async (headers: Record<string, string>) => gw.handle(new Request("http://internal/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "notion.create_page", arguments: {} } }) }));
    const proofFor = (k: AgentKeyPair, o = {}) => createProof(k.privateJwk, { agentId: a.agentId, method: "POST", url: URL_, accessToken: token, now: T0, ...o });
    return { a, token, send, proofFor, calls: () => upstreamCalls };
  }
  it("a bearer token on its own is refused, and a stolen token is useless without the agent's key", async () => {
    const r = await rig(); const none = await r.send({}); expect(none.status).toBe(401); expect(none.headers.get("www-authenticate")).toContain("DPoP"); expect(r.calls()).toBe(0);
    const thief = await generateKeyPair(); const fake = await createProof(thief.privateJwk, { agentId: r.a.agentId, method: "POST", url: URL_, accessToken: r.token, now: T0 });
    expect((await r.send({ dpop: fake })).status).toBe(401); expect(r.calls()).toBe(0);
  });
  it("a correct proof goes through once; the same proof again is a replay", async () => {
    const r = await rig(); const p = await r.proofFor(r.a);
    expect((await r.send({ dpop: p })).status).toBe(200); expect(r.calls()).toBe(1);
    const again = await r.send({ dpop: p }); expect(again.status).toBe(401); expect(r.calls()).toBe(1);
    expect((await r.send({ dpop: await r.proofFor(r.a) })).status).toBe(200);
  });
  it("a proof for a different URL or method is refused", async () => {
    const r = await rig(); expect((await r.send({ dpop: await r.proofFor(r.a, { url: "https://evil.example/mcp" }) })).status).toBe(401); expect((await r.send({ dpop: await r.proofFor(r.a, { method: "GET" }) })).status).toBe(401); expect(r.calls()).toBe(0);
  });
  it("optional mode accepts a bearer token alone but still rejects a bad proof; off ignores proofs", async () => {
    const o = await rig("optional"); expect((await o.send({})).status).toBe(200);
    const thief = await generateKeyPair(); expect((await o.send({ dpop: await createProof(thief.privateJwk, { agentId: o.a.agentId, method: "POST", url: URL_, accessToken: o.token, now: T0 }) })).status).toBe(401);
    const off = await rig("off"); expect((await off.send({ dpop: "garbage" })).status).toBe(200);
  });
});
