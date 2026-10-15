import { parse as parseYaml } from "yaml";

export type Decision = "allow" | "deny" | "require_approval";
export type Condition = string | number | boolean | { gte?: number; lte?: number; gt?: number; lt?: number; eq?: unknown; ne?: unknown; in?: unknown[]; notIn?: unknown[]; matches?: string };
export interface Rule { id?: string; agent?: string; tool?: string; action?: string; when?: Record<string, Condition>; then: Decision }
export interface Policy { rules: Rule[]; default: Decision }
export interface PolicyResult { decision: Decision; ruleId?: string; reason: string }

const PRECEDENCE: Record<Decision, number> = { allow: 0, require_approval: 1, deny: 2 };

/** ">= 0.9", "<= 10", "== x", "!= x", or a bare value meaning equality. */
function test(cond: Condition, v: unknown): boolean {
  if (typeof cond === "string") {
    const m = /^\s*(>=|<=|>|<|==|!=)\s*(.+?)\s*$/.exec(cond);
    if (!m) return v === cond;
    const [, op, rhs] = m; const num = Number(rhs);
    if (op === "==") return String(v) === rhs; if (op === "!=") return String(v) !== rhs;
    if (typeof v !== "number" || Number.isNaN(num)) return false;
    return op === ">=" ? v >= num : op === "<=" ? v <= num : op === ">" ? v > num : v < num;
  }
  if (typeof cond !== "object" || cond === null) return v === cond;
  if (cond.gte !== undefined && !(typeof v === "number" && v >= cond.gte)) return false;
  if (cond.lte !== undefined && !(typeof v === "number" && v <= cond.lte)) return false;
  if (cond.gt !== undefined && !(typeof v === "number" && v > cond.gt)) return false;
  if (cond.lt !== undefined && !(typeof v === "number" && v < cond.lt)) return false;
  if ("eq" in cond && v !== cond.eq) return false; if ("ne" in cond && v === cond.ne) return false;
  if (cond.in && !cond.in.includes(v)) return false; if (cond.notIn && cond.notIn.includes(v)) return false;
  if (cond.matches !== undefined && !(typeof v === "string" && new RegExp(cond.matches).test(v))) return false;
  return true;
}

/** A condition on a fact the call does not have never matches: missing data cannot unlock an allow. */
function matches(rule: Rule, call: { agentId: string; tool: string; action: string }, facts: Record<string, unknown>): boolean {
  if (rule.agent && rule.agent !== "*" && rule.agent !== call.agentId) return false;
  if (rule.tool && rule.tool !== "*" && rule.tool !== call.tool) return false;
  if (rule.action && rule.action !== "*" && rule.action !== call.action) return false;
  return Object.entries(rule.when ?? {}).every(([k, c]) => k in facts && test(c, facts[k]));
}

/** Deny beats require_approval beats allow, whatever the order of the rules. Nothing matching means the default, which is deny. */
export function evaluate(policy: Policy, call: { agentId: string; tool: string; action: string }, facts: Record<string, unknown>): PolicyResult {
  let best: Rule | null = null;
  for (const r of policy.rules) if (matches(r, call, facts) && (!best || PRECEDENCE[r.then] > PRECEDENCE[best.then])) best = r;
  if (!best) return { decision: policy.default, reason: "no rule matched; default applies" };
  return { decision: best.then, ...(best.id ? { ruleId: best.id } : {}), reason: `rule ${best.id ?? "(unnamed)"} says ${best.then}` };
}

export function parsePolicy(text: string): Policy {
  const doc = parseYaml(text) as { rules?: Rule[]; default?: Decision } | null;
  const rules = doc?.rules ?? []; const def = doc?.default ?? "deny";
  const ok = (d: unknown): d is Decision => d === "allow" || d === "deny" || d === "require_approval";
  if (!ok(def)) throw new Error(`default must be allow, deny or require_approval, got ${JSON.stringify(def)}`);
  rules.forEach((r, i) => { if (!ok(r?.then)) throw new Error(`rule ${i}: 'then' must be allow, deny or require_approval`); for (const [k, c] of Object.entries(r.when ?? {})) if (c && typeof c === "object" && c.matches !== undefined) { try { if (c.matches.length > 200) throw new Error("long"); new RegExp(c.matches); } catch { throw new Error(`rule ${i}: bad regex in ${k}`); } } });
  return { rules, default: def };
}
