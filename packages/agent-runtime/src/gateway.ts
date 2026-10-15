import { AuditLog, type AuditInput } from "./audit";
import { requestHash, type ApprovalStore } from "./approvals";
import { AuthError } from "./errors";
import { exchangeToken, type CredentialVault } from "./exchange";
import type { AgentRegistry } from "./identity";
import { evaluate, type Policy } from "./policy";
import { checkConstraints, type ScopeStore } from "./scope";
import { MemoryReplayCache, verifyProof, type ReplayCache } from "./proof";
import { verifyAgentToken } from "./token";

export interface GatewayDeps {
  /** The audience agent tokens must be issued for: this gateway. */
  audience: string;
  registry: AgentRegistry; scopes: ScopeStore; audit: AuditLog; approvals: ApprovalStore;
  /** Read on every call, so a new policy takes effect without a restart. */
  getPolicy: (ctx: { tenantId: string; agentId: string }) => Policy | Promise<Policy>;
  exchange: { mode: "vault" | "runtime-jwt"; vault?: CredentialVault; runtime?: { privateJwk: JsonWebKey; issuer: string } };
  /** Where a tool's real MCP server lives. "*" is the default for methods that name no tool. */
  upstream: (tool: string) => string | null;
  forward?: typeof fetch;
  deriveFacts?: (call: { tool: string; action: string; params: Record<string, unknown> }) => Record<string, unknown>;
  isTokenRevoked?: (jti: string) => boolean | Promise<boolean>;
  now?: () => number; maxBodyBytes?: number;
  /** Per-request proof of possession (DPoP style). "required" refuses a bearer token on its own; "optional" checks the proof only if sent; "off" ignores it. */
  proof?: "off" | "optional" | "required"; replay?: ReplayCache;
  /** The URL clients call, when the gateway sits behind a proxy and req.url is not what they signed. */
  publicUrl?: string;
}

