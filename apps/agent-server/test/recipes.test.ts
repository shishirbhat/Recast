// Recipes on the deployable server: list the reviewed catalog, refuse to apply without scopes, apply into a Space whose policy
// pack denies what the tenant policy allows, refuse widening and unreviewed content. Official MCP client, Postgres wire.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { loadConfig, type ServerConfig } from "../src/config";
import { createRuntimeServer } from "../src/server";

const CATALOG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../recipes");
const ADMIN = "admin-token-admin-token-recipe1"; const SECRET = "MAIL-TOKEN";
let socket: PGLiteSocketServer, pool: pg.Pool, mail: Server, runtime: ReturnType<typeof createRuntimeServer>, base: string, config: ServerConfig, tenant: string, agent: AgentKeyPair, recipesDir: string;
const sent: string[] = [];
const body = async (q: IncomingMessage) => { const c: Buffer[] = []; for await (const x of q) c.push(x as Buffer); const t = Buffer.concat(c).toString(); return t ? JSON.parse(t) : undefined; };
const adm = (p: string, b?: unknown) => fetch(base + p, { method: b === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, ...(b === undefined ? {} : { body: JSON.stringify(b) }) }).then(async (r) => ({ status: r.status, json: await r.json() as any }));

beforeAll(async () => {
  const db = await freshDb(); socket = new PGLiteSocketServer({ db, port: 0, host: "127.0.0.1" }); await socket.start();
  const port: number = (socket as any).server?.address?.()?.port ?? (socket as any).port;
  pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`, max: 1 });
  tenant = (await pool.query(`insert into tenants(name, cohort) values ('Acme', 'internal') returning id`)).rows[0].id;
  mail = createServer(async (q, r) => {
    const parsed = await body(q); if (q.headers.authorization !== `Bearer ${SECRET}`) { r.writeHead(401).end(); return; }
    const s = new McpServer({ name: "mail", version: "1" });
    s.tool("gmail.create_draft", "Draft", { to: z.string(), body: z.string() }, async (a) => ({ content: [{ type: "text", text: `draft to ${a.to}` }] }));
    s.tool("gmail.read_thread", "Read", { id: z.string() }, async () => ({ content: [{ type: "text", text: "thread" }] }));
    s.tool("gmail.send_email", "Send", { to: z.string() }, async (a) => { sent.push(a.to); return { content: [{ type: "text", text: "sent" }] }; });
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true }); r.on("close", () => { void t.close(); void s.close(); });
    await s.connect(t); await t.handleRequest(q, r, parsed);
  });
  await new Promise<void>((ok) => mail.listen(0, "127.0.0.1", ok));
  recipesDir = mkdtempSync(path.join(tmpdir(), "catalog-")); cpSync(CATALOG, recipesDir, { recursive: true });
  const signer = await generateKeyPair();
  config = loadConfig({ PORT: "0", DATABASE_URL: "postgresql://unused", UPSTREAM_URL: `http://127.0.0.1:${(mail.address() as any).port}/mcp`, ADMIN_TOKEN: ADMIN, RUNTIME_SIGNING_KEY: JSON.stringify(signer.privateJwk), PROOF_MODE: "optional", SPACES_MODE: "required", RECIPES_DIR: recipesDir,
    RECAST_VAULT: JSON.stringify({ [tenant]: { "*": SECRET, gmail: SECRET } }) });
  runtime = createRuntimeServer(config, pool as any); await new Promise<void>((ok) => runtime.server.listen(0, "127.0.0.1", ok)); base = `http://127.0.0.1:${(runtime.server.address() as any).port}`;
  agent = await createAgentIdentity("mailer", "acme");
  expect((await adm("/admin/agents", { tenant, agentId: agent.agentId, name: "mailer", publicKey: agent.publicJwk })).status).toBe(200);
  // The tenant's own policy is permissive about mail, sending included. The recipe is what keeps this agent from sending.
  expect((await adm("/admin/policy", { tenant, name: "main", yaml: "rules:\n  - { tool: gmail, then: allow }\n" })).status).toBe(200);
}, 120_000);
afterAll(async () => { runtime?.close(); mail?.close(); await pool?.end(); await socket?.stop(); });

describe("recipes on the runtime server", () => {
  it("lists the reviewed catalog", async () => {
    const r = await adm(`/admin/recipes?tenant=${tenant}`);
    expect(r.json.recipes.map((x: any) => [x.id, x.reviewed])).toEqual([["draft-replies", true], ["grocery-runner", true], ["meeting-scheduler", true]]);
  });
  it("never grants scopes: applying without them is refused and names what is missing", async () => {
    const r = await adm("/admin/recipes/draft-replies/apply", { tenant, agentId: agent.agentId, createdBy: "usr_meera" });
    expect(r).toMatchObject({ status: 409, json: { error: { code: "needs_scopes" } } }); expect(r.json.error.message).toMatch(/gmail\.read_thread, gmail\.create_draft/);
    expect((await adm(`/admin/spaces?tenant=${tenant}`)).json.spaces).toEqual([]);
  });
  it("applied, the agent can draft but not send, though the tenant policy and its scopes would allow sending", async () => {
    for (const action of ["read_thread", "create_draft", "send_email"]) expect((await adm("/admin/scopes", { tenant, agentId: agent.agentId, tool: "gmail", action, ttlSeconds: 3600, maxCalls: 20 })).status).toBe(200);
    expect((await adm("/admin/recipes/draft-replies/apply", { tenant, agentId: agent.agentId, createdBy: "usr_meera", narrow: { maxCalls: 500 } })).json.error.code).toBe("invalid_narrowing");
    const applied = await adm("/admin/recipes/draft-replies/apply", { tenant, agentId: agent.agentId, createdBy: "usr_meera", narrow: { maxCalls: 20, durationHours: 8 } });
    expect(applied.status).toBe(200); expect(applied.json.space).toMatchObject({ name: "Draft replies, never send", budget: { maxCalls: 20 }, state: "active" });
    expect(applied.json.recipe).toMatchObject({ id: "draft-replies", version: 1 });
    const t = await signToken(agent.privateJwk, { iss: agent.agentId, sub: agent.agentId, aud: config.audience });
    const c = new Client({ name: "c", version: "1" }); await c.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { authorization: `Bearer ${t}` } } }));
    expect((await c.listTools()).tools.map((x) => x.name).sort()).toEqual(["gmail.create_draft", "gmail.read_thread"]);
    expect((await c.callTool({ name: "gmail.create_draft", arguments: { to: "meera@x.com", body: "Thanks!" } })).content).toEqual([{ type: "text", text: "draft to meera@x.com" }]);
    await expect(c.callTool({ name: "gmail.send_email", arguments: { to: "meera@x.com" } })).rejects.toThrow(/no active Space includes gmail.send_email/);
    expect(sent).toEqual([]);
    await c.close();
  });
  it("a recipe edited after its review cannot be applied until it is reviewed again", async () => {
    const f = path.join(recipesDir, "grocery-runner.yaml"); writeFileSync(f, readFileSync(f, "utf8").replace("limitMinor: 500000", "limitMinor: 5000000"));
    expect((await adm(`/admin/recipes?tenant=${tenant}`)).json.recipes.find((x: any) => x.id === "grocery-runner").reviewed).toBe(false);
    expect((await adm("/admin/recipes/grocery-runner/apply", { tenant, agentId: agent.agentId, createdBy: "usr_meera" })).json.error.code).toBe("not_reviewed");
  });
});
