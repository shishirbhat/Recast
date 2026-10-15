import { sha256Hex } from "@recast/core";
import type { Tier } from "./tiers";

export interface ApiKeyRecord { tenantId: string; tier: Tier; revoked: boolean; correctionsOptIn: boolean; label?: string }
export interface KeyStore {
  /** Look a key up by its hash. The plain key is never stored. */
  find(keyHash: string): Promise<ApiKeyRecord | null>;
}
export const hashKey = (key: string) => sha256Hex(key);

export class MemoryKeyStore implements KeyStore {
  private byHash = new Map<string, ApiKeyRecord>();
  async add(plainKey: string, rec: Omit<ApiKeyRecord, "revoked" | "correctionsOptIn"> & { revoked?: boolean; correctionsOptIn?: boolean }) {
    this.byHash.set(await hashKey(plainKey), { revoked: false, correctionsOptIn: false, ...rec });
  }
  async find(h: string) { return this.byHash.get(h) ?? null; }
  async revoke(plainKey: string) { const r = this.byHash.get(await hashKey(plainKey)); if (r) r.revoked = true; }
}

/** Resolution events per tenant per calendar month (UTC). */
export interface UsageStore {
  get(tenantId: string, month: string): Promise<number>;
  add(tenantId: string, month: string, n: number): Promise<number>;
}
export class MemoryUsageStore implements UsageStore {
  private m = new Map<string, number>();
  async get(t: string, mo: string) { return this.m.get(`${t}|${mo}`) ?? 0; }
  async add(t: string, mo: string, n: number) { const k = `${t}|${mo}`; const v = (this.m.get(k) ?? 0) + n; this.m.set(k, v); return v; }
}

export interface Correction { tenantId: string; objectId: string; field?: string; oldValue?: unknown; newValue?: unknown; kind: "undo" | "reject" | "edit"; at: string }
export interface CorrectionStore { add(c: Correction): Promise<void>; list(tenantId: string): Promise<Correction[]> }
export class MemoryCorrectionStore implements CorrectionStore {
  private rows: Correction[] = [];
  async add(c: Correction) { this.rows.push(c); }
  async list(t: string) { return this.rows.filter((r) => r.tenantId === t); }
}

export interface IdemRecord { bodyHash: string; status: number; json: unknown; at: number }
/** What happened when a request tried to claim its Idempotency-Key. */
export type IdemBegin = { state: "new" } | { state: "replay"; record: IdemRecord } | { state: "mismatch" } | { state: "in_progress" };
/**
 * Claim first, then do the work, then complete (or abort on failure). Of two concurrent requests with the same key exactly one
 * gets "new"; the other sees "in_progress" until the first completes, then "replay". A claim older than `staleMs` is treated as abandoned.
 */
export interface IdempotencyStore {
  begin(tenantId: string, key: string, bodyHash: string, now: number): Promise<IdemBegin>;
  complete(tenantId: string, key: string, record: IdemRecord): Promise<void>;
  abort(tenantId: string, key: string): Promise<void>;
}
export const IDEM_TTL_MS = 24 * 3600_000, IDEM_STALE_MS = 60_000;
export class MemoryIdempotencyStore implements IdempotencyStore {
  private m = new Map<string, { bodyHash: string; at: number; record?: IdemRecord }>();
  constructor(private ttlMs = IDEM_TTL_MS, private staleMs = IDEM_STALE_MS) {}
  async begin(t: string, k: string, bodyHash: string, now: number): Promise<IdemBegin> {
    const id = `${t}|${k}`; const cur = this.m.get(id);
    if (cur && (now - cur.at > this.ttlMs || (!cur.record && now - cur.at > this.staleMs))) this.m.delete(id);
    const r = this.m.get(id);
    if (!r) { this.m.set(id, { bodyHash, at: now }); return { state: "new" }; }
    if (r.bodyHash !== bodyHash) return { state: "mismatch" };
    return r.record ? { state: "replay", record: r.record } : { state: "in_progress" };
  }
  async complete(t: string, k: string, record: IdemRecord) { const id = `${t}|${k}`; this.m.set(id, { bodyHash: record.bodyHash, at: this.m.get(id)?.at ?? record.at, record }); }
  async abort(t: string, k: string) { const id = `${t}|${k}`; if (!this.m.get(id)?.record) this.m.delete(id); }
}
