import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verify as verifySig, AuditLog, MemoryAgentRegistry, MemoryApprovalStore, MemoryAuditStore, MemoryScopeStore, MemoryVault, createAgentIdentity, createGateway, generateKeyPair, parsePolicy, signToken, verifyChain, type AgentKeyPair, type AuditStore, type Policy } from "../src";

// A real HTTP "MCP server" that records exactly what reaches it.
let upstream: Server, upstreamUrl: string; let seen: { auth: string | undefined; cookie: string | undefined; body: any }[] = []; let reply: { status: number; body: unknown; headers?: Record<string, string> } = { status: 200, body: {} };
beforeAll(async () => {
  upstream = createServer(async (q, r) => {
    const chunks: Buffer[] = []; for await (const c of q) chunks.push(c as Buffer); const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    seen.push({ auth: q.headers.authorization, cookie: q.headers.cookie, body });
    r.writeHead(reply.status, { "content-type": "application/json", ...(reply.headers ?? {}) }); r.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok)); upstreamUrl = `http://127.0.0.1:${(upstream.address() as any).port}/mcp`;
});
afterAll(() => { upstream.close(); });

const T0 = Date.parse("2026-10-15T10:00:00Z"); let clock = T0;
const POLICY = `rules:
  - { id: cal-ok, tool: google_calendar, action: create_event, then: allow }
  - { id: mail-ask, tool: gmail, action: send_email, then: require_approval }
  - { id: mail-ban, tool: gmail, action: send_email, when: { recipient_domain: banned.example }, then: deny }
  - { id: notes, tool: notion, then: allow }
`;
interface Rig { agent: AgentKeyPair; reg: MemoryAgentRegistry; scopes: MemoryScopeStore; approvals: MemoryApprovalStore; audit: AuditLog; store: AuditStore; keys: Record<string, JsonWebKey>; gw: ReturnType<typeof createGateway>; vault: MemoryVault; policy: { current: Policy }; runtime: { privateJwk: JsonWebKey; publicJwk: JsonWebKey } }
async function rig(over: { store?: AuditStore; mode?: "vault" | "runtime-jwt" } = {}): Promise<Rig> {
  const agent = await createAgentIdentity("calendar-bot", "acme"); const reg = new MemoryAgentRegistry();
  await reg.register({ agentId: agent.agentId, tenantId: "t1", name: agent.name, publicJwk: agent.publicJwk, ownerUserId: "usr_meera" });
  const scopes = new MemoryScopeStore(); const approvals = new MemoryApprovalStore(); const store = over.store ?? new MemoryAuditStore(); const signer = await generateKeyPair(); const runtime = await generateKeyPair();
  const audit = new AuditLog(store, { privateJwk: signer.privateJwk, keyId: "rt1" }, () => new Date(clock)); const vault = new MemoryVault(); vault.set("t1", "google_calendar", "UPSTREAM-SECRET-CAL"); vault.set("t1", "gmail", "UPSTREAM-SECRET-MAIL");
  const policy = { current: parsePolicy(POLICY) };
  const gw = createGateway({ audience: "gw", registry: reg, scopes, audit, approvals, getPolicy: () => policy.current, exchange: { mode: over.mode ?? "vault", vault, runtime: { privateJwk: runtime.privateJwk, issuer: "recast-runtime" } },
    upstream: (tool) => (["google_calendar", "gmail", "notion", "*"].includes(tool) ? upstreamUrl : null), now: () => clock,
    deriveFacts: ({ params }) => (typeof params.to === "string" ? { recipient_domain: params.to.split("@")[1] } : {}) });
  for (const [tool, action] of [["google_calendar", "create_event"], ["gmail", "send_email"], ["notion", "create_page"]] as const) await scopes.grant({ agentId: agent.agentId, tenantId: "t1", tool, action, maxCalls: 5, expiresAt: new Date(T0 + 3600_000).toISOString() });
  return { agent, reg, scopes, approvals, audit, store, keys: { rt1: signer.publicJwk }, gw, vault, policy, runtime };
}
const token = (r: Rig, over = {}) => signToken(r.agent.privateJwk, { iss: r.agent.agentId, sub: r.agent.agentId, aud: "gw", now: clock, ...over });
const rpcCall = (name: string, args: unknown, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
async function call(r: Rig, body: unknown, opts: { token?: string | null; headers?: Record<string, string> } = {}) {
  const t = opts.token === undefined ? await token(r) : opts.token;
  return r.gw.handle(new Request("http://gw/mcp", { method: "POST", headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}), ...(opts.headers ?? {}) }, body: typeof body === "string" ? body : JSON.stringify(body) }));
}
const results = async (r: Rig) => (await r.store.list("t1")).map((e) => e.result);
beforeEach(() => { seen = []; reply = { status: 200, body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "done" }] } } }; clock = T0; });

