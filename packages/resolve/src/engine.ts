import { assessRisk, propose, rankProposals, resolve as coreResolve, RecastError, RELIABILITY_LABEL } from "@recast/core";
import type { Proposal, SemanticObject } from "@recast/core";
import { DESTINATIONS, destinationIds } from "./registry";
import { allReadings, RELATIVE, type Reading } from "./rules";
import { CircuitBreaker, cosine, withTimeout } from "./stages";
import {
  API_TYPES, MAX_RAW_CHARS, MODEL_CONFIDENCE_CAP, SCHEMA_VERSION, toApiType, toCoreType,
  type ApiType, type Embedder, type FieldProvenance, type Llm, type Meta, type ResolveInput, type ResolveOutcome, type ResolvedObjectView, type Routing, type Stage, type TrustLevel,
} from "./types";

/** The caller's input is wrong (not the text's content). The API maps this to a 4xx. */
export interface Prepared { outcome: ResolveOutcome; proposal: Proposal | null }

export class ResolveInputError extends Error {
  constructor(message: string, readonly code: "empty_input" | "input_too_large" | "bad_option" | "unknown_destination") { super(message); this.name = "ResolveInputError"; }
}

export interface ResolverConfig {
  embedder?: Embedder; llm?: Llm; now?: () => Date;
  breaker?: { threshold?: number; cooldownMs?: number; now?: () => number };
  timeouts?: { embedMs?: number; llmMs?: number };
}

