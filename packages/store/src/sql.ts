import type { AuditEvent, Export, Grant, Integration, Repository, Reliability, StoredObject, StoredRelationship } from "./types";

/** The one thing we need from a Postgres client. PGlite and node-postgres both fit. */
export interface Sql { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }> }

const iso = (v: unknown) => (v instanceof Date ? v : new Date(String(v))).toISOString();

/** Postgres implementation. RLS (supabase/migrations) decides whose rows these are; this code never filters by owner. */
export class SqlRepository implements Repository {
  constructor(private sql: Sql) {}
  private audit(action: string, subject?: string, detail: Record<string, unknown> = {}) {
    return this.sql.query(`insert into audit_events(action, subject, detail) values ($1,$2,$3)`, [action, subject ?? null, JSON.stringify(detail)]);
  }
  async listObjects(): Promise<StoredObject[]> {
    const { rows } = await this.sql.query<{ id: string; kind: string; title: string; data: Record<string, unknown>; source: string | null; created_at: unknown }>(`select * from objects order by title`);
    return rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, data: r.data, source: r.source ?? undefined, createdAt: iso(r.created_at) }));
  }
  async putObject(o: Omit<StoredObject, "createdAt">) {
    const { rows } = await this.sql.query<{ inserted: boolean }>(
      `insert into objects(id, kind, title, data, source) values ($1,$2,$3,$4,$5)
       on conflict (owner, id) do update set kind = excluded.kind, title = excluded.title, data = excluded.data, source = excluded.source
       returning (xmax = 0) as inserted`, [o.id, o.kind, o.title, JSON.stringify(o.data), o.source ?? null]);
    await this.audit(rows[0]?.inserted ? "object.created" : "object.updated", o.id, { kind: o.kind });
  }
  async deleteObject(id: string) {
    const del = await this.sql.query(`delete from objects where id = $1 returning id`, [id]);
    if (!del.rows.length) return;
    await this.sql.query(`delete from relationships where from_id = $1 or to_id = $1`, [id]);
    await this.audit("object.deleted", id);
  }
  async listRelationships(): Promise<StoredRelationship[]> {
    const { rows } = await this.sql.query<{ id: string; relation: string; from_id: string; to_id: string; created_at: unknown }>(`select * from relationships order by created_at, id`);
    return rows.map((r) => ({ id: r.id, relation: r.relation, fromId: r.from_id, toId: r.to_id, createdAt: iso(r.created_at) }));
  }
  async putRelationship(r: Omit<StoredRelationship, "createdAt">) {
    await this.sql.query(`insert into relationships(id, relation, from_id, to_id) values ($1,$2,$3,$4)
      on conflict (owner, id) do update set relation = excluded.relation, from_id = excluded.from_id, to_id = excluded.to_id`, [r.id, r.relation, r.fromId, r.toId]);
    await this.audit("relationship.placed", r.id, { relation: r.relation });
  }
  async listIntegrations(): Promise<Integration[]> {
    const { rows } = await this.sql.query<{ destination: string; app: string; reliability: Reliability; enabled: boolean }>(`select * from integrations order by app`);
    return rows.map((r) => ({ destination: r.destination, app: r.app, reliability: r.reliability, enabled: r.enabled }));
  }
  async setIntegration(i: Integration) {
    await this.sql.query(`insert into integrations(destination, app, reliability, enabled) values ($1,$2,$3,$4)
      on conflict (owner, destination) do update set app = excluded.app, reliability = excluded.reliability, enabled = excluded.enabled, updated_at = now()`, [i.destination, i.app, i.reliability, i.enabled]);
    await this.audit(i.enabled ? "integration.enabled" : "integration.disabled", i.destination);
  }
  async listGrants(): Promise<Grant[]> {
    const { rows } = await this.sql.query<{ id: string; destination: string; scope: string; granted_at: unknown; revoked_at: unknown | null }>(`select * from grants order by granted_at, id`);
    return rows.map((r) => ({ id: r.id, destination: r.destination, scope: r.scope, grantedAt: iso(r.granted_at), revokedAt: r.revoked_at ? iso(r.revoked_at) : undefined }));
  }
  async grant(g: Omit<Grant, "grantedAt" | "revokedAt">) {
    await this.sql.query(`insert into grants(id, destination, scope) values ($1,$2,$3)
      on conflict (owner, id) do update set destination = excluded.destination, scope = excluded.scope, granted_at = now(), revoked_at = null`, [g.id, g.destination, g.scope]);
    await this.audit("grant.created", g.id, { scope: g.scope });
  }
  async revokeGrant(id: string) {
    const r = await this.sql.query(`update grants set revoked_at = now() where id = $1 and revoked_at is null returning id`, [id]);
    if (r.rows.length) await this.audit("grant.revoked", id);
  }
  async listAudit(): Promise<AuditEvent[]> {
    const { rows } = await this.sql.query<{ seq: string | number; at: unknown; action: string; subject: string | null; detail: Record<string, unknown> }>(`select * from audit_events order by seq`);
    return rows.map((r) => ({ seq: Number(r.seq), at: iso(r.at), action: r.action, subject: r.subject ?? undefined, detail: r.detail }));
  }
  async exportAll(): Promise<Export> {
    return { version: 1, exportedAt: new Date().toISOString(), objects: await this.listObjects(), relationships: await this.listRelationships(), integrations: await this.listIntegrations(), grants: await this.listGrants(), audit: await this.listAudit() };
  }
  async deleteAll() { await this.sql.query(`select delete_my_data()`); }
}
