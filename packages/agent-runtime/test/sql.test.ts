import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { freshDb } from "@recast/store/testing";
import { AuditLog, GENESIS, MemoryScopeStore, SqlAgentRegistry, SqlApprovalStore, SqlAuditStore, SqlPolicyStore, SqlRevocationList, SqlScopeStore, createAgentIdentity, createGateway, generateKeyPair, requestHash, signToken, verifyChain, verifyAgentToken, MemoryVault, parsePolicy, AuthError, type ScopeStore } from "../src";

const T0 = Date.parse("2026-10-15T10:00:00Z"); const OWNER = "00000000-0000-0000-0000-0000000000a1";
let db: PGlite; let tenant: string, other: string;
beforeEach(async () => {
  db = await freshDb();
  tenant = (await db.query<{ id: string }>(`insert into tenants(name) values ('Acme') returning id`)).rows[0]!.id;
  other = (await db.query<{ id: string }>(`insert into tenants(name) values ('Beta') returning id`)).rows[0]!.id;
});
async function agent(tenantId = tenant) { const id = await createAgentIdentity("bot", "acme"); await new SqlAgentRegistry(db).register({ agentId: id.agentId, tenantId, name: id.name, publicJwk: id.publicJwk, ownerUserId: OWNER }); return id; }

describe("SqlAgentRegistry", () => {
  it("stores only the public key, round-trips it, and revocation sticks", async () => {
    const reg = new SqlAgentRegistry(db); const id = await agent();
    const rec = (await reg.get(id.agentId))!; expect(rec).toMatchObject({ agentId: id.agentId, tenantId: tenant, ownerUserId: OWNER }); expect(rec.publicJwk.d).toBeUndefined(); expect(rec.revokedAt).toBeUndefined();
    expect(await reg.get("agt_000000000000")).toBeNull();
    await reg.revoke(id.agentId); expect((await reg.get(id.agentId))!.revokedAt).toBeTruthy();
  });
  it("tokens verify against the database registry, and a revoked agent is refused", async () => {
    const reg = new SqlAgentRegistry(db); const id = await agent();
    const t = await signToken(id.privateJwk, { iss: id.agentId, sub: id.agentId, aud: "gw", now: T0 });
    expect((await verifyAgentToken(t, { registry: reg, audience: "gw", now: T0 })).agent.tenantId).toBe(tenant);
    await reg.revoke(id.agentId); await expect(verifyAgentToken(t, { registry: reg, audience: "gw", now: T0 })).rejects.toBeInstanceOf(AuthError);
  });
});

const scopeImpls = { memory: async () => ({ s: new MemoryScopeStore() as ScopeStore, agentId: "agt_mem", tenantId: "t" }), sql: async () => { const id = await agent(); return { s: new SqlScopeStore(db) as ScopeStore, agentId: id.agentId, tenantId: tenant }; } };
for (const [name, make] of Object.entries(scopeImpls)) describe(`ScopeStore contract: ${name}`, () => {
  it("grants, finds live grants for the exact tool and action, and spends a budget exactly", async () => {
    const { s, agentId, tenantId } = await make();
    const g = await s.grant({ agentId, tenantId, tool: "gmail", action: "send", maxCalls: 2, expiresAt: new Date(T0 + 60_000).toISOString(), constraints: { n: { max: 3 } } });
    expect(g.constraints).toEqual({ n: { max: 3 } }); expect((await s.find(agentId, "gmail", "send", T0)).map((x) => x.id)).toEqual([g.id]); expect(await s.find(agentId, "gmail", "delete", T0)).toEqual([]);
    const spent = await Promise.all([1, 2, 3, 4, 5].map(() => s.consume(g.id, T0))); expect(spent.filter(Boolean)).toHaveLength(2);
    expect(await s.find(agentId, "gmail", "send", T0)).toEqual([]);
  });
  it("an expired grant is not found and cannot be spent (by the injected clock)", async () => {
    const { s, agentId, tenantId } = await make(); const g = await s.grant({ agentId, tenantId, tool: "x", action: "y", maxCalls: 5, expiresAt: new Date(T0 + 1000).toISOString() });
    expect(await s.find(agentId, "x", "y", T0 + 2000)).toEqual([]); expect(await s.consume(g.id, T0 + 2000)).toBe(false); expect(await s.consume(g.id, T0)).toBe(true);
  });
});
it("SqlScopeStore refuses a grant for an agent of another tenant", async () => {
  const id = await agent(); await expect(new SqlScopeStore(db).grant({ agentId: id.agentId, tenantId: other, tool: "x", action: "y", maxCalls: 1, expiresAt: new Date(T0 + 1e6).toISOString() })).rejects.toThrow(/no agent/);
});

