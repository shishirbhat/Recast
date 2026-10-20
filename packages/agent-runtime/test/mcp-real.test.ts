// The official MCP client talking to a real MCP server, with the gateway in between. Nothing here is mocked: three real HTTP hops.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createProof, AuditLog, MemoryAgentRegistry, MemoryApprovalStore, MemoryAuditStore, MemoryScopeStore, MemoryVault, createAgentIdentity, createGateway, generateKeyPair, parsePolicy, signToken, verifyChain } from "../src";

const UPSTREAM_SECRET = "UPSTREAM-OAUTH-TOKEN"; const received: { auth: string | undefined; tool?: string }[] = []; const created: unknown[] = [];
let upstream: Server, gatewayHttp: Server, upstreamUrl: string, gatewayUrl: string;

async function body(q: IncomingMessage) { const c: Buffer[] = []; for await (const x of q) c.push(x as Buffer); const t = Buffer.concat(c).toString(); return t ? JSON.parse(t) : undefined; }

beforeAll(async () => {
  // A real MCP server (stateless Streamable HTTP) that only trusts the upstream credential.
  upstream = createServer(async (q, r) => {
    const parsed = await body(q); received.push({ auth: q.headers.authorization, ...(parsed?.params?.name ? { tool: parsed.params.name } : {}) });
    if (q.headers.authorization !== `Bearer ${UPSTREAM_SECRET}`) { r.writeHead(401).end(); return; }
    const server = new McpServer({ name: "calendar-and-mail", version: "1.0.0" });
    server.tool("google_calendar.create_event", "Create an event", { title: z.string(), attendees: z.array(z.string()).optional() }, async (a) => { created.push(a); return { content: [{ type: "text", text: `created ${a.title}` }] }; });
    server.tool("gmail.send_email", "Send an email", { to: z.string(), body: z.string() }, async (a) => ({ content: [{ type: "text", text: `sent to ${a.to}` }] }));
    server.tool("gmail.delete_all", "Delete everything", {}, async () => ({ content: [{ type: "text", text: "deleted" }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    r.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport); await transport.handleRequest(q, r, parsed);
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok)); upstreamUrl = `http://127.0.0.1:${(upstream.address() as any).port}/mcp`;
});
afterAll(() => { upstream?.close(); gatewayHttp?.close(); });

const T0 = Date.now();
async function startGateway(proof: "off" | "optional" | "required" = "optional") {
  const agent = await createAgentIdentity("mcp-bot", "acme"); const reg = new MemoryAgentRegistry(); await reg.register({ agentId: agent.agentId, tenantId: "t1", name: agent.name, publicJwk: agent.publicJwk, ownerUserId: "usr_meera" });
  const scopes = new MemoryScopeStore(); const approvals = new MemoryApprovalStore(); const store = new MemoryAuditStore(); const signer = await generateKeyPair(); const vault = new MemoryVault(); vault.set("t1", "google_calendar", UPSTREAM_SECRET); vault.set("t1", "gmail", UPSTREAM_SECRET); vault.set("t1", "*", UPSTREAM_SECRET);
  const policy = parsePolicy(`rules:\n  - { tool: google_calendar, action: create_event, then: allow }\n  - { tool: gmail, action: send_email, then: require_approval }\n`);
  for (const [tool, action] of [["google_calendar", "create_event"], ["gmail", "send_email"]] as const) await scopes.grant({ agentId: agent.agentId, tenantId: "t1", tool, action, maxCalls: 10, expiresAt: new Date(T0 + 3600_000).toISOString() });
  let gw!: ReturnType<typeof createGateway>;
  gatewayHttp = createServer(async (q, r) => {
    const chunks: Buffer[] = []; for await (const c of q) chunks.push(c as Buffer);
    const res = await gw.handle(new Request(`http://localhost${q.url}`, { method: q.method!, headers: q.headers as Record<string, string>, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }));
    r.writeHead(res.status, Object.fromEntries(res.headers)); r.end(Buffer.from(await res.arrayBuffer()));
  });
  await new Promise<void>((ok) => gatewayHttp.listen(0, "127.0.0.1", ok)); gatewayUrl = `http://127.0.0.1:${(gatewayHttp.address() as any).port}/mcp`;
  gw = createGateway({ audience: "gw", registry: reg, scopes, approvals, audit: new AuditLog(store, { privateJwk: signer.privateJwk, keyId: "rt1" }), getPolicy: () => policy, exchange: { mode: "vault", vault }, upstream: () => upstreamUrl, proof, publicUrl: gatewayUrl });
  const token = () => signToken(agent.privateJwk, { iss: agent.agentId, sub: agent.agentId, aud: "gw" });
  return { agent, approvals, store, signer, token };
}
async function connect(token: string) {
  const client = new Client({ name: "real-client", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(gatewayUrl), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

describe("the official MCP client with per-request proof of possession", () => {
  it("works when the client signs every request, and a bare bearer token is refused", async () => {
    const rig = await startGateway("required"); const token = await rig.token();
    // The SDK lets us supply fetch; ours adds a fresh proof to every request it makes.
    const signedFetch: typeof fetch = async (input, init) => {
      const h = new Headers(init?.headers); const method = (init?.method ?? "GET").toUpperCase(); const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      h.set("authorization", `Bearer ${token}`); h.set("dpop", await createProof(rig.agent.privateJwk, { agentId: rig.agent.agentId, method, url, accessToken: token }));
      return fetch(input, { ...init, headers: h });
    };
    const client = new Client({ name: "dpop-client", version: "1.0.0" }); await client.connect(new StreamableHTTPClientTransport(new URL(gatewayUrl), { fetch: signedFetch }));
    expect(((await client.callTool({ name: "google_calendar.create_event", arguments: { title: "signed" } })).content as any)[0].text).toBe("created signed"); await client.close();
    await expect(connect(token)).rejects.toThrow();                      // the same token, bearer only
  });
});

describe("the official MCP client through the gateway to a real MCP server", () => {
  it("initialises, lists only the tools this agent has scopes for, and calls an allowed tool", async () => {
    const rig = await startGateway(); const client = await connect(await rig.token());
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["gmail.send_email", "google_calendar.create_event"]);          // gmail.delete_all exists upstream but is not shown
    const out = await client.callTool({ name: "google_calendar.create_event", arguments: { title: "Team sync", attendees: ["meera@x.com"] } });
    expect((out.content as any)[0].text).toBe("created Team sync"); expect(created.at(-1)).toMatchObject({ title: "Team sync" });
    await client.close();
  });
  it("the upstream only ever saw the exchanged credential, never the agent's token", async () => {
    const rig = await startGateway(); const t = await rig.token(); const client = await connect(t); received.length = 0;
    await client.callTool({ name: "google_calendar.create_event", arguments: { title: "x" } });
    expect(received.length).toBeGreaterThan(0); expect(received.every((r) => r.auth === `Bearer ${UPSTREAM_SECRET}`)).toBe(true); expect(JSON.stringify(received)).not.toContain(t);
    await client.close();
  });
  it("a tool with no scope is refused as a typed MCP error and never reaches the server", async () => {
    const rig = await startGateway(); const client = await connect(await rig.token()); received.length = 0;
    await expect(client.callTool({ name: "gmail.delete_all", arguments: {} })).rejects.toMatchObject({ code: -32003, message: expect.stringMatching(/no live scope/) });
    expect(received.filter((r) => r.tool === "gmail.delete_all")).toEqual([]);
    await client.close();
  });
  it("a send needs a person: the client gets error -32004 with an approval id, then the same call succeeds once approved", async () => {
    const rig = await startGateway(); const client = await connect(await rig.token()); const args = { to: "meera@x.com", body: "hi" };
    const err: any = await client.callTool({ name: "gmail.send_email", arguments: args }).then(() => null, (e) => e);
    expect(err.code).toBe(-32004); expect(err.data).toMatchObject({ status: "pending_approval", approval_id: expect.stringMatching(/^apr_/) });
    await rig.approvals.decide(err.data.approval_id, "t1", "usr_meera", true, Date.now());
    const retry = new Client({ name: "real-client", version: "1.0.0" });
    await retry.connect(new StreamableHTTPClientTransport(new URL(gatewayUrl), { requestInit: { headers: { authorization: `Bearer ${await rig.token()}`, "x-approval-id": err.data.approval_id } } }));
    expect(((await retry.callTool({ name: "gmail.send_email", arguments: args })).content as any)[0].text).toBe("sent to meera@x.com");
    await client.close(); await retry.close();
  });
  it("without a valid agent token the client cannot even connect", async () => {
    await startGateway(); await expect(connect("garbage")).rejects.toThrow();
  });
  it("everything the client did is in a signed chain that verifies", async () => {
    const rig = await startGateway(); const client = await connect(await rig.token());
    await client.callTool({ name: "google_calendar.create_event", arguments: { title: "audited" } });
    await client.callTool({ name: "gmail.delete_all", arguments: {} }).catch(() => undefined);
    const entries = await rig.store.list("t1"); expect(entries.map((e) => `${e.action}:${e.result}`)).toEqual(["create_event:allowed", "create_event:success", "delete_all:denied"]);
    expect(await verifyChain(entries, { rt1: rig.signer.publicJwk }, entries.at(-1)!.hash)).toEqual({ ok: true, entries: 3 });
    await client.close();
  });
});
