import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { checkConstraints, checkGatewayUrl, createAgentIdentity, createBridge, runStdioBridge } from "../src";

const reply = (status: number, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) => new Response(body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body), { status, headers });

describe("stdio bridge", () => {
  it("refuses a plain-http gateway that is not this machine", () => {
    expect(() => checkGatewayUrl("http://gw.example/mcp")).toThrow(/https/);
    expect(checkGatewayUrl("http://127.0.0.1:8080/mcp").port).toBe("8080"); expect(checkGatewayUrl("https://gw.example/mcp").protocol).toBe("https:");
  });
  it("signs every request with a fresh proof, reuses the short token, keeps the session, and never sends the private key", async () => {
    const id = await createAgentIdentity("b", "o"); const sent: { headers: Record<string, string>; body: string }[] = [];
    const fetch = (async (_u: string, init: RequestInit) => { sent.push({ headers: init.headers as Record<string, string>, body: String(init.body) }); return reply(200, { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }, { "content-type": "application/json", "mcp-session-id": "s1" }); }) as typeof globalThis.fetch;
    const b = createBridge({ gatewayUrl: "http://localhost:1/mcp", audience: "gw", agentId: id.agentId, privateJwk: id.privateJwk, space: "spc_1", fetch });
    await b.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })); await b.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    expect(sent[0]!.headers.authorization).toBe(sent[1]!.headers.authorization); expect(sent[0]!.headers.dpop).not.toBe(sent[1]!.headers.dpop);
    expect(sent[1]!.headers["mcp-session-id"]).toBe("s1"); expect(sent[1]!.headers["mcp-protocol-version"]).toBe("2025-06-18"); expect(sent[1]!.headers["x-recast-space"]).toBe("spc_1");
    expect(JSON.stringify(sent)).not.toContain(String(id.privateJwk.d));
  });
  it("turns an HTTP-level refusal into a JSON-RPC error for that request, says nothing for notifications, and survives bad input", async () => {
    const id = await createAgentIdentity("b", "o");
    const b = createBridge({ gatewayUrl: "http://localhost:1/mcp", audience: "gw", agentId: id.agentId, privateJwk: id.privateJwk, fetch: (async () => reply(401, { error: { code: "agent_revoked", message: "this agent has been revoked" } })) as typeof fetch });
    expect(await b.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "x" } }))).toEqual([{ jsonrpc: "2.0", id: 7, error: { code: -32001, message: "gateway: this agent has been revoked", data: { status: 401, code: "agent_revoked" } } }]);
    expect(await b.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).toEqual([]);
    expect(await b.handleLine("{not json")).toEqual([{ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }]);
    const down = createBridge({ gatewayUrl: "http://localhost:1/mcp", audience: "gw", agentId: id.agentId, privateJwk: id.privateJwk, fetch: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch });
    expect((await down.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })))[0]).toMatchObject({ id: 1, error: { message: "the Recast gateway is unreachable" } });
  });
  it("reads an event-stream answer and writes one line per message to stdout", async () => {
    const id = await createAgentIdentity("b", "o"); const input = new PassThrough(), output = new PassThrough(); const lines: string[] = [];
    output.on("data", (c) => lines.push(...String(c).split("\n").filter(Boolean)));
    const fetch = (async () => reply(200, `event: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"ok":true}}\n\n`, { "content-type": "text/event-stream" })) as typeof globalThis.fetch;
    const done = runStdioBridge({ gatewayUrl: "http://localhost:1/mcp", audience: "gw", agentId: id.agentId, privateJwk: id.privateJwk, fetch }, input, output);
    input.end(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }) + "\n"); await done;
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ jsonrpc: "2.0", id: 3, result: { ok: true } }]);
  });
});

describe("constraints on text", () => {
  it("min and max bound a string's length, as they do a list's", () => {
    expect(checkConstraints({ text: { max: 5 } }, { text: "short" })).toBeNull();
    expect(checkConstraints({ text: { max: 5 } }, { text: "too long" })).toMatch(/at most 5/);
    expect(checkConstraints({ n: { max: 5 } }, { n: 6 })).toMatch(/at most 5/);
  });
});
