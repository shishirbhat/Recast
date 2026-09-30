import { normalizeProps, perceive, resolve, RecastError, identityOf } from "@recast/core";
import type { Candidate, Evidence, FieldMeta, ObjectType, PerceptionInput, SemanticObject } from "@recast/core";
import { buildTextIndex, corroborate } from "./evidence.js";
import { collectSignals, cssPath } from "./signals.js";
import { domCandidates } from "./dom.js";

export interface ExtractOptions { url: string; now: string; corroborate?: boolean }
export interface Rejected { type: ObjectType; adapter: string; reason: string }
export interface ExtractResult {
  objects: SemanticObject[];
  /** "primary": the thing the page is about. "related": other objects on the page (cards, recommendations, listings). */
  roles: Record<string, "primary" | "related">;
  rejected: Rejected[];
  droppedProperties: { type: ObjectType; property: string; reason: string }[];
  diagnostics: { jsonLdScripts: number; jsonLdParseFailures: number; metaTags: number; microdataItems: number; ms: number };
}

const URL_KEYS = ["url", "image", "pdfUrl"];
const absolutize = (v: string, base: string) => { try { const u = new URL(v, base); return /^https?:$/.test(u.protocol) ? u.href : v; } catch { return v; } };
const pageKey = (u: string) => { try { const x = new URL(u); return x.origin + x.pathname.replace(/\/+$/, ""); } catch { return u; } };

function classify(doc: Document, url: string, objects: SemanticObject[]): Record<string, "primary" | "related"> {
  const heads = [doc.title, ...[...doc.querySelectorAll("h1")].slice(0, 3).map((h) => h.textContent ?? ""),
    ...doc.querySelectorAll('meta[property="og:title" i], meta[name="citation_title" i]')].map((x) => typeof x === "string" ? x : x.getAttribute("content") ?? "");
  const headWords = new Set(heads.flatMap((h) => h.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []));
  const roles: Record<string, "primary" | "related"> = {};
  for (const o of objects) {
    const name = String(o.properties["name"] ?? o.properties["title"] ?? "");
    const words = name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const sameUrl = typeof o.properties["url"] === "string" && pageKey(o.properties["url"] as string) === pageKey(url);
    roles[o.id] = sameUrl || (words.length > 0 && words.every((w) => headWords.has(w))) ? "primary" : "related";
  }
  if (objects.length === 1) roles[objects[0]!.id] = "primary";
  return roles;
}

const DATE_KEYS = new Set(["start", "end", "due", "modified", "date"]);
const fixDate = (s: string) => s.trim().replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/, "$1T$2");

function rewriteMicrodataEvidence(c: Candidate, elements: Map<string, Element>): Candidate {
  const fields: Record<string, FieldMeta> = {};
  const properties = { ...c.properties };
  for (const k of Object.keys(properties)) {
    const evs: Evidence[] = [];
    for (const e of c.fields[k]?.evidence ?? []) {
      // Most specific element first: /0/offers/price, then /0/offers.
      const parts = e.locator.value.split("/").slice(1);
      let el: Element | undefined;
      for (let n = parts.length; n >= 2 && !el; n--) el = elements.get("/" + parts.slice(0, n).join("/"));
      if (el) evs.push({ locator: { kind: "css", value: cssPath(el) } });
    }
    if (evs.length) fields[k] = { confidence: c.fields[k]!.confidence, evidence: evs };
    else delete properties[k];
  }
  return { ...c, properties, fields };
}

/** Try to resolve; if one property is invalid, drop just that property (and say so) instead of losing the object. */
function resolveRepairing(c: Candidate, dropped: ExtractResult["droppedProperties"]): SemanticObject | { error: string } {
  let cur = c;
  for (let i = 0; i < 6; i++) {
    try { return resolve(cur); }
    catch (e) {
      if (!(e instanceof RecastError)) throw e;
      const bad = e.details.map((d) => /^\/properties\/([^/\s]+)/.exec(d)?.[1]).find((k): k is string => !!k && k in cur.properties);
      if (!bad) return { error: `${e.message}: ${e.details.slice(0, 2).join("; ")}` };
      dropped.push({ type: cur.type, property: bad, reason: e.details.find((d) => d.includes(bad)) ?? "invalid" });
      const properties = { ...cur.properties }; const fields = { ...cur.fields };
      delete properties[bad]; delete fields[bad];
      cur = { ...cur, properties, fields };
    }
  }
  return { error: "too many invalid properties" };
}

