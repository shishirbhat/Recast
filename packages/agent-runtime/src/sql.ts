import { GENESIS, type AuditEntry, type AuditStore } from "./audit";
import type { Approval, ApprovalStore } from "./approvals";
import type { AgentRecord, AgentRegistry } from "./identity";
import { parsePolicy, type Policy } from "./policy";
import type { Constraint, ScopeGrant, ScopeStore } from "./scope";
import { SpaceError, validateSpace, type ReserveResult, type Space, type SpaceInput, type SpaceStore } from "./space";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One Postgres connection (PGlite or node-postgres fit). These run as the service role: they are the gateway's own stores. */
export interface Sql { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }> }
const iso = (v: unknown) => (v instanceof Date ? v : new Date(String(v))).toISOString();

export class SqlAgentRegistry implements AgentRegistry {
  constructor(private sql: Sql) {}
  async get(agentId: string): Promise<AgentRecord | null> {
    const { rows } = await this.sql.query<{ agent_key: string; tenant_id: string; name: string; public_key: JsonWebKey; owner_user_id: string | null; revoked_at: unknown }>(`select * from agents where agent_key = $1`, [agentId]);
    const r = rows[0]; if (!r) return null;
    return { agentId: r.agent_key, tenantId: r.tenant_id, name: r.name, publicJwk: r.public_key, ...(r.owner_user_id ? { ownerUserId: r.owner_user_id } : {}), ...(r.revoked_at ? { revokedAt: iso(r.revoked_at) } : {}) };
  }
  async register(rec: AgentRecord) {
    await this.sql.query(`insert into agents(tenant_id, agent_key, name, public_key, owner_user_id) values ($1,$2,$3,$4,$5)`, [rec.tenantId, rec.agentId, rec.name, JSON.stringify(rec.publicJwk), rec.ownerUserId ?? null]);
  }
  async revoke(agentId: string) { await this.sql.query(`update agents set revoked_at = now() where agent_key = $1 and revoked_at is null`, [agentId]); }
}

export class SqlScopeStore implements ScopeStore {
  constructor(private sql: Sql) {}
  private map(r: { id: string; agent_key: string; tenant_id: string; tool: string; action: string; constraints: Record<string, Constraint> | null; issued_at: unknown; expires_at: unknown; max_calls: number; calls: number }): ScopeGrant {
    return { id: r.id, agentId: r.agent_key, tenantId: r.tenant_id, tool: r.tool, action: r.action, ...(r.constraints ? { constraints: r.constraints } : {}), issuedAt: iso(r.issued_at), expiresAt: iso(r.expires_at), maxCalls: r.max_calls, calls: r.calls };
  }
  async grant(g: Omit<ScopeGrant, "id" | "calls" | "issuedAt"> & { id?: string; issuedAt?: string }) {
    const { rows } = await this.sql.query<any>(
      `with ins as (insert into agent_scopes(tenant_id, agent_id, tool, action, constraints, max_calls, expires_at)
         select $1, a.id, $3, $4, $5, $6, $7 from agents a where a.agent_key = $2 and a.tenant_id = $1 returning *)
       select ins.*, $2 as agent_key from ins`, [g.tenantId, g.agentId, g.tool, g.action, g.constraints ? JSON.stringify(g.constraints) : null, g.maxCalls, g.expiresAt]);
    if (!rows[0]) throw new Error(`no agent ${g.agentId} in this tenant`);
    return this.map(rows[0]);
  }
  async find(agentId: string, tool: string, action: string, nowMs: number) {
    const { rows } = await this.sql.query<any>(
      `select s.*, a.agent_key from agent_scopes s join agents a on a.id = s.agent_id
        where a.agent_key = $1 and s.tool = $2 and s.action = $3 and s.expires_at > $4::timestamptz and s.calls < s.max_calls order by s.expires_at, s.id`, [agentId, tool, action, new Date(nowMs).toISOString()]);
    return rows.map((r) => this.map(r));
  }
  async consume(grantId: string, nowMs: number) {
    const { rows } = await this.sql.query<{ consume_scope: boolean }>(`select consume_scope($1::uuid, $2::timestamptz)`, [grantId, new Date(nowMs).toISOString()]);
    return rows[0]!.consume_scope === true;
  }
}

