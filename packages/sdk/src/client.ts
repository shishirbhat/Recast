import { batchFromWire, bridgeFromWire, fromWire, toWireInput } from "./convert";
import { AuthError, CircuitOpenError, DestinationError, NetworkError, QuotaError, RateLimitError, RecastError, ServerError, ValidationError } from "./errors";
import type { BatchItemResult, BridgeInfo, CorrectionInput, ObjectType, PlaceInput, Placement, PlacementUnknown, ResolveInput, ResolveResult, Usage } from "./types";

export interface RecastConfig {
  apiKey: string;
  baseUrl?: string;                 // default https://api.recast.dev
  maxRetries?: number;              // default 2 (so up to 3 attempts)
  timeoutMs?: number;               // default 15000
  cacheTtlMs?: number;              // default 24h; 0 turns the cache off
  fetch?: typeof fetch;             // inject for tests or unusual runtimes
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  version?: string;                 // sent as X-Recast-Version
  circuit?: { threshold?: number; cooldownMs?: number };
}

const uuid = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);

export class Recast {
  private cfg: Required<Pick<RecastConfig, "baseUrl" | "maxRetries" | "timeoutMs" | "cacheTtlMs">> & RecastConfig;
  private cache = new Map<string, { at: number; value: ResolveResult }>();
  private failures = 0; private openedAt = 0;
  /** Quota numbers from the last response, so callers can warn before they hit the wall. */
  lastUsage: Usage = { limit: null, used: null };
  private schemaVersion: string | null = null;

  constructor(config: RecastConfig) {
    if (!config?.apiKey) throw new RecastError("apiKey is required", "config");
    this.cfg = { baseUrl: "https://api.recast.dev", maxRetries: 2, timeoutMs: 15_000, cacheTtlMs: 24 * 3600_000, ...config };
    this.cfg.baseUrl = this.cfg.baseUrl.replace(/\/+$/, "");
  }
  private now = () => (this.cfg.now ?? Date.now)();
  private sleep = (ms: number) => (this.cfg.sleep ?? ((m: number) => new Promise<void>((r) => setTimeout(r, m))))(ms);

  private circuitOpen() { const { threshold = 5, cooldownMs = 30_000 } = this.cfg.circuit ?? {}; return this.failures >= threshold && this.now() - this.openedAt < cooldownMs; }