describe("allowed call", () => {
  it("is forwarded with the upstream credential, never the agent's token, and the answer comes back", async () => {
    const r = await rig(); const t = await token(r);
    const res = await call(r, rpcCall("google_calendar.create_event", { title: "Team sync", attendees: ["meera@x.com"] }), { token: t });
    expect(res.status).toBe(200); expect((await res.json() as any).result.content[0].text).toBe("done");
    expect(seen).toHaveLength(1); expect(seen[0]!.auth).toBe("Bearer UPSTREAM-SECRET-CAL"); expect(JSON.stringify(seen)).not.toContain(t);
    expect(seen[0]!.body.params.arguments.title).toBe("Team sync");
    expect(res.headers.get("x-recast-request-id")).toMatch(/^req_/);
  });
  it("is audited twice (decision, then outcome), signed, chained, with the delegation chain, and the log verifies", async () => {
    const r = await rig(); await call(r, rpcCall("google_calendar.create_event", { title: "T", api_key: "sk-leak" }));
    const e = await r.store.list("t1"); expect(e.map((x) => x.result)).toEqual(["allowed", "success"]);
    expect(e[0]).toMatchObject({ agentId: r.agent.agentId, userId: "usr_meera", tool: "google_calendar", action: "create_event", delegationChain: ["usr_meera", r.agent.agentId], humanApproved: false });
    expect(e[0]!.requestId).toBe(e[1]!.requestId); expect(JSON.stringify(e)).not.toContain("sk-leak");
    expect(await verifyChain(e, r.keys, e.at(-1)!.hash)).toEqual({ ok: true, entries: 2 });
  });
  it("runtime-jwt mode: upstream gets a short token naming the tool as audience and the agent as actor", async () => {
    const r = await rig({ mode: "runtime-jwt" }); await call(r, rpcCall("google_calendar.create_event", { title: "T" }));
    const jwt = seen[0]!.auth!.replace("Bearer ", ""); const [, p] = jwt.split("."); const claims = JSON.parse(atob(p!.replace(/-/g, "+").replace(/_/g, "/")));
    expect(claims).toMatchObject({ iss: "recast-runtime", aud: "google_calendar", scope: "google_calendar:create_event", act: { sub: r.agent.agentId } }); expect(claims.exp - claims.iat).toBe(60);
    const [h, , sig] = jwt.split(".");                                    // an upstream that trusts the runtime checks the runtime's signature
    expect(await verifySig(r.runtime.publicJwk, `${h}.${p}`, sig!)).toBe(true);
  });
  it("upstream cookies never come back to the agent", async () => {
    const r = await rig(); reply.headers = { "set-cookie": "session=abc" };
    expect((await call(r, rpcCall("google_calendar.create_event", { title: "T" }))).headers.get("set-cookie")).toBeNull();
  });
  it("an upstream failure or JSON-RPC error is logged as failure and relayed", async () => {
    const r = await rig(); reply = { status: 500, body: { error: "boom" } };
    expect((await call(r, rpcCall("google_calendar.create_event", { title: "T" }))).status).toBe(500);
    reply = { status: 200, body: { jsonrpc: "2.0", id: 1, error: { code: -1, message: "bad" } } }; await call(r, rpcCall("google_calendar.create_event", { title: "T" }));
    expect(await results(r)).toEqual(["allowed", "failure", "allowed", "failure"]);
  });
});

