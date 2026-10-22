/**
 * The examples on /docs. They are data, so the same list renders the page and drives the test that runs each one against the
 * built server (test/docs.test.ts): an example that stops working fails the build instead of misleading a developer.
 */
export interface Example {
  id: string; title: string; method: "GET" | "POST"; path: string;
  headers?: Record<string, string>; body?: unknown;
  /** What the test expects from a key in the `private` cohort with no placements configured. */
  expect: { status: number; code?: string; header?: [string, string] };
  note?: string;
}

const resolveBody = { input: { raw: "Meera Iyer, meera@example.com, +91 98450 12345" }, target: { destination: "gmail" } };

export const EXAMPLES: Example[] = [
  { id: "resolve", title: "Resolve text into a typed object", method: "POST", path: "/v1/resolve", body: resolveBody, expect: { status: 200 },
    note: "The answer is resolved, ambiguous or unresolved. Each field says how sure it is and where it came from; routing says what placing it would do and what consent it needs." },
  { id: "batch", title: "Resolve up to 50 at once", method: "POST", path: "/v1/resolve/batch",
    body: { items: [{ input: { raw: "Launch dinner, 2026-11-14 19:00, Indiranagar" } }, { input: { raw: "" } }] }, expect: { status: 200 },
    note: "One result per item, in order. A bad item becomes {\"status\":\"error\"} without failing the others." },
  { id: "idempotency", title: "Retry safely", method: "POST", path: "/v1/resolve", headers: { "Idempotency-Key": "order-4711-resolve" }, body: resolveBody, expect: { status: 200 },
    note: "Send the same Idempotency-Key with the same body and you get the first answer again (Idempotent-Replay: true), counted once. The same key with a different body is 422 idempotency_key_reused." },
  { id: "bridges", title: "List destinations", method: "GET", path: "/v1/bridges", expect: { status: 200 } },
  { id: "capabilities", title: "See what your key may use", method: "GET", path: "/v1/capabilities", expect: { status: 200 },
    note: "Capabilities are released to accounts in stages. The server checks every request; this list is for your UI." },
  { id: "contract", title: "Get the contract", method: "GET", path: "/v1/openapi.json", expect: { status: 200 }, note: "OpenAPI 3.1, limited to what your key may use." },
  { id: "place", title: "Place into a destination (not released yet)", method: "POST", path: "/v1/place",
    body: { ...resolveBody, consent: { kind: "confirm" } }, expect: { status: 403, code: "not_available" },
    note: "Placing writes into a person's own accounts. It is released to internal accounts only, so this answers 403 not_available for now. When it is released: 201 with a receipt, or 202 outcome_unknown, which you reconcile (POST /v1/place/reconcile) and never retry." },
  { id: "error", title: "Errors are JSON with a stable code", method: "POST", path: "/v1/resolve", headers: { Authorization: "Bearer sk_test_not_a_real_key_0" }, body: resolveBody,
    expect: { status: 401, code: "unauthorized", header: ["www-authenticate", "Bearer"] } },
];

export function curl(e: Example, base = "https://api.recast.example", key = "$RECAST_API_KEY"): string {
  const h = { Authorization: `Bearer ${key}`, ...(e.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(e.headers ?? {}) };
  return [`curl${e.method === "GET" ? "" : ` -X ${e.method}`} ${base}${e.path}`, ...Object.entries(h).map(([k, v]) => `  -H "${k}: ${v}"`), ...(e.body !== undefined ? [`  -d '${JSON.stringify(e.body)}'`] : [])].join(" \\\n");
}

/** Every code an error can carry, with what to do about it. The test checks this covers everything the server can send. */
export const ERROR_CODES: [code: string, status: number, meaning: string][] = [
  ["invalid_request", 400, "A field is missing or has the wrong type; the message names it."],
  ["invalid_json", 400, "The body is not JSON."],
  ["invalid_object", 400, "A complete object was sent but does not pass the schema."],
  ["invalid_idempotency_key", 400, "Idempotency-Key must be 1 to 255 visible ASCII characters."],
  ["unsupported_version", 400, "X-Recast-Version names a major version this endpoint does not serve."],
  ["empty_input", 400, "input.raw is empty."],
  ["unknown_destination", 400, "target.destination is not one of GET /v1/bridges."],
  ["bad_option", 400, "An option is out of range (for example confidence_threshold)."],
  ["unauthorized", 401, "Missing, unknown or revoked key."],
  ["quota_exceeded", 402, "This month's resolutions are used up; it resets on the 1st (UTC)."],
  ["not_available", 403, "Not released to your account yet."],
  ["consent_required", 403, "This placement needs consent: show the person what will move, then send consent.kind."],
  ["corrections_not_enabled", 403, "Your account has not opted in to storing corrections."],
  ["destination_not_connected", 403, "Connect that destination for this account first."],
  ["not_found", 404, "No such placement for this account."],
  ["idempotency_key_in_use", 409, "A request with this key is still running; retry after Retry-After."],
  ["object_changed", 409, "The text now resolves differently from what you previewed; resolve again."],
  ["already_placed", 409, "It is already there; nothing new was created."],
  ["already_undone", 409, "This placement was already undone."],
  ["undo_in_progress", 409, "Another undo for this placement is running."],
  ["not_reversible", 409, "This placement cannot be undone."],
  ["not_placed", 409, "This placement failed; there is nothing to undo."],
  ["outcome_unknown", 409, "It is not known whether this placement happened; reconcile it first."],
  ["cannot_reconcile", 409, "This destination cannot be checked; look in the destination yourself."],
  ["payload_too_large", 413, "The body is over 512 KB."],
  ["input_too_large", 413, "input.raw is over the length limit."],
  ["unsupported_media_type", 415, "Send Content-Type: application/json."],
  ["idempotency_key_reused", 422, "This key was already used with a different body."],
  ["not_resolved", 422, "Nothing was placed: the text did not resolve."],
  ["not_placeable", 422, "Nothing was placed: the destination cannot take this object."],
  ["incomplete", 422, "Nothing was placed: the destination needs a field the text does not give."],
  ["rate_limited", 429, "Too many requests; wait Retry-After seconds."],
  ["internal_error", 500, "Our fault. No details are returned; retry later."],
  ["not_enabled", 501, "This server does not have placements configured."],
  ["destination_unauthorized", 502, "The destination refused the stored credential; reconnect it."],
  ["destination_error", 502, "The destination failed; the message says how."],
];