/** The signed body is stored whole (column `entry`) so verification re-hashes exactly what was signed; the other columns exist for querying. */
export class SqlAuditStore implements AuditStore {
  constructor(private sql: Sql) {}
  async last(tenantId: string) {
    const { rows } = await this.sql.query<{ entry: AuditEntry }>(`select entry from agent_audit_log where tenant_id = $1 order by seq desc limit 1`, [tenantId]);
    return rows[0]?.entry ?? null;
  }
  async append(e: AuditEntry) {
    try {
      await this.sql.query(
        `insert into agent_audit_log(tenant_id, seq, agent_id, user_id, session_id, request_id, tool, action, params, result, reason, human_approved, delegation_chain, key_id, prev_hash, hash, signature, at, entry)
         values ($1,$2,(select id from agents where agent_key = $3 and tenant_id = $1),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [e.tenantId, e.seq, e.agentId, e.userId ?? null, e.sessionId ?? null, e.requestId, e.tool, e.action, JSON.stringify(e.params ?? null), e.result, e.reason ?? null, e.humanApproved ?? false, JSON.stringify(e.delegationChain ?? null), e.keyId, e.prevHash, e.hash, e.signature, e.at, JSON.stringify(e)]);
    } catch (err) {
      if (/duplicate key|unique/i.test(String(err))) throw new Error("audit chain conflict");   // another writer took this position
      throw err;
    }
  }
  async list(tenantId: string) {
    const { rows } = await this.sql.query<{ entry: AuditEntry }>(`select entry from agent_audit_log where tenant_id = $1 order by seq`, [tenantId]);
    return rows.map((r) => r.entry);
  }
}
void GENESIS;

export class SqlApprovalStore implements ApprovalStore {
  constructor(private sql: Sql, private ttlMs = 15 * 60_000) {}
  private map(r: any): Approval { return { id: r.id, tenantId: r.tenant_id, agentId: r.agent_key, tool: r.tool, action: r.action, requestHash: r.request_hash, status: r.status, createdAt: Number(r.created_ms), ...(r.decided_by ? { decidedBy: r.decided_by } : {}) }; }
  async request(a: Omit<Approval, "id" | "status" | "createdAt">, now: number) {
    const existing = await this.sql.query<any>(`select p.*, g.agent_key from agent_approvals p join agents g on g.id = p.agent_id where p.tenant_id = $1 and p.request_hash = $2 and p.status = 'pending' and p.created_ms > $3 limit 1`, [a.tenantId, a.requestHash, now - this.ttlMs]);
    if (existing.rows[0]) return this.map(existing.rows[0]);
    const id = `apr_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const { rows } = await this.sql.query<any>(`with ins as (insert into agent_approvals(id, tenant_id, agent_id, tool, action, request_hash, created_ms) select $1, $2, g.id, $4, $5, $6, $7 from agents g where g.agent_key = $3 and g.tenant_id = $2 returning *) select ins.*, $3 as agent_key from ins`, [id, a.tenantId, a.agentId, a.tool, a.action, a.requestHash, now]);
    return this.map(rows[0]);
  }
  async decide(id: string, tenantId: string, by: string, approve: boolean, now: number) {
    const { rows } = await this.sql.query<any>(`with u as (update agent_approvals set status = $4, decided_by = $3 where id = $1 and tenant_id = $2 and status = 'pending' and created_ms > $5 returning *) select u.*, (select agent_key from agents where id = u.agent_id) as agent_key from u`, [id, tenantId, by, approve ? "approved" : "rejected", now - this.ttlMs]);
    return rows[0] ? this.map(rows[0]) : null;
  }
  /** One statement: only one caller can flip approved to used. */
  async redeem(id: string, tenantId: string, hash: string, now: number) {
    const { rows } = await this.sql.query(`update agent_approvals set status = 'used' where id = $1 and tenant_id = $2 and request_hash = $3 and status = 'approved' and created_ms > $4 returning id`, [id, tenantId, hash, now - this.ttlMs]);
    return rows.length === 1;
  }
  /** What a person still has to decide, oldest first. */
  async listPending(tenantId: string, now: number): Promise<Approval[]> {
    const { rows } = await this.sql.query<any>(`select p.*, g.agent_key from agent_approvals p join agents g on g.id = p.agent_id where p.tenant_id = $1 and p.status = 'pending' and p.created_ms > $2 order by p.created_ms`, [tenantId, now - this.ttlMs]);
    return rows.map((r) => this.map(r));
  }
  async get(id: string) {
    const { rows } = await this.sql.query<any>(`select p.*, g.agent_key from agent_approvals p join agents g on g.id = p.agent_id where p.id = $1`, [id]);
    return rows[0] ? this.map(rows[0]) : null;
  }
}

/** A revoked token id is refused from then on. Pass `isRevoked` to the gateway. */
export class SqlRevocationList {
  constructor(private sql: Sql, private tenantId: string) {}
  async revoke(jti: string) { await this.sql.query(`insert into agent_revoked_tokens(jti, tenant_id) values ($1,$2) on conflict do nothing`, [jti, this.tenantId]); }
  isRevoked = async (jti: string) => (await this.sql.query(`select 1 from agent_revoked_tokens where tenant_id = $1 and jti = $2`, [this.tenantId, jti])).rows.length > 0;
}

export class SqlPolicyStore {
  constructor(private sql: Sql) {}
  /** The tenant's active policy, or the default-deny policy if none was ever set. */
  async active(tenantId: string): Promise<Policy> {
    const { rows } = await this.sql.query<{ rule_yaml: string }>(`select rule_yaml from agent_policies where tenant_id = $1 and active`, [tenantId]);
    return rows[0] ? parsePolicy(rows[0].rule_yaml) : { rules: [], default: "deny" };
  }
  /** Validates the text first, so a bad policy never becomes the active one. Returns the new version. */
  async activate(tenantId: string, name: string, yaml: string): Promise<number> {
    parsePolicy(yaml);
    const { rows } = await this.sql.query<{ activate_policy: number }>(`select activate_policy($1::uuid, $2, $3)`, [tenantId, name, yaml]);
    return rows[0]!.activate_policy;
  }
}

/** Replay protection shared across gateway instances: the insert either succeeds (first use) or hits the primary key (replay). */
export class SqlReplayCache {
  constructor(private sql: Sql, private windowMs = 120_000) {}
  async firstUse(tenantId: string, jti: string, nowMs: number): Promise<boolean> {
    await this.sql.query(`delete from agent_dpop_seen where tenant_id = $1 and seen_ms < $2`, [tenantId, nowMs - this.windowMs]);
    const { rows } = await this.sql.query(`insert into agent_dpop_seen(tenant_id, jti, seen_ms) values ($1,$2,$3) on conflict do nothing returning jti`, [tenantId, jti, nowMs]);
    return rows.length === 1;
  }
}

export class SqlSpaceStore implements SpaceStore {
  constructor(private sql: Sql) {}
  private map(r: any): Space {
    return {
      id: r.id, tenantId: r.tenant_id, agentId: r.agent_key, name: r.name, ...(r.purpose ? { purpose: r.purpose } : {}), tools: r.tools,
      budget: { maxCalls: r.max_calls, ...(r.spend_currency ? { spend: { currency: r.spend_currency, limitMinor: Number(r.spend_limit_minor) } } : {}) },
      expiresAt: iso(r.expires_at), status: r.status, calls: r.calls, spentMinor: Number(r.spent_minor), createdAt: iso(r.created_at),
      ...(r.created_by ? { createdBy: r.created_by } : {}), ...(r.stopped_at ? { stoppedAt: iso(r.stopped_at), stoppedBy: r.stopped_by } : {}),
    };
  }
  async create(s: SpaceInput, nowMs: number) {
    validateSpace(s, nowMs);
    const { rows } = await this.sql.query<any>(
      `with ins as (insert into agent_spaces(tenant_id, agent_id, name, purpose, tools, max_calls, spend_currency, spend_limit_minor, expires_at, created_at, created_by)
         select $1, a.id, $3, $4, $5, $6, $7, $8, $9, $10, $11 from agents a where a.agent_key = $2 and a.tenant_id = $1 returning *)
       select ins.*, $2 as agent_key from ins`,
      [s.tenantId, s.agentId, s.name, s.purpose ?? null, JSON.stringify(s.tools), s.budget.maxCalls, s.budget.spend?.currency ?? null, s.budget.spend?.limitMinor ?? null, s.expiresAt, new Date(nowMs).toISOString(), s.createdBy ?? null]);
    if (!rows[0]) throw new SpaceError(`no agent ${s.agentId} in this tenant`);
    return this.map(rows[0]);
  }
  async get(id: string, tenantId: string) {
    if (!UUID.test(id)) return null;
    const { rows } = await this.sql.query<any>(`select s.*, a.agent_key from agent_spaces s join agents a on a.id = s.agent_id where s.id = $1 and s.tenant_id = $2`, [id, tenantId]);
    return rows[0] ? this.map(rows[0]) : null;
  }
  async list(tenantId: string, agentId?: string) {
    const { rows } = await this.sql.query<any>(`select s.*, a.agent_key from agent_spaces s join agents a on a.id = s.agent_id where s.tenant_id = $1 and ($2::text is null or a.agent_key = $2) order by s.created_at, s.id`, [tenantId, agentId ?? null]);
    return rows.map((r) => this.map(r));
  }
  async reserve(id: string, cost: number, nowMs: number): Promise<ReserveResult> {
    if (!UUID.test(id)) return "not_found";
    const { rows } = await this.sql.query<{ reserve_space: ReserveResult }>(`select reserve_space($1::uuid, $2::bigint, $3::timestamptz)`, [id, cost, new Date(nowMs).toISOString()]);
    return rows[0]!.reserve_space;
  }
  async refund(id: string, take: { calls: number; cost: number }) {
    await this.sql.query(`update agent_spaces set calls = greatest(0, calls - $2), spent_minor = greatest(0, spent_minor - $3) where id = $1`, [id, take.calls, take.cost]);
  }
  async stop(id: string, tenantId: string, by: string, nowMs: number) {
    if (!UUID.test(id)) return false;
    const { rows } = await this.sql.query(`update agent_spaces set status = 'stopped', stopped_at = $3, stopped_by = $4 where id = $1 and tenant_id = $2 and status = 'active' returning id`, [id, tenantId, new Date(nowMs).toISOString(), by]);
    return rows.length > 0;
  }
}
