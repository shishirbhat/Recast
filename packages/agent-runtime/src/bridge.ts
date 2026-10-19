import { createInterface } from "node:readline";
import { createProof } from "./proof";
import { signToken } from "./token";

/**
 * The stdio bridge behind `agent-auth connect`. Desktop MCP clients (which speak MCP over stdio) launch it as their server; it
 * forwards each message to the Recast gateway over HTTP. The agent's private key stays in this process: every request carries a
 * short-lived token and a fresh proof signed here, so nothing a network observer or the gateway sees can be replayed.
 * stdout carries only protocol messages; everything else goes to `log` (stderr).
 */
export interface BridgeOptions {
  gatewayUrl: string; audience: string; agentId: string; privateJwk: JsonWebKey;
  /** Which Space this connection spends from (sent as x-recast-space). */
  space?: string;
  fetch?: typeof fetch; now?: () => number; log?: (s: string) => void;
}

const TOKEN_TTL_SEC = 300;

/** Plain HTTP only to this machine: the token and proofs would otherwise cross the network in the clear. */
export function checkGatewayUrl(u: string): URL {
  let url: URL; try { url = new URL(u); } catch { throw new Error(`gateway URL is not a URL: '${u}'`); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("the gateway must be https (plain http is allowed only for localhost)");
  return url;
}

export function createBridge(o: BridgeOptions) {
  const url = checkGatewayUrl(o.gatewayUrl).toString(); const now = o.now ?? Date.now; const doFetch = o.fetch ?? fetch; const log = o.log ?? (() => {});
  let token: { value: string; expMs: number } | null = null; let session: string | undefined; let protocolVersion: string | undefined;

  const bearer = async () => {
    if (!token || token.expMs - now() < 30_000) token = { value: await signToken(o.privateJwk, { iss: o.agentId, sub: o.agentId, aud: o.audience, ttlSec: TOKEN_TTL_SEC, now: now() }), expMs: now() + TOKEN_TTL_SEC * 1000 };
    return token.value;
  };
  const rpcError = (id: unknown, code: number, message: string, data?: unknown) => ({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });

  /** One message from the client in, zero or more messages for the client out. */
  async function forward(msg: any): Promise<unknown[]> {
    const isRequest = msg && typeof msg === "object" && "id" in msg && typeof msg.method === "string";
    const t = await bearer();
    const headers: Record<string, string> = {
      "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${t}`,
      dpop: await createProof(o.privateJwk, { agentId: o.agentId, method: "POST", url, accessToken: t, now: now() }),
      ...(session ? { "mcp-session-id": session } : {}), ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}), ...(o.space ? { "x-recast-space": o.space } : {}),
    };
    let res: Response;
    try { res = await doFetch(url, { method: "POST", headers, body: JSON.stringify(msg) }); }
    catch (e) { log(`gateway unreachable: ${e instanceof Error ? e.message : String(e)}`); return isRequest ? [rpcError(msg.id, -32000, "the Recast gateway is unreachable")] : []; }
    const sid = res.headers.get("mcp-session-id"); if (sid) session = sid;
    if (res.status === 202 || res.status === 204) return [];
    const type = res.headers.get("content-type") ?? ""; const text = await res.text();
    let out: any[] = [];
    try {
      if (/event-stream/.test(type)) out = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)));
      else if (text) out = [JSON.parse(text)];
    } catch { out = []; }
    const rpc = out.filter((m) => m && m.jsonrpc === "2.0");
    if (!rpc.length && isRequest) {
      // Not a JSON-RPC answer: the gateway refused at the HTTP level (401, 413...). Say why, without the token.
      const why = out[0]?.error?.message ?? `gateway answered ${res.status}`; log(`refused: ${why}`);
      return [rpcError(msg.id, -32001, `gateway: ${why}`, { status: res.status, ...(out[0]?.error?.code ? { code: out[0].error.code } : {}) })];
    }
    for (const m of rpc) if (msg?.method === "initialize" && m.result?.protocolVersion) protocolVersion = String(m.result.protocolVersion);
    return rpc;
  }

  async function handleLine(line: string): Promise<unknown[]> {
    if (!line.trim()) return [];
    let msg: unknown; try { msg = JSON.parse(line); } catch { return [rpcError(null, -32700, "parse error")]; }
    return forward(msg);
  }
  return { handleLine };
}

/** Reads newline-delimited JSON-RPC from `input`, writes answers to `output`, until `input` ends. Requests run concurrently. */
export async function runStdioBridge(o: BridgeOptions, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void> {
  const b = createBridge(o); const pending = new Set<Promise<void>>();
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    const p = b.handleLine(line).then((msgs) => { for (const m of msgs) output.write(JSON.stringify(m) + "\n"); }).catch((e) => o.log?.(`bridge error: ${e instanceof Error ? e.message : String(e)}`));
    pending.add(p); void p.finally(() => pending.delete(p));
  }
  await Promise.all(pending);
}