const text = (v: unknown) => (typeof v === "string" ? v.toLowerCase().replace(/\s+/g, " ").trim() : "");
const sameThing = (a: SemanticObject, b: SemanticObject) => {
  if (a.type !== b.type) return false;
  const an = text(a.properties["name"] ?? a.properties["title"]), bn = text(b.properties["name"] ?? b.properties["title"]);
  const au = text(a.properties["url"]), bu = text(b.properties["url"]);
  if (a.id === b.id || (!!an && an === bn) || (!!au && au === bu)) return true;
  const aa = text(a.properties["address"]), ba = text(b.properties["address"]);
  if (a.type === "Location" && aa && ba && (aa === ba || aa.includes(ba) || ba.includes(aa))) return true;
  // OpenGraph titles usually carry a site suffix ("Stagg EKG | Fellow"): let them merge into a structured
  // object of the same type when one name contains the other. Two structured objects never merge this way.
  const og = a.provenance.capture.adapter === "opengraph" || b.provenance.capture.adapter === "opengraph";
  const [short, long] = an.length <= bn.length ? [an, bn] : [bn, an];
  return og && short.length >= 4 && long.includes(short);
};

/** Merge duplicates: keep the higher-confidence value for each property. */
function mergeInto(base: SemanticObject, other: SemanticObject): Candidate {
  const properties: Record<string, unknown> = { ...base.properties };
  const fields: Record<string, FieldMeta> = JSON.parse(JSON.stringify(base.fields));
  for (const k of Object.keys(other.properties)) {
    const o = other.fields[k]!;
    if (!(k in properties) || o.confidence > fields[k]!.confidence) { properties[k] = other.properties[k]; fields[k] = JSON.parse(JSON.stringify(o)); }
    else if (JSON.stringify(properties[k]) === JSON.stringify(other.properties[k])) {
      fields[k]!.evidence.push(...JSON.parse(JSON.stringify(o.evidence)));
    }
  }
  return { type: base.type, properties, fields, provenance: JSON.parse(JSON.stringify(base.provenance)) };
}

export function extractPage(doc: Document, opts: ExtractOptions): ExtractResult {
  const t0 = performance.now();
  const sig = collectSignals(doc);
  const source = { app: new URL(opts.url).hostname, url: opts.url, ...(doc.title ? { title: doc.title.slice(0, 200) } : {}) };
  const base = { source, at: opts.now };
  const inputs: PerceptionInput[] = [
    { kind: "jsonld", docs: sig.jsonld.docs, ...base },
    { kind: "jsonld", docs: sig.microdata.docs, adapter: "microdata", ...base },
    { kind: "meta", tags: sig.meta, ...base },
    { kind: "opengraph", tags: sig.meta, ...base },
  ];
  let cands: Candidate[] = inputs.flatMap((input) => {
    const raw = perceive(input);
    return input.kind === "jsonld" && input.adapter === "microdata" ? raw.map((c) => rewriteMicrodataEvidence(c, sig.microdata.elements)) : raw;
  });
  cands.push(...domCandidates(doc, source, opts.now));
  // Strongest signals first, so weaker ones merge into them rather than the other way round.
  const rank = (c: Candidate) => (c.provenance.capture.method === "dom" ? 2 : c.provenance.capture.adapter === "opengraph" ? 1 : 0);
  cands = cands.sort((a, b) => rank(a) - rank(b));

  if (opts.corroborate !== false) {
    const index = buildTextIndex(doc);
    for (const c of cands) {
      for (const k of Object.keys(c.properties)) {
        if (["url", "image", "pdfUrl", "price", "lat", "lng", "description", "abstract"].includes(k)) continue;
        const ev = corroborate(index, c.properties[k]);
        if (ev) c.fields[k]!.evidence.push(ev);
      }
    }
  }

  const rejected: Rejected[] = [], droppedProperties: ExtractResult["droppedProperties"] = [];
  const resolved: SemanticObject[] = [];
  for (const c of cands) {
    const props = { ...c.properties };
    for (const k of DATE_KEYS) if (typeof props[k] === "string") props[k] = fixDate(props[k] as string);
    for (const k of URL_KEYS) if (typeof props[k] === "string") props[k] = absolutize(props[k] as string, doc.baseURI || opts.url);
    const r = resolveRepairing({ ...c, properties: props }, droppedProperties);
    if ("error" in r) rejected.push({ type: c.type, adapter: c.provenance.capture.adapter, reason: r.error });
    else resolved.push(r);
  }
  const merged: SemanticObject[] = [];
  for (const o of resolved) {
    const i = merged.findIndex((m) => sameThing(m, o));
    if (i < 0) merged.push(o);
    else { const m = mergeInto(merged[i]!, o); merged[i] = resolve({ ...m, properties: normalizeProps(m.type, m.properties) }); }
  }
  merged.sort((a, b) => Object.keys(b.properties).length - Object.keys(a.properties).length);
  return {
    objects: merged, roles: classify(doc, opts.url, merged), rejected, droppedProperties,
    diagnostics: {
      jsonLdScripts: sig.jsonld.total, jsonLdParseFailures: sig.jsonld.failures, metaTags: sig.meta.length,
      microdataItems: sig.microdata.docs.length, ms: performance.now() - t0,
    },
  };
}
export { identityOf };
