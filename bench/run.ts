// Performance measurements for docs/PERFORMANCE.md. Local only: one machine, loopback HTTP, PGlite in-process for Postgres.
// Run: npx tsx bench/run.ts   (prints a JSON report; numbers are milliseconds)
import { createServer, type Server } from "node:http";
import { freshDb } from "@recast/store/testing";
import { createResolver } from "@recast/resolve";
import { MemoryKeyStore, MemoryPlacementStore, MemoryCredentialStore, SqlKeyStore, SqlUsageStore, SqlRateLimiter, SqlIdempotencyStore, createApi, hashKey } from "@recast/api-core";
import {
  AuditLog, MemoryAgentRegistry, MemoryApprovalStore, MemoryAuditStore, MemoryScopeStore, MemorySpaceStore, MemoryVault, SqlAgentRegistry, SqlAuditStore, SqlScopeStore, SqlApprovalStore, SqlSpaceStore,
  createAgentIdentity, createGateway, createProof, generateKeyPair, parsePolicy, signToken, type AuditStore, type ScopeStore, type SpaceStore,
} from "@recast/agent-runtime";

const N = Number(process.env.BENCH_N ?? 300);
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!.toFixed(2); };
const stats = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99) });
async function time(n: number, f: (i: number) => Promise<unknown>) { for (let i = 0; i < 20; i++) await f(-1 - i); const out: number[] = []; for (let i = 0; i < n; i++) { const t = performance.now(); await f(i); out.push(performance.now() - t); } return out; }
const listen = (s: Server) => new Promise<string>((ok) => s.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(s.address() as { port: number }).port}`)));

async function gateway(kind: "memory" | "postgres") {
  const upstream = createServer((q, r) => { q.resume(); q.on("end", () => { r.writeHead(200, { "content-type": "application/json" }); r.end('{"jsonrpc":"2.0","id":1,"result":{"content":[]}}'); }); });
  const up = await listen(upstream) + "/mcp";
  const agent = await createAgentIdentity("bench", "acme"); const signer = await generateKeyPair();
  let tenant = "t1"; let registry: any, scopes: ScopeStore, store: AuditStore, approvals: any, spaces: SpaceStore;
  if (kind === "postgres") {
    const db = await freshDb(); tenant = (await db.query<{ id: string }>(`insert into tenants(name, cohort) values ('B','internal') returning id`)).rows[0]!.id;
    registry = new SqlAgentRegistry(db); await registry.register({ agentId: agent.agentId, tenantId: tenant, name: "bench", publicJwk: agent.publicJwk });
    scopes = new SqlScopeStore(db); store = new SqlAuditStore(db); approvals = new SqlApprovalStore(db); spaces = new SqlSpaceStore(db);
  } else {
    registry = new MemoryAgentRegistry(); await registry.register({ agentId: agent.agentId, tenantId: tenant, name: "bench", publicJwk: agent.publicJwk });
    scopes = new MemoryScopeStore(); store = new MemoryAuditStore(); approvals = new MemoryApprovalStore(); spaces = new MemorySpaceStore();
  }
  const vault = new MemoryVault(); vault.set(tenant, "notes", "T");
  await scopes.grant({ agentId: agent.agentId, tenantId: tenant, tool: "notes", action: "append", maxCalls: 100_000, expiresAt: new Date(Date.now() + 86400_000).toISOString() });
  await spaces.create({ tenantId: tenant, agentId: agent.agentId, name: "b", tools: [{ tool: "notes", action: "append" }], budget: { maxCalls: 100_000 }, expiresAt: new Date(Date.now() + 86400_000).toISOString() }, Date.now());
  const policy = parsePolicy("rules:\n  - { tool: notes, then: allow }\n");
  const gw = createGateway({ audience: "gw", registry, scopes, approvals, audit: new AuditLog(store, { privateJwk: signer.privateJwk, keyId: "k" }), getPolicy: () => policy, exchange: { mode: "vault", vault }, upstream: () => up, proof: "required", spaces });
  const token = await signToken(agent.privateJwk, { iss: agent.agentId, sub: agent.agentId, aud: "gw", ttlSec: 900 });
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "notes.append", arguments: { text: "x" } } });
  const direct = await time(N, () => fetch(up, { method: "POST", headers: { "content-type": "application/json" }, body }).then((r) => r.text()));
  const through = await time(N, async () => {
    const proof = await createProof(agent.privateJwk, { agentId: agent.agentId, method: "POST", url: "http://gw/mcp", accessToken: token });
    const r = await gw.handle(new Request("http://gw/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, dpop: proof }, body }));
    if (r.status !== 200) throw new Error(`gateway ${r.status}`); await r.text();
  });
  upstream.close();
  return { direct_upstream: stats(direct), through_gateway: stats(through), overhead_p50: +(pct(through, 50) - pct(direct, 50)).toFixed(2), overhead_p95: +(pct(through, 95) - pct(direct, 95)).toFixed(2) };
}

async function api(kind: "memory" | "postgres") {
  const KEY = "sk_test_bench_000001"; let deps: any;
  if (kind === "postgres") {
    const db = await freshDb(); const t = (await db.query<{ id: string }>(`insert into tenants(name, tier, cohort) values ('B','enterprise','internal') returning id`)).rows[0]!.id;
    const keys = new SqlKeyStore(db); await keys.add(t, await hashKey(KEY));
    deps = { keys, usage: new SqlUsageStore(db), limiter: new SqlRateLimiter(db), idempotency: new SqlIdempotencyStore(db) };
  } else { const keys = new MemoryKeyStore(); await keys.add(KEY, { tenantId: "t", tier: "enterprise", cohort: "internal" }); deps = { keys }; }
  const core = createApi({ resolver: createResolver(), ...deps });
  const server = createServer(async (q, r) => { const c: Buffer[] = []; for await (const x of q) c.push(x as Buffer); const res = await core.handle(new Request("http://x" + q.url, { method: q.method, headers: q.headers as Record<string, string>, ...(c.length ? { body: Buffer.concat(c) } : {}) })); r.writeHead(res.status, Object.fromEntries(res.headers)); r.end(Buffer.from(await res.arrayBuffer())); });
  const base = await listen(server);
  const post = (i: number) => fetch(base + "/v1/resolve", { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...(i % 2 ? { "idempotency-key": `k${i}` } : {}) }, body: JSON.stringify({ input: { raw: `Meera Iyer ${i}, meera${i}@x.com` }, target: { destination: "gmail" } }) }).then((r) => { if (r.status !== 200) throw new Error(`api ${r.status}`); return r.text(); });
  const resolveHttp = await time(N, post);
  const resolver = createResolver(); const rulesOnly = await time(N, (i) => resolver.resolve({ raw: `Meera Iyer ${i}, meera${i}@x.com`, target: { destination: "gmail" } }));
  server.close();
  return { resolve_engine_only: stats(rulesOnly), resolve_over_http: stats(resolveHttp) };
}

async function placement() {
  const google = createServer((q, r) => { q.resume(); q.on("end", () => { r.writeHead(200, { "content-type": "application/json" }); r.end(JSON.stringify({ id: "draft-1" })); }); });
  const g = await listen(google); const KEY = "sk_test_bench_place01";
  const keys = new MemoryKeyStore(); await keys.add(KEY, { tenantId: "t", tier: "enterprise", cohort: "internal" });
  const credentials = new MemoryCredentialStore(); await credentials.set("t", "gmail", { accessToken: "x" });
  const core = createApi({ resolver: createResolver(), keys, placement: { credentials, placements: new MemoryPlacementStore(), fetch: (u, i) => fetch(g + new URL(String(u)).pathname, i) } });
  const xs = await time(Math.min(N, 200), async (i) => {
    const r = await core.handle(new Request("http://x/v1/place", { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: JSON.stringify({ input: { raw: `Meera Iyer, meera${i}@x.com` }, target: { destination: "gmail" }, consent: { kind: "confirm" } }) }));
    if (r.status !== 201) throw new Error(`place ${r.status} ${await r.text()}`);
  });
  google.close();
  return { place_gmail_draft_fake_google: stats(xs) };
}

const report = { when: new Date().toISOString(), node: process.version, n: N, gateway_memory: await gateway("memory"), gateway_postgres_pglite: await gateway("postgres"), api_memory: await api("memory"), api_postgres_pglite: await api("postgres"), ...(await placement()) };
console.log(JSON.stringify(report, null, 2));