describe("refusals reach nothing upstream and are logged", () => {
  it("no scope for that tool or action", async () => {
    const r = await rig(); const res = await call(r, rpcCall("google_calendar.delete_event", { id: "1" }));
    expect(res.headers.get("x-recast-decision")).toBe("denied"); expect((await res.json() as any).error.message).toMatch(/no live scope/); expect(seen).toEqual([]); expect(await results(r)).toEqual(["denied"]);
  });
  it("scope constraints are enforced", async () => {
    const r = await rig(); await r.scopes.grant({ agentId: r.agent.agentId, tenantId: "t1", tool: "notion", action: "create_page", maxCalls: 9, constraints: { blocks: { max: 2 } }, expiresAt: new Date(T0 + 1e6).toISOString() });
    // the broad grant made in rig() would also satisfy this; use a fresh rig with only the constrained one
    const r2 = await rig(); r2.vault.set("t1", "notion", "UPSTREAM-SECRET-NOTION"); (r2.scopes as any).g.clear(); await r2.scopes.grant({ agentId: r2.agent.agentId, tenantId: "t1", tool: "notion", action: "create_page", maxCalls: 9, constraints: { blocks: { max: 2 } }, expiresAt: new Date(T0 + 1e6).toISOString() });
    expect((await call(r2, rpcCall("notion.create_page", { blocks: [1, 2, 3] }))).headers.get("x-recast-decision")).toBe("denied"); expect(seen).toEqual([]);
    expect((await call(r2, rpcCall("notion.create_page", { blocks: [1] }))).status).toBe(200); expect(seen).toHaveLength(1);
  });
  it("policy default deny and explicit deny", async () => {
    const r = await rig(); await r.scopes.grant({ agentId: r.agent.agentId, tenantId: "t1", tool: "sheets", action: "append", maxCalls: 5, expiresAt: new Date(T0 + 1e6).toISOString() });
    const a = await call(r, rpcCall("sheets.append", {})); expect(a.headers.get("x-recast-decision")).toBe("denied"); expect((await a.json() as any).error.message).toMatch(/default applies/);
    const b = await call(r, rpcCall("gmail.send_email", { to: "x@banned.example" })); expect(b.headers.get("x-recast-decision")).toBe("denied"); expect((await b.json() as any).error.message).toMatch(/mail-ban/); expect(seen).toEqual([]);
  });
  it("scope call budget runs out", async () => {
    const r = await rig(); (r.scopes as any).g.clear(); await r.scopes.grant({ agentId: r.agent.agentId, tenantId: "t1", tool: "google_calendar", action: "create_event", maxCalls: 2, expiresAt: new Date(T0 + 1e6).toISOString() });
    const s = []; for (let i = 0; i < 3; i++) { const x = await call(r, rpcCall("google_calendar.create_event", { title: `T${i}` }, i)); s.push(x.headers.get("x-recast-decision") ?? x.status); }
    expect(s).toEqual([200, 200, "denied"]); expect(seen).toHaveLength(2);       // third has no live scope: spent grants are not found
  });
  it("a scope that has expired no longer works", async () => {
    const r = await rig(); const old = await token(r); clock = T0 + 2 * 3600_000;
    expect((await call(r, rpcCall("google_calendar.create_event", { title: "T" }), { token: old })).status).toBe(401);   // the old token expired first
    const t = await token(r); expect((await call(r, rpcCall("google_calendar.create_event", { title: "T" }), { token: t })).headers.get("x-recast-decision")).toBe("denied");   // fresh token, expired scope
  });
});

describe("approval flow", () => {
  const send = { to: "meera@x.com", body: "hi" };
  it("pauses with 202, then goes through once a person approves that exact request, and only once", async () => {
    const r = await rig(); const first = await call(r, rpcCall("gmail.send_email", send));
    expect(first.headers.get("x-recast-decision")).toBe("pending_approval"); const id = (await first.json() as any).error.data.approval_id; expect(seen).toEqual([]);
    expect(await results(r)).toEqual(["pending_approval"]);
    // not yet approved: presenting the id does nothing
    expect((await call(r, rpcCall("gmail.send_email", send), { headers: { "x-approval-id": id } })).headers.get("x-recast-decision")).toBe("pending_approval");
    await r.approvals.decide(id, "t1", "usr_meera", true, clock);
    const ok = await call(r, rpcCall("gmail.send_email", send), { headers: { "x-approval-id": id } }); expect(ok.status).toBe(200); expect(seen).toHaveLength(1);
    const again = await call(r, rpcCall("gmail.send_email", send), { headers: { "x-approval-id": id } }); expect(again.headers.get("x-recast-decision")).toBe("pending_approval");   // single use
    const log = await r.store.list("t1"); expect(log.find((e) => e.result === "allowed")!.humanApproved).toBe(true);
  });
  it("an approval for one request cannot be used for a different one, or by another tenant", async () => {
    const r = await rig(); const id = ((await (await call(r, rpcCall("gmail.send_email", send))).json()) as any).error.data.approval_id; await r.approvals.decide(id, "t1", "usr_meera", true, clock);
    expect((await call(r, rpcCall("gmail.send_email", { ...send, to: "everyone@x.com" }), { headers: { "x-approval-id": id } })).headers.get("x-recast-decision")).toBe("pending_approval"); expect(seen).toEqual([]);
    expect(await r.approvals.decide(id, "other-tenant", "usr_evil", true, clock)).toBeNull();
  });
  it("a rejected or expired approval never lets the call through", async () => {
    const r = await rig(); const id = ((await (await call(r, rpcCall("gmail.send_email", send))).json()) as any).error.data.approval_id;
    await r.approvals.decide(id, "t1", "usr_meera", false, clock); expect((await call(r, rpcCall("gmail.send_email", send), { headers: { "x-approval-id": id } })).headers.get("x-recast-decision")).toBe("pending_approval");
    const r2 = await rig(); const id2 = ((await (await call(r2, rpcCall("gmail.send_email", send))).json()) as any).error.data.approval_id; await r2.approvals.decide(id2, "t1", "usr_meera", true, clock);
    clock += 20 * 60_000; expect((await call(r2, rpcCall("gmail.send_email", send), { headers: { "x-approval-id": id2 } })).headers.get("x-recast-decision")).toBe("pending_approval"); expect(seen).toEqual([]);
  });
});

