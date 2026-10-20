// The deployable runtime, for real: a Postgres wire server (PGlite behind pglite-socket) with every migration applied,
// the `pg` driver, the runtime's HTTP server, the official MCP client, and a real MCP server upstream.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createAgentIdentity, createProof, generateKeyPair, signToken, type AgentKeyPair } from "@recast/agent-runtime";
import { freshDb } from "@recast/store/testing";
import { ConfigError, loadConfig, type ServerConfig } from "../src/config";
import { createRuntimeServer } from "../src/server";

const UPSTREAM_SECRET = "UPSTREAM-OAUTH-TOKEN-XYZ"; const ADMIN = "admin-token-admin-token-123456";
let socket: PGLiteSocketServer, pool: pg.Pool, upstream: Server, runtime: ReturnType<typeof createRuntimeServer>, base: string, tenant: string, agent: AgentKeyPair, signerPub: JsonWebKey, config: ServerConfig;
const created: unknown[] = [];
const body = async (q: IncomingMessage) => { const c: Buffer[] = []; for await (const x of q) c.push(x as Buffer); const t = Buffer.concat(c).toString(); return t ? JSON.parse(t) : undefined; };

beforeAll(async () => {
  const db = await freshDb(); socket = new PGLiteSocketServer({ db, port: 0, host: "127.0.0.1" }); await socket.start();
  const addr = (socket as any).server?.address?.() ?? null; const port: number = addr?.port ?? (socket as any).port;
  pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`, max: 1 });
  tenant = (await pool.query(`insert into tenants(name, cohort) values ('Acme', 'internal') returning id`)).rows[0].id;

  upstream = createServer(async (q, r) => {
    const parsed = await body(q); if (q.headers.authorization !== `Bearer ${UPSTREAM_SECRET}`) { r.writeHead(401).end(); return; }
    const server = new McpServer({ name: "mail", version: "1" });
    server.tool("google_calendar.create_event", "Create", { title: z.string() }, async (a) => { created.push(a); return { content: [{ type: "text", text: `created ${a.title}` }] }; });
    server.tool("gmail.send_email", "Send", { to: z.string() }, async (a) => ({ content: [{ type: "text", text: `sent to ${a.to}` }] }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true }); r.on("close", () => { void t.close(); void server.close(); });
    await server.connect(t); await t.handleRequest(q, r, parsed);
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));

  const signer = await generateKeyPair(); signerPub = signer.publicJwk;
  config = loadConfig({ PORT: "0", DATABASE_URL: "postgresql://unused", UPSTREAM_URL: `http://127.0.0.1:${(upstream.address() as any).port}/mcp`, ADMIN_TOKEN: ADMIN, RUNTIME_SIGNING_KEY: JSON.stringify(signer.privateJwk), RUNTIME_KEY_ID: "rt-test", PROOF_MODE: "optional", RECAST_VAULT: JSON.stringify({ [tenant]: { "*": UPSTREAM_SECRET, google_calendar: UPSTREAM_SECRET, gmail: UPSTREAM_SECRET } }) });
  runtime = createRuntimeServer(config, pool as any); await new Promise<void>((ok) => runtime.server.listen(0, "127.0.0.1", ok)); base = `http://127.0.0.1:${(runtime.server.address() as any).port}`;

  // Provision everything through the admin API, as an operator would.
  agent = await createAgentIdentity("deploy-bot", "acme");
  const adm = (path: string, b: unknown) => fetch(base + path, { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify(b) });
  expect((await adm("/admin/agents", { tenant, agentId: agent.agentId, name: "deploy-bot", publicKey: agent.publicJwk })).status).toBe(200);
  for (const [tool, action] of [["google_calendar", "create_event"], ["gmail", "send_email"]]) expect((await adm("/admin/scopes", { tenant, agentId: agent.agentId, tool, action, ttlSeconds: 3600, maxCalls: 20 })).status).toBe(200);
  expect((await adm("/admin/policy", { tenant, name: "main", yaml: "rules:\n  - { tool: google_calendar, action: create_event, then: allow }\n  - { tool: gmail, action: send_email, then: require_approval }\n" })).status).toBe(200);
}, 120_000);
afterAll(async () => { runtime?.close(); upstream?.close(); await pool?.end(); await socket?.stop(); });

const token = () => signToken(agent.privateJwk, { iss: agent.agentId, sub: agent.agentId, aud: config.audience });
const adminGet = (path: string) => fetch(base + path, { headers: { authorization: `Bearer ${ADMIN}` } }).then(async (r) => ({ status: r.status, json: await r.json() as any }));
async function connect(headers: Record<string, string> = {}) {
  const c = new Client({ name: "c", version: "1" }); await c.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { authorization: `Bearer ${await token()}`, ...headers } } })); return c;
}

