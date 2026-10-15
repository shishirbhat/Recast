import type { BatchItemResult, BridgeInfo, Meta, Provenance, RecastObject, ResolveInput, ResolveResult, Routing } from "./types";

type Json = Record<string, any>;
const prov = (p: Json): Provenance => ({ field: p.field, source: p.source, confidence: p.confidence, ...(p.excerpt ? { excerpt: p.excerpt } : {}) });
const obj = (o: Json): RecastObject => ({ id: o.id, type: o.type, fields: o.fields, confidence: o.confidence, trust: o.trust, ...(o.provenance ? { provenance: o.provenance.map(prov) } : {}) });
const routing = (r: Json): Routing => ({
  destination: r.destination, action: r.action, relationId: r.relation_id, bridge: r.bridge, bridgeReliability: r.bridge_reliability, reliabilityLabel: r.reliability_label,
  requiresConfirmation: r.requires_confirmation, consent: r.consent, risk: r.risk, reasons: r.reasons,
});
const meta = (m: Json): Meta => ({ stage: m.stage, schemaVersion: m.schema_version, degraded: m.degraded });

export function fromWire(j: Json): ResolveResult {
  const base = { degraded: !!j.degraded, meta: meta(j.meta) };
  if (j.status === "resolved") return { status: "resolved", object: obj(j.object), routing: j.routing ? routing(j.routing) : null, ...(j.route_error ? { routeError: j.route_error } : {}), alternatives: (j.alternatives ?? []).map(obj), ...base };
  if (j.status === "ambiguous") return { status: "ambiguous", reason: j.reason, alternatives: (j.alternatives ?? []).map(obj), ...base };
  return { status: "unresolved", reason: j.reason, ...(j.suggestion ? { suggestion: j.suggestion } : {}), ...base };
}
export const batchFromWire = (j: Json): BatchItemResult => (j.status === "error" ? { status: "error", error: j.error, index: j.index } : fromWire(j));
export const bridgeFromWire = (b: Json): BridgeInfo => ({ id: b.id, name: b.name, bridge: b.bridge, bridgeReliability: b.bridge_reliability, objects: b.objects, actions: b.actions });

export function toWireInput(i: ResolveInput): Json {
  return {
    input: { raw: i.raw, ...(i.sourceUrl ? { source_url: i.sourceUrl } : {}), ...(i.sourceType ? { source_type: i.sourceType } : {}) },
    ...(i.target ? { target: { ...(i.target.type ? { type: i.target.type } : {}), ...(i.target.destination ? { destination: i.target.destination } : {}) } } : {}),
    ...(i.options ? { options: { ...(i.options.confidenceThreshold !== undefined ? { confidence_threshold: i.options.confidenceThreshold } : {}), ...(i.options.includeProvenance !== undefined ? { include_provenance: i.options.includeProvenance } : {}) } } : {}),
  };
}
