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
const PLACE_TYPE = /^(Place|LocalBusiness|Landmark|LandmarksOrHistoricalBuildings|TouristAttraction|CivicStructure|Residence|AdministrativeArea|City|Country|.*(Restaurant|Establishment|Store|Shop|Hotel|Motel|Hostel|Resort|Museum|Gallery|Park|Garden|Zoo|Aquarium|Library|Airport|Bar|Pub|Bakery|Cafe|CafeOrCoffeeShop|Winery|Brewery|Distillery|Stadium|ArtGallery|Hospital|School|Theater|Theatre|Cinema|NightClub|Casino|Spa|Salon|Gym|HealthClub|Campground|Church|Temple|Mosque|Synagogue|Cemetery|Beach|Mountain|Volcano))$/;
const PRODUCT_TYPES = new Set(["Product", "ProductGroup", "ProductModel", "IndividualProduct"]);
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
  if (ts.some((t) => t.endsWith("Event") || t === "Festival" || t === "Hackathon")) {
    b.set("title", str(n["name"]), "/name");
    b.set("start", str(n["startDate"]), "/startDate"); b.set("end", str(n["endDate"]), "/endDate");
    const loc = n["location"]; const l = isObj(loc) ? nameOf(loc) ?? addressOf(loc["address"]) : str(loc);
    b.set("location", l, "/location", CONF.derived);
    b.set("url", str(n["url"]), "/url"); b.set("description", str(n["description"]), "/description");
    return { type: "Event", b };
  }
  // An Organization is NOT a place: on the dev corpus every Organization-with-address was a company home page.
  if (ts.some((t) => PLACE_TYPE.test(t))) {
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
  if (ts.some((t) => PRODUCT_TYPES.has(t))) {
    b.set("name", str(n["name"]), "/name");
    b.set("brand", nameOf(n["brand"]), "/brand"); b.set("sku", str(n["sku"]), "/sku");
    b.set("url", str(n["url"]), "/url"); b.set("image", urlOf(asArray(n["image"])[0]), "/image");
    const priced = (x: unknown) => isObj(x) && (num(x["price"]) !== undefined || num(x["lowPrice"]) !== undefined);
    const find = (v: unknown, base: string, want: (x: unknown) => boolean = isObj): { o: Obj; ptr: string } | undefined => {
      const arr = Array.isArray(v) ? v : v === undefined ? [] : [v];
      const i = arr.findIndex(want);
      return i >= 0 ? { o: arr[i] as Obj, ptr: Array.isArray(v) ? `${base}/${i}` : base } : undefined;
    };
    let offer = find(n["offers"], "/offers", priced);
    if (!offer) {
      const variants = Array.isArray(n["hasVariant"]) ? n["hasVariant"] : [];
      for (let vi = 0; vi < variants.length && !offer; vi++) {
        const v = variants[vi];
        if (isObj(v)) offer = find(v["offers"], `/hasVariant/${vi}/offers`, priced);
      }
    }
    if (offer) {
      const amount = num(offer.o["price"]) ?? num(offer.o["lowPrice"]);
      const cur = str(offer.o["priceCurrency"]);
      const key = offer.o["price"] !== undefined ? "price" : "lowPrice";
      if (amount !== undefined && cur && /^[A-Za-z]{3}$/.test(cur)) b.set("price", { amount, currency: cur.toUpperCase() }, `${offer.ptr}/${key}`, CONF.derived);
    }
    const rating = isObj(n["aggregateRating"]) ? num(n["aggregateRating"]["ratingValue"]) : undefined;
    b.set("rating", rating, "/aggregateRating/ratingValue");
    return { type: "Product", b };
  }
  return undefined;
}

function* withMain(n: Obj, ptr: string): Generator<{ n: Obj; ptr: string }> {
  yield { n, ptr };
  // ProfilePage / AboutPage / WebPage wrap the real subject in mainEntity.
  const main = n["mainEntity"];
  if (isObj(main)) yield { n: main, ptr: `${ptr}/mainEntity` };
}
function* nodes(docs: unknown[]): Generator<{ n: Obj; ptr: string }> {
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    if (isObj(d) && Array.isArray(d["@graph"])) {
      for (let j = 0; j < d["@graph"].length; j++) { const g = d["@graph"][j]; if (isObj(g)) yield* withMain(g, `/${i}/@graph/${j}`); }
    } else if (Array.isArray(d)) {
      for (let j = 0; j < d.length; j++) { const g = d[j]; if (isObj(g)) yield* withMain(g, `/${i}/${j}`); }
    } else if (isObj(d)) yield* withMain(d, `/${i}`);
  }
}

const NAME_SUFFIX = /^(jr|sr|ii|iii|iv|phd|md)\.?$/i;
/** Metadata often says "Last, First"; people read "First Last". Flip only when EVERY name in the list is
 *  exactly "X, Y" (a consistent convention) and Y is not a suffix like "Jr.". Otherwise leave the list alone. */