describe("configuration", () => {
  const ok = { DATABASE_URL: "postgres://x", UPSTREAM_URL: "http://up/mcp", ADMIN_TOKEN: ADMIN, RUNTIME_SIGNING_KEY: "" };
  it("refuses to start without what it needs, with a message that names the setting", async () => {
    const key = JSON.stringify((await generateKeyPair()).privateJwk);
    expect(() => loadConfig({})).toThrow(/ADMIN_TOKEN is required/); expect(() => loadConfig({ ...ok, ADMIN_TOKEN: "short", RUNTIME_SIGNING_KEY: key })).toThrow(/at least 24/);
    expect(() => loadConfig({ ...ok, RUNTIME_SIGNING_KEY: "{}" })).toThrow(/Ed25519 private JWK/); expect(() => loadConfig({ ...ok, RUNTIME_SIGNING_KEY: key, PROOF_MODE: "maybe" })).toThrow(/PROOF_MODE/);
    expect(() => loadConfig({ ...ok, RUNTIME_SIGNING_KEY: key, UPSTREAM_URL: "nope" })).toThrow(ConfigError); expect(() => loadConfig({ ...ok, RUNTIME_SIGNING_KEY: key, RECAST_VAULT: "{bad" })).toThrow(/RECAST_VAULT/);
    expect(loadConfig({ ...ok, RUNTIME_SIGNING_KEY: key })).toMatchObject({ proof: "required", port: 8080 });     // proofs are required unless you opt out
  });
});

describe("the runtime server, end to end on a Postgres wire connection", () => {
  it("health checks the database", async () => { const r = await fetch(base + "/healthz"); expect(r.status).toBe(200); expect(await r.json()).toEqual({ status: "ok" }); });
  it("the real MCP client lists only scoped tools and calls an allowed one; the upstream only saw the vault credential", async () => {
    const c = await connect(); expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(["gmail.send_email", "google_calendar.create_event"]);
    expect(((await c.callTool({ name: "google_calendar.create_event", arguments: { title: "Deployed" } })).content as any)[0].text).toBe("created Deployed"); expect(created.at(-1)).toEqual({ title: "Deployed" }); await c.close();
  });
  it("a send waits for a person: it shows up in the pending list, a decision releases it once, and the chain verifies", async () => {
    const c = await connect(); const err: any = await c.callTool({ name: "gmail.send_email", arguments: { to: "meera@x.com" } }).then(() => null, (e) => e); expect(err.code).toBe(-32004); const id = err.data.approval_id;
    const pending = await adminGet(`/admin/approvals?tenant=${tenant}`); expect(pending.json.approvals.map((a: any) => a.id)).toContain(id);
    const decide = await fetch(`${base}/admin/approvals/${id}/decide`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ tenant, approve: true, by: "usr_meera" }) }); expect(decide.status).toBe(200);
    expect((await adminGet(`/admin/approvals?tenant=${tenant}`)).json.approvals.map((a: any) => a.id)).not.toContain(id);
    expect((await fetch(`${base}/admin/approvals/${id}/decide`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ tenant, approve: true, by: "x" }) })).status).toBe(404);   // already decided
    const approved = await connect({ "x-approval-id": id }); expect(((await approved.callTool({ name: "gmail.send_email", arguments: { to: "meera@x.com" } })).content as any)[0].text).toBe("sent to meera@x.com");
    const audit = await adminGet(`/admin/audit?tenant=${tenant}`); expect(audit.json.verification).toMatchObject({ ok: true }); expect(audit.json.entries.some((e: any) => e.humanApproved)).toBe(true);
    await c.close(); await approved.close();
  });
  it("a new policy applies at once; a bad policy is refused and leaves the old one in place", async () => {
    const adm = (b: unknown) => fetch(base + "/admin/policy", { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify(b) });
    expect((await adm({ tenant, name: "main", yaml: "default: nope" })).status).toBe(400);
    const c = await connect(); await c.callTool({ name: "google_calendar.create_event", arguments: { title: "still allowed" } });
    expect((await adm({ tenant, name: "main", yaml: "rules: []\ndefault: deny\n" })).status).toBe(200);
    await expect(c.callTool({ name: "google_calendar.create_event", arguments: { title: "now denied" } })).rejects.toMatchObject({ code: -32003 });
    expect((await adm({ tenant, name: "main", yaml: "rules:\n  - { tool: google_calendar, action: create_event, then: allow }\n" })).status).toBe(200); await c.close();
  });
  it("proof mode: with proofs required, a bare token is refused; a signed request works", async () => {
    const strict = createRuntimeServer({ ...config, proof: "required" }, pool as any); await new Promise<void>((ok) => strict.server.listen(0, "127.0.0.1", ok)); const url = `http://127.0.0.1:${(strict.server.address() as any).port}/mcp`;
    const call = (headers: Record<string, string>) => fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    const t = await token(); expect((await call({ authorization: `Bearer ${t}` })).status).toBe(401);
    const proof = await createProof(agent.privateJwk, { agentId: agent.agentId, method: "POST", url, accessToken: t });
    expect((await call({ authorization: `Bearer ${t}`, dpop: proof })).status).toBe(200); expect((await call({ authorization: `Bearer ${t}`, dpop: proof })).status).toBe(401);   // replay, through the database cache
    strict.close();
  });
  it("revoking an agent or a token stops it at once", async () => {
    const jti = "revoke-me-1"; const t = await signToken(agent.privateJwk, { iss: agent.agentId, sub: agent.agentId, aud: config.audience, jti });
    const ping = (tok: string) => fetch(base + "/mcp", { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    expect((await ping(t)).status).toBe(200);
    expect((await fetch(base + "/admin/tokens/revoke", { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ tenant, jti }) })).status).toBe(200); expect((await ping(t)).status).toBe(401);
    const other = await createAgentIdentity("temp", "acme"); const adm = (p: string, b: unknown) => fetch(base + p, { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify(b) });
    await adm("/admin/agents", { tenant, agentId: other.agentId, name: "temp", publicKey: other.publicJwk }); const ot = await signToken(other.privateJwk, { iss: other.agentId, sub: other.agentId, aud: config.audience });
    expect((await ping(ot)).status).toBe(200); await adm("/admin/agents/revoke", { agentId: other.agentId }); const r = await ping(ot); expect(r.status).toBe(401); expect(((await r.json()) as any).error.code).toBe("agent_revoked");
  });
  it("the admin API is closed to anyone without the admin token, validates input, and leaks nothing on failure", async () => {
    expect((await fetch(`${base}/admin/audit?tenant=${tenant}`)).status).toBe(401); expect((await fetch(`${base}/admin/audit?tenant=${tenant}`, { headers: { authorization: "Bearer wrong-token-wrong-token-1234" } })).status).toBe(401);
    expect((await adminGet(`/admin/audit?tenant=not-a-uuid`)).status).toBe(400); expect((await adminGet(`/admin/nope`)).status).toBe(404);
    const bad = await fetch(base + "/admin/agents", { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ tenant, agentId: "x", name: "y", publicKey: { kty: "OKP", crv: "Ed25519", x: "a", d: "PRIVATE" } }) }); expect(bad.status).toBe(400);
    expect((await fetch(base + "/admin/scopes", { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ tenant, agentId: agent.agentId, tool: "x", action: "y", ttlSeconds: 99999999 }) })).status).toBe(400);
    expect((await fetch(base + "/admin/policy", { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: "{oops" })).status).toBe(400);
  });
  it("the audit endpoint reports a broken chain if the stored log is tampered with at the database level", async () => {
    // A superuser can drop the append-only trigger; the signatures are what still show it.
    await pool.query(`alter table agent_audit_log disable trigger audit_no_update`);
    await pool.query(`update agent_audit_log set entry = jsonb_set(entry, '{tool}', '"evil"') where seq = 2`);
    const v = (await adminGet(`/admin/audit?tenant=${tenant}`)).json.verification; await pool.query(`alter table agent_audit_log enable trigger audit_no_update`);
    expect(v).toMatchObject({ ok: false, brokenAt: 2, reason: "entry contents were changed" }); void signerPub;
  });
});

