import type { ApiKeyRecord, Correction, CorrectionStore, KeyStore, UsageStore } from "./stores";
import type { Tier } from "./tiers";

/** One Postgres connection (PGlite or node-postgres fit). Runs as the service role: these stores authenticate callers, so RLS is not in their way. */
export interface Sql { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }> }

export class SqlKeyStore implements KeyStore {
  constructor(private sql: Sql) {}
  async find(keyHash: string): Promise<ApiKeyRecord | null> {
    const { rows } = await this.sql.query<{ tenant_id: string; tier: Tier; opt: boolean; revoked_at: unknown; label: string | null }>(
      `select t.id as tenant_id, t.tier, t.corrections_opt_in as opt, k.revoked_at, k.label from api_keys k join tenants t on t.id = k.tenant_id where k.key_hash = $1`, [keyHash]);
    const r = rows[0]; if (!r) return null;
    return { tenantId: r.tenant_id, tier: r.tier, revoked: r.revoked_at !== null, correctionsOptIn: r.opt, ...(r.label ? { label: r.label } : {}) };
  }
  /** Issuing a key: only the hash is stored. The caller shows the plain key once. */
  async add(tenantId: string, keyHash: string, label?: string) { await this.sql.query(`insert into api_keys(tenant_id, key_hash, label) values ($1,$2,$3)`, [tenantId, keyHash, label ?? null]); }
  async revoke(keyHash: string) { await this.sql.query(`update api_keys set revoked_at = now() where key_hash = $1 and revoked_at is null`, [keyHash]); }
}

export class SqlUsageStore implements UsageStore {
  constructor(private sql: Sql) {}
  async get(tenantId: string, month: string) {
    const { rows } = await this.sql.query<{ resolutions: string | number }>(`select resolutions from api_usage where tenant_id = $1 and month = $2`, [tenantId, month]);
    return rows[0] ? Number(rows[0].resolutions) : 0;
  }
  /** Atomic upsert in the database: concurrent requests cannot lose each other's counts. */
  async add(tenantId: string, month: string, n: number) {
    const { rows } = await this.sql.query<{ record_usage: string | number }>(`select record_usage($1::uuid, $2, $3::bigint)`, [tenantId, month, n]);
    return Number(rows[0]!.record_usage);
  }
}

export class SqlCorrectionStore implements CorrectionStore {
  constructor(private sql: Sql) {}
  /** The database refuses this for a tenant that has not opted in, whatever the caller checked. */
  async add(c: Correction) {
    await this.sql.query(`insert into api_corrections(tenant_id, object_id, field, old_value, new_value, kind, at) values ($1,$2,$3,$4,$5,$6,$7)`,
      [c.tenantId, c.objectId, c.field ?? null, c.oldValue === undefined ? null : JSON.stringify(c.oldValue), c.newValue === undefined ? null : JSON.stringify(c.newValue), c.kind, c.at]);
  }
  async list(tenantId: string): Promise<Correction[]> {
    const { rows } = await this.sql.query<{ tenant_id: string; object_id: string; field: string | null; old_value: unknown; new_value: unknown; kind: Correction["kind"]; at: Date | string }>(`select * from api_corrections where tenant_id = $1 order by at, id`, [tenantId]);
    return rows.map((r) => ({ tenantId: r.tenant_id, objectId: r.object_id, kind: r.kind, at: new Date(r.at).toISOString(), ...(r.field ? { field: r.field } : {}), ...(r.old_value !== null ? { oldValue: r.old_value } : {}), ...(r.new_value !== null ? { newValue: r.new_value } : {}) }));
  }
}
