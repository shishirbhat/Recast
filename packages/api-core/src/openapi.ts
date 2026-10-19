import { API_VERSION } from "./version";
import type { Capability } from "@recast/release";

/**
 * The public contract of /v1, as OpenAPI 3.1. It is the source the contract tests check every server response against, so a
 * renamed field, a dropped field or an undeclared status code fails a test before it reaches a developer.
 * Response objects are closed (`additionalProperties: false`) so the server cannot leak a field by accident; clients must still
 * ignore fields they do not know, because adding one is not a breaking change (docs/18-api-compatibility.md).
 */
type Schema = Record<string, unknown>;
const ref = (n: string): Schema => ({ $ref: `#/components/schemas/${n}` });
const closed = (properties: Record<string, Schema>, required: string[] = Object.keys(properties)): Schema => ({ type: "object", properties, required, additionalProperties: false });
const str: Schema = { type: "string" }, num: Schema = { type: "number" }, bool: Schema = { type: "boolean" }, strs: Schema = { type: "array", items: str };
const iso: Schema = { type: "string", format: "date-time" };
const receiptId: Schema = { type: "string", pattern: "^rc_r_[0-9a-f]{32}$" };

const schemas: Record<string, Schema> = {
  Error: closed({ error: closed({ code: str, message: str, retry_after: num }, ["code", "message"]) }),
  Health: closed({ status: { const: "ok" } }),
  Provenance: closed({ field: str, source: str, confidence: num, excerpt: str }, ["field", "source", "confidence"]),
  Object: closed({ id: str, type: str, fields: { type: "object" }, confidence: num, trust: str, provenance: { type: "array", items: ref("Provenance") } }, ["id", "type", "fields", "confidence", "trust"]),
  Routing: closed({ destination: str, action: str, relation_id: str, bridge: str, bridge_reliability: str, reliability_label: str, requires_confirmation: bool, consent: str, risk: str, reasons: strs }),
  Meta: closed({ stage: str, schema_version: str, degraded: bool }),
  Resolved: closed({ status: { const: "resolved" }, object: ref("Object"), routing: { oneOf: [ref("Routing"), { type: "null" }] }, route_error: str, alternatives: { type: "array", items: ref("Object") }, degraded: bool, meta: ref("Meta") }, ["status", "object", "routing", "alternatives", "degraded", "meta"]),
  Ambiguous: closed({ status: { const: "ambiguous" }, reason: str, alternatives: { type: "array", items: ref("Object") }, degraded: bool, meta: ref("Meta") }),
  Unresolved: closed({ status: { const: "unresolved" }, reason: str, suggestion: str, degraded: bool, meta: ref("Meta") }, ["status", "reason", "degraded", "meta"]),
  ResolveResult: { oneOf: [ref("Resolved"), ref("Ambiguous"), ref("Unresolved")] },
  BatchItemError: closed({ status: { const: "error" }, error: closed({ code: str, message: str }), index: { type: "integer" } }),
  BatchResult: closed({ results: { type: "array", items: { oneOf: [ref("Resolved"), ref("Ambiguous"), ref("Unresolved"), ref("BatchItemError")] } } }),
  Bridges: closed({ bridges: { type: "array", items: closed({ id: str, name: str, bridge: str, bridge_reliability: str, objects: strs, actions: strs }) } }),
  Capabilities: closed({ capabilities: strs }),
  CorrectionStored: closed({ status: { const: "stored" } }),
  ActionStep: closed({ status: str, at: iso, reason: str }, ["status", "at"]),
  Placement: closed({
    status: { const: "placed" },
    receipt: closed({ id: receiptId, op_id: str, destination: str, relation_id: str, effect: str, reversible: bool, at: iso }),
    action: closed({ status: { const: "succeeded" }, history: { type: "array", items: ref("ActionStep") } }),
    undo: closed({ available: bool, kind: str }, ["available"]),
    object: ref("Object"), data_moved: { type: "array", items: closed({ path: str, value: str }) }, risk: str,
  }),
  PlacementUnknown: closed({ status: { const: "outcome_unknown" }, action_id: receiptId, message: str, next: str }),
  Undone: closed({ status: { const: "undone" }, receipt: closed({ id: str, destination: str, effect: str, at: iso }), action: closed({ status: { const: "reversed" } }) }),
  Reconciled: closed({ status: { enum: ["succeeded", "failed", "reversing", "reversed", "outcome_unknown"] }, action_id: receiptId, changed: bool, message: str }, ["status", "action_id", "changed"]),
  ResolveRequest: { type: "object", required: ["input"], properties: {
    input: { type: "object", required: ["raw"], properties: { raw: str, source_url: str, source_type: str } },
    target: { type: "object", properties: { type: str, destination: str } },
    options: { type: "object", properties: { confidence_threshold: num, include_provenance: bool } } } },
  PlaceRequest: { type: "object", required: ["target"], properties: {
    input: { type: "object", properties: { raw: str } }, object: { type: "object", description: "a complete Recast object instead of text (release: api.place.object)" },
    target: { type: "object", required: ["destination"], properties: { destination: str } }, destination_target: { type: "object" }, object_id: str,
    consent: { type: "object", properties: { kind: { enum: ["release", "confirm", "hold"] }, held_ms: num } } } },
};

