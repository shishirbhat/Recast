// Spaces on the deployable server: provisioned through the admin API, enforced on real MCP traffic, over the Postgres wire protocol.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { z } from "zod";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { freshDb } from "@recast/store/testing";
import { createAgentIdentity, generateKeyPair, signToken, type AgentKeyPair } from "@recast/agent-runtime";
import { ConfigError, loadConfig, type ServerConfig } from "../src/config";
import { createRuntimeServer } from "../src/server";

const SECRET = "UPSTREAM-SHOP-TOKEN"; const ADMIN = "admin-token-admin-token-spaces1";
let socket: PGLiteSocketServer, pool: pg.Pool, upstream: Server, runtime: ReturnType<typeof createRuntimeServer>, base: string, config: ServerConfig;
let tenant: string, outsider: string, agent: AgentKeyPair, stranger: AgentKeyPair;
const bought: number[] = [];
const body = async (q: IncomingMessage) => { const c: Buffer[] = []; for await (const x of q) c.push(x as Buffer); const t = Buffer.concat(c).toString(); return t ? JSON.parse(t) : undefined; };
const adm = (path: string, b: unknown) => fetch(base + path, { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, json: await r.json() as any }));
const admGet = (path: string) => fetch(base + path, { headers: { authorization: `Bearer ${ADMIN}` } }).then(async (r) => ({ status: r.status, json: await r.json() as any }));
const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

beforeAll(async () => {
  const db = await freshDb(); socket = new PGLiteSocketServer({ db, port: 0, host: "127.0.0.1" }); await socket.start();
  const port: number = (socket as any).server?.address?.()?.port ?? (socket as any).port;
  pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`, max: 1 });
  tenant = (await pool.query(`insert into tenants(name, cohort) values ('Acme', 'internal') returning id`)).rows[0].id;
  outsider = (await pool.query(`insert into tenants(name) values ('Public Co') returning id`)).rows[0].id;   // default cohort: public

  upstream = createServer(async (q, r) => {
    const parsed = await body(q); if (q.headers.authorization !== `Bearer ${SECRET}`) { r.writeHead(401).end(); return; }
    const server = new McpServer({ name: "shop", version: "1" });
    server.tool("shop.buy", "Buy", { amount: z.number(), store: z.string() }, async (a) => { bought.push(a.amount); return { content: [{ type: "text", text: `bought ${a.amount}` }] }; });
    server.tool("shop.refund_all", "Refund everything", {}, async () => ({ content: [{ type: "text", text: "refunded" }] }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true }); r.on("close", () => { void t.close(); void server.close(); });
    await server.connect(t); await t.handleRequest(q, r, parsed);
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));

  const signer = await generateKeyPair();
  config = loadConfig({ PORT: "0", DATABASE_URL: "postgresql://unused", UPSTREAM_URL: `http://127.0.0.1:${(upstream.address() as any).port}/mcp`, ADMIN_TOKEN: ADMIN, RUNTIME_SIGNING_KEY: JSON.stringify(signer.privateJwk), PROOF_MODE: "optional", SPACES_MODE: "required",
    RECAST_VAULT: JSON.stringify({ [tenant]: { "*": SECRET, shop: SECRET }, [outsider]: { "*": SECRET, shop: SECRET } }) });
  runtime = createRuntimeServer(config, pool as any); await new Promise<void>((ok) => runtime.server.listen(0, "127.0.0.1", ok)); base = `http://127.0.0.1:${(runtime.server.address() as any).port}`;

  agent = await createAgentIdentity("grocer", "acme"); stranger = await createAgentIdentity("other", "public");
  for (const [t, a] of [[tenant, agent], [outsider, stranger]] as const) {
    expect((await adm("/admin/agents", { tenant: t, agentId: a.agentId, name: a.name, publicKey: a.publicJwk })).status).toBe(200);
    for (const action of ["buy", "refund_all"]) expect((await adm("/admin/scopes", { tenant: t, agentId: a.agentId, tool: "shop", action, ttlSeconds: 3600, maxCalls: 50 })).status).toBe(200);
    expect((await adm("/admin/policy", { tenant: t, name: "main", yaml: "rules:\n  - { tool: shop, then: allow }\n" })).status).toBe(200);
  }
}, 120_000);
afterAll(async () => { runtime?.close(); upstream?.close(); await pool?.end(); await socket?.stop(); });

async function client(a: AgentKeyPair) {
  const t = await signToken(a.privateJwk, { iss: a.agentId, sub: a.agentId, aud: config.audience });
  const c = new Client({ name: "c", version: "1" }); await c.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { authorization: `Bearer ${t}` } } })); return c;
}

