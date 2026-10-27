import { RecastError, checkConsent, commit, deserialize, hash32, propose, rankProposals, InMemoryEventLog, OutcomeUnknownError, plan, undo as coreUndo, type ActionStep, type Consent, type Proposal, type Receipt, type SemanticObject } from "@recast/core";
import { DestinationError, DuplicateError, HttpBridge } from "@recast/bridges";
import { sha256Hex } from "@recast/core";
import { API_TYPES, DESTINATIONS, ResolveInputError, bridgeCatalog, toApiType, toWire, type ResolveOutcome, type ApiType, type ResolveInput, type Resolver } from "@recast/resolve";
import { createRelease, type Capability, type Release } from "@recast/release";
import { openapiFor } from "./openapi";
import { RateLimiter, type Limiter } from "./limiter";
import { MemoryCorrectionStore, MemoryIdempotencyStore, MemoryUsageStore, hashKey, type ApiKeyRecord, type CorrectionStore, type IdempotencyStore, type KeyStore, type UsageStore } from "./stores";
import { TIERS } from "./tiers";
import { checkVersion, type Deprecation } from "./version";
import { PLACE_TARGETS, PlaceInputError, fetchTransport, type PlacementDeps } from "./place";

export interface ApiDeps {
  resolver: Resolver; keys: KeyStore;
  usage?: UsageStore; corrections?: CorrectionStore; now?: () => number; deprecated?: Deprecation[];
  /** Shared implementations (SqlRateLimiter, SqlIdempotencyStore) make limits and replays hold across server instances. */
  limiter?: Limiter; idempotency?: IdempotencyStore;
  /** Enables POST /v1/place and /v1/place/undo. Without it those answer 501. */
  placement?: PlacementDeps;
  maxBodyBytes?: number; maxBatch?: number;
  /** Release states (docs/RELEASE_STATES.md). Checked here, on the server, for every request; defaults to the registry. */
  release?: Release;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7);

/** A request that was accepted but whose result is not known (HTTP 202). Thrown so the idempotency record still completes. */
class Accepted extends Error { constructor(readonly json: Record<string, unknown>) { super("accepted"); } }
class HttpError extends Error { constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, string> = {}) { super(message); } }
const err = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { code, message, ...(headers["Retry-After"] ? { retry_after: Number(headers["Retry-After"]) } : {}) } }), { status, headers: { ...JSON_HEADERS, ...headers } });

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Wire (snake_case) -> engine input, with every field checked. */
export function parseResolveInput(v: unknown, where = "body"): ResolveInput {
  if (!isObj(v)) throw new HttpError(400, "invalid_request", `${where} must be an object`);
  const input = v.input; if (!isObj(input) || typeof input.raw !== "string") throw new HttpError(400, "invalid_request", `${where}.input.raw must be a string`);
  const out: ResolveInput = { raw: input.raw };
  if (input.source_url !== undefined) { if (typeof input.source_url !== "string") throw new HttpError(400, "invalid_request", `${where}.input.source_url must be a string`); out.sourceUrl = input.source_url; }
  if (input.source_type !== undefined) { if (typeof input.source_type !== "string") throw new HttpError(400, "invalid_request", `${where}.input.source_type must be a string`); out.sourceType = input.source_type; }
  if (v.target !== undefined) {
    if (!isObj(v.target)) throw new HttpError(400, "invalid_request", `${where}.target must be an object`);
    const t = v.target; out.target = {};
    if (t.type !== undefined) { if (typeof t.type !== "string" || !(API_TYPES as readonly string[]).includes(t.type)) throw new HttpError(400, "invalid_request", `${where}.target.type must be one of ${API_TYPES.join(", ")}`); out.target.type = t.type as ApiType; }
    if (t.destination !== undefined) { if (typeof t.destination !== "string") throw new HttpError(400, "invalid_request", `${where}.target.destination must be a string`); out.target.destination = t.destination; }
  }
  if (v.options !== undefined) {
    if (!isObj(v.options)) throw new HttpError(400, "invalid_request", `${where}.options must be an object`);
    const o = v.options; out.options = {};
    if (o.confidence_threshold !== undefined) { if (typeof o.confidence_threshold !== "number") throw new HttpError(400, "invalid_request", `${where}.options.confidence_threshold must be a number`); out.options.confidenceThreshold = o.confidence_threshold; }
    if (o.include_provenance !== undefined) { if (typeof o.include_provenance !== "boolean") throw new HttpError(400, "invalid_request", `${where}.options.include_provenance must be a boolean`); out.options.includeProvenance = o.include_provenance; }
  }
  return out;
}