  private async request(method: "GET" | "POST", path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ json: any; headers: Headers }> {
    if (this.circuitOpen()) throw new CircuitOpenError();
    const f = this.cfg.fetch ?? fetch; const headers: Record<string, string> = { authorization: `Bearer ${this.cfg.apiKey}`, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(this.cfg.version ? { "x-recast-version": this.cfg.version } : {}), ...extra };
    let last: unknown;
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), this.cfg.timeoutMs);
        let res: Response;
        try { res = await f(this.cfg.baseUrl + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: ctl.signal }); }
        finally { clearTimeout(t); }
        this.noteUsage(res.headers);
        const text = await res.text(); let json: any; try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
        if (res.ok) { this.failures = 0; return { json, headers: res.headers }; }
        const msg = json?.error?.message ?? `HTTP ${res.status}`; const code = json?.error?.code ?? "error";
        if (res.status === 401) throw new AuthError(msg);
        if (res.status === 402) throw new QuotaError(msg, this.lastUsage.used, typeof this.lastUsage.limit === "number" ? this.lastUsage.limit : null);
        if (res.status === 429) { const ra = Number(res.headers.get("retry-after") ?? 1); if (attempt < this.cfg.maxRetries) { await this.sleep(ra * 1000); continue; } throw new RateLimitError(msg, ra); }
        if (res.status === 502 && /^destination_/.test(code)) throw new DestinationError(msg, code);
        if (res.status >= 500) { if (attempt < this.cfg.maxRetries) { await this.sleep(this.backoff(attempt)); continue; } this.fail(); throw new ServerError(msg, res.status); }
        throw new ValidationError(msg, code, res.status);          // other 4xx: the request is wrong, retrying cannot help
      } catch (e) {
        if (e instanceof RecastError && !(e instanceof NetworkError)) throw e;
        last = e;
        if (attempt < this.cfg.maxRetries) { await this.sleep(this.backoff(attempt)); continue; }
        this.fail(); throw new NetworkError(e instanceof Error ? e.message : String(e));
      }
    }
    throw new NetworkError(String(last));
  }
  private backoff(attempt: number) { return Math.min(1000 * 2 ** attempt, 8000) + Math.floor(Math.random() * 250); }
  private fail() { this.failures++; this.openedAt = this.now(); }
  private noteUsage(h: Headers) {
    const used = h.get("x-recast-quota-used"), limit = h.get("x-recast-quota-limit");
    if (used !== null) this.lastUsage = { used: Number(used), limit: limit === "unlimited" ? "unlimited" : limit === null ? null : Number(limit) };
  }

  /** Turn raw text into a typed object, optionally with a route to a destination. Never throws for "couldn't tell": check `status`. */
  async resolve(input: ResolveInput, opts: { bypassCache?: boolean } = {}): Promise<ResolveResult> {
    const wire = toWireInput(input); const key = JSON.stringify(wire);
    if (this.cfg.cacheTtlMs > 0 && !opts.bypassCache) {
      const hit = this.cache.get(key);
      if (hit && this.now() - hit.at < this.cfg.cacheTtlMs) return hit.value;
    }
    // One key per logical call, reused by retries: a retried request can never be counted twice.
    const { json } = await this.request("POST", "/v1/resolve", wire, { "idempotency-key": uuid() });
    const value = fromWire(json);
    // A new schema version changes what answers mean: drop everything cached under the old one.
    if (this.schemaVersion !== null && this.schemaVersion !== value.meta.schemaVersion) this.cache.clear();
    this.schemaVersion = value.meta.schemaVersion;
    if (this.cfg.cacheTtlMs > 0 && value.status === "resolved" && !value.degraded) { if (this.cache.size >= 500) this.cache.delete(this.cache.keys().next().value!); this.cache.set(key, { at: this.now(), value }); }
    return value;
  }

  /** Up to 50 inputs in one call. Results are in the same order; a bad item becomes `{ status: "error" }`, not a thrown error. */
  async resolveBatch(inputs: ResolveInput[]): Promise<BatchItemResult[]> {
    const { json } = await this.request("POST", "/v1/resolve/batch", { items: inputs.map(toWireInput) }, { "idempotency-key": uuid() });
    return (json.results as any[]).map(batchFromWire);
  }

  readonly bridges = { list: async (): Promise<BridgeInfo[]> => ((await this.request("GET", "/v1/bridges")).json.bridges as any[]).map(bridgeFromWire) };
  readonly corrections = {
    /** Only stored if the account opted in; otherwise the API answers 403 and this throws a ValidationError. */
    create: async (c: CorrectionInput): Promise<void> => { await this.request("POST", "/v1/corrections", { object_id: c.objectId, kind: c.kind, ...(c.field ? { field: c.field } : {}), old_value: c.oldValue, new_value: c.newValue }); },
  };
  /**
   * Place an object into a destination app (draft, attendee, row, task, page). Needs the destination connected for this account
   * and the consent the routing asked for; a missing consent is a ValidationError with code "consent_required" and nothing moves.
   * One idempotency key per call, reused by retries, so a retry never places twice.
   */
  async place(p: PlaceInput): Promise<Placement | PlacementUnknown> {
    const body = {
      input: { raw: p.raw, ...(p.sourceUrl ? { source_url: p.sourceUrl } : {}) },
      target: { destination: p.destination, ...(p.type ? { type: p.type } : {}) },
      ...(p.target ? { destination_target: p.target } : {}),
      consent: p.consent === undefined ? { kind: "release" } : typeof p.consent === "string" ? { kind: p.consent } : { kind: "hold", held_ms: p.consent.heldMs },
      ...(p.objectId ? { object_id: p.objectId } : {}),
    };
    const { json } = await this.request("POST", "/v1/place", body, { "idempotency-key": uuid() });
    if (json.status === "outcome_unknown") return { status: "outcome_unknown", actionId: json.action_id, message: json.message, next: json.next };
    const r = json.receipt;
    return {
      status: "placed",
      receipt: { id: r.id, opId: r.op_id, destination: r.destination, relationId: r.relation_id, effect: r.effect, reversible: r.reversible, at: r.at },
      object: { id: json.object.id, type: json.object.type, fields: json.object.fields, confidence: json.object.confidence, trust: json.object.trust },
      dataMoved: json.data_moved, risk: json.risk, history: json.action?.history ?? [], undo: json.undo ?? { available: r.reversible },
    };
  }
  readonly placements = {
    /** Reverse a placement by its receipt id. A second undo is a ValidationError with code "already_undone". */
    undo: async (receiptId: string): Promise<{ id: string; at: string }> => { const r = (await this.request("POST", "/v1/place/undo", { receipt_id: receiptId })).json.receipt; return { id: r.id, at: r.at }; },
    /** After an unknown outcome: ask the destination whether it happened. Reads only; never sends the write again. */
    reconcile: async (actionId: string): Promise<{ status: "succeeded" | "failed" | string; changed: boolean }> => { const j = (await this.request("POST", "/v1/place/reconcile", { action_id: actionId })).json; return { status: j.status, changed: j.changed }; },
  };

  async health(): Promise<boolean> { try { return (await this.request("GET", "/v1/health")).json.status === "ok"; } catch { return false; } }

  /** Fluent form: recast.from("...").as("Event").to("google_calendar").threshold(0.8).run() */
  from(raw: string, sourceUrl?: string) {
    const input: ResolveInput = { raw, ...(sourceUrl ? { sourceUrl } : {}) };
    const self = this;
    const b = {
      as(type: ObjectType) { input.target = { ...input.target, type }; return b; },
      to(destination: string) { input.target = { ...input.target, destination }; return b; },
      threshold(t: number) { input.options = { ...input.options, confidenceThreshold: t }; return b; },
      withoutProvenance() { input.options = { ...input.options, includeProvenance: false }; return b; },
      run: () => self.resolve(input),
    };
    return b;
  }
}
