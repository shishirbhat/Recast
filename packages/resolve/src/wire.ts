import { DESTINATIONS } from "./registry";
import { toApiType, type FieldProvenance, type ResolvedObjectView, type ResolveOutcome, type Routing } from "./types";

const prov = (p: FieldProvenance) => ({ field: p.field, source: p.source, confidence: p.confidence, ...(p.excerpt ? { excerpt: p.excerpt } : {}) });
const obj = (o: ResolvedObjectView, withProv: boolean) => ({ id: o.id, type: o.type, fields: o.fields, confidence: o.confidence, trust: o.trust, ...(withProv ? { provenance: o.provenance.map(prov) } : {}) });
const routing = (r: Routing) => ({
  destination: r.destination, action: r.action, relation_id: r.relationId, bridge: r.bridge, bridge_reliability: r.bridgeReliability, reliability_label: r.reliabilityLabel,
  requires_confirmation: r.requiresConfirmation, consent: r.consent, risk: r.risk, reasons: r.reasons,
});
const meta = (m: ResolveOutcome["meta"]) => ({ stage: m.stage, schema_version: m.schemaVersion, degraded: m.degraded });

/** The public JSON shape (snake_case). The SDK maps it back to camelCase. */
export function toWire(o: ResolveOutcome, includeProvenance = true) {
  if (o.status === "resolved") return { status: o.status, object: obj(o.object, includeProvenance), routing: o.routing ? routing(o.routing) : null, ...(o.routeError ? { route_error: o.routeError } : {}), alternatives: o.alternatives.map((a) => obj(a, includeProvenance)), degraded: o.meta.degraded, meta: meta(o.meta) };
  if (o.status === "ambiguous") return { status: o.status, reason: o.reason, alternatives: o.alternatives.map((a) => obj(a, includeProvenance)), degraded: o.meta.degraded, meta: meta(o.meta) };
  return { status: o.status, reason: o.reason, ...(o.suggestion ? { suggestion: o.suggestion } : {}), degraded: o.meta.degraded, meta: meta(o.meta) };
}
export type WireResolve = ReturnType<typeof toWire>;

/** Every destination, in the public shape of `GET /v1/bridges`. */
export function bridgeCatalog() {
  return Object.entries(DESTINATIONS).map(([id, c]) => ({
    id, name: c.app, bridge: c.destination, bridge_reliability: c.reliability.replace(/-/g, "_"),
    objects: [...new Set(c.accepts.map((a) => a.relationId.split("-")[0]!))].map((s) => toApiType(s === "paper" ? "ResearchPaper" : (s[0]!.toUpperCase() + s.slice(1)) as never)).filter(Boolean),
    actions: c.accepts.map((a) => a.effect),
  }));
}