export function displayNames(names: string[]): string[] {
  const parts = names.map((n) => /^([^,]+),\s*([^,]+)$/.exec(n));
  if (!parts.length || parts.some((m) => !m || NAME_SUFFIX.test(m[2]!.trim()))) return names;
  return parts.map((m) => `${m![2]!.trim()} ${m![1]!.trim()}`);
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
  if (authors.length) put("authors", displayNames(authors.map((a) => a.content.trim())), "citation_author", authors.map((_, i) => i));
  const doi = first("citation_doi"); if (doi) put("doi", doi.v, doi.n);
  const date = first("citation_publication_date", "citation_date", "citation_online_date");
  const y = date?.v.match(/\d{4}/)?.[0]; if (date && y) put("year", Number(y), date.n, 0, CONF.derived);
  const venue = first("citation_journal_title", "citation_conference_title"); if (venue) put("venue", venue.v, venue.n);
  const pdf = first("citation_pdf_url"); if (pdf) put("pdfUrl", pdf.v, pdf.n);
  const url = first("citation_abstract_html_url", "citation_fulltext_html_url"); if (url) put("url", url.v, url.n);
  const ax = first("citation_arxiv_id"); if (ax) put("arxivId", ax.v, ax.n);
  return { type: "ResearchPaper", b };
}

/** OpenGraph: weaker than JSON-LD (og:title often carries a site suffix), so confidence is lower. */
const OG_CONF = 0.75;
function openGraph(tags: { name: string; content: string }[]): { type: ObjectType; b: Builder } | undefined {
  const idx = new Map<string, number>();
  tags.forEach((t, i) => { const k = t.name.toLowerCase(); if (t.content.trim() && !idx.has(k)) idx.set(k, i); });
  const get = (...names: string[]) => { for (const n of names) { const i = idx.get(n); if (i !== undefined) return { v: tags[i]!.content.trim(), n }; } return undefined; };
  const type = get("og:type")?.v.toLowerCase();
  if (!type) return undefined;
  const b = new Builder("");
  const put = (key: string, value: unknown, name: string, confidence: number = OG_CONF) => {
    if (value === undefined) return;
    b.props[key] = value; b.fields[key] = { confidence, evidence: [{ locator: { kind: "meta", value: `${name}[0]` } }] };
  };
  const title = get("og:title");
  if (type === "product" || type === "og:product" || type === "product.item") {
    if (!title) return undefined;
    put("name", title.v, title.n); const u = get("og:url"); if (u) put("url", u.v, u.n);
    const im = get("og:image", "og:image:url"); if (im) put("image", im.v, im.n);
    const amt = get("product:price:amount", "og:price:amount"), cur = get("product:price:currency", "og:price:currency");
    const a = amt && num(amt.v);
    if (amt && a !== undefined && cur && /^[A-Za-z]{3}$/.test(cur.v)) { put("price", { amount: a, currency: cur.v.toUpperCase() }, amt.n); }
    const br = get("product:brand", "og:brand"); if (br) put("brand", br.v, br.n);
    return { type: "Product", b };
  }
  if (type === "profile") {
    const f = get("profile:first_name"), l = get("profile:last_name");
    if (f && l) { b.props["name"] = `${f.v} ${l.v}`; b.fields["name"] = { confidence: 0.85, evidence: [f, l].map((x) => ({ locator: { kind: "meta" as const, value: `${x.n}[0]` } })) }; }
    else if (title) put("name", title.v, title.n);
    else return undefined;
    const u = get("og:url"); if (u) put("url", u.v, u.n);
    const im = get("og:image"); if (im) put("image", im.v, im.n);
    return { type: "Person", b };
  }
  if (type === "place" || type === "business.business" || type === "restaurant.restaurant") {
    if (title) put("name", title.v, title.n);
    const lat = get("place:location:latitude", "og:latitude"), lng = get("place:location:longitude", "og:longitude");
    const la = lat && num(lat.v), lo = lng && num(lng.v);
    if (lat && lng && la !== undefined && lo !== undefined) { put("lat", la, lat.n, 0.85); put("lng", lo, lng.n, 0.85); }
    const street = get("business:contact_data:street_address", "og:street-address"), city = get("business:contact_data:locality", "og:locality");
    const addr = [street?.v, city?.v, get("business:contact_data:region", "og:region")?.v, get("business:contact_data:postal_code", "og:postal-code")?.v].filter(Boolean).join(", ");
    if (addr && (street || city)) put("address", addr, (street ?? city)!.n, 0.8);
    const u = get("og:url"); if (u) put("url", u.v, u.n);
    return Object.keys(b.props).length ? { type: "Location", b } : undefined;
  }
  if (type === "event") {
    const st = get("event:start_time", "og:start_time");
    if (!title || !st) return undefined;
    put("title", title.v, title.n); put("start", st.v, st.n);
    const en = get("event:end_time", "og:end_time"); if (en) put("end", en.v, en.n);
    const u = get("og:url"); if (u) put("url", u.v, u.n);
    return { type: "Event", b };
  }
  return undefined; // article, website, video, book...: too generic to call an object
}

export function perceive(input: PerceptionInput): Candidate[] {
  const prov = (adapter: string): Candidate["provenance"] => ({ source: input.source, capture: { method: "structured", adapter, at: input.at } });
  const found: { type: ObjectType; b: Builder; adapter: string }[] = [];
  if (input.kind === "jsonld") {
    for (const { n, ptr } of nodes(input.docs)) { const r = fromNode(n, ptr); if (r) found.push({ ...r, adapter: input.adapter ?? "jsonld" }); }
  } else if (input.kind === "opengraph") {
    const r = openGraph(input.tags); if (r) found.push({ ...r, adapter: "opengraph" });
  } else {
    const r = metaPaper(input.tags); if (r) found.push({ ...r, adapter: "meta-citation" });
  }
  return found
    .filter((f) => Object.keys(f.b.props).length > 0)
    .map((f) => ({ type: f.type, properties: f.b.props, fields: f.b.fields, provenance: prov(f.adapter) }));
}
