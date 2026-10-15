import { canonicalJson, sha256Hex } from "@recast/core";
import { sign, verify } from "./identity";

export type AuditResult = "allowed" | "denied" | "pending_approval" | "success" | "failure";
export interface AuditInput {
  tenantId: string; agentId: string; userId?: string; sessionId?: string; requestId: string; tool: string; action: string; params: unknown;
  result: AuditResult; reason?: string; humanApproved?: boolean; delegationChain?: string[];
}
export interface AuditEntry extends AuditInput { seq: number; at: string; prevHash: string; hash: string; signature: string; keyId: string }
export const GENESIS = "0".repeat(64);

const SENSITIVE = /token|secret|password|passwd|authorization|api[_-]?key|credential|private/i;
/** Credentials must never reach the log, even if an agent puts one in a parameter. */
export function redact(v: unknown, depth = 0): unknown {
  if (depth > 6) return "[too deep]";
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SENSITIVE.test(k) ? "[redacted]" : redact(x, depth + 1)]));
  return v;
}

export interface AuditStore {
  last(tenantId: string): Promise<AuditEntry | null>;
  /** Must refuse an entry whose prevHash is not the current head: two writers cannot fork the chain. */
  append(entry: AuditEntry): Promise<void>;
  list(tenantId: string): Promise<AuditEntry[]>;
}
export class MemoryAuditStore implements AuditStore {
  private m = new Map<string, AuditEntry[]>();
  async last(t: string) { return this.m.get(t)?.at(-1) ?? null; }
  async append(e: AuditEntry) {
    const arr = this.m.get(e.tenantId) ?? []; const head = arr.at(-1)?.hash ?? GENESIS;
    if (e.prevHash !== head || e.seq !== arr.length + 1) throw new Error("audit chain conflict");
    arr.push(e); this.m.set(e.tenantId, arr);
  }
  async list(t: string) { return [...(this.m.get(t) ?? [])]; }
}

const body = (e: Omit<AuditEntry, "hash" | "signature">) => canonicalJson(e);

export class AuditLog {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private store: AuditStore, private signer: { privateJwk: JsonWebKey; keyId: string }, private now: () => Date = () => new Date()) {}
  /** Serialised per process; the store's conflict check protects across processes. */
  append(input: AuditInput): Promise<AuditEntry> {
    const run = async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const last = await this.store.last(input.tenantId);
        const base: Omit<AuditEntry, "hash" | "signature"> = { ...input, params: redact(input.params), seq: (last?.seq ?? 0) + 1, at: this.now().toISOString(), prevHash: last?.hash ?? GENESIS, keyId: this.signer.keyId };
        const hash = await sha256Hex(body(base)); const entry: AuditEntry = { ...base, hash, signature: await sign(this.signer.privateJwk, hash) };
        try { await this.store.append(entry); return entry; } catch (e) { if (attempt === 4 || !/conflict/.test(String(e))) throw e; }
      }
      throw new Error("unreachable");
    };
    const p = this.queue.then(run, run); this.queue = p.catch(() => undefined); return p;
  }
}

export type ChainResult = { ok: true; entries: number } | { ok: false; brokenAt: number; reason: string };
/** Recomputes every hash and signature. Detects an edited entry, a removed one, a reordered pair, or a truncated tail (when `expectedHead` is given). */
export async function verifyChain(entries: AuditEntry[], keys: Record<string, JsonWebKey>, expectedHead?: string): Promise<ChainResult> {
  let prev = GENESIS;
  for (const [i, e] of entries.entries()) {
    if (e.seq !== i + 1) return { ok: false, brokenAt: e.seq, reason: "sequence gap or reorder" };
    if (e.prevHash !== prev) return { ok: false, brokenAt: e.seq, reason: "previous hash does not match" };
    const { hash, signature, ...rest } = e;
    if ((await sha256Hex(body(rest))) !== hash) return { ok: false, brokenAt: e.seq, reason: "entry contents were changed" };
    const k = keys[e.keyId]; if (!k) return { ok: false, brokenAt: e.seq, reason: `unknown signing key ${e.keyId}` };
    if (!(await verify(k, hash, signature))) return { ok: false, brokenAt: e.seq, reason: "signature is invalid" };
    prev = hash;
  }
  if (expectedHead !== undefined && prev !== expectedHead) return { ok: false, brokenAt: entries.length + 1, reason: "entries are missing from the end" };
  return { ok: true, entries: entries.length };
}
