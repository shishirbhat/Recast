// Loads and checks the data-driven rules: relationship grammar, identity keys, capability contracts.
import relationsJson from "../../../schema/grammar/relations.json";
import identityJson from "../../../schema/grammar/identity.json";
import { validateRelations, validateContract } from "./generated/validators.js";
import { RecastError } from "./errors.js";
import type { CapabilityContract, ObjectType, RiskTier, TargetKind } from "./types.js";

export interface Relation {
  id: string; from: ObjectType; to: TargetKind; relation: string; risk: RiskTier; requires: string[][]; reversible: boolean;
}
type Validator = ((d: unknown) => boolean) & { errors?: { instancePath: string; message?: string }[] | null };
export const errorsOf = (v: Validator) => (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`);
/** Run a generated standalone validator; returns [] when valid, else readable violations. */
export function violations(validator: unknown, data: unknown): string[] {
  const v = validator as Validator;
  return v(data) ? [] : errorsOf(v);
}

{
  const bad = violations(validateRelations, relationsJson);
  if (bad.length) throw new RecastError("INVALID_CONTRACT", "relations.json fails its schema", bad);
}
export const RELATIONS: readonly Relation[] = (relationsJson as { relations: Relation[] }).relations;
export const IDENTITY_KEYS = (identityJson as { keys: Record<ObjectType, string[][]> }).keys;
const byId = new Map(RELATIONS.map((r) => [r.id, r]));
export const relationById = (id: string) => byId.get(id);

export const RISK_ORDER: Record<RiskTier, number> = { low: 0, medium: 1, high: 2 };

/** Validate a destination's contract against the schema AND the grammar. */
export function checkContract(input: unknown): CapabilityContract {
  const bad = violations(validateContract, input);
  if (bad.length) throw new RecastError("INVALID_CONTRACT", "contract fails schema", bad);
  const c = input as CapabilityContract;
  const problems: string[] = [];
  if (c.reliability === "unsupported" && c.accepts.length > 0) problems.push("an 'unsupported' destination cannot accept anything");
  for (const row of c.accepts) {
    const rel = relationById(row.relationId);
    if (!rel) { problems.push(`unknown relation '${row.relationId}'`); continue; }
    if (rel.to !== c.targetKind) problems.push(`${row.relationId} targets ${rel.to}, contract targets ${c.targetKind}`);
    if (row.risk && RISK_ORDER[row.risk] < RISK_ORDER[rel.risk]) problems.push(`${row.relationId}: contract may raise risk, never lower it (grammar says ${rel.risk})`);
    if (row.reversible === true && !rel.reversible) problems.push(`${row.relationId}: grammar marks it irreversible`);
    for (const p of row.dataMoved) {
      if (!p.startsWith(rel.from + ".")) problems.push(`${row.relationId}: dataMoved '${p}' must start with '${rel.from}.'`);
    }
  }
  if (problems.length) throw new RecastError("INVALID_CONTRACT", "contract conflicts with grammar", problems);
  return c;
}