describe("SqlAuditStore", () => {
  async function filled(n = 5) {
    const id = await agent(); const signer = await generateKeyPair(); const store = new SqlAuditStore(db); const log = new AuditLog(store, { privateJwk: signer.privateJwk, keyId: "k1" }, () => new Date(T0));
    for (let i = 0; i < n; i++) await log.append({ tenantId: tenant, agentId: id.agentId, userId: i % 2 ? OWNER : undefined, requestId: `r${i}`, tool: "gmail", action: "send", params: { i, nested: { b: 1, a: [1, 2] } }, result: i % 2 ? "denied" : "allowed", ...(i === 0 ? { humanApproved: true } : {}), ...(i === 2 ? { reason: "why" } : {}) });
    return { store, signer, id };
  }
  it("a chain written to Postgres and read back still verifies, including entries with absent optional fields", async () => {
    const { store, signer } = await filled(); const entries = await store.list(tenant);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]); expect(entries[0]!.prevHash).toBe(GENESIS);
    expect(await verifyChain(entries, { k1: signer.publicJwk }, entries.at(-1)!.hash)).toEqual({ ok: true, entries: 5 });
    expect((await db.query(`select count(*)::int as n from agent_audit_log where agent_id is not null`)).rows[0]).toEqual({ n: 5 });
  });
  it("concurrent writers through the log still form one straight chain", async () => {
    const id = await agent(); const signer = await generateKeyPair(); const store = new SqlAuditStore(db); const log = new AuditLog(store, { privateJwk: signer.privateJwk, keyId: "k1" });
    await Promise.all(Array.from({ length: 15 }, (_, i) => log.append({ tenantId: tenant, agentId: id.agentId, requestId: `r${i}`, tool: "x", action: "y", params: {}, result: "success" })));
    expect(await verifyChain(await store.list(tenant), { k1: signer.publicJwk })).toEqual({ ok: true, entries: 15 });
  });
  it("a second writer with a stale head is refused as a conflict, not stored", async () => {
    const { store } = await filled(2); const e = (await store.list(tenant))[1]!;
    await expect(store.append({ ...e, seq: 3, hash: "x" })).rejects.toThrow(/conflict/); expect(await store.list(tenant)).toHaveLength(2);
  });
  it("rows cannot be changed afterwards; a database-level edit of the signed body is caught by verification only if it bypasses the trigger", async () => {
    const { store, signer } = await filled(3);
    await expect(db.query(`update agent_audit_log set entry = '{}'::jsonb`)).rejects.toThrow(/append-only/);
    expect(await verifyChain(await store.list(tenant), { k1: signer.publicJwk })).toMatchObject({ ok: true });
  });
  it("tenants are separate chains", async () => {
    const { store } = await filled(2); expect(await store.list(other)).toEqual([]); expect(await store.last(other)).toBeNull();
  });
});

