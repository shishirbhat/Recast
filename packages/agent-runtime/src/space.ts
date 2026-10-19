import { checkConstraints, type Constraint } from "./scope";
import type { Policy, Rule } from "./policy";

/**
 * A Space is a bounded configuration for one agent: which tools and actions it may use (with parameter constraints), how many
 * calls and how much money it may spend, until when, and which actions need a person's approval. A Space can only narrow what
 * scopes and policy already allow; it never grants anything on its own. Stopping is immediate and permanent.
 */
export interface SpaceTool {
  tool: string; action: string;
  constraints?: Record<string, Constraint>;
  /** "always": every call needs a person's approval, bound to its exact parameters. */
  approval?: "always" | "never";
  /** What one call costs, in minor units of the Space's currency: fixed, or read from a parameter (e.g. an order total). */
  cost?: { fixedMinor?: number; param?: string };
}
export interface SpaceBudget { maxCalls: number; spend?: { currency: string; limitMinor: number } }
export interface SpaceInput {
  tenantId: string; agentId: string; name: string; purpose?: string; tools: SpaceTool[]; budget: SpaceBudget; expiresAt: string; createdBy?: string;
  /** Extra rules inside this Space only (a recipe's policy pack): deny or require_approval, never allow. */
  rules?: Rule[];
}
export interface Space extends SpaceInput { id: string; status: "active" | "stopped"; calls: number; spentMinor: number; createdAt: string; stoppedAt?: string; stoppedBy?: string }
export type SpaceState = "active" | "stopped" | "expired" | "exhausted";
export type ReserveResult = "ok" | "not_found" | "stopped" | "expired" | "calls_exhausted" | "spend_exhausted";

/** Longest a Space may live. Long-lived agent authority is the thing Spaces exist to prevent. */
export const MAX_SPACE_MS = 30 * 24 * 3600_000;
export const MAX_SPACE_CALLS = 100_000;
const NAME = /^[a-z][a-z0-9_-]{0,63}$/i;

export class SpaceError extends Error {}

/** Refuses anything unbounded: wildcard tools, no expiry, expiry too far out, costs without a spend budget. */
export function validateSpace(s: SpaceInput, nowMs: number): void {
  const fail = (m: string) => { throw new SpaceError(m); };
  if (!s.name?.trim() || s.name.length > 120) fail("name is required (at most 120 characters)");
  if (!s || typeof s !== "object") fail("a Space must be an object");
  if (!Array.isArray(s.tools) || s.tools.length === 0 || s.tools.length > 50) fail("a Space lists 1 to 50 tool actions");
  const seen = new Set<string>();
  for (const t of s.tools) {
    if (!t || typeof t !== "object") fail("each tool must be an object with tool and action");
    if (!NAME.test(t.tool ?? "") || !NAME.test(t.action ?? "")) fail(`tool and action must be plain names; wildcards are not allowed in a Space ('${t.tool}.${t.action}')`);
    const k = `${t.tool}.${t.action}`; if (seen.has(k)) fail(`${k} is listed twice`); seen.add(k);
    if (t.approval !== undefined && t.approval !== "always" && t.approval !== "never") fail(`${k}: approval must be 'always' or 'never'`);
    if (t.cost) {
      if (!s.budget?.spend) fail(`${k} has a cost, so the Space needs a spend budget`);
      if (t.cost.fixedMinor !== undefined && !(Number.isInteger(t.cost.fixedMinor) && t.cost.fixedMinor >= 0)) fail(`${k}: cost.fixedMinor must be a whole number of minor units`);
      if (t.cost.param !== undefined && !NAME.test(t.cost.param)) fail(`${k}: cost.param must be a parameter name`);
      if (t.cost.fixedMinor === undefined && t.cost.param === undefined) fail(`${k}: cost needs fixedMinor or param`);
    }
  }
  const b = s.budget;
  if (!b || !Number.isInteger(b.maxCalls) || b.maxCalls < 1 || b.maxCalls > MAX_SPACE_CALLS) fail(`budget.maxCalls must be 1 to ${MAX_SPACE_CALLS}`);
  if (b.spend && (!/^[A-Z]{3}$/.test(b.spend.currency) || !Number.isInteger(b.spend.limitMinor) || b.spend.limitMinor < 0)) fail("budget.spend needs a currency (ISO 4217) and a whole limitMinor");
  if (s.rules !== undefined) {
    if (!Array.isArray(s.rules) || s.rules.length > 100) fail("rules must be a list of at most 100");
    for (const [i, r] of s.rules.entries()) {
      if (!r || typeof r !== "object" || (r.then !== "deny" && r.then !== "require_approval")) fail(`rules[${i}]: a Space may only add deny or require_approval rules`);
      if (r.agent !== undefined) fail(`rules[${i}]: 'agent' is not allowed; the rule applies to this Space's agent`);
    }
  }
  const exp = Date.parse(s.expiresAt);
  if (!Number.isFinite(exp) || exp <= nowMs) fail("expiresAt must be in the future");
  if (exp - nowMs > MAX_SPACE_MS) fail("a Space can last at most 30 days");
}

