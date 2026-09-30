import { validateEnvelope, validateCandidate } from "./generated/validators.js";
import { RecastError } from "./errors.js";
import { canonicalJson, clone, deepFreeze, hash32 } from "./canonical.js";
import { IDENTITY_KEYS, violations } from "./rules.js";
import type { Candidate, ObjectType, Props, SemanticObject } from "./types.js";

const collapse = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();
const normDoi = (s: string) => s.trim().replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:\s*)/i, "").toLowerCase();

/** Normalise property values. Pure: returns a new object. */
export function normalizeProps(type: ObjectType, input: Props): Props {
  const out: Props = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string") { const s = collapse(v); if (s) out[k] = s; }
    else if (Array.isArray(v)) {
      const items = v.map((x) => (typeof x === "string" ? collapse(x) : x)).filter((x) => x !== "");
      if (items.length) out[k] = items;
    } else if (v !== undefined && v !== null) out[k] = v;
  }
  if (type === "Person" && Array.isArray(out["email"])) {
    out["email"] = [...new Set((out["email"] as string[]).map((e) => e.replace(/^mailto:/i, "").toLowerCase()))];
  }
  if (type === "ResearchPaper" && typeof out["doi"] === "string") out["doi"] = normDoi(out["doi"]);
  return out;
}

const keyText = (v: unknown): string =>
  Array.isArray(v) ? [...v].map(keyText).sort().join("|") : typeof v === "string" ? collapse(v).toLowerCase() : canonicalJson(v);

/** Stable ID: first identity key group whose properties are all present. */
export function identityOf(type: ObjectType, props: Props): string {
  for (const group of IDENTITY_KEYS[type]) {
    if (group.every((p) => props[p] !== undefined)) {
      return "rc_" + hash32(`${type}\n${group.join("+")}\n${group.map((p) => keyText(props[p])).join("\n")}`);
    }
  }
  // No identity key present: fall back to the whole property set so the ID is still deterministic.
  return "rc_" + hash32(`${type}\n*\n${canonicalJson(props)}`);
}

export function resolve(candidate: Candidate): SemanticObject {
  const badCandidate = violations(validateCandidate, candidate);
  if (badCandidate.length) throw new RecastError("INVALID_CANDIDATE", "candidate fails schema", badCandidate);
  const properties = normalizeProps(candidate.type, clone(candidate.properties));
  const missing = Object.keys(properties).filter((k) => !candidate.fields[k]);
  if (missing.length) throw new RecastError("MISSING_EVIDENCE", "every property needs confidence and evidence", missing);
  const fields = Object.fromEntries(Object.keys(properties).map((k) => [k, clone(candidate.fields[k]!)]));
  const obj = {
    id: identityOf(candidate.type, properties), type: candidate.type, schemaVersion: "1.0.0" as const,
    properties, fields, provenance: clone(candidate.provenance),
  };
  const badObject = violations(validateEnvelope, obj);
  if (badObject.length) throw new RecastError("INVALID_OBJECT", `${candidate.type} fails its schema`, badObject);
  return deepFreeze(obj) as SemanticObject;
}

export const serialize = (o: SemanticObject): string => canonicalJson(o);

export function deserialize(text: string): SemanticObject {
  let data: SemanticObject;
  try { data = JSON.parse(text) as SemanticObject; } catch { throw new RecastError("INVALID_OBJECT", "not valid JSON"); }
  const bad = violations(validateEnvelope, data);
  if (bad.length) throw new RecastError("INVALID_OBJECT", "object fails its schema", bad);
  if (identityOf(data.type, data.properties as Props) !== data.id) throw new RecastError("INVALID_OBJECT", "id does not match identity keys");
  return deepFreeze(data);
}
