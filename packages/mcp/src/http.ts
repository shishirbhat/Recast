import { createServer, type IncomingMessage, type Server } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Backend } from "./backend";
import { createRecastMcpServer } from "./server";

const MAX_BODY = 64 * 1024;
async function readBody(q: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of q) { n += (c as Buffer).length; if (n > MAX_BODY) throw new Error("too large"); chunks.push(c as Buffer); }
  const t = Buffer.concat(chunks).toString("utf8"); return t ? JSON.parse(t) : undefined;
}

/** Streamable HTTP, stateless: a fresh server per request, JSON responses. Serves POST /mcp; GET /healthz for load balancers. */
export function createMcpHttpServer(backend: Backend): Server {
  return createServer(async (q, r) => {
    const url = new URL(q.url ?? "/", "http://x");
    if (url.pathname === "/healthz" && q.method === "GET") { r.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok", mode: backend.mode })); return; }
    if (url.pathname !== "/mcp") { r.writeHead(404).end(); return; }
    if (q.method !== "POST") { r.writeHead(405, { allow: "POST" }).end(); return; }
    let body: unknown;
    try { body = await readBody(q); } catch { r.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "invalid or too large body" }, id: null })); return; }
    const server = createRecastMcpServer(backend);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    r.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport); await transport.handleRequest(q, r, body);
  });
}