describe("Spaces on the runtime server", () => {
  it("refuses an unbounded Space, and a tenant outside the release cohort cannot create one or call through the gateway", async () => {
    const bad = await adm("/admin/spaces", { tenant, agentId: agent.agentId, createdBy: "usr", name: "x", tools: [{ tool: "shop", action: "*" }], budget: { maxCalls: 3 }, expiresAt: inHours(1) });
    expect(bad).toMatchObject({ status: 400, json: { error: { code: "invalid_space" } } });
    const far = await adm("/admin/spaces", { tenant, agentId: agent.agentId, createdBy: "usr", name: "x", tools: [{ tool: "shop", action: "buy" }], budget: { maxCalls: 3 }, expiresAt: inHours(24 * 40) });
    expect(far.json.error.message).toMatch(/at most 30 days/);
    expect((await adm("/admin/spaces", { tenant: outsider, agentId: stranger.agentId, createdBy: "usr", name: "x", tools: [{ tool: "shop", action: "buy" }], budget: { maxCalls: 3 }, expiresAt: inHours(1) })).status).toBe(403);
    await expect(client(stranger)).rejects.toThrow(/not available/);   // even initialize is refused
  });
  it("a real MCP client sees and uses only what the Space allows, within its money budget; stop ends it at once", async () => {
    const created = await adm("/admin/spaces", { tenant, agentId: agent.agentId, createdBy: "usr_meera", name: "Weekly groceries", purpose: "Buy groceries from Fresh Mart",
      tools: [{ tool: "shop", action: "buy", cost: { param: "amount" }, constraints: { store: { eq: "fresh-mart" } } }], budget: { maxCalls: 10, spend: { currency: "INR", limitMinor: 300_000 } }, expiresAt: inHours(24) });
    expect(created.status).toBe(200); const id = created.json.space.id;
    const c = await client(agent);
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(["shop.buy"]);   // refund_all is scoped but not in the Space
    expect((await c.callTool({ name: "shop.buy", arguments: { amount: 200_000, store: "fresh-mart" } })).content).toEqual([{ type: "text", text: "bought 200000" }]);
    await expect(c.callTool({ name: "shop.buy", arguments: { amount: 150_000, store: "fresh-mart" } })).rejects.toThrow(/spend exhausted/);
    await expect(c.callTool({ name: "shop.buy", arguments: { amount: 100, store: "elsewhere" } })).rejects.toThrow(/store must equal/);
    await expect(c.callTool({ name: "shop.refund_all", arguments: {} })).rejects.toThrow(/no active Space includes shop.refund_all/);
    expect(bought).toEqual([200_000]);

    const listed = await admGet(`/admin/spaces?tenant=${tenant}`);
    expect(listed.json.spaces[0]).toMatchObject({ id, state: "active", calls: 1, spentMinor: 200_000, remaining: { calls: 9, spendMinor: 100_000 } });
    expect((await adm(`/admin/spaces/${id}/stop`, { tenant, by: "usr_meera" })).json.space).toMatchObject({ state: "stopped", stoppedBy: "usr_meera" });
    await expect(c.callTool({ name: "shop.buy", arguments: { amount: 100, store: "fresh-mart" } })).rejects.toThrow(/no active Space/);
    expect((await adm(`/admin/spaces/${id}/stop`, { tenant, by: "usr_meera" })).status).toBe(404);
    expect(bought).toEqual([200_000]);

    const audit = await admGet(`/admin/audit?tenant=${tenant}`);
    expect(audit.json.verification.ok).toBe(true);
    expect(audit.json.entries.filter((e: any) => e.result === "success").map((e: any) => [e.spaceId, e.costMinor])).toEqual([[id, 200_000]]);
    await c.close();
  });
  it("configuration refuses a typo in the release overrides or the Spaces mode", () => {
    const ok = { DATABASE_URL: "postgres://x", UPSTREAM_URL: "http://up/mcp", ADMIN_TOKEN: ADMIN, RUNTIME_SIGNING_KEY: JSON.stringify(config.signingKey.privateJwk) };
    expect(() => loadConfig({ ...ok, SPACES_MODE: "maybe" })).toThrow(/SPACES_MODE/);
    expect(() => loadConfig({ ...ok, RECAST_RELEASE: "agent.spacse=public" })).toThrow(ConfigError);
    expect(loadConfig(ok)).toMatchObject({ spaces: "off", release: {} });
  });
});
