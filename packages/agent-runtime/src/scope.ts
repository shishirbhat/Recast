export interface Constraint { max?: number; min?: number; eq?: unknown; in?: unknown[] }
export interface ScopeGrant {
  id: string; agentId: string; tenantId: string; tool: string; action: string;
  constraints?: Record<string, Constraint>; issuedAt: string; expiresAt: string; maxCalls: number; calls: number;
}

/** Every constraint must hold for the call's params; a constrained param that is missing fails the check.
 *  `min`/`max` bound a number's value, or the length of a string or list. */
export function checkConstraints(c: Record<string, Constraint> | undefined, params: Record<string, unknown>): string | null {
  for (const [k, rule] of Object.entries(c ?? {})) {
    const v = params[k];
    if (v === undefined) return `parameter '${k}' is required by this scope`;
    const n = Array.isArray(v) || typeof v === "string" ? v.length : v;   // for lists and text, min and max bound the length
    if (rule.max !== undefined && !(typeof n === "number" && n <= rule.max)) return `${k} must be at most ${rule.max}`;
    if (rule.min !== undefined && !(typeof n === "number" && n >= rule.min)) return `${k} must be at least ${rule.min}`;
    if (rule.eq !== undefined && v !== rule.eq) return `${k} must equal ${JSON.stringify(rule.eq)}`;
    if (rule.in !== undefined && !rule.in.includes(v)) return `${k} must be one of ${JSON.stringify(rule.in)}`;
  }
  return null;
}

export interface ScopeStore {
  grant(g: Omit<ScopeGrant, "id" | "calls" | "issuedAt"> & { id?: string; issuedAt?: string }): Promise<ScopeGrant>;
  /** Live grants for this exact tool and action, soonest-expiring first. */
  find(agentId: string, tool: string, action: string, nowMs: number): Promise<ScopeGrant[]>;
  /** Atomically spend one call. False if the grant is exhausted or expired. Never lets two callers share the last call. */
  consume(grantId: string, nowMs: number): Promise<boolean>;
}
export class MemoryScopeStore implements ScopeStore {
  private g = new Map<string, ScopeGrant>(); private n = 0;
  async grant(x: Omit<ScopeGrant, "id" | "calls" | "issuedAt"> & { id?: string; issuedAt?: string }) {
    const rec: ScopeGrant = { ...x, id: x.id ?? `scp_${++this.n}`, calls: 0, issuedAt: x.issuedAt ?? new Date().toISOString() }; this.g.set(rec.id, rec); return { ...rec };
  }
  async find(agentId: string, tool: string, action: string, nowMs: number) {
    return [...this.g.values()].filter((s) => s.agentId === agentId && s.tool === tool && s.action === action && Date.parse(s.expiresAt) > nowMs && s.calls < s.maxCalls).sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt)).map((s) => ({ ...s }));
  }
  async consume(id: string, nowMs: number) {
    const s = this.g.get(id); if (!s || Date.parse(s.expiresAt) <= nowMs || s.calls >= s.maxCalls) return false; s.calls++; return true;
  }
}