import { HttpRuntimeClient, RuntimeError } from "@recast/runtime-client";
describe("the control center's client against the real runtime", () => {
  it("lists agents with live scopes, pending approvals, decides one, and reads a verified audit report", async () => {
    const rc = new HttpRuntimeClient({ baseUrl: base, adminToken: ADMIN, tenantId: tenant });
    const agents = await rc.listAgents(); const mine = agents.find((a) => a.agentId === agent.agentId)!;
    expect(mine).toMatchObject({ name: "deploy-bot", revoked: false }); expect(mine.scopes.map((s) => `${s.tool}.${s.action}`).sort()).toEqual(["gmail.send_email", "google_calendar.create_event"]);
    await fetch(base + "/admin/policy", { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ tenant, name: "main", yaml: "rules:\n  - { tool: gmail, action: send_email, then: require_approval }\n" }) });
    const c = await connect(); const err: any = await c.callTool({ name: "gmail.send_email", arguments: { to: "client@x.com" } }).then(() => null, (e) => e);
    const pending = await rc.listApprovals(); expect(pending.map((p) => p.id)).toContain(err.data.approval_id); expect(pending.find((p) => p.id === err.data.approval_id)).toMatchObject({ agentId: agent.agentId, tool: "gmail", action: "send_email" });
    await rc.decide(err.data.approval_id, false, "usr_meera"); expect((await rc.listApprovals()).map((p) => p.id)).not.toContain(err.data.approval_id);
    await expect(rc.decide(err.data.approval_id, true, "usr_meera")).rejects.toBeInstanceOf(RuntimeError);
    const report = await rc.audit(); expect(report.total).toBeGreaterThan(0); expect(report.entries.at(-1)).toMatchObject({ tool: expect.any(String), hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    await c.close();
    await expect(new HttpRuntimeClient({ baseUrl: base, adminToken: "wrong-token-wrong-token-9999", tenantId: tenant }).listAgents()).rejects.toMatchObject({ status: 401 });
  });
});