export function spaceState(s: Space, nowMs: number): SpaceState {
  if (s.status === "stopped") return "stopped";
  if (Date.parse(s.expiresAt) <= nowMs) return "expired";
  if (s.calls >= s.budget.maxCalls) return "exhausted";   // a spent-out money budget is refused per call: free actions may still fit
  return "active";
}

export const spaceTool = (s: Space, tool: string, action: string) => s.tools.find((t) => t.tool === tool && t.action === action);

/** The cost of one call, or why it cannot be priced. A parameter-priced call without that parameter is refused, never free. */
export function costOf(t: SpaceTool, params: Record<string, unknown>): number | string {
  if (!t.cost) return 0;
  let c = t.cost.fixedMinor ?? 0;
  if (t.cost.param !== undefined) {
    const v = params[t.cost.param];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return `parameter '${t.cost.param}' must be a whole, non-negative amount in minor units`;
    c += v;
  }
  return c;
}

/** The checks a Space adds for one call, apart from the budget (which the store reserves atomically). */
export function checkSpaceCall(s: Space, tool: string, action: string, params: Record<string, unknown>, nowMs: number): { ok: true; cost: number; entry: SpaceTool } | { ok: false; reason: string } {
  const st = spaceState(s, nowMs); if (st !== "active") return { ok: false, reason: `Space '${s.name}' is ${st}` };
  const entry = spaceTool(s, tool, action); if (!entry) return { ok: false, reason: `Space '${s.name}' does not include ${tool}.${action}` };
  const problem = checkConstraints(entry.constraints, params); if (problem) return { ok: false, reason: `Space constraint failed: ${problem}` };
  const cost = costOf(entry, params); if (typeof cost === "string") return { ok: false, reason: cost };
  return { ok: true, cost, entry };
}

/** The tenant's policy with the Space's approval rules and its own rules added. Added rules are only deny or require_approval,
 *  so a Space can tighten policy and never loosen it. */
export function withSpaceRules(p: Policy, s: Space): Policy {
  const extra: Rule[] = [
    ...s.tools.filter((t) => t.approval === "always").map((t): Rule => ({ id: `space:${s.id}:${t.tool}.${t.action}`, tool: t.tool, action: t.action, then: "require_approval" })),
    // Re-checked here as well as at creation: whatever is stored, a Space's own rules can only tighten.
    ...(s.rules ?? []).filter((r) => r.then === "deny" || r.then === "require_approval").map((r) => ({ ...r, agent: s.agentId })),
  ];
  return extra.length ? { ...p, rules: [...p.rules, ...extra] } : p;
}

export interface SpaceStore {
  create(input: SpaceInput, nowMs: number): Promise<Space>;
  get(id: string, tenantId: string): Promise<Space | null>;
  list(tenantId: string, agentId?: string): Promise<Space[]>;
  /** Atomically take one call and `cost` from the budget, after re-checking status and expiry. Two callers never share the last unit. */
  reserve(id: string, cost: number, nowMs: number): Promise<ReserveResult>;
  /** Give back what `reserve` took when nothing was done (the scope refused, or the tool answered with an error). */
  refund(id: string, take: { calls: number; cost: number }): Promise<void>;
  /** Immediate and permanent. Returns false if the Space was not active. */
  stop(id: string, tenantId: string, by: string, nowMs: number): Promise<boolean>;
}

export class MemorySpaceStore implements SpaceStore {
  private m = new Map<string, Space>(); private n = 0;
  async create(input: SpaceInput, nowMs: number) {
    validateSpace(input, nowMs);
    const s: Space = structuredClone({ ...input, id: `spc_${++this.n}`, status: "active", calls: 0, spentMinor: 0, createdAt: new Date(nowMs).toISOString() });
    this.m.set(s.id, s); return structuredClone(s);
  }
  async get(id: string, tenantId: string) { const s = this.m.get(id); return s && s.tenantId === tenantId ? structuredClone(s) : null; }
  async list(tenantId: string, agentId?: string) { return [...this.m.values()].filter((s) => s.tenantId === tenantId && (!agentId || s.agentId === agentId)).map((s) => structuredClone(s)); }
  async reserve(id: string, cost: number, nowMs: number): Promise<ReserveResult> {
    const s = this.m.get(id); if (!s) return "not_found";
    if (s.status === "stopped") return "stopped"; if (Date.parse(s.expiresAt) <= nowMs) return "expired";
    if (s.calls >= s.budget.maxCalls) return "calls_exhausted";
    if (cost > 0 && (!s.budget.spend || s.spentMinor + cost > s.budget.spend.limitMinor)) return "spend_exhausted";
    s.calls++; s.spentMinor += cost; return "ok";
  }
  async refund(id: string, take: { calls: number; cost: number }) { const s = this.m.get(id); if (s) { s.calls = Math.max(0, s.calls - take.calls); s.spentMinor = Math.max(0, s.spentMinor - take.cost); } }
  async stop(id: string, tenantId: string, by: string, nowMs: number) {
    const s = this.m.get(id); if (!s || s.tenantId !== tenantId || s.status !== "active") return false;
    s.status = "stopped"; s.stoppedAt = new Date(nowMs).toISOString(); s.stoppedBy = by; return true;
  }
}