const ALLOWED: Record<ApiType, string[]> = {
  Person: ["name", "email", "phone", "org", "role", "url"], Event: ["title", "start", "end", "location", "url", "description"],
  Location: ["name", "address", "url"], Product: ["name", "brand", "price", "url"], Paper: ["title", "authors", "doi", "arxivId", "year", "venue", "url"], Document: ["title", "url"],
};
const ROUTE_TEXT: Record<ApiType, string> = {
  Person: "a person with a name, email address or phone number", Event: "an event with a title, date and time", Location: "a place with a street address and postal code",
  Product: "a product with a name and a price", Paper: "an academic paper with a title, authors and a DOI", Document: "a web page or document with a title and a link",
};
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export function createResolver(cfg: ResolverConfig = {}) {
  const now = cfg.now ?? (() => new Date());
  const embedBreaker = new CircuitBreaker(cfg.breaker?.threshold, cfg.breaker?.cooldownMs, cfg.breaker?.now);
  const llmBreaker = new CircuitBreaker(cfg.breaker?.threshold, cfg.breaker?.cooldownMs, cfg.breaker?.now);
  const embedMs = cfg.timeouts?.embedMs ?? 1500, llmMs = cfg.timeouts?.llmMs ?? 5000;
  let routeVecs: Promise<Record<ApiType, number[]>> | undefined;
  const routes = (e: Embedder) => (routeVecs ??= Promise.all(API_TYPES.map(async (t) => [t, await e.embed(ROUTE_TEXT[t])] as const)).then((x) => Object.fromEntries(x) as Record<ApiType, number[]>));

  function build(r: Reading, raw: string, input: ResolveInput, adapter: string): { obj: SemanticObject; view: ResolvedObjectView; prov: FieldProvenance[] } | null {
    const fields = Object.fromEntries(Object.keys(r.fields).map((k) => {
      const span = r.spans[k];
      return [k, { confidence: r.conf[k] ?? 0.5, evidence: [{ locator: { kind: "api" as const, value: "resolve:raw" }, ...(span ? { textRange: { start: span[0], end: span[1] }, excerpt: raw.slice(span[0], Math.min(span[1], span[0] + 200)) } : {}) }] }];
    }));
    const url = input.sourceUrl && /^https?:\/\//i.test(input.sourceUrl) ? input.sourceUrl : undefined;
    try {
      const obj = coreResolve({
        type: toCoreType(r.type), properties: r.fields, fields,
        provenance: { source: { app: "recast-api", ...(url ? { url } : {}) }, capture: { method: "api", adapter, at: now().toISOString() } },
      });
      const confs = Object.keys(obj.properties).map((k) => obj.fields[k]?.confidence ?? 0);
      const confidence = confs.length ? Math.min(...confs) : 0;
      const prov: FieldProvenance[] = Object.keys(obj.properties).map((k) => ({
        field: k, source: adapter === "resolve-rules" ? "rules" : adapter === "resolve-llm" ? "llm" : adapter, confidence: obj.fields[k]?.confidence ?? 0,
        ...(obj.fields[k]?.evidence[0]?.excerpt ? { excerpt: obj.fields[k]!.evidence[0]!.excerpt } : {}),
      }));
      const tier = assessRisk({ baseRisk: "low", flags: [], reversible: true, confidence, reliability: "official-api" }).tier;
      return { obj, view: { id: obj.id, type: r.type, fields: { ...obj.properties }, confidence, trust: tier, provenance: prov }, prov };
    } catch (e) { if (e instanceof RecastError) return null; throw e; }
  }

  function route(obj: SemanticObject, destination: string): { routing: Routing | null; routeError?: string; trust?: TrustLevel; proposal?: Proposal } {
    const contract = DESTINATIONS[destination];
    if (!contract) throw new ResolveInputError(`unknown destination '${destination}'. Known: ${destinationIds().join(", ")}`, "unknown_destination");
    const ps: Proposal[] = propose(obj, contract);
    if (!ps.length) return { routing: null, routeError: `${contract.app} does not accept a ${toApiType(obj.type)}` };
    const best = rankProposals(ps)[0]!;
    if (best.status === "blocked") return { routing: null, routeError: `${contract.app}: ${best.blocked?.reason ?? "blocked"}` };
    const routing: Routing = {
      destination, action: best.effect, relationId: best.relationId, bridge: contract.destination, bridgeReliability: contract.reliability.replace(/-/g, "_"),
      reliabilityLabel: RELIABILITY_LABEL[contract.reliability], requiresConfirmation: best.risk.consent !== "release", consent: best.risk.consent, risk: best.risk.tier, reasons: best.risk.reasons,
    };
    return { routing, trust: best.risk.tier, proposal: best };
  }

  /** Every string a model returned must appear in the text. A value it made up is dropped, not trusted. */
  function groundLlm(raw: string, type: ApiType, f: Record<string, unknown>, conf: number): Reading | null {
    const hay = norm(raw); const fields: Record<string, unknown> = {}; const c = Math.min(conf, MODEL_CONFIDENCE_CAP);
    for (const [k, v] of Object.entries(f)) {
      if (!ALLOWED[type].includes(k)) continue;
      const strs = Array.isArray(v) ? v : [v];
      if (k === "start" || k === "end") { if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(v)) fields[k] = v; continue; }
      if (k === "price" && v && typeof v === "object") { const p = v as { amount?: unknown; currency?: unknown }; if (typeof p.amount === "number" && typeof p.currency === "string" && hay.includes(String(p.amount).replace(/\.0+$/, ""))) fields[k] = v; continue; }
      if (strs.every((s) => typeof s === "string" && s && hay.includes(norm(s)))) fields[k] = v;
    }
    if (!Object.keys(fields).length) return null;
    return { type, fields, conf: Object.fromEntries(Object.keys(fields).map((k) => [k, c])), spans: {}, score: c };
  }

  async function prepare(input: ResolveInput): Promise<Prepared> {
    const raw = (input.raw ?? "").trim();
    if (!raw) throw new ResolveInputError("raw must be a non-empty string", "empty_input");
    if (raw.length > MAX_RAW_CHARS) throw new ResolveInputError(`raw is ${raw.length} characters; the limit is ${MAX_RAW_CHARS}`, "input_too_large");
    const threshold = input.options?.confidenceThreshold ?? 0.5;
    if (!(threshold >= 0 && threshold <= 1)) throw new ResolveInputError("confidence_threshold must be between 0 and 1", "bad_option");
    const targetType = input.target?.type; const destination = input.target?.destination;
    if (destination && !DESTINATIONS[destination]) throw new ResolveInputError(`unknown destination '${destination}'. Known: ${destinationIds().join(", ")}`, "unknown_destination");
    if (targetType && !API_TYPES.includes(targetType)) throw new ResolveInputError(`unknown type '${targetType}'`, "bad_option");

    let stage: Stage = "rules"; let degraded = false;
    const meta = (): Meta => ({ stage, schemaVersion: SCHEMA_VERSION, degraded });
    let readings = allReadings(raw);
    const pool = () => (targetType ? readings.filter((r) => r.type === targetType) : readings);
    const ambiguous = () => !targetType && readings.length > 1 && readings[1]!.score >= readings[0]!.score - 0.1;
    let adapter = "resolve-rules";

    // Stage 2: an embedding may break a tie between readings the rules found. It never invents fields.
    if (cfg.embedder && (ambiguous() || (pool()[0] && pool()[0]!.score < 0.8))) {
      if (embedBreaker.isOpen) degraded = true;
      else try {
        const vecs = await embedBreaker.run(() => withTimeout(routes(cfg.embedder!), embedMs));
        const q = await embedBreaker.run(() => withTimeout(cfg.embedder!.embed(raw), embedMs));
        if (ambiguous()) {
          const scored = readings.slice(0, 3).map((r) => ({ r, s: cosine(q, vecs[r.type]) })).sort((a, b) => b.s - a.s);
          if (scored[0]!.s >= 0.6 && scored[0]!.s - (scored[1]?.s ?? 0) >= 0.05) { readings = [scored[0]!.r, ...readings.filter((r) => r !== scored[0]!.r)]; readings[0] = { ...readings[0]!, score: readings[0]!.score + 0.15 }; stage = "embedding"; }
        }
      } catch { degraded = true; }
    }

    // Stage 3: a model, only when the rules found nothing usable. Its answer is grounded in the text and capped.
    const needLlm = pool().length === 0 || (!targetType && ambiguous() && stage === "rules");
    if (cfg.llm && needLlm) {
      if (llmBreaker.isOpen) degraded = true;
      else try {
        const out = await llmBreaker.run(() => withTimeout(cfg.llm!.extract({ text: raw, types: targetType ? [targetType] : API_TYPES, ...(targetType ? { hint: targetType } : {}) }), llmMs));
        const g = out && (!targetType || out.type === targetType) ? groundLlm(raw, out.type, out.fields, out.confidence) : null;
        if (g) { readings = [g, ...readings.filter((r) => r.type !== g.type)]; stage = "llm"; adapter = "resolve-llm"; }
      } catch { degraded = true; }
    }

    const p = pool();
    if (!p.length) {
      const others = readings.map((r) => r.type);
      const relative = RELATIVE.test(raw) && (!targetType || targetType === "Event");
      return { outcome: {
        status: "unresolved", meta: meta(),
        reason: targetType && others.length ? `no ${targetType} found; the text reads as ${others.join(" or ")}` : "nothing recognisable as a person, event, place, product or paper",
        ...(relative ? { suggestion: "relative dates like 'Friday' need a full date (for example 2026-11-14) to become an event" } : /@/.test(raw) && !targetType ? { suggestion: "include a name with the email address" } : {}),
      }, proposal: null };
    }
    const built = readings.map((r) => ({ r, b: build(r, raw, input, r.type === p[0]!.type && stage === "llm" && adapter === "resolve-llm" && r === p[0] ? adapter : "resolve-rules") })).filter((x) => x.b);
    const primaryBuilt = built.find((x) => x.r === p[0]) ?? null;
    if (!primaryBuilt) return { outcome: { status: "unresolved", reason: "the text matched a pattern but did not form a valid object", meta: meta() }, proposal: null };
    const others = built.filter((x) => x !== primaryBuilt).map((x) => x.b!.view);

    if (ambiguous() && stage === "rules") {
      return { outcome: { status: "ambiguous", reason: `the text reads as both ${readings[0]!.type} and ${readings[1]!.type}; say which with target.type`, alternatives: built.map((x) => x.b!.view), meta: meta() }, proposal: null };
    }
    if (primaryBuilt.b!.view.confidence < threshold) {
      return { outcome: { status: "ambiguous", reason: `best reading (${primaryBuilt.r.type}) is below the confidence threshold ${threshold}`, alternatives: built.map((x) => x.b!.view), meta: meta() }, proposal: null };
    }
    const view = primaryBuilt.b!.view;
    let routing: Routing | null = null; let routeError: string | undefined; let proposal: Proposal | null = null;
    if (destination) { const rt = route(primaryBuilt.b!.obj, destination); routing = rt.routing; routeError = rt.routeError; proposal = rt.proposal ?? null; if (rt.trust) view.trust = rt.trust; }
    return { outcome: { status: "resolved", object: view, routing, ...(routeError ? { routeError } : {}), alternatives: targetType ? [] : others, meta: meta() }, proposal };
  }

  /**
   * `resolve` is the public answer. `prepare` also hands back the core proposal it routed through, so a placement acts on
   * exactly what the answer described (same object, same relation, same risk). Server-side only; never serialised.
   */
  return { resolve: async (input: ResolveInput): Promise<ResolveOutcome> => (await prepare(input)).outcome, prepare };
}
export type Resolver = ReturnType<typeof createResolver>;
