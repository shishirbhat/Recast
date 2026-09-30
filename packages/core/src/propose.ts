import { RecastError } from "./errors.js";
import { hash32 } from "./canonical.js";
import { RELATIONS, checkContract, relationById } from "./rules.js";
import { assessRisk } from "./trust.js";
import type { Approach, CapabilityContract, Preferences, Proposal, SemanticObject } from "./types.js";

const present = (o: SemanticObject, p: string) => o.properties[p] !== undefined;

/**
 * Intent = source + destination + destination capabilities + approach + preferences.
 * With no destination there is nothing to propose: intent is never inferred from the source alone.
 */
export function propose(object: SemanticObject, destination: unknown, approach: Approach = {}, prefs: Preferences = {}): Proposal[] {
  const dest: CapabilityContract = checkContract(destination);
  const out: Proposal[] = [];
  for (const row of dest.accepts) {
    const rel = relationById(row.relationId)!; // checkContract guarantees it exists
    if (rel.from !== object.type) continue;
    const missing = rel.requires.filter((g) => !g.some((p) => present(object, p))).map((g) => g.join(" or "));
    const usedProps = new Set(rel.requires.flatMap((g) => g.filter((p) => present(object, p))));
    const confidence = usedProps.size ? Math.min(...[...usedProps].map((p) => object.fields[p]?.confidence ?? 0)) : 0;
    const flags = row.effectFlags ?? [];
    const reversible = (row.reversible ?? rel.reversible) && rel.reversible;
    const baseRisk = row.risk ?? rel.risk;
    const ready = missing.length === 0;
    out.push({
      id: "rc_p_" + hash32(`${object.id}\n${dest.destination}\n${row.relationId}`),
      object, destination: dest, relationId: row.relationId, relation: rel.relation, effect: row.effect,
      effectFlags: [...flags], reversible, reliability: dest.reliability, dataMoved: [...row.dataMoved],
      confidence: ready ? confidence : 0,
      risk: assessRisk({ baseRisk, flags, reversible, confidence: ready ? confidence : 0, reliability: dest.reliability }),
      preferred: (prefs.approved ?? []).some((a) => a.destination === dest.destination && a.relationId === row.relationId),
      status: ready ? "ready" : "blocked",
      ...(ready ? {} : { blocked: { reason: `needs ${missing.join("; ")}`, missing } }),
    });
  }
  return rankProposals(out, approach);
}

/** Ready before blocked, then user-approved, then the approach hint, then higher confidence, then grammar order. */
export function rankProposals(proposals: readonly Proposal[], approach: Approach = {}): Proposal[] {
  const order = new Map(RELATIONS.map((r, i) => [r.id, i]));
  const key = (p: Proposal) => [p.status === "ready" ? 0 : 1, p.preferred ? 0 : 1, p.relationId === approach.hintRelationId ? 0 : 1, -p.confidence, order.get(p.relationId) ?? 99, p.id];
  return [...proposals].sort((a, b) => {
    const x = key(a), y = key(b);
    for (let i = 0; i < x.length; i++) {
      if (x[i] === y[i]) continue;
      return typeof x[i] === "string" ? (x[i]! < y[i]! ? -1 : 1) : (x[i] as number) - (y[i] as number);
    }
    return 0;
  });
}

export function assertReady(p: Proposal): void {
  if (p.status === "blocked") throw new RecastError("BLOCKED", `cannot ${p.relation}: ${p.blocked?.reason ?? "blocked"}`, p.blocked?.missing ?? []);
}
