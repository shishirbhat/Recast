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
export class MemoryIdempotencyStore {
  private m = new Map<string, IdemRecord>();
  constructor(private ttlMs = 24 * 3600_000) {}
  get(k: string, now: number) { const r = this.m.get(k); if (r && now - r.at > this.ttlMs) { this.m.delete(k); return undefined; } return r; }
  set(k: string, r: IdemRecord) { this.m.set(k, r); }
}