describe("SqlApprovalStore", () => {
  it("request, decide and redeem: bound to the request, once, within the window, only by its tenant", async () => {
    const id = await agent(); const s = new SqlApprovalStore(db); const hash = await requestHash(tenant, id.agentId, "gmail", "send", { to: "a" });
    const a = await s.request({ tenantId: tenant, agentId: id.agentId, tool: "gmail", action: "send", requestHash: hash }, T0);
    expect((await s.request({ tenantId: tenant, agentId: id.agentId, tool: "gmail", action: "send", requestHash: hash }, T0 + 1000)).id).toBe(a.id);   // asking again does not duplicate
    expect(await s.redeem(a.id, tenant, hash, T0)).toBe(false);                                 // not approved yet
    expect(await s.decide(a.id, other, "evil", true, T0)).toBeNull();                           // another tenant cannot decide
    expect((await s.decide(a.id, tenant, "usr_meera", true, T0))!.status).toBe("approved");
    expect(await s.redeem(a.id, tenant, await requestHash(tenant, id.agentId, "gmail", "send", { to: "b" }), T0)).toBe(false);   // different request
    expect(await Promise.all([1, 2, 3].map(() => s.redeem(a.id, tenant, hash, T0)))).toEqual(expect.arrayContaining([true])); expect((await s.get(a.id))!.status).toBe("used");
    expect(await s.redeem(a.id, tenant, hash, T0)).toBe(false);
  });
  it("exactly one of several concurrent redeemers wins", async () => {
    const id = await agent(); const s = new SqlApprovalStore(db); const hash = await requestHash(tenant, id.agentId, "gmail", "send", {});
    const a = await s.request({ tenantId: tenant, agentId: id.agentId, tool: "gmail", action: "send", requestHash: hash }, T0); await s.decide(a.id, tenant, "u", true, T0);
    expect((await Promise.all(Array.from({ length: 8 }, () => s.redeem(a.id, tenant, hash, T0)))).filter(Boolean)).toHaveLength(1);
  });
  it("an approval older than the window cannot be decided or redeemed", async () => {
    const id = await agent(); const s = new SqlApprovalStore(db, 60_000); const hash = await requestHash(tenant, id.agentId, "gmail", "send", {});
    const a = await s.request({ tenantId: tenant, agentId: id.agentId, tool: "gmail", action: "send", requestHash: hash }, T0);
    expect(await s.decide(a.id, tenant, "u", true, T0 + 61_000)).toBeNull(); await s.decide(a.id, tenant, "u", true, T0); expect(await s.redeem(a.id, tenant, hash, T0 + 61_000)).toBe(false);
  });
});

describe("SqlRevocationList and SqlPolicyStore", () => {
  it("a revoked token id is refused by the verifier", async () => {
    const reg = new SqlAgentRegistry(db); const id = await agent(); const rev = new SqlRevocationList(db, tenant);
    const t = await signToken(id.privateJwk, { iss: id.agentId, sub: id.agentId, aud: "gw", now: T0, jti: "jti-1" });
    await expect(verifyAgentToken(t, { registry: reg, audience: "gw", now: T0, isRevoked: rev.isRevoked })).resolves.toBeTruthy();
    await rev.revoke("jti-1"); await rev.revoke("jti-1");
    await expect(verifyAgentToken(t, { registry: reg, audience: "gw", now: T0, isRevoked: rev.isRevoked })).rejects.toMatchObject({ code: "token_revoked" });
  });
  it("no policy means default deny; activating one replaces the last; a bad one is refused and changes nothing", async () => {
    const p = new SqlPolicyStore(db); expect(await p.active(tenant)).toEqual({ rules: [], default: "deny" });
    expect(await p.activate(tenant, "main", "rules:\n  - { tool: a, then: allow }\n")).toBe(1); expect((await p.active(tenant)).rules).toHaveLength(1);
    expect(await p.activate(tenant, "main", "rules:\n  - { tool: b, then: deny }\n  - { tool: c, then: allow }\n")).toBe(2); expect((await p.active(tenant)).rules).toHaveLength(2);
    await expect(p.activate(tenant, "main", "default: maybe")).rejects.toThrow(/default must be/); expect((await p.active(tenant)).rules).toHaveLength(2);
    expect((await p.active(other)).rules).toEqual([]);
    expect((await db.query(`select version, active from agent_policies where tenant_id = $1 order by version`, [tenant])).rows).toEqual([{ version: 1, active: false }, { version: 2, active: true }]);
  });
});

