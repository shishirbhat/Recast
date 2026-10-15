import { sha256Hex } from "@recast/core";
import { API_TYPES, DESTINATIONS, ResolveInputError, toApiType, toWire, type ApiType, type ResolveInput, type Resolver } from "@recast/resolve";
import { RateLimiter } from "./limiter";
import { MemoryCorrectionStore, MemoryIdempotencyStore, MemoryUsageStore, hashKey, type CorrectionStore, type KeyStore, type UsageStore } from "./stores";
import { TIERS } from "./tiers";
import { checkVersion, type Deprecation } from "./version";

export interface ApiDeps {
  resolver: Resolver; keys: KeyStore;
  usage?: UsageStore; corrections?: CorrectionStore; now?: () => number; deprecated?: Deprecation[];
  maxBodyBytes?: number; maxBatch?: number;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7);

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
  const idem = new MemoryIdempotencyStore(); const limiter = new RateLimiter(now);
  const maxBody = deps.maxBodyBytes ?? 512 * 1024, maxBatch = deps.maxBatch ?? 50;

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
      const rl = limiter.take(key.tenantId, limits.rps, limits.burst);
      base["RateLimit-Limit"] = String(limits.rps);
      if (!rl.ok) throw new HttpError(429, "rate_limited", "too many requests", { "Retry-After": String(rl.retryAfterSec) });
      base["RateLimit-Remaining"] = String(rl.remaining);
      const month = monthOf(now()); const used = await usage.get(key.tenantId, month);
      const quotaHeaders = (u: number) => ({ "X-Recast-Quota-Limit": String(limits.monthly === Number.MAX_SAFE_INTEGER ? "unlimited" : limits.monthly), "X-Recast-Quota-Used": String(u) });

      if (path === "/v1/bridges" && req.method === "GET") {
        const list = Object.entries(DESTINATIONS).map(([id, c]) => ({
          id, name: c.app, bridge: c.destination, bridge_reliability: c.reliability.replace(/-/g, "_"),
          objects: [...new Set(c.accepts.map((a) => a.relationId.split("-")[0]!))].map((s) => toApiType(s === "paper" ? "ResearchPaper" : (s[0]!.toUpperCase() + s.slice(1)) as never)).filter(Boolean),
          actions: c.accepts.map((a) => a.effect),
        }));
        return new Response(JSON.stringify({ bridges: list }), { status: 200, headers: { ...JSON_HEADERS, ...base } });
      }

      if (path === "/v1/corrections" && req.method === "POST") {
        if (!key.correctionsOptIn) throw new HttpError(403, "corrections_not_enabled", "this account has not opted in to storing corrections; nothing was saved");
        const b = await readJson(req); if (!isObj(b) || typeof b.object_id !== "string" || !["undo", "reject", "edit"].includes(String(b.kind))) throw new HttpError(400, "invalid_request", "object_id (string) and kind (undo|reject|edit) are required");
        await corrections.add({ tenantId: key.tenantId, objectId: b.object_id, kind: b.kind as "undo", ...(typeof b.field === "string" ? { field: b.field } : {}), oldValue: b.old_value, newValue: b.new_value, at: new Date(now()).toISOString() });
        return new Response(JSON.stringify({ status: "stored" }), { status: 201, headers: { ...JSON_HEADERS, ...base } });
      }

      if ((path === "/v1/resolve" || path === "/v1/resolve/batch") && req.method === "POST") {
        const limit = limits.monthly;
        if (used >= limit) throw new HttpError(402, "quota_exceeded", `monthly quota of ${limit} resolutions is used up; it resets on the 1st (UTC) or upgrade your plan`, quotaHeaders(used));
        const body = await readJson(req);

        const ik = req.headers.get("idempotency-key");
        let idemKey: string | undefined; const bodyHash = await sha256Hex(path + "\n" + JSON.stringify(body));
        if (ik !== null) {
          if (!/^[\x21-\x7e]{1,255}$/.test(ik)) throw new HttpError(400, "invalid_idempotency_key", "Idempotency-Key must be 1 to 255 visible ASCII characters");
          idemKey = `${key.tenantId}|${ik}`;
          const prev = idem.get(idemKey, now());
          if (prev) {
            if (prev.bodyHash !== bodyHash) throw new HttpError(422, "idempotency_key_reused", "this Idempotency-Key was already used with a different request");
            return new Response(JSON.stringify(prev.json), { status: prev.status, headers: { ...JSON_HEADERS, ...base, ...quotaHeaders(used), "Idempotent-Replay": "true" } });
          }
        }

        let resolved = 0; let json: unknown; let status = 200;
        const run = async (input: ResolveInput) => {
          const o = await deps.resolver.resolve(input); if (o.status === "resolved") resolved++;
          return toWire(o, input.options?.includeProvenance ?? true);
        };
        if (path === "/v1/resolve") {
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
        const newUsed = resolved ? await usage.add(key.tenantId, month, resolved) : used;
        if (idemKey) idem.set(idemKey, { bodyHash, status, json, at: now() });
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
