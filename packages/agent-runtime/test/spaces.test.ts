// Spaces: a bounded configuration per agent, enforced by the gateway on every call (docs/16-spaces.md).
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { freshDb } from "@recast/store/testing";
import { createRelease, parseOverrides, type Cohort } from "@recast/release";
import {
  AuditLog, MemoryAgentRegistry, MemoryApprovalStore, MemoryAuditStore, MemoryScopeStore, MemorySpaceStore, MemoryVault, SpaceError, SqlAgentRegistry, SqlSpaceStore,
  createAgentIdentity, createGateway, generateKeyPair, parsePolicy, signToken, validateSpace, verifyChain, type AgentKeyPair, type SpaceInput, type SpaceStore,
} from "../src";

let upstream: Server, upstreamUrl: string; let seen: any[] = []; let reply: { status: number; body: unknown } = { status: 200, body: {} };
beforeAll(async () => {
  upstream = createServer(async (q, r) => {
    const chunks: Buffer[] = []; for await (const c of q) chunks.push(c as Buffer); const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    seen.push(body);
    if (body.method === "tools/list") { r.writeHead(200, { "content-type": "application/json" }); r.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "shop.buy" }, { name: "google_calendar.create_event" }, { name: "gmail.send_email" }] } })); return; }
    r.writeHead(reply.status, { "content-type": "application/json" }); r.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok)); upstreamUrl = `http://127.0.0.1:${(upstream.address() as any).port}/mcp`;
});
afterAll(() => { upstream.close(); });

const T0 = Date.parse("2026-10-15T10:00:00Z"); let clock = T0;
const hours = (h: number) => new Date(T0 + h * 3600_000).toISOString();
// The tenant policy allows everything used here; the Space is what narrows it.
const POLICY = `rules:
  - { id: cal, tool: google_calendar, then: allow }
  - { id: mail, tool: gmail, then: allow }
  - { id: shop, tool: shop, then: allow }
  - { id: no-big, tool: shop, action: buy, when: { amount: { gt: 50000 } }, then: deny }
`;
interface Rig { agent: AgentKeyPair; spaces: MemorySpaceStore; scopes: MemoryScopeStore; approvals: MemoryApprovalStore; store: MemoryAuditStore; keys: Record<string, JsonWebKey>; gw: ReturnType<typeof createGateway> }
async function rig(opts: { cohort?: Cohort } = {}): Promise<Rig> {
  const agent = await createAgentIdentity("shopper", "acme"); const reg = new MemoryAgentRegistry();
  await reg.register({ agentId: agent.agentId, tenantId: "t1", name: agent.name, publicJwk: agent.publicJwk, ownerUserId: "usr_meera" });
  const scopes = new MemoryScopeStore(); const approvals = new MemoryApprovalStore(); const store = new MemoryAuditStore(); const signer = await generateKeyPair();
  const audit = new AuditLog(store, { privateJwk: signer.privateJwk, keyId: "rt1" }, () => new Date(clock)); const vault = new MemoryVault();
  for (const t of ["google_calendar", "gmail", "shop"]) vault.set("t1", t, `SECRET-${t}`);
  const spaces = new MemorySpaceStore();
  const gw = createGateway({ audience: "gw", registry: reg, scopes, audit, approvals, getPolicy: () => parsePolicy(POLICY), exchange: { mode: "vault", vault }, upstream: () => upstreamUrl, now: () => clock, spaces,
    ...(opts.cohort ? { release: { release: createRelease(), cohortOf: async () => opts.cohort! } } : {}) });
  for (const [tool, action] of [["google_calendar", "create_event"], ["gmail", "send_email"], ["shop", "buy"]] as const) await scopes.grant({ agentId: agent.agentId, tenantId: "t1", tool, action, maxCalls: 100, expiresAt: hours(48) });
  return { agent, spaces, scopes, approvals, store, keys: { rt1: signer.publicJwk }, gw };
}
const space = (r: Rig, over: Partial<SpaceInput> = {}): SpaceInput => ({
  tenantId: "t1", agentId: r.agent.agentId, name: "Groceries", expiresAt: hours(24), createdBy: "usr_meera",
  tools: [{ tool: "shop", action: "buy", cost: { param: "amount" }, constraints: { store: { in: ["fresh-mart"] } } }, { tool: "google_calendar", action: "create_event" }],
  budget: { maxCalls: 5, spend: { currency: "INR", limitMinor: 100_000 } }, ...over,
});
const rpc = (name: string, args: unknown, method = "tools/call") => ({ jsonrpc: "2.0", id: 1, method, params: method === "tools/call" ? { name, arguments: args } : {} });
async function call(r: Rig, body: unknown, headers: Record<string, string> = {}) {
  const t = await signToken(r.agent.privateJwk, { iss: r.agent.agentId, sub: r.agent.agentId, aud: "gw", now: clock });
  const res = await r.gw.handle(new Request("http://gw/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${t}`, ...headers }, body: JSON.stringify(body) }));
  return { res, decision: res.headers.get("x-recast-decision"), json: await res.json() as any };
}
const buy = (amount: unknown, store = "fresh-mart") => rpc("shop.buy", { amount, store });
beforeEach(() => { seen = []; clock = T0; reply = { status: 200, body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } } }; });

