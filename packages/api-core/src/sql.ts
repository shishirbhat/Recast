import type { ActionStep, Receipt } from "@recast/core";
import { takeResult, type Limiter, type TakeResult } from "./limiter";
import type { Credential, CredentialCipher, CredentialStore, PlacementRecord, PlacementStore } from "./place";
import { IDEM_STALE_MS, IDEM_TTL_MS, type ApiKeyRecord, type Correction, type CorrectionStore, type IdemBegin, type IdemRecord, type IdempotencyStore, type KeyStore, type UsageStore } from "./stores";
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

/** The token bucket lives in Postgres (`take_token`), so a tenant's limit holds across every server instance. */
export class SqlRateLimiter implements Limiter {
  constructor(private sql: Sql, private now: () => number = Date.now) {}
  async take(key: string, rps: number, burst: number): Promise<TakeResult> {
    const { rows } = await this.sql.query<{ left: number | string }>(`select take_token($1, $2, $3, $4::bigint) as left`, [key, rps, burst, this.now()]);
    return takeResult(Number(rows[0]!.left), rps);
  }
}

/** Idempotency records in Postgres. The primary key on (tenant, key) makes the claim atomic across instances. */
export class SqlIdempotencyStore implements IdempotencyStore {
  constructor(private sql: Sql, private ttlMs = IDEM_TTL_MS, private staleMs = IDEM_STALE_MS) {}
  async begin(tenantId: string, key: string, bodyHash: string, now: number): Promise<IdemBegin> {
    await this.sql.query(`delete from api_idempotency where tenant_id = $1 and key = $2 and (created_ms < $3::bigint or (status is null and created_ms < $4::bigint))`, [tenantId, key, now - this.ttlMs, now - this.staleMs]);
    const claimed = await this.sql.query(`insert into api_idempotency(tenant_id, key, body_hash, created_ms) values ($1,$2,$3,$4) on conflict (tenant_id, key) do nothing returning 1`, [tenantId, key, bodyHash, now]);
    if (claimed.rows.length) return { state: "new" };
    const { rows } = await this.sql.query<{ body_hash: string; status: number | null; response: unknown; created_ms: number | string }>(`select body_hash, status, response, created_ms from api_idempotency where tenant_id = $1 and key = $2`, [tenantId, key]);
    const r = rows[0];
    if (!r) return this.begin(tenantId, key, bodyHash, now);   // removed between our insert and select: claim again
    if (r.body_hash !== bodyHash) return { state: "mismatch" };
    if (r.status === null) return { state: "in_progress" };
    return { state: "replay", record: { bodyHash: r.body_hash, status: r.status, json: r.response, at: Number(r.created_ms) } };
  }
  async complete(tenantId: string, key: string, rec: IdemRecord) {
    await this.sql.query(`update api_idempotency set status = $3, response = $4::jsonb where tenant_id = $1 and key = $2`, [tenantId, key, rec.status, JSON.stringify(rec.json)]);
  }
  async abort(tenantId: string, key: string) { await this.sql.query(`delete from api_idempotency where tenant_id = $1 and key = $2 and status is null`, [tenantId, key]); }
}

/** Destination tokens, sealed with AES-256-GCM before they are written; see CredentialCipher. */
export class SqlCredentialStore implements CredentialStore {
  constructor(private sql: Sql, private cipher: CredentialCipher) {}
  async get(tenantId: string, destination: string): Promise<Credential | null> {
    const { rows } = await this.sql.query<{ sealed: string }>(`select sealed from api_credentials where tenant_id = $1 and destination = $2`, [tenantId, destination]);
    return rows[0] ? this.cipher.open(tenantId, destination, rows[0].sealed) : null;
  }
  async set(tenantId: string, destination: string, c: Credential) {
    await this.sql.query(`insert into api_credentials(tenant_id, destination, sealed) values ($1,$2,$3) on conflict (tenant_id, destination) do update set sealed = excluded.sealed, updated_at = now()`, [tenantId, destination, await this.cipher.seal(tenantId, destination, c)]);
  }
  async remove(tenantId: string, destination: string) { return (await this.sql.query(`delete from api_credentials where tenant_id = $1 and destination = $2 returning 1`, [tenantId, destination])).rows.length > 0; }
}

export class SqlPlacementStore implements PlacementStore {
  constructor(private sql: Sql) {}
  async save(r: PlacementRecord) {
    await this.sql.query(`insert into api_placements(receipt_id, tenant_id, destination, target, receipt, data_moved, status, action, reconcile_ref) values ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9)`,
      [r.receipt.receiptId, r.tenantId, r.destination, JSON.stringify(r.target), JSON.stringify(r.receipt), JSON.stringify(r.dataMoved), r.status, JSON.stringify(r.action), r.reconcileRef ?? null]);
  }
  async get(tenantId: string, receiptId: string): Promise<PlacementRecord | null> {
    const { rows } = await this.sql.query<{ destination: string; target: Record<string, string>; receipt: Receipt; data_moved: PlacementRecord["dataMoved"]; status: PlacementRecord["status"]; action: PlacementRecord["action"]; reconcile_ref: string | null }>(
      `select destination, target, receipt, data_moved, status, action, reconcile_ref from api_placements where tenant_id = $1 and receipt_id = $2`, [tenantId, receiptId]);
    const r = rows[0];
    return r ? { tenantId, destination: r.destination, target: r.target, receipt: r.receipt, dataMoved: r.data_moved, status: r.status, action: r.action, ...(r.reconcile_ref ? { reconcileRef: r.reconcile_ref } : {}) } : null;
  }
  async claimUndo(tenantId: string, receiptId: string) {
    return (await this.sql.query(`update api_placements set status = 'reversing' where tenant_id = $1 and receipt_id = $2 and status = 'succeeded' returning 1`, [tenantId, receiptId])).rows.length > 0;
  }
  async finishUndo(tenantId: string, receiptId: string, ok: boolean, step: ActionStep, receipt?: Receipt) {
    if (ok) await this.sql.query(`update api_placements set status = 'reversed', reversed_at = now(), receipt = coalesce($3::jsonb, receipt), action = action || $4::jsonb where tenant_id = $1 and receipt_id = $2 and status = 'reversing'`, [tenantId, receiptId, receipt ? JSON.stringify(receipt) : null, JSON.stringify([step])]);
    else await this.sql.query(`update api_placements set status = 'succeeded' where tenant_id = $1 and receipt_id = $2 and status = 'reversing'`, [tenantId, receiptId]);
  }
  async resolveUnknown(tenantId: string, receiptId: string, to: "succeeded" | "failed", step: ActionStep) {
    return (await this.sql.query(`update api_placements set status = $3, action = action || $4::jsonb where tenant_id = $1 and receipt_id = $2 and status = 'outcome_unknown' returning 1`, [tenantId, receiptId, to, JSON.stringify([step])])).rows.length > 0;
  }
}