describe("the gateway end to end on Postgres-backed stores", () => {
  it("allow, deny, approve once, spend a budget: all persisted, and the audit chain verifies", async () => {
    const id = await agent(); const reg = new SqlAgentRegistry(db); const scopes = new SqlScopeStore(db); const approvals = new SqlApprovalStore(db); const store = new SqlAuditStore(db); const policy = new SqlPolicyStore(db);
    const signer = await generateKeyPair(); const vault = new MemoryVault(); vault.set(tenant, "gmail", "SECRET"); let clock = T0; const seen: (string | null)[] = [];
    await policy.activate(tenant, "main", "rules:\n  - { tool: gmail, action: send_email, then: require_approval }\n  - { tool: gmail, action: draft, then: allow }\n");
    await scopes.grant({ agentId: id.agentId, tenantId: tenant, tool: "gmail", action: "send_email", maxCalls: 3, expiresAt: new Date(T0 + 3600_000).toISOString() });
    await scopes.grant({ agentId: id.agentId, tenantId: tenant, tool: "gmail", action: "draft", maxCalls: 1, expiresAt: new Date(T0 + 3600_000).toISOString() });
    const gw = createGateway({ audience: "gw", registry: reg, scopes, approvals, audit: new AuditLog(store, { privateJwk: signer.privateJwk, keyId: "k1" }, () => new Date(clock)), getPolicy: () => policy.active(tenant), exchange: { mode: "vault", vault },
      upstream: () => "http://up/mcp", forward: (async (_u: string, init: RequestInit) => { seen.push((init.headers as Record<string, string>).authorization ?? null); return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { headers: { "content-type": "application/json" } }); }) as typeof fetch, now: () => clock });
    const call = async (name: string, args: object, headers: Record<string, string> = {}) => gw.handle(new Request("http://gw/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${await signToken(id.privateJwk, { iss: id.agentId, sub: id.agentId, aud: "gw", now: clock })}`, ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }));
    expect((await call("gmail.draft", { to: "a" })).status).toBe(200); expect(seen).toEqual(["Bearer SECRET"]);
    expect((await call("gmail.draft", { to: "a" })).headers.get("x-recast-decision")).toBe("denied");                       // budget of 1 is spent: no live scope
    expect((await call("gmail.delete", {})).headers.get("x-recast-decision")).toBe("denied");
    const pending = await call("gmail.send_email", { to: "m@x.com" }); expect(pending.headers.get("x-recast-decision")).toBe("pending_approval"); const aid = ((await pending.json()) as any).error.data.approval_id; expect(seen).toHaveLength(1);
    await approvals.decide(aid, tenant, "usr_meera", true, clock);
    expect((await call("gmail.send_email", { to: "m@x.com" }, { "x-approval-id": aid })).status).toBe(200); expect(seen).toHaveLength(2);
    expect((await call("gmail.send_email", { to: "m@x.com" }, { "x-approval-id": aid })).headers.get("x-recast-decision")).toBe("pending_approval");   // single use
    const entries = await store.list(tenant); expect(entries.map((e) => e.result)).toEqual(["allowed", "success", "denied", "denied", "pending_approval", "allowed", "success", "pending_approval"]);
    expect(await verifyChain(entries, { k1: signer.publicJwk }, entries.at(-1)!.hash)).toEqual({ ok: true, entries: 8 });
    expect(entries.find((e) => e.humanApproved)).toBeTruthy(); expect(JSON.stringify(entries)).not.toContain("SECRET");
    clock += 1; void parsePolicy;
  });
});

import { SqlReplayCache } from "../src";
describe("SqlReplayCache", () => {
  it("first use wins across callers, replays lose, old ids are forgotten, tenants are separate", async () => {
    const c = new SqlReplayCache(db, 1000);
    const first = await Promise.all(Array.from({ length: 6 }, () => c.firstUse(tenant, "jti-1", T0))); expect(first.filter(Boolean)).toHaveLength(1);
    expect(await c.firstUse(tenant, "jti-1", T0 + 500)).toBe(false); expect(await c.firstUse(other, "jti-1", T0)).toBe(true); expect(await c.firstUse(tenant, "jti-1", T0 + 5000)).toBe(true);
  });
});