const PASS_THROUGH = new Set(["initialize", "ping", "tools/list"]);
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const rpcError = (status: number, id: unknown, code: number, message: string, data?: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } }), { status, headers: { ...JSON_HEADERS, ...headers } });
const rid = () => `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

/** "google_calendar.create_event" -> tool "google_calendar", action "create_event". A bare name is the tool with action "call". */
export function parseToolName(name: string): { tool: string; action: string } {
  const i = name.indexOf("."); return i < 0 ? { tool: name, action: "call" } : { tool: name.slice(0, i), action: name.slice(i + 1) };
}

export function createGateway(d: GatewayDeps) {
  let replay: ReplayCache | undefined;
  const now = d.now ?? Date.now; const doFetch = d.forward ?? fetch; const maxBody = d.maxBodyBytes ?? 256 * 1024;

  async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return new Response(JSON.stringify({ error: { code: "method_not_allowed", message: "MCP requests are POSTed" } }), { status: 405, headers: { ...JSON_HEADERS, allow: "POST" } });

    // 1. Who is calling? Nothing is parsed, logged or forwarded before this succeeds.
    const m = /^Bearer\s+(\S+)$/.exec(req.headers.get("authorization") ?? "");
    if (!m) return new Response(JSON.stringify({ error: { code: "unauthorized", message: "send Authorization: Bearer <agent token>" } }), { status: 401, headers: { ...JSON_HEADERS, "www-authenticate": "Bearer" } });
    let who;
    try { who = await verifyAgentToken(m[1]!, { registry: d.registry, audience: d.audience, now: now(), ...(d.isTokenRevoked ? { isRevoked: d.isTokenRevoked } : {}) }); }
    catch (e) {
      if (e instanceof AuthError) return new Response(JSON.stringify({ error: { code: e.code, message: e.message } }), { status: 401, headers: { ...JSON_HEADERS, "www-authenticate": `Bearer error="invalid_token"` } });
      throw e;
    }
    const { agent } = who;
    const mode = d.proof ?? "optional"; const proof = req.headers.get("dpop");
    if (mode === "required" && !proof) return new Response(JSON.stringify({ error: { code: "proof_required", message: "send a DPoP proof signed by the agent's key" } }), { status: 401, headers: { ...JSON_HEADERS, "www-authenticate": `DPoP error="use_dpop_proof"` } });
    if (mode !== "off" && proof) {
      try { await verifyProof(proof, { agent, method: req.method, url: d.publicUrl ?? req.url, accessToken: m[1]!, replay: (replay ??= d.replay ?? new MemoryReplayCache()), now: now() }); }
      catch (e) { if (e instanceof AuthError) return new Response(JSON.stringify({ error: { code: e.code, message: `proof rejected: ${e.message}` } }), { status: 401, headers: { ...JSON_HEADERS, "www-authenticate": `DPoP error="invalid_dpop_proof"` } }); throw e; }
    }
    const requestId = rid(); const sessionId = req.headers.get("mcp-session-id") ?? undefined;
    const base = { tenantId: agent.tenantId, agentId: agent.agentId, requestId, ...(agent.ownerUserId ? { userId: agent.ownerUserId } : {}), ...(sessionId ? { sessionId } : {}), delegationChain: [...(agent.ownerUserId ? [agent.ownerUserId] : []), agent.agentId] };
    const log = (e: Pick<AuditInput, "tool" | "action" | "params" | "result"> & Partial<AuditInput>) => d.audit.append({ ...base, ...e });

    // 2. What is being asked?
    const text = await req.text();
    if (new TextEncoder().encode(text).length > maxBody) return rpcError(413, null, -32600, `request is larger than ${maxBody} bytes`);
    let rpc: any; try { rpc = JSON.parse(text); } catch { return rpcError(400, null, -32700, "parse error"); }
    if (!rpc || typeof rpc !== "object" || Array.isArray(rpc) || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") return rpcError(400, rpc?.id, -32600, "expected a single JSON-RPC 2.0 request (batches are not supported)");
    const method: string = rpc.method;

    const passThrough = PASS_THROUGH.has(method) || method.startsWith("notifications/");
    if (!passThrough && method !== "tools/call") {
      try { await log({ tool: "*", action: method, params: {}, result: "denied", reason: "method is not supported by the gateway" }); } catch { return rpcError(503, rpc.id, -32000, "audit log unavailable; refusing to act"); }
      return rpcError(200, rpc.id, -32601, `method '${method}' is not available through the gateway`, undefined, { "x-recast-decision": "denied" });
    }

    // Methods that call nothing: forward without policy, still authenticated.
    if (passThrough) {
      const url = d.upstream("*"); if (!url) return rpcError(404, rpc.id, -32601, "no upstream configured");
      // The upstream usually wants a credential even to initialise or list tools. It is the one stored for tool "*" (if any).
      const cred = await exchangeToken({ tenantId: agent.tenantId, agentId: agent.agentId, tool: "*", action: method, ...d.exchange, now: now() });
      const res = await relay(doFetch, url, req, text, cred ? `${cred.tokenType} ${cred.accessToken}` : null);
      return method === "tools/list" ? filterToolList(res, async (name) => { const t = parseToolName(name); return (await d.scopes.find(agent.agentId, t.tool, t.action, now())).length > 0; }) : res;
    }

    // 3. Is this agent allowed, in this tool, doing this action, with these parameters?
    const nameArg = rpc.params?.name; const params = rpc.params?.arguments && typeof rpc.params.arguments === "object" && !Array.isArray(rpc.params.arguments) ? rpc.params.arguments as Record<string, unknown> : {};
    if (typeof nameArg !== "string" || !nameArg) return rpcError(400, rpc.id, -32602, "tools/call needs params.name");
    const { tool, action } = parseToolName(nameArg);
    // A refusal is an application-level answer, so it travels as a JSON-RPC error over HTTP 200: that is what real MCP clients
    // turn into a typed error with its data. (A 403 would surface as a transport failure.) Observers read x-recast-decision.
    const deny = async (_status: number, why: string, data?: unknown) => {
      try { await log({ tool, action, params, result: "denied", reason: why }); } catch { return rpcError(503, rpc.id, -32000, "audit log unavailable; refusing to act"); }
      return rpcError(200, rpc.id, -32003, why, data, { "x-recast-request-id": requestId, "x-recast-decision": "denied" });
    };

    const grants = await d.scopes.find(agent.agentId, tool, action, now());
    if (!grants.length) return deny(403, `agent has no live scope for ${tool}.${action}`);
    const fits = grants.map((g) => ({ g, problem: checkConstraints(g.constraints, params) })); const grant = fits.find((f) => !f.problem)?.g;
    if (!grant) return deny(403, `scope constraint failed: ${fits[0]!.problem}`);

    const facts = { ...params, ...(d.deriveFacts?.({ tool, action, params }) ?? {}), tool, action };
    const verdict = evaluate(await d.getPolicy({ tenantId: agent.tenantId, agentId: agent.agentId }), { agentId: agent.agentId, tool, action }, facts);
    if (verdict.decision === "deny") return deny(403, `policy: ${verdict.reason}`);

    let humanApproved = false;
    if (verdict.decision === "require_approval") {
      const hash = await requestHash(agent.tenantId, agent.agentId, tool, action, params);
      const presented = req.headers.get("x-approval-id");
      if (presented && (await d.approvals.redeem(presented, agent.tenantId, hash, now()))) humanApproved = true;
      else {
        const a = await d.approvals.request({ tenantId: agent.tenantId, agentId: agent.agentId, tool, action, requestHash: hash }, now());
        try { await log({ tool, action, params, result: "pending_approval", reason: verdict.reason }); } catch { return rpcError(503, rpc.id, -32000, "audit log unavailable; refusing to act"); }
        // Not 202: in MCP, 202 means "accepted, no response", and a client would wait forever for an answer.
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32004, message: "a person must approve this first", data: { status: "pending_approval", approval_id: a.id } } }), { status: 200, headers: { ...JSON_HEADERS, "x-recast-request-id": requestId, "x-recast-decision": "pending_approval" } });
      }
    }

    // 4. Spend one call from the scope, record the decision (fail closed if we cannot), then act.
    if (!(await d.scopes.consume(grant.id, now()))) return deny(429, "scope has no calls left");
    try { await log({ tool, action, params, result: "allowed", reason: verdict.reason, humanApproved }); } catch { return rpcError(503, rpc.id, -32000, "audit log unavailable; refusing to act"); }

    const url = d.upstream(tool); const cred = url ? await exchangeToken({ tenantId: agent.tenantId, agentId: agent.agentId, tool, action, ...d.exchange, now: now() }) : null;
    if (!url || !cred) {
      await log({ tool, action, params, result: "failure", reason: !url ? "no upstream for this tool" : "no credential for this tool", humanApproved }).catch(() => undefined);
      return rpcError(502, rpc.id, -32000, !url ? `no upstream is configured for '${tool}'` : `no credential is configured for '${tool}'`, undefined, { "x-recast-request-id": requestId });
    }

    // 5. Forward with the exchanged credential. The agent's own token is never sent upstream.
    let res: Response;
    try { res = await relay(doFetch, url, req, text, `${cred.tokenType} ${cred.accessToken}`); }
    catch (e) { await log({ tool, action, params, result: "failure", reason: "upstream unreachable", humanApproved }).catch(() => undefined); return rpcError(502, rpc.id, -32000, "upstream unreachable", undefined, { "x-recast-request-id": requestId }); }
    let ok = res.ok;
    if (ok && /json/.test(res.headers.get("content-type") ?? "")) { try { ok = !(JSON.parse(await res.clone().text())?.error); } catch { /* not JSON-RPC: trust the status */ } }
    let auditHeader: Record<string, string> = {};
    try { await log({ tool, action, params, result: ok ? "success" : "failure", humanApproved }); } catch { auditHeader = { "x-recast-audit": "failed" }; }
    const h = new Headers(res.headers); h.set("x-recast-request-id", requestId); for (const [k, v] of Object.entries(auditHeader)) h.set(k, v);
    return new Response(res.body, { status: res.status, headers: h });
  }
  return { handle };
}

/** Only content headers cross the gateway; the agent's Authorization never goes upstream and upstream cookies never come back. */
async function relay(f: typeof fetch, url: string, req: Request, body: string, authorization: string | null): Promise<Response> {
  const h: Record<string, string> = { "content-type": "application/json", accept: req.headers.get("accept") ?? "application/json, text/event-stream" };
  const sid = req.headers.get("mcp-session-id"); if (sid) h["mcp-session-id"] = sid;
  const pv = req.headers.get("mcp-protocol-version"); if (pv) h["mcp-protocol-version"] = pv;
  if (authorization) h.authorization = authorization;
  const r = await f(url, { method: "POST", headers: h, body });
  const out = new Headers(r.headers); out.delete("set-cookie"); out.delete("set-cookie2");
  return new Response(r.body, { status: r.status, headers: out });
}

/** An agent only learns about tools it holds a live scope for. Handles a JSON answer or a single-event SSE answer. */
async function filterToolList(res: Response, allowed: (name: string) => Promise<boolean>): Promise<Response> {
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !/json|event-stream/.test(type)) return res;
  const text = await res.text();
  const keep = async (msg: any) => { if (msg?.result?.tools && Array.isArray(msg.result.tools)) { const out = []; for (const t of msg.result.tools) if (typeof t?.name === "string" && (await allowed(t.name))) out.push(t); msg.result.tools = out; } return msg; };
  let body: string;
  if (/json/.test(type)) { try { body = JSON.stringify(await keep(JSON.parse(text))); } catch { return new Response(text, { status: res.status, headers: res.headers }); } }
  else body = (await Promise.all(text.split("\n").map(async (line) => { if (!line.startsWith("data:")) return line; try { return "data: " + JSON.stringify(await keep(JSON.parse(line.slice(5)))); } catch { return line; } }))).join("\n");
  const h = new Headers(res.headers); h.delete("content-length");
  return new Response(body, { status: res.status, headers: h });
}