const json = (schema: Schema) => ({ "application/json": { schema } });
const res = (description: string, s: string) => ({ description, content: json(ref(s)) });
const errors = (...codes: number[]) => Object.fromEntries(codes.map((c) => [String(c), res(ERROR_TEXT[c] ?? "error", "Error")]));
const ERROR_TEXT: Record<number, string> = {
  400: "invalid request, JSON, version or idempotency key", 401: "missing, invalid or revoked API key", 402: "monthly quota used up", 403: "not allowed: release state, consent, opt-in or connection",
  404: "no such placement for this account", 409: "conflict: idempotency key in use, object changed, already placed or undone", 413: "body too large", 415: "body is not JSON",
  422: "understood but not done: unresolved, unplaceable, incomplete, or idempotency key reused", 429: "rate limited (see Retry-After)", 500: "server error (no details)", 501: "placements are not enabled on this server", 502: "the destination failed or refused the credential",
};
const AUTHED = [400, 401, 429, 500];
const body = (s: string) => ({ required: true, content: json(ref(s)) });
const idem = { name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", maxLength: 255 } };

/** Each operation with the capability that releases it (x-recast-capability), which /v1/openapi.json uses to filter. */
const paths: Record<string, Record<string, Schema & { "x-recast-capability"?: Capability }>> = {
  "/v1/health": { get: { operationId: "health", security: [], responses: { "200": res("the service is up", "Health") } } },
  "/v1/capabilities": { get: { operationId: "capabilities", responses: { "200": res("what this key may use", "Capabilities"), ...errors(...AUTHED) } } },
  "/v1/openapi.json": { get: { operationId: "openapi", responses: { "200": { description: "this document, limited to what this key may use", content: json({ type: "object" }) }, ...errors(...AUTHED) } } },
  "/v1/bridges": { get: { operationId: "bridges", "x-recast-capability": "api.resolve", responses: { "200": res("destinations and what they accept", "Bridges"), ...errors(...AUTHED, 403) } } },
  "/v1/resolve": { post: { operationId: "resolve", "x-recast-capability": "api.resolve", parameters: [idem], requestBody: body("ResolveRequest"), responses: { "200": res("resolved, ambiguous or unresolved", "ResolveResult"), ...errors(...AUTHED, 402, 403, 409, 413, 415, 422) } } },
  "/v1/resolve/batch": { post: { operationId: "resolveBatch", "x-recast-capability": "api.resolve", parameters: [idem], requestBody: { required: true, content: json({ type: "object", required: ["items"], properties: { items: { type: "array", minItems: 1, maxItems: 50, items: ref("ResolveRequest") } } }) }, responses: { "200": res("one result per item, in order", "BatchResult"), ...errors(...AUTHED, 402, 403, 409, 413, 415, 422) } } },
  "/v1/corrections": { post: { operationId: "correction", "x-recast-capability": "api.corrections", requestBody: { required: true, content: json({ type: "object", required: ["object_id", "kind"], properties: { object_id: str, kind: { enum: ["undo", "reject", "edit"] }, field: str, old_value: {}, new_value: {} } }) }, responses: { "201": res("stored (opted-in accounts only)", "CorrectionStored"), ...errors(...AUTHED, 403, 413, 415) } } },
  "/v1/place": { post: { operationId: "place", "x-recast-capability": "api.place", parameters: [idem], requestBody: body("PlaceRequest"), responses: { "201": res("placed and confirmed by the destination", "Placement"), "202": res("sent, but the outcome is unknown; reconcile, never retry", "PlacementUnknown"), ...errors(...AUTHED, 402, 403, 409, 413, 415, 422, 501, 502) } } },
  "/v1/place/undo": { post: { operationId: "undo", "x-recast-capability": "api.place", requestBody: { required: true, content: json(closed({ receipt_id: receiptId })) }, responses: { "200": res("reversed at the destination", "Undone"), ...errors(...AUTHED, 403, 404, 409, 413, 415, 501, 502) } } },
  "/v1/place/reconcile": { post: { operationId: "reconcile", "x-recast-capability": "api.place", requestBody: { required: true, content: json(closed({ action_id: receiptId })) }, responses: { "200": res("what the destination says happened", "Reconciled"), ...errors(...AUTHED, 403, 404, 409, 413, 415, 501, 502) } } },
};

export const OPENAPI = {
  openapi: "3.1.0",
  info: { title: "Recast API", version: API_VERSION, description: "Resolve text into typed objects, and place them into a person's apps. Versioning and compatibility: docs/18-api-compatibility.md." },
  servers: [{ url: "https://api.recast.example" }],
  security: [{ bearer: [] }],
  paths,
  components: { schemas, securitySchemes: { bearer: { type: "http", scheme: "bearer", description: "sk_live_… or sk_test_…" } } },
} as const;

/** The document limited to operations `allowed` returns true for (operations with no capability are always kept). */
export function openapiFor(allowed: (c: Capability) => boolean) {
  const kept: typeof paths = {};
  for (const [p, ops] of Object.entries(paths)) {
    const left = Object.fromEntries(Object.entries(ops).filter(([, op]) => !op["x-recast-capability"] || allowed(op["x-recast-capability"])));
    if (Object.keys(left).length) kept[p] = left;
  }
  return { ...OPENAPI, paths: kept };
}

/** The response schema the contract declares for this operation and status, or why there is none. */
export function declaredResponse(method: string, path: string, status: number): { schema: Schema } | { undeclared: string } {
  const op = paths[path]?.[method.toLowerCase()]; if (!op) return { undeclared: `${method} ${path} is not in the contract` };
  const r = (op.responses as Record<string, { content?: Record<string, { schema: Schema }> }>)[String(status)];
  if (!r) return { undeclared: `${method} ${path} does not declare status ${status}` };
  return { schema: r.content?.["application/json"]?.schema ?? {} };
}
