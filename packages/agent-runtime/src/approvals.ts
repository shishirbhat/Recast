import { sha256Hex, canonicalJson } from "@recast/core";
import { randomHex } from "./b64";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "used" | "expired";
export interface Approval { id: string; tenantId: string; agentId: string; tool: string; action: string; requestHash: string; status: ApprovalStatus; createdAt: number; decidedBy?: string }

/** An approval is bound to the exact request it was asked for, and works once. Approving "send to Meera" cannot be replayed for "send to everyone". */
export const requestHash = (tenantId: string, agentId: string, tool: string, action: string, params: unknown) => sha256Hex(canonicalJson({ tenantId, agentId, tool, action, params }));

export interface ApprovalStore {
  request(a: Omit<Approval, "id" | "status" | "createdAt">, now: number): Promise<Approval>;
  decide(id: string, tenantId: string, by: string, approve: boolean, now: number): Promise<Approval | null>;
  /** Consume an approved approval if it matches this request. Returns true at most once. */
  redeem(id: string, tenantId: string, hash: string, now: number): Promise<boolean>;
  get(id: string): Promise<Approval | null>;
}
export class MemoryApprovalStore implements ApprovalStore {
  private m = new Map<string, Approval>(); constructor(private ttlMs = 15 * 60_000) {}
  async request(a: Omit<Approval, "id" | "status" | "createdAt">, now: number) {
    for (const x of this.m.values()) if (x.requestHash === a.requestHash && x.tenantId === a.tenantId && x.status === "pending" && now - x.createdAt < this.ttlMs) return x;   // asking twice does not spam the human
    const rec: Approval = { ...a, id: `apr_${randomHex(6)}`, status: "pending", createdAt: now }; this.m.set(rec.id, rec); return rec;
  }
  async decide(id: string, tenantId: string, by: string, approve: boolean, now: number) {
    const a = this.m.get(id); if (!a || a.tenantId !== tenantId || a.status !== "pending" || now - a.createdAt >= this.ttlMs) return null;
    a.status = approve ? "approved" : "rejected"; a.decidedBy = by; return { ...a };
  }
  async redeem(id: string, tenantId: string, hash: string, now: number) {
    const a = this.m.get(id); if (!a || a.tenantId !== tenantId || a.requestHash !== hash || a.status !== "approved" || now - a.createdAt >= this.ttlMs) return false;
    a.status = "used"; return true;
  }
  async get(id: string) { const a = this.m.get(id); return a ? { ...a } : null; }
}
