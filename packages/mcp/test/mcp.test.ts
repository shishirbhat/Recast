// The official MCP client against the Recast MCP server: in memory, over Streamable HTTP, over stdio as a real process,
// and in remote mode through the real API core.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MemoryKeyStore, createApi } from "@recast/api-core";
import { createResolver } from "@recast/resolve";
import { createMcpHttpServer, createRecastMcpServer, localBackend, remoteBackend, type Backend } from "../src";

async function memClient(backend: Backend) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createRecastMcpServer(backend).connect(a);
  const c = new Client({ name: "test", version: "1" }); await c.connect(b); return c;
}
const text = (r: any) => r.content.map((c: any) => c.text).join("\n");

describe("local mode", () => {
  let c: Client; beforeAll(async () => { c = await memClient(localBackend()); });
  it("lists two read-only tools with input schemas and server instructions", async () => {
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["list_destinations", "resolve_object"]);
    const r = tools.find((t) => t.name === "resolve_object")!;
    expect(r.inputSchema.required).toEqual(["raw"]); expect(r.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect((r.inputSchema.properties as any).target_type.enum).toEqual(["Person", "Event", "Location", "Product", "Paper", "Document"]);
    expect(c.getInstructions()).toContain("Nothing is changed in any app");
  });
  it("resolves a person and says how it lands in Gmail", async () => {
    const r: any = await c.callTool({ name: "resolve_object", arguments: { raw: "Meera Iyer, meera@x.com", destination: "gmail" } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ status: "resolved", object: { type: "Person", fields: { name: "Meera Iyer", email: ["meera@x.com"] } }, routing: { destination: "gmail", action: "Create a draft to this person" } });
    expect(text(r)).toMatch(/^Resolved a Person .* In gmail it becomes: Create a draft to this person/);
    expect(r.structuredContent.object.provenance.length).toBeGreaterThan(0);
  });
  it("unresolved and ambiguous answers are results, not errors, with advice for the model", async () => {
    const r: any = await c.callTool({ name: "resolve_object", arguments: { raw: "hello there" } });
    expect(r.isError).toBeFalsy(); expect(r.structuredContent.status).toBe("unresolved"); expect(text(r)).toMatch(/^Not resolved/);
  });
  it("lists destinations in the public /v1/bridges shape", async () => {
    const r: any = await c.callTool({ name: "list_destinations", arguments: {} });
    expect(r.structuredContent.destinations.map((d: any) => d.id)).toEqual(["google_calendar", "gmail", "google_sheets", "google_tasks", "notion"]);
  });
  it("refuses bad input before the engine runs", async () => {
    for (const args of [{}, { raw: "" }, { raw: "x".repeat(4001) }, { raw: "x", target_type: "Spaceship" }, { raw: "x", source_url: "not a url" }]) {
      const res = await c.callTool({ name: "resolve_object", arguments: args }).then((r: any) => r.isError ? "tool-error" : "ok", () => "protocol-error");
      expect(res, JSON.stringify(args).slice(0, 60)).not.toBe("ok");
    }
  });
});

describe("remote mode, through the real API core", () => {
  const KEY = "sk_test_mcp_remote_01"; let calls: string[] = [];
  async function api() {
    const keys = new MemoryKeyStore(); await keys.add(KEY, { tenantId: "t1", tier: "free", correctionsOptIn: false });
    const a = createApi({ resolver: createResolver(), keys });
    return (async (url: string | URL | Request, init?: RequestInit) => { calls.push(String(url)); return a.handle(new Request(url, init)); }) as typeof fetch;
  }
  it("resolves with the tenant's key and reports the same shape as local mode", async () => {
    calls = []; const c = await memClient(remoteBackend({ apiKey: KEY, baseUrl: "https://api.test/", fetch: await api() }));
    const r: any = await c.callTool({ name: "resolve_object", arguments: { raw: "Meera Iyer, meera@x.com", destination: "gmail" } });
    const local: any = await (await memClient(localBackend())).callTool({ name: "resolve_object", arguments: { raw: "Meera Iyer, meera@x.com", destination: "gmail" } });
    expect(r.structuredContent.routing).toEqual(local.structuredContent.routing); expect(r.structuredContent.object.fields).toEqual(local.structuredContent.object.fields);
    expect((await c.callTool({ name: "list_destinations", arguments: {} }) as any).structuredContent.destinations).toHaveLength(5);
    expect(calls).toEqual(["https://api.test/v1/resolve", "https://api.test/v1/bridges"]);
    expect((await c.listTools()).tools[0]!.annotations?.openWorldHint).toBe(true);
  });
  it("a bad key or an outage becomes a clear tool error, never a crash", async () => {
    const bad: any = await (await memClient(remoteBackend({ apiKey: "sk_nobody_nobody_01", baseUrl: "https://api.test", fetch: await api() }))).callTool({ name: "resolve_object", arguments: { raw: "x" } });
    expect(bad.isError).toBe(true); expect(text(bad)).toContain("Recast API 401 unauthorized");
    const down: any = await (await memClient(remoteBackend({ apiKey: KEY, fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch }))).callTool({ name: "list_destinations", arguments: {} });
    expect(down.isError).toBe(true); expect(text(down)).toBe("could not reach the Recast API; try again shortly");
  });
});

describe("transports", () => {
  let http: Server, base: string;
  beforeAll(async () => { http = createMcpHttpServer(localBackend()); await new Promise<void>((ok) => http.listen(0, "127.0.0.1", ok)); base = `http://127.0.0.1:${(http.address() as any).port}`; });
  afterAll(() => { http?.close(); });
  it("Streamable HTTP: the official client connects and calls a tool; health and wrong methods answer plainly", async () => {
    const c = new Client({ name: "http", version: "1" }); await c.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
    const r: any = await c.callTool({ name: "resolve_object", arguments: { raw: "Launch dinner 2026-11-14 19:00" } });
    expect(r.structuredContent.object.type).toBe("Event"); await c.close();
    expect(await (await fetch(base + "/healthz")).json()).toEqual({ status: "ok", mode: "local" });
    expect((await fetch(base + "/mcp")).status).toBe(405); expect((await fetch(base + "/other")).status).toBe(404);
    expect((await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(70_000) })).status).toBe(400);
  });
  it("stdio: the real binary as a child process", async () => {
    const t = new StdioClientTransport({ command: "npx", args: ["tsx", "src/stdio.ts"], env: { ...process.env, RECAST_API_KEY: "" } as Record<string, string>, stderr: "pipe" });
    const c = new Client({ name: "stdio", version: "1" }); await c.connect(t);
    const r: any = await c.callTool({ name: "resolve_object", arguments: { raw: "Meera Iyer, meera@x.com" } });
    expect(r.structuredContent.object.type).toBe("Person"); await c.close();
  }, 60_000);
});