export function createApi(deps: ApiDeps) {
  const now = deps.now ?? Date.now;
  const usage = deps.usage ?? new MemoryUsageStore();
  const corrections = deps.corrections ?? new MemoryCorrectionStore();
  const idem = deps.idempotency ?? new MemoryIdempotencyStore(); const limiter = deps.limiter ?? new RateLimiter(now);
  const maxBody = deps.maxBodyBytes ?? 512 * 1024, maxBatch = deps.maxBatch ?? 50;
  const release = deps.release ?? createRelease();
  /** Same answer whether the capability is unreleased to this cohort or disabled: it does not tell outsiders what exists. */
  const gate = (c: Capability, key: ApiKeyRecord) => { if (!release.allows(c, key.cohort)) throw new HttpError(403, "not_available", "this capability is not available to this account"); };

  async function readJson(req: Request): Promise<unknown> {
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > maxBody) throw new HttpError(413, "payload_too_large", `body is larger than ${maxBody} bytes`);
    const text = await req.text();
    if (new TextEncoder().encode(text).length > maxBody) throw new HttpError(413, "payload_too_large", `body is larger than ${maxBody} bytes`);
    if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) throw new HttpError(415, "unsupported_media_type", "send Content-Type: application/json");
    try { return JSON.parse(text); } catch { throw new HttpError(400, "invalid_json", "body is not valid JSON"); }
  }

  async function authenticate(req: Request) {
    const h = req.headers.get("authorization") ?? "";
    const m = /^Bearer\s+(sk_[A-Za-z0-9_-]{8,200})$/.exec(h);
    if (!m) throw new HttpError(401, "unauthorized", "send Authorization: Bearer sk_...", { "WWW-Authenticate": "Bearer" });
    const rec = await deps.keys.find(await hashKey(m[1]!));
    if (!rec || rec.revoked) throw new HttpError(401, "unauthorized", "invalid or revoked API key", { "WWW-Authenticate": "Bearer" });
    return rec;
  }

  const placementOrThrow = () => { if (!deps.placement) throw new HttpError(501, "not_enabled", "placements are not enabled on this server"); return deps.placement; };
  const parseConsent = (v: unknown): Consent => {
    if (v === undefined) return { kind: "release" };
    if (!isObj(v) || !["release", "confirm", "hold"].includes(String(v.kind))) throw new HttpError(400, "invalid_request", "consent.kind must be release, confirm or hold");
    if (v.kind === "hold") { if (typeof v.held_ms !== "number" || !(v.held_ms >= 0)) throw new HttpError(400, "invalid_request", "consent.held_ms must be a number for kind hold"); return { kind: "hold", heldMs: v.held_ms }; }
    return { kind: v.kind as "release" | "confirm" };
  };
  const destinationFailure = (e: unknown): never => {
    if (e instanceof DestinationError) {
      const auth = e.status === 401 || e.status === 403;
      throw new HttpError(502, auth ? "destination_unauthorized" : "destination_error", auth ? "the destination refused the stored credential; reconnect it" : `the destination failed: ${e.message}`);
    }
    throw e;
  };

  /** Re-resolves, then plans, checks consent and commits through the bridge: the same pipeline as the desktop app, server-side. */
  async function place(key: ApiKeyRecord, body: unknown) {
    const tenantId = key.tenantId;
    const hasObject = isObj(body) && (body as Record<string, unknown>).object !== undefined;
    if (hasObject) gate("api.place.object", key);
    const pd = placementOrThrow();
    const input = parseResolveInput(hasObject ? { ...(body as Record<string, unknown>), input: { raw: "(object)" } } : body); const destination = input.target?.destination;
    if (!destination) throw new HttpError(400, "invalid_request", "target.destination is required to place");
    const b = body as Record<string, unknown>; const dt = PLACE_TARGETS[destination];
    if (!dt) throw new HttpError(400, "invalid_request", `cannot place into '${destination}'`);
    let target: Record<string, string>;
    try { target = dt.parse(isObj(b.destination_target) ? b.destination_target : {}); }
    catch (e) { if (e instanceof PlaceInputError) throw new HttpError(400, "invalid_request", e.message.replace("target.", "destination_target.")); throw e; }
    const consent = parseConsent(b.consent);
    if (b.object_id !== undefined && typeof b.object_id !== "string") throw new HttpError(400, "invalid_request", "object_id must be a string");

    let outcome: ResolveOutcome; let proposal: Proposal | null;
    if (b.object !== undefined) {
      // A complete object (for example composed on the device from pieces the person picked). It must pass the schema and
      // its content id must match its properties; then it goes through exactly the same checks as a resolved one.
      let obj: SemanticObject;
      try { obj = deserialize(JSON.stringify(b.object)); } catch (e) { throw new HttpError(400, "invalid_object", `object is not a valid Recast object: ${e instanceof Error ? e.message : String(e)}`); }
      const contract = DESTINATIONS[destination]!;
      proposal = rankProposals(propose(obj, contract)).find((p) => p.status === "ready") ?? null;
      outcome = { status: "resolved", object: { id: obj.id, type: toApiType(obj.type) ?? "Document", fields: { ...obj.properties }, confidence: Math.min(...Object.values(obj.fields).map((f) => f.confidence)), trust: "medium", provenance: [] }, routing: null, alternatives: [], meta: { stage: "rules", schemaVersion: "1.0.0", degraded: false } };
      if (!proposal) throw new HttpError(422, "not_placeable", `nothing was placed: ${contract.app} cannot take this ${obj.type}`);
    } else {
      ({ outcome, proposal } = await deps.resolver.prepare(input));
      if (outcome.status !== "resolved") throw new HttpError(422, "not_resolved", `nothing was placed: ${outcome.reason}`);
      if (!proposal) throw new HttpError(422, "not_placeable", `nothing was placed: ${outcome.routeError ?? "no route to this destination"}`);
    }
    if (b.object_id !== undefined && b.object_id !== outcome.object.id) throw new HttpError(409, "object_changed", "the text now resolves to a different object than the one you previewed; resolve again and confirm");

    const iso = () => new Date(now()).toISOString();
    const op = plan(proposal, { now: iso });
    try { checkConsent(op, consent); }
    catch (e) { if (e instanceof RecastError) throw new HttpError(403, "consent_required", `this placement needs consent '${op.risk.consent}' (${op.risk.reasons.join("; ")}); send consent.kind accordingly after showing the person what will move`); throw e; }
    const cred = await pd.credentials.get(tenantId, destination);
    if (!cred) throw new HttpError(403, "destination_not_connected", `connect ${destination} for this account before placing into it`);

    const bridge = new HttpBridge(dt.spec, target, fetchTransport(cred.accessToken, pd.fetch, pd.timeoutMs));
    const caps = bridge.capabilities(op.proposal.relationId);
    const needs = bridge.check(op);
    if (needs.length) throw new HttpError(422, "incomplete", `nothing was placed: ${destination} needs ${needs.join(", ")}, which the text does not give`);
    // Lifecycle: proposed and validated (resolved, consent checked, connected), then executing.
    const action: ActionStep[] = [{ status: "proposed", at: op.at }, { status: "validated", at: iso() }, { status: "executing", at: iso() }];
    const provisional = (bridgeRef?: string): Receipt => ({
      receiptId: `rc_r_${hash32(`${op.opId}\ncommit`)}`, opId: op.opId, at: iso(), status: "done", objectId: op.proposal.object.id,
      destination: op.proposal.destination.destination, relationId: op.proposal.relationId, effect: op.proposal.effect, reversible: op.proposal.reversible, ...(bridgeRef ? { bridgeRef } : {}),
    });
    const wireObject = (toWire(outcome, false) as { object: unknown }).object;
    let receipt: Receipt;
    try {
      receipt = await commit(op, consent, { bridge, log: new InMemoryEventLog(), now: iso });
    } catch (e) {
      if (e instanceof OutcomeUnknownError) {
        const r = provisional(e.reconcileRef);
        await pd.placements.save({ tenantId, destination, target, receipt: r, dataMoved: op.dataMoved, status: "outcome_unknown", action: [...action, { status: "outcome_unknown", at: iso(), reason: e.message }], ...(e.reconcileRef ? { reconcileRef: e.reconcileRef } : {}) });
        // 202: the provider may or may not have done it. Never reported as success, never silently retried.
        throw new Accepted({ status: "outcome_unknown", action_id: r.receiptId, message: `${e.message}. Recast has not retried it.`,
          // Only when the bridge can actually ask about a lost write (being readable afterwards is not enough).
          next: e.reconcileRef && dt.spec.reconcile ? "POST /v1/place/reconcile with this action_id to check with the destination" : "check the destination yourself before trying again: this destination cannot be checked or retried safely" });
      }
      if (e instanceof DuplicateError) throw new HttpError(409, "already_placed", "this is already in that destination; nothing new was created");
      const r = provisional();
      await pd.placements.save({ tenantId, destination, target, receipt: r, dataMoved: op.dataMoved, status: "failed", action: [...action, { status: "failed", at: iso(), reason: e instanceof Error ? e.message : String(e) }] });
      return destinationFailure(e);
    }
    const done: ActionStep[] = [...action, { status: "succeeded", at: receipt.at }];
    await pd.placements.save({ tenantId, destination, target, receipt, dataMoved: op.dataMoved, status: "succeeded", action: done });
    const undoAvailable = receipt.reversible && caps?.reversal !== "none";
    return {
      status: "placed",
      receipt: { id: receipt.receiptId, op_id: receipt.opId, destination, relation_id: receipt.relationId, effect: receipt.effect, reversible: undoAvailable, at: receipt.at },
      action: { status: "succeeded", history: done }, undo: { available: undoAvailable, ...(caps ? { kind: caps.reversal } : {}) },
      object: wireObject, data_moved: op.dataMoved, risk: op.risk.tier,
    };
  }

  async function undoPlacement(tenantId: string, receiptId: string) {
    const pd = placementOrThrow();
    const rec = await pd.placements.get(tenantId, receiptId);
    if (!rec) throw new HttpError(404, "not_found", "no placement with this receipt for this account");
    if (rec.status === "outcome_unknown") throw new HttpError(409, "outcome_unknown", "it is not known whether this placement happened; reconcile it first");
    if (rec.status === "failed") throw new HttpError(409, "not_placed", "this placement failed; there is nothing to undo");
    const dt = PLACE_TARGETS[rec.destination]!;
    const caps = dt.spec.capabilities[rec.receipt.relationId];
    if (!rec.receipt.reversible || caps?.reversal === "none") throw new HttpError(409, "not_reversible", "this placement cannot be undone");
    if (!(await pd.placements.claimUndo(tenantId, receiptId))) throw new HttpError(409, rec.status === "reversed" ? "already_undone" : "undo_in_progress", rec.status === "reversed" ? "this placement was already undone" : "an undo for this placement is already running");
    let ok = false;
    try {
      const cred = await pd.credentials.get(tenantId, rec.destination);
      if (!cred) throw new HttpError(403, "destination_not_connected", `reconnect ${rec.destination} to undo`);
      const bridge = new HttpBridge(dt.spec, rec.target, fetchTransport(cred.accessToken, pd.fetch, pd.timeoutMs));
      const log = new InMemoryEventLog(); await log.append({ kind: "commit", at: rec.receipt.at, receipt: rec.receipt });
      const undone = await coreUndo(rec.receipt, { bridge, log, now: () => new Date(now()).toISOString() }).catch(destinationFailure);
      ok = true; await pd.placements.finishUndo(tenantId, receiptId, true, { status: "reversed", at: undone.at }, undone);
      return { status: "undone", receipt: { id: undone.receiptId, destination: rec.destination, effect: undone.effect, at: undone.at }, action: { status: "reversed" } };
    } finally { if (!ok) await pd.placements.finishUndo(tenantId, receiptId, false, { status: "succeeded", at: new Date(now()).toISOString() }); }
  }

  /** Ask the destination whether an unknown-outcome placement happened. Reads only; never sends the write again. */
  async function reconcilePlacement(tenantId: string, receiptId: string) {
    const pd = placementOrThrow();
    const rec = await pd.placements.get(tenantId, receiptId);
    if (!rec) throw new HttpError(404, "not_found", "no placement with this id for this account");
    if (rec.status !== "outcome_unknown") return { status: rec.status, action_id: receiptId, changed: false };
    const dt = PLACE_TARGETS[rec.destination]!;
    if (!rec.reconcileRef || !dt.spec.reconcile) throw new HttpError(409, "cannot_reconcile", "this destination cannot be checked; look in the destination before trying again");
    const cred = await pd.credentials.get(tenantId, rec.destination);
    if (!cred) throw new HttpError(403, "destination_not_connected", `reconnect ${rec.destination} to check`);
    const bridge = new HttpBridge(dt.spec, rec.target, fetchTransport(cred.accessToken, pd.fetch, pd.timeoutMs));
    const found = await bridge.reconcile(rec.reconcileRef).catch(destinationFailure);
    const to = found === "present" ? "succeeded" : "failed";
    const changed = await pd.placements.resolveUnknown(tenantId, receiptId, to, { status: to, at: new Date(now()).toISOString(), reason: found === "present" ? "found at the destination" : "not found at the destination" });
    return { status: to, action_id: receiptId, changed, ...(to === "failed" ? { message: "nothing was created; it is safe to place again" } : {}) };
  }

  /** Undo and reconcile only touch placements the account already made, so narrowing a release never strands them. Only the
   *  `disabled` kill switch stops them, because they also call the destination. */
  const settleGate = () => { if (release.state("api.place") === "disabled") throw new HttpError(403, "not_available", "this capability is not available to this account"); };

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url); const path = url.pathname.replace(/\/+$/, "") || "/";
    const base: Record<string, string> = {};
    try {
      if (path === "/v1/health" && req.method === "GET") return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: JSON_HEADERS });
      if (!path.startsWith("/v1/")) throw new HttpError(404, "not_found", "unknown endpoint");

      const ver = checkVersion(req.headers.get("x-recast-version"), deps.deprecated);
      if (!ver.ok) throw new HttpError(400, "unsupported_version", ver.message);
      Object.assign(base, ver.headers);

      const key = await authenticate(req); const limits = TIERS[key.tier];
      const rl = await limiter.take(key.tenantId, limits.rps, limits.burst);
      base["RateLimit-Limit"] = String(limits.rps);
      if (!rl.ok) throw new HttpError(429, "rate_limited", "too many requests", { "Retry-After": String(rl.retryAfterSec) });
      base["RateLimit-Remaining"] = String(rl.remaining);
      const month = monthOf(now()); const used = await usage.get(key.tenantId, month);
      const quotaHeaders = (u: number) => ({ "X-Recast-Quota-Limit": String(limits.monthly === Number.MAX_SAFE_INTEGER ? "unlimited" : limits.monthly), "X-Recast-Quota-Used": String(u) });

      if (path === "/v1/openapi.json" && req.method === "GET") {
        return new Response(JSON.stringify(openapiFor((c) => release.allows(c, key.cohort))), { status: 200, headers: { ...JSON_HEADERS, ...base } });
      }
      if (path === "/v1/capabilities" && req.method === "GET") {
        // Only what this account can use; unreleased names are not listed.
        const available = release.table().filter((r) => ["api", "sdk", "mcp"].includes(r.surface) && release.allows(r.capability, key.cohort)).map((r) => r.capability);
        return new Response(JSON.stringify({ capabilities: available }), { status: 200, headers: { ...JSON_HEADERS, ...base } });
      }
      if (path === "/v1/bridges" && req.method === "GET") {
        gate("api.resolve", key);
        const list = bridgeCatalog();
        return new Response(JSON.stringify({ bridges: list }), { status: 200, headers: { ...JSON_HEADERS, ...base } });
      }

      if (path === "/v1/corrections" && req.method === "POST") {
        gate("api.corrections", key);
        if (!key.correctionsOptIn) throw new HttpError(403, "corrections_not_enabled", "this account has not opted in to storing corrections; nothing was saved");
        const b = await readJson(req); if (!isObj(b) || typeof b.object_id !== "string" || !["undo", "reject", "edit"].includes(String(b.kind))) throw new HttpError(400, "invalid_request", "object_id (string) and kind (undo|reject|edit) are required");
        await corrections.add({ tenantId: key.tenantId, objectId: b.object_id, kind: b.kind as "undo", ...(typeof b.field === "string" ? { field: b.field } : {}), oldValue: b.old_value, newValue: b.new_value, at: new Date(now()).toISOString() });
        return new Response(JSON.stringify({ status: "stored" }), { status: 201, headers: { ...JSON_HEADERS, ...base } });
      }

      if (path === "/v1/place/reconcile" && req.method === "POST") {
        settleGate();
        const b = await readJson(req);
        if (!isObj(b) || typeof b.action_id !== "string" || !/^rc_r_[0-9a-f]{32}$/.test(b.action_id)) throw new HttpError(400, "invalid_request", "action_id must be an id from POST /v1/place");
        return new Response(JSON.stringify(await reconcilePlacement(key.tenantId, b.action_id)), { status: 200, headers: { ...JSON_HEADERS, ...base } });
      }
      if (path === "/v1/place/undo" && req.method === "POST") {
        settleGate();
        const b = await readJson(req);
        if (!isObj(b) || typeof b.receipt_id !== "string" || !/^rc_r_[0-9a-f]{32}$/.test(b.receipt_id)) throw new HttpError(400, "invalid_request", "receipt_id must be a receipt id from POST /v1/place");
        return new Response(JSON.stringify(await undoPlacement(key.tenantId, b.receipt_id)), { status: 200, headers: { ...JSON_HEADERS, ...base } });
      }

      if ((path === "/v1/resolve" || path === "/v1/resolve/batch" || path === "/v1/place") && req.method === "POST") {
        gate(path === "/v1/place" ? "api.place" : "api.resolve", key);
        const limit = limits.monthly;
        if (used >= limit) throw new HttpError(402, "quota_exceeded", `monthly quota of ${limit} resolutions is used up; it resets on the 1st (UTC) or upgrade your plan`, quotaHeaders(used));
        const body = await readJson(req);

        const ik = req.headers.get("idempotency-key");
        let idemKey: string | undefined; const bodyHash = await sha256Hex(path + "\n" + JSON.stringify(body));
        if (ik !== null) {
          if (!/^[\x21-\x7e]{1,255}$/.test(ik)) throw new HttpError(400, "invalid_idempotency_key", "Idempotency-Key must be 1 to 255 visible ASCII characters");
          const claim = await idem.begin(key.tenantId, ik, bodyHash, now());
          if (claim.state === "mismatch") throw new HttpError(422, "idempotency_key_reused", "this Idempotency-Key was already used with a different request");
          if (claim.state === "in_progress") throw new HttpError(409, "idempotency_key_in_use", "a request with this Idempotency-Key is still running; retry shortly", { "Retry-After": "1" });
          if (claim.state === "replay") return new Response(JSON.stringify(claim.record.json), { status: claim.record.status, headers: { ...JSON_HEADERS, ...base, ...quotaHeaders(used), "Idempotent-Replay": "true" } });
          idemKey = ik;
        }

        let resolved = 0; let json: unknown; let status = 200; let newUsed = used;
        try {
          const run = async (input: ResolveInput) => {
            const o = await deps.resolver.resolve(input); if (o.status === "resolved") resolved++;
            return toWire(o, input.options?.includeProvenance ?? true);
          };
          if (path === "/v1/place") {
            try { json = await place(key, body); status = 201; }
            catch (e) { if (!(e instanceof Accepted)) throw e; json = e.json; status = 202; }
            resolved = 1;
          } else if (path === "/v1/resolve") {
            json = await run(parseResolveInput(body));
          } else {
            if (!isObj(body) || !Array.isArray(body.items)) throw new HttpError(400, "invalid_request", "body.items must be an array");
            if (body.items.length === 0 || body.items.length > maxBatch) throw new HttpError(400, "invalid_request", `body.items must have 1 to ${maxBatch} items`);
            const inputs = body.items.map((it, i) => parseResolveInput(it, `items[${i}]`));
            const results: unknown[] = [];
            for (const [i, input] of inputs.entries()) {
              try { results.push(await run(input)); }
              catch (e) { if (e instanceof ResolveInputError) results.push({ status: "error", error: { code: e.code, message: e.message }, index: i }); else throw e; }
            }
            json = { results };
          }
          newUsed = resolved ? await usage.add(key.tenantId, month, resolved) : used;
          if (idemKey) await idem.complete(key.tenantId, idemKey, { bodyHash, status, json, at: now() });
        } catch (e) { if (idemKey) await idem.abort(key.tenantId, idemKey).catch(() => {}); throw e; }   // a failed request can be retried with the same key
        return new Response(JSON.stringify(json), { status, headers: { ...JSON_HEADERS, ...base, ...quotaHeaders(newUsed) } });
      }

      throw new HttpError(404, "not_found", "unknown endpoint");
    } catch (e) {
      if (e instanceof HttpError) return err(e.status, e.code, e.message, { ...base, ...e.extra });
      if (e instanceof ResolveInputError) return err(e.code === "input_too_large" ? 413 : 400, e.code, e.message, base);
      return err(500, "internal_error", "something went wrong on our side", base);   // details are not leaked
    }
  }
  return { handle };
}
export type Api = ReturnType<typeof createApi>;
