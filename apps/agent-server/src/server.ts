import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  AuditLog, SpaceError, SqlAgentRegistry, SqlApprovalStore, SqlAuditStore, SqlPolicyStore, SqlReplayCache, SqlRevocationList, SqlScopeStore, SqlSpaceStore, createGateway, parsePolicy, spaceState, verifyChain,
  type Policy, type Space, type SpaceInput, type Sql,
} from "@recast/agent-runtime";
import { createRelease, isCohort, type Capability, type Cohort } from "@recast/release";
import { instantiate, RecipeError, type Narrowing } from "@recast/agent-runtime";
import { loadCatalog } from "@recast/agent-runtime/src/recipes-cli";
import { ConfigVault, type ServerConfig } from "./config";

const JSON_H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const MAX_BODY = 256 * 1024;
const same = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class Bad extends Error { constructor(readonly status: number, readonly code: string, m: string) { super(m); } }

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > MAX_BODY) throw new Bad(413, "payload_too_large", `body is larger than ${MAX_BODY} bytes`); chunks.push(c as Buffer); }
  return Buffer.concat(chunks);
}
const send = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, JSON_H); res.end(JSON.stringify(body)); };

export function createRuntimeServer(config: ServerConfig, sql: Sql, now: () => number = Date.now): { server: Server; close: () => void } {
  const registry = new SqlAgentRegistry(sql), scopes = new SqlScopeStore(sql), approvals = new SqlApprovalStore(sql), store = new SqlAuditStore(sql), policies = new SqlPolicyStore(sql);
  const audit = new AuditLog(store, { privateJwk: config.signingKey.privateJwk, keyId: config.signingKey.keyId }, () => new Date(now()));
  // Policies are read per tenant and cached briefly so a call does not cost a query; a change made through this server applies at once.
  const cache = new Map<string, { at: number; p: Policy }>(); const TTL = 5000;
  const policyFor = async ({ tenantId }: { tenantId: string }) => { const c = cache.get(tenantId); if (c && now() - c.at < TTL) return c.p; const p = await policies.active(tenantId); cache.set(tenantId, { at: now(), p }); return p; };
  // Release states: a tenant's cohort is read from the database and cached briefly, like the policy.
  const release = createRelease(config.release); const cohorts = new Map<string, { at: number; c: Cohort }>();
  const cohortOf = async (tenantId: string): Promise<Cohort> => {
    const c = cohorts.get(tenantId); if (c && now() - c.at < TTL) return c.c;
    const { rows } = await sql.query<{ cohort: string }>(`select cohort from tenants where id = $1`, [tenantId]);
    const v = isCohort(rows[0]?.cohort) ? rows[0]!.cohort as Cohort : "public"; cohorts.set(tenantId, { at: now(), c: v }); return v;
  };
  const spaces = new SqlSpaceStore(sql);
  const revocations = new Map<string, SqlRevocationList>(); const revocationFor = (t: string) => revocations.get(t) ?? (revocations.set(t, new SqlRevocationList(sql, t)), revocations.get(t)!);

  const gateway = createGateway({
    audience: config.audience, registry, scopes, approvals, audit, getPolicy: policyFor, exchange: { mode: "vault", vault: new ConfigVault(config.vault) }, upstream: () => config.upstreamUrl,
    replay: new SqlReplayCache(sql), proof: config.proof, ...(config.publicUrl ? { publicUrl: config.publicUrl } : {}), now,
    release: { release, cohortOf }, ...(config.spaces === "required" ? { spaces } : {}),
    isTokenRevoked: async (jti) => { for (const r of revocations.values()) if (await r.isRevoked(jti)) return true; return false; },
  });

  const admin = async (req: IncomingMessage, url: URL): Promise<unknown> => {
    const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? ""); if (!m || !same(m[1]!, config.adminToken)) throw new Bad(401, "unauthorized", "admin token required");
    const tenant = url.searchParams.get("tenant");
    const json = async () => { try { return JSON.parse((await readBody(req)).toString() || "{}"); } catch (e) { if (e instanceof Bad) throw e; throw new Bad(400, "invalid_json", "body is not valid JSON"); } };
    const t = (v: unknown) => { if (typeof v !== "string" || !UUID.test(v)) throw new Bad(400, "invalid_request", "tenant must be a UUID"); return v; };

    if (req.method === "GET" && url.pathname === "/admin/approvals") return { approvals: await approvals.listPending(t(tenant), now()) };
    const decide = /^\/admin\/approvals\/(apr_[0-9a-f]{12})\/decide$/.exec(url.pathname);
    if (req.method === "POST" && decide) {
      const b = await json(); if (typeof b.approve !== "boolean" || typeof b.by !== "string" || !b.by) throw new Bad(400, "invalid_request", "approve (boolean) and by (string) are required");
      const a = await approvals.decide(decide[1]!, t(b.tenant), b.by, b.approve, now()); if (!a) throw new Bad(404, "not_found", "no pending approval with that id (it may have been decided or expired)"); return { approval: a };
    }
    if (req.method === "GET" && url.pathname === "/admin/agents") {
      const { rows } = await sql.query<any>(
        `select a.agent_key, a.name, a.created_at, a.revoked_at,
                coalesce(json_agg(json_build_object('id', s.id, 'tool', s.tool, 'action', s.action, 'calls', s.calls, 'maxCalls', s.max_calls, 'expiresAt', s.expires_at) order by s.expires_at) filter (where s.id is not null), '[]') as scopes
           from agents a left join agent_scopes s on s.agent_id = a.id and s.expires_at > now() where a.tenant_id = $1 group by a.id order by a.created_at`, [t(tenant)]);
      return { agents: rows.map((r) => ({ agentId: r.agent_key, name: r.name, createdAt: new Date(r.created_at).toISOString(), revoked: r.revoked_at !== null, scopes: r.scopes })) };
    }
    if (req.method === "GET" && url.pathname === "/admin/audit") {
      const entries = await store.list(t(tenant)); const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 1000);
      const verification = await verifyChain(entries, { [config.signingKey.keyId]: config.signingKey.publicJwk }, entries.at(-1)?.hash);
      return { verification, total: entries.length, entries: entries.slice(-limit) };
    }
    if (req.method === "POST" && url.pathname === "/admin/policy") {
      const b = await json(); if (typeof b.name !== "string" || typeof b.yaml !== "string") throw new Bad(400, "invalid_request", "name and yaml are required");
      try { parsePolicy(b.yaml); } catch (e) { throw new Bad(400, "invalid_policy", e instanceof Error ? e.message : String(e)); }
      const version = await policies.activate(t(b.tenant), b.name, b.yaml); cache.delete(b.tenant); return { version };
    }
    if (req.method === "POST" && url.pathname === "/admin/tokens/revoke") { const b = await json(); if (typeof b.jti !== "string") throw new Bad(400, "invalid_request", "jti is required"); await revocationFor(t(b.tenant)).revoke(b.jti); return { revoked: b.jti }; }
    if (req.method === "POST" && url.pathname === "/admin/agents") {
      const b = await json(); const jwk = b.publicKey as JsonWebKey; if (typeof b.agentId !== "string" || !/^agt_[0-9a-f]{12}$/.test(b.agentId) || typeof b.name !== "string" || !jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string" || "d" in jwk) throw new Bad(400, "invalid_request", "agentId (agt_ + 12 hex), name and an Ed25519 public JWK are required");
      await registry.register({ agentId: b.agentId, tenantId: t(b.tenant), name: b.name, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, ...(typeof b.ownerUserId === "string" && UUID.test(b.ownerUserId) ? { ownerUserId: b.ownerUserId } : {}) }); return { agentId: b.agentId };
    }
    if (req.method === "POST" && url.pathname === "/admin/agents/revoke") { const b = await json(); if (typeof b.agentId !== "string") throw new Bad(400, "invalid_request", "agentId is required"); await registry.revoke(b.agentId); return { revoked: b.agentId }; }
    if (req.method === "POST" && url.pathname === "/admin/scopes") {
      const b = await json(); const ttl = Number(b.ttlSeconds ?? 900), max = Number(b.maxCalls ?? 50);
      if (typeof b.agentId !== "string" || typeof b.tool !== "string" || typeof b.action !== "string" || !(ttl > 0 && ttl <= 7 * 86400) || !Number.isInteger(max) || max < 1) throw new Bad(400, "invalid_request", "agentId, tool, action, ttlSeconds (up to 7 days) and maxCalls are required");
      const g = await scopes.grant({ agentId: b.agentId, tenantId: t(b.tenant), tool: b.tool, action: b.action, maxCalls: max, expiresAt: new Date(now() + ttl * 1000).toISOString(), ...(b.constraints && typeof b.constraints === "object" ? { constraints: b.constraints } : {}) });
      return { scope: g };
    }
    // Spaces. The release gate applies here too: an operator token does not open a capability a tenant has not been given.
    const needs = async (tenantId: string, c: Capability) => { if (!release.allows(c, await cohortOf(tenantId))) throw new Bad(403, "not_available", "this capability is not available to this account"); };
    const view = (s: Space) => ({ ...s, state: spaceState(s, now()), remaining: { calls: Math.max(0, s.budget.maxCalls - s.calls), ...(s.budget.spend ? { spendMinor: Math.max(0, s.budget.spend.limitMinor - s.spentMinor) } : {}) } });
    if (req.method === "GET" && url.pathname === "/admin/spaces") {
      const tenantId = t(tenant); await needs(tenantId, "agent.spaces");
      return { spaces: (await spaces.list(tenantId, url.searchParams.get("agent") ?? undefined)).map(view) };
    }
    if (req.method === "POST" && url.pathname === "/admin/spaces") {
      const b = await json(); const tenantId = t(b.tenant); await needs(tenantId, "agent.spaces");
      if (typeof b.agentId !== "string" || typeof b.createdBy !== "string" || !b.createdBy) throw new Bad(400, "invalid_request", "agentId and createdBy are required");
      const input: SpaceInput = { tenantId, agentId: b.agentId, name: String(b.name ?? ""), ...(typeof b.purpose === "string" ? { purpose: b.purpose.slice(0, 500) } : {}), tools: b.tools, budget: b.budget, expiresAt: String(b.expiresAt ?? ""), createdBy: b.createdBy };
      try { return { space: view(await spaces.create(input, now())) }; } catch (e) { if (e instanceof SpaceError) throw new Bad(400, "invalid_space", e.message); throw e; }
    }
    const stop = /^\/admin\/spaces\/([0-9a-f-]{36})\/stop$/.exec(url.pathname);
    if (req.method === "POST" && stop) {
      // Stopping is never gated: whoever can see a Space must always be able to stop it.
      const b = await json(); if (typeof b.by !== "string" || !b.by) throw new Bad(400, "invalid_request", "by is required");
      if (!(await spaces.stop(stop[1]!, t(b.tenant), b.by, now()))) throw new Bad(404, "not_found", "no active Space with that id");
      return { space: view((await spaces.get(stop[1]!, b.tenant))!) };
    }
    // Recipes: only reviewed ones from the operator's catalog; applying one creates a Space and grants nothing.
    if (req.method === "GET" && url.pathname === "/admin/recipes") {
      const tenantId = t(tenant); await needs(tenantId, "agent.recipes");
      const cat = config.recipesDir ? await loadCatalog(config.recipesDir) : [];
      return { recipes: cat.map((c) => ({ id: c.recipe.id, version: c.recipe.version, title: c.recipe.title, description: c.recipe.description, reviewed: !!c.review, ...(c.review ? { reviewedBy: c.review.reviewedBy } : {}), tools: c.recipe.space.tools.map((x) => `${x.tool}.${x.action}`), policy: c.recipe.policy.length })) };
    }
    const apply = /^\/admin\/recipes\/([a-z][a-z0-9-]{1,63})\/apply$/.exec(url.pathname);
    if (req.method === "POST" && apply) {
      const b = await json(); const tenantId = t(b.tenant);
      await needs(tenantId, "agent.recipes"); await needs(tenantId, "agent.spaces");
      if (typeof b.agentId !== "string" || typeof b.createdBy !== "string" || !b.createdBy) throw new Bad(400, "invalid_request", "agentId and createdBy are required");
      const entry = (config.recipesDir ? await loadCatalog(config.recipesDir) : []).find((c) => c.recipe.id === apply[1]);
      if (!entry) throw new Bad(404, "not_found", "no such recipe");
      if (!entry.review) throw new Bad(409, "not_reviewed", "this recipe's current content has not been reviewed; it cannot be applied");
      // Never self-granting: every tool must already be scoped for this agent. The recipe does not add scopes.
      const missing: string[] = [];
      for (const x of entry.recipe.space.tools) if (!(await scopes.find(b.agentId, x.tool, x.action, now())).some((g) => g.tenantId === tenantId)) missing.push(`${x.tool}.${x.action}`);
      if (missing.length) throw new Bad(409, "needs_scopes", `grant these scopes first; a recipe never grants them: ${missing.join(", ")}`);
      try { const space = await spaces.create(instantiate(entry.recipe, { tenantId, agentId: b.agentId, createdBy: b.createdBy, nowMs: now(), ...(b.narrow ? { narrow: b.narrow as Narrowing } : {}) }), now()); return { space: view(space), recipe: { id: entry.recipe.id, version: entry.recipe.version, reviewedBy: entry.review.reviewedBy } }; }
      catch (e) { if (e instanceof RecipeError || e instanceof SpaceError) throw new Bad(400, "invalid_narrowing", e.message); throw e; }
    }
    throw new Bad(404, "not_found", "unknown admin endpoint");
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://runtime");
      if (url.pathname === "/healthz") { await sql.query("select 1"); return send(res, 200, { status: "ok" }); }
      if (url.pathname === "/mcp") {
        const body = req.method === "POST" ? await readBody(req) : undefined;
        const headers: Record<string, string> = {}; for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
        const r = await gateway.handle(new Request(`${config.publicUrl ?? `http://${req.headers.host ?? "runtime"}`}${url.pathname}`, { method: req.method ?? "GET", headers, ...(body ? { body: new Uint8Array(body) } : {}) }));
        const out: Record<string, string> = {}; r.headers.forEach((v, k) => { out[k] = v; });
        res.writeHead(r.status, out); res.end(Buffer.from(await r.arrayBuffer())); return;
      }
      if (url.pathname.startsWith("/admin/")) return send(res, 200, await admin(req, url));
      send(res, 404, { error: { code: "not_found", message: "unknown endpoint" } });
    } catch (e) {
      if (e instanceof Bad) return send(res, e.status, { error: { code: e.code, message: e.message } });
      send(res, 500, { error: { code: "internal_error", message: "something went wrong on our side" } });      // details stay in the server log
      console.error(e);
    }
  });
  return { server, close: () => server.close() };
}