describe("a Space is bounded by construction", () => {
  it("refuses wildcards, missing or distant expiry, empty tool lists and costs without a money budget", () => {
    const base = { tenantId: "t", agentId: "a", name: "x", expiresAt: hours(1), tools: [{ tool: "shop", action: "buy" }], budget: { maxCalls: 1 } };
    expect(() => validateSpace(base, T0)).not.toThrow();
    for (const bad of [
      { tools: [{ tool: "*", action: "buy" }] }, { tools: [{ tool: "shop", action: "*" }] }, { tools: [] },
      { expiresAt: hours(-1) }, { expiresAt: hours(24 * 31) }, { budget: { maxCalls: 0 } },
      { tools: [{ tool: "shop", action: "buy", cost: { fixedMinor: 10 } }] },
      { tools: [{ tool: "shop", action: "buy" }, { tool: "shop", action: "buy" }] },
    ]) expect(() => validateSpace({ ...base, ...bad } as SpaceInput, T0)).toThrow(SpaceError);
  });
});

describe("the gateway enforces Spaces", () => {
  it("with Spaces on, a call needs an active Space that includes it, even when scope and policy allow it", async () => {
    const r = await rig();
    expect((await call(r, rpc("gmail.send_email", { to: "a@b.c" }))).json.error.message).toMatch(/no active Space includes gmail.send_email/);
    await r.spaces.create(space(r), clock);
    expect((await call(r, rpc("gmail.send_email", { to: "a@b.c" }))).decision).toBe("denied");
    expect((await call(r, rpc("google_calendar.create_event", { title: "x" }))).res.status).toBe(200);
    expect(seen).toHaveLength(1);
  });
  it("applies the Space's own constraints on top of the scope's", async () => {
    const r = await rig(); await r.spaces.create(space(r), clock);
    expect((await call(r, buy(500, "other-shop"))).json.error.message).toMatch(/Space constraint failed: store must be one of/);
    expect(seen).toHaveLength(0);
  });
  it("spends the money budget, refuses the call that would exceed it before anything reaches the tool, and never prices a missing amount as free", async () => {
    const r = await rig(); const s = await r.spaces.create(space(r), clock);
    expect((await call(r, buy(45_000))).json.result).toBeTruthy(); expect((await call(r, buy(45_000))).json.result).toBeTruthy();
    const over = await call(r, buy(20_000)); expect(over.json.error.message).toMatch(/spend exhausted/); expect(seen).toHaveLength(2);
    expect((await call(r, buy(10_000))).json.result).toBeTruthy();
    expect((await r.spaces.get(s.id, "t1"))!.spentMinor).toBe(100_000);
    expect((await call(r, rpc("shop.buy", { store: "fresh-mart" }))).json.error.message).toMatch(/'amount' must be a whole/);
    expect((await call(r, buy(-5))).decision).toBe("denied");
  });
  it("gives the money back when the tool refuses; keeps it when the outcome is unknown", async () => {
    const r = await rig(); const s = await r.spaces.create(space(r), clock);
    reply = { status: 200, body: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "card declined" } } };
    await call(r, buy(30_000)); expect((await r.spaces.get(s.id, "t1"))!).toMatchObject({ spentMinor: 0, calls: 1 });
    reply = { status: 503, body: {} };
    await call(r, buy(30_000)); expect((await r.spaces.get(s.id, "t1"))!.spentMinor).toBe(30_000);
  });
  it("stops at the call budget; the scope's calls are not spent by a refused call", async () => {
    const r = await rig(); await r.spaces.create(space(r, { budget: { maxCalls: 2 } , tools: [{ tool: "google_calendar", action: "create_event" }] }), clock);
    for (let i = 0; i < 2; i++) expect((await call(r, rpc("google_calendar.create_event", { title: "x" }))).res.status).toBe(200);
    const third = await call(r, rpc("google_calendar.create_event", { title: "x" }));
    expect(third.json.error.message).toMatch(/no active Space|calls exhausted/);
    const [g] = await r.scopes.find(r.agent.agentId, "google_calendar", "create_event", clock); expect(g!.calls).toBe(2);
  });
  it("a Space cannot loosen policy: a denied amount stays denied inside a Space with room to spend", async () => {
    const r = await rig(); await r.spaces.create(space(r, { budget: { maxCalls: 5, spend: { currency: "INR", limitMinor: 1_000_000 } } }), clock);
    expect((await call(r, buy(60_000))).json.error.message).toMatch(/policy: rule no-big says deny/);
  });
  it("approval 'always' asks a person even when policy allows; the approval is bound to the parameters and to the Space", async () => {
    const r = await rig();
    const tools = [{ tool: "gmail", action: "send_email", approval: "always" as const }];
    const a = await r.spaces.create(space(r, { name: "A", tools, budget: { maxCalls: 5 } }), clock);
    const b = await r.spaces.create(space(r, { name: "B", tools, budget: { maxCalls: 5 } }), clock);
    const send = rpc("gmail.send_email", { to: "meera@x.com" });
    const first = await call(r, send, { "x-recast-space": a.id }); expect(first.decision).toBe("pending_approval");
    const id = first.json.error.data.approval_id; await r.approvals.decide(id, "t1", "usr_meera", true, clock);
    expect((await call(r, send, { "x-recast-space": b.id, "x-approval-id": id })).decision).toBe("pending_approval");   // other Space: not this approval
    expect((await call(r, rpc("gmail.send_email", { to: "all@x.com" }), { "x-recast-space": a.id, "x-approval-id": id })).decision).toBe("pending_approval");
    expect((await call(r, send, { "x-recast-space": a.id, "x-approval-id": id })).res.status).toBe(200);
    expect((await call(r, send)).json.error.message).toMatch(/several Spaces include gmail.send_email; send x-recast-space/);
  });
  it("stop is immediate and permanent; expiry ends a Space too", async () => {
    const r = await rig(); const s = await r.spaces.create(space(r), clock);
    expect((await call(r, buy(100))).res.status).toBe(200);
    expect(await r.spaces.stop(s.id, "t1", "usr_meera", clock)).toBe(true); expect(await r.spaces.stop(s.id, "t1", "usr_meera", clock)).toBe(false);
    expect((await call(r, buy(100))).decision).toBe("denied");
    const s2 = await r.spaces.create(space(r, { expiresAt: hours(1) }), clock);
    clock = T0 + 2 * 3600_000; expect((await call(r, buy(100), { "x-recast-space": s2.id })).json.error.message).toMatch(/is expired/);
  });
  it("tools/list shows only tools that are in an active Space and scoped", async () => {
    const r = await rig(); await r.spaces.create(space(r), clock);
    const names = (await call(r, rpc("", {}, "tools/list"))).json.result.tools.map((t: any) => t.name);
    expect(names).toEqual(["shop.buy", "google_calendar.create_event"]);
  });
  it("the activity log names the Space and the cost of each call, and still verifies", async () => {
    const r = await rig(); const s = await r.spaces.create(space(r), clock);
    await call(r, buy(2_500)); await call(r, buy(100, "other-shop"));
    const e = await r.store.list("t1");
    expect(e.map((x) => [x.result, x.spaceId, x.costMinor])).toEqual([["allowed", s.id, 2500], ["success", s.id, 2500], ["denied", s.id, undefined]]);
    expect((await verifyChain(e, r.keys, e.at(-1)!.hash)).ok).toBe(true);
  });
  it("release states: a tenant outside the agent cohorts is refused at the gateway, for every method", async () => {
    const out = await rig({ cohort: "public" }); await out.spaces.create(space(out), clock);
    expect((await call(out, buy(100))).json.error.message).toBe("this capability is not available to this account");
    expect((await call(out, rpc("", {}, "tools/list"))).decision).toBe("denied");
    const internal = await rig({ cohort: "internal" }); await internal.spaces.create(space(internal), clock);
    expect((await call(internal, buy(100))).res.status).toBe(200);
    const priv = await rig({ cohort: "private" });   // the gateway is private, but Spaces are still internal
    expect((await call(priv, buy(100))).decision).toBe("denied");
    expect(createRelease(parseOverrides("agent.spaces=private")).allows("agent.spaces", "private")).toBe(true);
  });
});

