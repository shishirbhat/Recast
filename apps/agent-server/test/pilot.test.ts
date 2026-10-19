// The bounded agent pilot, end to end: `agent-auth init` registers an agent, an operator gives it a Space, and a desktop-style
// MCP client (the official SDK over stdio) launches `agent-auth connect`, which reaches two local tools only through the gateway,
// with proofs required and Spaces required, over the Postgres wire protocol.
import { mkdtempSync, readFileSync, existsSync, statSync, appendFileSync, writeFileSync } from "node:fs";
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
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { freshDb } from "@recast/store/testing";
import { generateKeyPair } from "@recast/agent-runtime";
import { runCli } from "@recast/agent-runtime/src/cli";
import { loadConfig, type ServerConfig } from "../src/config";
import { createRuntimeServer } from "../src/server";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/agent-runtime/src/cli.ts");
const ADMIN = "admin-token-admin-token-pilot01"; const TOOL_SECRET = "LOCAL-TOOLS-TOKEN";
let socket: PGLiteSocketServer, pool: pg.Pool, tools: Server, runtime: ReturnType<typeof createRuntimeServer>, base: string, config: ServerConfig, tenant: string;
const work = mkdtempSync(path.join(tmpdir(), "pilot-")); const NOTES = path.join(work, "notes.md"), CAL = path.join(work, "calendar.ics");
const authDir = mkdtempSync(path.join(tmpdir(), "agent-auth-"));
const body = async (q: IncomingMessage) => { const c: Buffer[] = []; for await (const x of q) c.push(x as Buffer); const t = Buffer.concat(c).toString(); return t ? JSON.parse(t) : undefined; };
const adm = (p: string, b: unknown) => fetch(base + p, { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, json: await r.json() as any }));
const admGet = (p: string) => fetch(base + p, { headers: { authorization: `Bearer ${ADMIN}` } }).then(async (r) => r.json() as any);
const toolAuth: (string | undefined)[] = [];

beforeAll(async () => {
  const db = await freshDb(); socket = new PGLiteSocketServer({ db, port: 0, host: "127.0.0.1" }); await socket.start();
  const port: number = (socket as any).server?.address?.()?.port ?? (socket as any).port;
  pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`, max: 1 });
  tenant = (await pool.query(`insert into tenants(name, cohort) values ('Pilot', 'internal') returning id`)).rows[0].id;

  // Two local tools: they write files on this machine. They accept only the credential the runtime's vault holds.
  tools = createServer(async (q, r) => {
    const parsed = await body(q); toolAuth.push(q.headers.authorization);
    if (q.headers.authorization !== `Bearer ${TOOL_SECRET}`) { r.writeHead(401).end(); return; }
    const s = new McpServer({ name: "local-tools", version: "1" });
    s.tool("notes.append", "Append a line to the notes file", { text: z.string().max(500) }, async ({ text }) => { appendFileSync(NOTES, `- ${text}\n`); return { content: [{ type: "text", text: "noted" }] }; });
    s.tool("calendar.add_event", "Add an event to the local calendar", { title: z.string(), start: z.string() }, async ({ title, start }) => { writeFileSync(CAL, `BEGIN:VEVENT\nSUMMARY:${title}\nDTSTART:${start}\nEND:VEVENT\n`); return { content: [{ type: "text", text: `added ${title}` }] }; });
    s.tool("notes.delete_all", "Delete the notes file", {}, async () => { writeFileSync(NOTES, ""); return { content: [{ type: "text", text: "deleted" }] }; });
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true }); r.on("close", () => { void t.close(); void s.close(); });
    await s.connect(t); await t.handleRequest(q, r, parsed);
  });
  await new Promise<void>((ok) => tools.listen(0, "127.0.0.1", ok));

  const signer = await generateKeyPair();
  config = loadConfig({ PORT: "0", DATABASE_URL: "postgresql://unused", UPSTREAM_URL: `http://127.0.0.1:${(tools.address() as any).port}/mcp`, ADMIN_TOKEN: ADMIN, RUNTIME_SIGNING_KEY: JSON.stringify(signer.privateJwk),
    PROOF_MODE: "required", SPACES_MODE: "required", RECAST_VAULT: JSON.stringify({ [tenant]: { "*": TOOL_SECRET, notes: TOOL_SECRET, calendar: TOOL_SECRET } }) });
  runtime = createRuntimeServer(config, pool as any); await new Promise<void>((ok) => runtime.server.listen(0, "127.0.0.1", ok)); base = `http://127.0.0.1:${(runtime.server.address() as any).port}`;
}, 120_000);
afterAll(async () => { runtime?.close(); tools?.close(); await pool?.end(); await socket?.stop(); });

