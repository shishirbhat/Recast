// Deterministic perception of already-structured signals (JSON-LD, citation_* meta).
// Layer 1 adds DOM/accessibility adapters; nothing here uses OCR or vision.
import type { Candidate, Evidence, FieldMeta, ObjectType, PerceptionInput, Props } from "./types.js";

const CONF = { direct: 0.95, derived: 0.85 } as const;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : typeof v === "number" ? String(v) : undefined);
const asArray = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const typesOf = (n: Obj) => asArray(n["@type"]).filter((t): t is string => typeof t === "string").map((t) => t.replace(/^.*[/#]/, ""));

class Builder {
  props: Props = {}; fields: Record<string, FieldMeta> = {};
  constructor(private ptr: string) {}
  set(key: string, value: unknown, sub: string, confidence: number = CONF.direct) {
    if (value === undefined || (Array.isArray(value) && value.length === 0)) return;
    const ev: Evidence = { locator: { kind: "jsonld", value: `${this.ptr}${sub}` } };
    this.props[key] = value;
    this.fields[key] = { confidence, evidence: [ev] };
  }
}

const nameOf = (v: unknown): string | undefined => (isObj(v) ? str(v["name"]) : str(v));
const urlOf = (v: unknown): string | undefined => (isObj(v) ? str(v["url"]) ?? str(v["contentUrl"]) : str(v));

function addressOf(v: unknown): string | undefined {
  if (!isObj(v)) return str(v);
  const parts = ["streetAddress", "addressLocality", "addressRegion", "postalCode", "addressCountry"].map((k) => nameOf(v[k])).filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
}
const num = (v: unknown): number | undefined => { const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN; return Number.isFinite(n) ? n : undefined; };
const LOCATION_TYPES = new Set(["Place", "LocalBusiness", "Restaurant", "CafeOrCoffeeShop", "Hotel", "Store", "TouristAttraction", "Museum", "Park"]);
const PAPER_TYPES = new Set(["ScholarlyArticle", "MedicalScholarlyArticle"]);
const doiFrom = (v: unknown): string | undefined => {
  for (const x of asArray(v)) {
    const s = isObj(x) ? str(x["value"]) : str(x);
    const m = s && /10\.\d{4,9}\/\S+/.exec(s);
    if (m) return m[0];
  }
  return undefined;
};

function fromNode(n: Obj, ptr: string): { type: ObjectType; b: Builder } | undefined {
  const ts = typesOf(n);
  const b = new Builder(ptr);
  if (ts.includes("Person")) {
    b.set("name", str(n["name"]), "/name");
    const em = asArray(n["email"]).map((e) => str(e)?.replace(/^mailto:/i, "")).filter((e): e is string => !!e);
    b.set("email", em, "/email");
    b.set("phone", asArray(n["telephone"]).map(str).filter((e): e is string => !!e), "/telephone");
    b.set("org", nameOf(n["worksFor"]), "/worksFor");
    b.set("role", str(n["jobTitle"]), "/jobTitle");
    b.set("url", str(n["url"]), "/url"); b.set("image", urlOf(n["image"]), "/image");
    return { type: "Person", b };
  }
  if (ts.some((t) => t.endsWith("Event"))) {
    b.set("title", str(n["name"]), "/name");
    b.set("start", str(n["startDate"]), "/startDate"); b.set("end", str(n["endDate"]), "/endDate");
    const loc = n["location"]; const l = isObj(loc) ? nameOf(loc) ?? addressOf(loc["address"]) : str(loc);
    b.set("location", l, "/location", CONF.derived);
    b.set("url", str(n["url"]), "/url"); b.set("description", str(n["description"]), "/description");
    return { type: "Event", b };
  }
  if (ts.some((t) => LOCATION_TYPES.has(t))) {
    b.set("name", str(n["name"]), "/name");
    b.set("address", addressOf(n["address"]), "/address", CONF.derived);
    const geo = isObj(n["geo"]) ? n["geo"] : undefined;
    const lat = geo && num(geo["latitude"]), lng = geo && num(geo["longitude"]);
    if (lat !== undefined && lng !== undefined) { b.set("lat", lat, "/geo/latitude"); b.set("lng", lng, "/geo/longitude"); }
    b.set("url", str(n["url"]), "/url");
    return { type: "Location", b };
  }
  if (ts.some((t) => PAPER_TYPES.has(t))) {
    b.set("title", str(n["name"]) ?? str(n["headline"]), n["name"] ? "/name" : "/headline");
    b.set("authors", asArray(n["author"]).map(nameOf).filter((a): a is string => !!a), "/author");
    b.set("doi", doiFrom(n["identifier"]) ?? doiFrom(n["sameAs"]) ?? doiFrom(n["doi"]), "/identifier");
    const y = str(n["datePublished"])?.match(/^\d{4}/)?.[0];
    b.set("year", y ? Number(y) : undefined, "/datePublished", CONF.derived);
    b.set("venue", nameOf(n["isPartOf"]), "/isPartOf");
    b.set("abstract", str(n["abstract"]), "/abstract"); b.set("url", str(n["url"]), "/url");
    return { type: "ResearchPaper", b };
  }
  if (ts.includes("Product")) {
    b.set("name", str(n["name"]), "/name");
    b.set("brand", nameOf(n["brand"]), "/brand"); b.set("sku", str(n["sku"]), "/sku");
    b.set("url", str(n["url"]), "/url"); b.set("image", urlOf(asArray(n["image"])[0]), "/image");
    const offer = asArray(n["offers"]).find(isObj);
    const amount = offer && num(offer["price"]), cur = offer && str(offer["priceCurrency"]);
    if (amount !== undefined && cur) b.set("price", { amount, currency: cur.toUpperCase() }, "/offers/price", CONF.derived);
    const rating = isObj(n["aggregateRating"]) ? num(n["aggregateRating"]["ratingValue"]) : undefined;
    b.set("rating", rating, "/aggregateRating/ratingValue");
    return { type: "Product", b };
  }
  return undefined;
}

function* nodes(docs: unknown[]): Generator<{ n: Obj; ptr: string }> {
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    if (isObj(d) && Array.isArray(d["@graph"])) {
      for (let j = 0; j < d["@graph"].length; j++) { const g = d["@graph"][j]; if (isObj(g)) yield { n: g, ptr: `/${i}/@graph/${j}` }; }
    } else if (Array.isArray(d)) {
      for (let j = 0; j < d.length; j++) { const g = d[j]; if (isObj(g)) yield { n: g, ptr: `/${i}/${j}` }; }
    } else if (isObj(d)) yield { n: d, ptr: `/${i}` };
  }
}

function metaPaper(tags: { name: string; content: string }[]): { type: ObjectType; b: Builder } | undefined {
  const all = (n: string) => tags.map((t, i) => ({ ...t, i })).filter((t) => t.name.toLowerCase() === n && t.content.trim());
  const first = (...names: string[]) => { for (const n of names) { const t = all(n)[0]; if (t) return { v: t.content.trim(), n }; } return undefined; };
  const title = first("citation_title");
  if (!title) return undefined;
  const b = new Builder("");
  const ev = (name: string, k = 0): Evidence => ({ locator: { kind: "meta", value: `${name}[${k}]` } });
  const put = (key: string, value: unknown, name: string, k: number | number[] = 0, confidence: number = CONF.direct) => {
    if (value === undefined) return;
    b.props[key] = value;
    b.fields[key] = { confidence, evidence: (Array.isArray(k) ? k : [k]).map((x) => ev(name, x)) };
  };
  put("title", title.v, "citation_title");
  const authors = all("citation_author");
  if (authors.length) put("authors", authors.map((a) => a.content.trim()), "citation_author", authors.map((_, i) => i));
  const doi = first("citation_doi"); if (doi) put("doi", doi.v, doi.n);
  const date = first("citation_publication_date", "citation_date", "citation_online_date");
  const y = date?.v.match(/\d{4}/)?.[0]; if (date && y) put("year", Number(y), date.n, 0, CONF.derived);
  const venue = first("citation_journal_title", "citation_conference_title"); if (venue) put("venue", venue.v, venue.n);
  const pdf = first("citation_pdf_url"); if (pdf) put("pdfUrl", pdf.v, pdf.n);
  const url = first("citation_abstract_html_url", "citation_fulltext_html_url"); if (url) put("url", url.v, url.n);
  const ax = first("citation_arxiv_id"); if (ax) put("arxivId", ax.v, ax.n);
  return { type: "ResearchPaper", b };
}

export function perceive(input: PerceptionInput): Candidate[] {
  const prov = (adapter: string): Candidate["provenance"] => ({ source: input.source, capture: { method: "structured", adapter, at: input.at } });
  const found: { type: ObjectType; b: Builder; adapter: string }[] = [];
  if (input.kind === "jsonld") {
    for (const { n, ptr } of nodes(input.docs)) { const r = fromNode(n, ptr); if (r) found.push({ ...r, adapter: "jsonld" }); }
  } else {
    const r = metaPaper(input.tags); if (r) found.push({ ...r, adapter: "meta-citation" });
  }
  return found
    .filter((f) => Object.keys(f.b.props).length > 0)
    .map((f) => ({ type: f.type, properties: f.b.props, fields: f.b.fields, provenance: prov(f.adapter) }));
}