describe("authentication and protocol edges", () => {
  it("no token, bad token, revoked agent: 401 and nothing upstream", async () => {
    const r = await rig(); const body = rpcCall("google_calendar.create_event", { title: "T" });
    expect((await call(r, body, { token: null })).status).toBe(401);
    expect((await call(r, body, { token: "garbage" })).status).toBe(401);
    await r.reg.revoke(r.agent.agentId); const res = await call(r, body); expect(res.status).toBe(401); expect((await res.json() as any).error.code).toBe("agent_revoked"); expect(seen).toEqual([]);
  });
  it("tools/list passes after authentication; other methods are refused and logged; batches are rejected", async () => {
    const r = await rig(); reply = { status: 200, body: { jsonrpc: "2.0", id: 1, result: { tools: [] } } };
    expect((await call(r, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(200); expect(seen).toHaveLength(1);
    expect((await call(r, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { token: null })).status).toBe(401);
    const res = await call(r, { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "file:///etc/passwd" } }); expect(res.headers.get("x-recast-decision")).toBe("denied"); expect(seen).toHaveLength(1);
    expect(await results(r)).toEqual(["denied"]);
    expect((await call(r, [rpcCall("google_calendar.create_event", {})])).status).toBe(400);
    expect((await call(r, "{not json")).status).toBe(400); expect((await call(r, { jsonrpc: "2.0", id: 1, method: "tools/call", params: {} })).status).toBe(400);
  });
  it("only POST is accepted, and oversize bodies are refused", async () => {
    const r = await rig(); expect((await r.gw.handle(new Request("http://gw/mcp", { method: "GET" }))).status).toBe(405);
    const big = createGateway({ ...(r.gw as any), audience: "gw", registry: r.reg, scopes: r.scopes, audit: r.audit, approvals: r.approvals, getPolicy: () => r.policy.current, exchange: { mode: "vault", vault: r.vault }, upstream: () => upstreamUrl, maxBodyBytes: 100, now: () => clock });
    const t = await token(r); expect((await big.handle(new Request("http://gw/mcp", { method: "POST", headers: { authorization: `Bearer ${t}` }, body: JSON.stringify(rpcCall("x.y", { a: "z".repeat(500) })) }))).status).toBe(413);
  });
});

describe("failing closed", () => {
  it("if the audit log cannot be written, nothing is forwarded", async () => {
    const broken: AuditStore = { last: async () => null, append: async () => { throw new Error("db down"); }, list: async () => [] };
    const r = await rig({ store: broken }); const res = await call(r, rpcCall("google_calendar.create_event", { title: "T" }));
    expect(res.status).toBe(503); expect(seen).toEqual([]);
  });
  it("a tool with no stored credential is not forwarded without one", async () => {
    const r = await rig(); const res = await call(r, rpcCall("notion.create_page", { title: "x" }));
    expect(res.status).toBe(502); expect((await res.json() as any).error.message).toMatch(/no credential/); expect(seen).toEqual([]); expect(await results(r)).toEqual(["allowed", "failure"]);
  });
  it("an unreachable upstream is a 502, logged", async () => {
    const r = await rig(); const dead = createGateway({ audience: "gw", registry: r.reg, scopes: r.scopes, audit: r.audit, approvals: r.approvals, getPolicy: () => r.policy.current, exchange: { mode: "vault", vault: r.vault }, upstream: () => "http://127.0.0.1:1/mcp", now: () => clock });
    const t = await token(r); const res = await dead.handle(new Request("http://gw/mcp", { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify(rpcCall("google_calendar.create_event", { title: "T" })) }));
    expect(res.status).toBe(502); expect((await r.store.list("t1")).at(-1)!.result).toBe("failure");
  });
});

describe("policy is live", () => {
  it("a new policy applies to the next call without restarting anything", async () => {
    const r = await rig(); expect((await call(r, rpcCall("google_calendar.create_event", { title: "T" }))).status).toBe(200);
    r.policy.current = parsePolicy("rules: []\ndefault: deny\n"); expect((await call(r, rpcCall("google_calendar.create_event", { title: "T" }))).headers.get("x-recast-decision")).toBe("denied");
  });
});