describe("bounded agent pilot", () => {
  let agentId: string; let spaceId: string; let client: Client;

  it("agent-auth init creates the key locally, registers only the public half, and prints the MCP client configuration", async () => {
    const out: string[] = [];
    expect(await runCli(["init", "--name", "pilot", "--org", "acme", "--tenant", tenant, "--gateway", `${base}/mcp`, "--register"], { dir: authDir, out: (s) => out.push(s), env: { RECAST_ADMIN_TOKEN: ADMIN } })).toBe(0);
    const key = JSON.parse(readFileSync(path.join(authDir, "keys", "pilot.json"), "utf8")); agentId = key.agentId;
    expect(statSync(path.join(authDir, "keys", "pilot.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(path.join(authDir, "profiles", "pilot.json"), "utf8")).not.toContain(key.privateJwk.d);
    expect(readFileSync(path.join(authDir, "profiles", "pilot.json"), "utf8")).not.toContain(ADMIN);
    expect(out.join("\n")).toMatch(/Registered agt_[0-9a-f]{12}/); expect(out.join("\n")).toMatch(/"args": \[\s*"connect",\s*"--name",\s*"pilot"\s*\]/);
    const stored = (await pool.query(`select public_key from agents where agent_key = $1`, [agentId])).rows[0].public_key; expect(stored.d).toBeUndefined();
    // A plain-http gateway on another machine is refused: the token and proofs would travel in the clear.
    expect(await runCli(["init", "--name", "x", "--org", "acme", "--tenant", tenant, "--gateway", "http://gateway.example/mcp"], { dir: authDir, out: (s) => out.push(s) })).toBe(1);
    expect(out.at(-1)).toMatch(/must be https/);
  });

  it("an operator scopes three tools but bounds the agent to a Space with two, and the calendar asks a person first", async () => {
    for (const [tool, action] of [["notes", "append"], ["calendar", "add_event"], ["notes", "delete_all"]]) expect((await adm("/admin/scopes", { tenant, agentId, tool, action, ttlSeconds: 3600, maxCalls: 20 })).status).toBe(200);
    expect((await adm("/admin/policy", { tenant, name: "pilot", yaml: "rules:\n  - { tool: notes, then: allow }\n  - { tool: calendar, then: allow }\n" })).status).toBe(200);
    const s = await adm("/admin/spaces", { tenant, agentId, createdBy: "usr_meera", name: "Pilot", purpose: "Take notes and add events", expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      tools: [{ tool: "notes", action: "append", constraints: { text: { max: 200 } } }, { tool: "calendar", action: "add_event", approval: "always" }], budget: { maxCalls: 10 } });
    expect(s.status).toBe(200); spaceId = s.json.space.id;
  });

  it("a desktop MCP client launches agent-auth connect over stdio and reaches only the Space's tools", async () => {
    client = new Client({ name: "desktop", version: "1" });
    await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", CLI, "connect", "--name", "pilot", "--space", spaceId], env: { ...process.env, AGENT_AUTH_DIR: authDir } as Record<string, string>, stderr: "pipe" }));
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["calendar.add_event", "notes.append"]);
    expect((await client.callTool({ name: "notes.append", arguments: { text: "Call Meera about the venue" } })).content).toEqual([{ type: "text", text: "noted" }]);
    expect(readFileSync(NOTES, "utf8")).toBe("- Call Meera about the venue\n");
    await expect(client.callTool({ name: "notes.delete_all", arguments: {} })).rejects.toThrow(/Space 'Pilot' does not include notes.delete_all/);
    expect(readFileSync(NOTES, "utf8")).toBe("- Call Meera about the venue\n");
    expect(toolAuth.every((a) => a === `Bearer ${TOOL_SECRET}`)).toBe(true);   // the tools only ever saw the vault's credential
  }, 60_000);

  it("the calendar waits for a person; the approval works once, for those exact arguments, passed through _meta", async () => {
    const args = { title: "Venue visit", start: "20261020T100000Z" };
    let approvalId = "";
    try { await client.callTool({ name: "calendar.add_event", arguments: args }); expect.fail("should wait for approval"); }
    catch (e: any) { expect(e.message).toMatch(/a person must approve this first/); approvalId = e.data.approval_id; }
    expect(existsSync(CAL)).toBe(false);
    expect((await adm(`/admin/approvals/${approvalId}/decide`, { tenant, approve: true, by: "usr_meera" })).status).toBe(200);
    await expect(client.callTool({ name: "calendar.add_event", arguments: { ...args, title: "Something else" }, _meta: { "recast/approval_id": approvalId } })).rejects.toThrow(/approve/);
    expect((await client.callTool({ name: "calendar.add_event", arguments: args, _meta: { "recast/approval_id": approvalId } })).content).toEqual([{ type: "text", text: "added Venue visit" }]);
    expect(readFileSync(CAL, "utf8")).toContain("SUMMARY:Venue visit");
    await expect(client.callTool({ name: "calendar.add_event", arguments: args, _meta: { "recast/approval_id": approvalId } })).rejects.toThrow(/approve/);   // once
  }, 60_000);

  it("the activity is a verified, signed record of every decision, tied to the Space", async () => {
    const a = await admGet(`/admin/audit?tenant=${tenant}`);
    expect(a.verification.ok).toBe(true);
    const calls = a.entries.filter((e: any) => e.tool !== "*").map((e: any) => `${e.tool}.${e.action}:${e.result}${e.humanApproved ? "+person" : ""}`);
    expect(calls).toEqual(["notes.append:allowed", "notes.append:success", "notes.delete_all:denied", "calendar.add_event:pending_approval", "calendar.add_event:pending_approval",
      "calendar.add_event:allowed+person", "calendar.add_event:success+person", "calendar.add_event:pending_approval"]);
    expect(a.entries.filter((e: any) => e.result === "success").every((e: any) => e.spaceId === spaceId)).toBe(true);
  });

  it("revoking the agent stops the bridge's next call with a clear reason", async () => {
    expect((await adm("/admin/agents/revoke", { agentId })).status).toBe(200);
    await expect(client.callTool({ name: "notes.append", arguments: { text: "after revoke" } })).rejects.toThrow(/gateway: this agent has been revoked/);
    expect(readFileSync(NOTES, "utf8")).not.toContain("after revoke");
    await client.close();
  }, 30_000);
});