describe("SqlSpaceStore", () => {
  let db: PGlite; let tenant: string, other: string; let agentKey: string;
  beforeEach(async () => {
    db = await freshDb();
    tenant = (await db.query<{ id: string }>(`insert into tenants(name) values ('Acme') returning id`)).rows[0]!.id;
    other = (await db.query<{ id: string }>(`insert into tenants(name) values ('Beta') returning id`)).rows[0]!.id;
    const id = await createAgentIdentity("bot", "acme"); agentKey = id.agentId;
    await new SqlAgentRegistry(db).register({ agentId: id.agentId, tenantId: tenant, name: id.name, publicJwk: id.publicJwk });
  });
  const input = (over: Partial<SpaceInput> = {}): SpaceInput => ({ tenantId: tenant, agentId: agentKey, name: "S", expiresAt: hours(24), tools: [{ tool: "shop", action: "buy", cost: { param: "amount" } }], budget: { maxCalls: 3, spend: { currency: "INR", limitMinor: 1000 } }, ...over });
  it("round-trips a Space and keeps it inside its tenant", async () => {
    const s = new SqlSpaceStore(db); const sp = await s.create(input(), T0);
    expect(await s.get(sp.id, tenant)).toMatchObject({ name: "S", agentId: agentKey, budget: { maxCalls: 3, spend: { currency: "INR", limitMinor: 1000 } }, status: "active", calls: 0, spentMinor: 0 });
    expect(await s.get(sp.id, other)).toBeNull(); expect(await s.list(other)).toEqual([]);
    expect(await s.stop(sp.id, other, "x", T0)).toBe(false);
    await expect(s.create(input({ tenantId: other }), T0)).rejects.toThrow(SpaceError);   // the agent is not in that tenant
  });
  it("reserve is atomic: concurrent callers never share the last unit of money", async () => {
    const s: SpaceStore = new SqlSpaceStore(db); const sp = await s.create(input({ budget: { maxCalls: 100, spend: { currency: "INR", limitMinor: 1000 } } }), T0);
    const out = await Promise.all(Array.from({ length: 8 }, () => s.reserve(sp.id, 300, T0)));
    expect(out.filter((x) => x === "ok")).toHaveLength(3); expect(out.filter((x) => x === "spend_exhausted")).toHaveLength(5);
    expect((await s.get(sp.id, tenant))!.spentMinor).toBe(900);
  });
  it("the database refuses a restart after stop, a Space longer than 30 days, and a cost with no money budget", async () => {
    const s = new SqlSpaceStore(db); const sp = await s.create(input(), T0);
    expect(await s.stop(sp.id, tenant, "usr", T0)).toBe(true); expect(await s.reserve(sp.id, 0, T0)).toBe("stopped");
    await expect(db.query(`update agent_spaces set status = 'active', stopped_at = null where id = $1`, [sp.id])).rejects.toThrow(/cannot be restarted/);
    await expect(db.query(`update agent_spaces set expires_at = created_at + interval '31 days' where id = $1`, [sp.id])).rejects.toThrow();
    const free = await s.create(input({ tools: [{ tool: "shop", action: "look" }], budget: { maxCalls: 3 } }), T0);
    expect(await s.reserve(free.id, 5, T0)).toBe("spend_exhausted"); expect(await s.reserve(free.id, 0, T0)).toBe("ok");
    expect(await s.reserve(free.id, 0, T0 + 25 * 3600_000)).toBe("expired");
  });
});
