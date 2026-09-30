// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createResolver, extractPage, parseLooseJson } from "../src/index.js";

const NOW = "2026-09-30T10:00:00Z";
const page = (html: string, url = "https://example.org/p") => {
  document.documentElement.innerHTML = html;
  return extractPage(document, { url, now: NOW });
};

describe("JSON-LD", () => {
  it("extracts an Event and a Restaurant, with a working evidence pointer for every property", () => {
    const r = page(`<head><title>t</title><script type="application/ld+json">{"@context":"https://schema.org","@graph":[
      {"@type":"Event","name":"Launch Night","startDate":"2026-10-05T18:30:00+05:30","location":{"@type":"Place","name":"Blue Tokai"}},
      {"@type":"Restaurant","name":"Toit","address":{"streetAddress":"298 100 Feet Rd","addressLocality":"Bengaluru"}}]}</script></head>
      <body><h1>Launch Night</h1><p>At Blue Tokai</p></body>`);
    expect(r.objects.map((o) => o.type).sort()).toEqual(["Event", "Location"]);
    const resolve = createResolver(document);
    for (const o of r.objects) for (const [k, meta] of Object.entries(o.fields)) {
      expect(meta.evidence.some((e) => resolve(e, o.properties[k]).ok), `${o.type}.${k}`).toBe(true);
    }
  });
  it("survives common real-world JSON-LD damage (trailing commas, raw newlines) and counts real failures", () => {
    expect(parseLooseJson('{"a":"x\ny",}')).toEqual({ a: "x\ny" });
    const r = page(`<head><script type="application/ld+json">{"@type":"Person","name":"Meera Iyer",}</script>
      <script type="application/ld+json">{ not json at all</script></head><body></body>`);
    expect(r.objects[0]!.properties["name"]).toBe("Meera Iyer");
    expect(r.diagnostics).toMatchObject({ jsonLdScripts: 2, jsonLdParseFailures: 1 });
  });
  it("repairs a space-separated date, and drops one bad property instead of losing the whole object", () => {
    const r = page(`<head><script type="application/ld+json">[
      {"@type":"Event","name":"A","startDate":"2026-10-05 18:00:00"},
      {"@type":"Person","name":"Meera","email":"not-an-email"}]</script></head>`);
    expect(r.objects.find((o) => o.type === "Event")!.properties["start"]).toBe("2026-10-05T18:00:00");
    const p = r.objects.find((o) => o.type === "Person")!;
    expect(p.properties["email"]).toBeUndefined();
    expect(r.droppedProperties).toEqual([expect.objectContaining({ type: "Person", property: "email" })]);
  });
  it("reports objects it had to reject rather than hiding them", () => {
    const r = page(`<head><script type="application/ld+json">{"@type":"Event","name":"No date"}</script></head>`);
    expect(r.objects).toEqual([]);
    expect(r.rejected).toEqual([expect.objectContaining({ type: "Event" })]);
  });
});

describe("citation_* meta", () => {
  it("builds a paper and each author's evidence points at its own meta tag", () => {
    const r = page(`<head><meta name="citation_title" content="Deep Residual Learning"><meta name="citation_author" content="He, Kaiming">
      <meta name="citation_author" content="Zhang, Xiangyu"><meta name="citation_doi" content="10.1109/CVPR.2016.90"></head>
      <body><h1>Deep Residual Learning</h1><span>Kaiming He</span></body>`);
    const o = r.objects[0]!;
    expect(o.type).toBe("ResearchPaper");
    const resolve = createResolver(document);
    const authorEv = o.fields["authors"]!.evidence.filter((e) => e.locator.kind === "meta");
    expect(authorEv.map((e) => resolve(e, o.properties["authors"]).element?.getAttribute("content"))).toEqual(["He, Kaiming", "Zhang, Xiangyu"]);
  });
});

describe("microdata", () => {
  it("reads itemprop values from the right attributes and links evidence to the visible element", () => {
    const r = page(`<body><div itemscope itemtype="https://schema.org/Product">
      <h1 itemprop="name">Stagg EKG Kettle</h1><meta itemprop="sku" content="STG-1"><a itemprop="url" href="/p/stagg">buy</a>
      <span itemprop="brand" itemscope itemtype="https://schema.org/Brand"><span itemprop="name">Fellow</span></span></div></body>`);
    const o = r.objects[0]!;
    expect(o.properties).toMatchObject({ name: "Stagg EKG Kettle", sku: "STG-1", brand: "Fellow" });
    const ev = o.fields["name"]!.evidence[0]!;
    expect(ev.locator.kind).toBe("css");
    expect(createResolver(document)(ev, "Stagg EKG Kettle")).toMatchObject({ ok: true });
  });
});

describe("OpenGraph, merging and corroboration", () => {
  it("merges JSON-LD and OpenGraph for the same product, keeping the higher-confidence value", () => {
    const r = page(`<head><meta property="og:type" content="product"><meta property="og:title" content="Stagg EKG | Fellow">
      <script type="application/ld+json">{"@type":"Product","name":"Stagg EKG","brand":"Fellow"}</script></head><body><h1>Stagg EKG</h1></body>`);
    expect(r.objects).toHaveLength(1);
    expect(r.objects[0]!.properties["name"]).toBe("Stagg EKG");
    expect(r.objects[0]!.fields["name"]!.confidence).toBe(0.95);
  });
  it("merges an OpenGraph title that only partly overlaps the structured name, but never two different structured objects", () => {
    const og = page(`<head><meta property="og:type" content="product"><meta property="og:title" content="Stagg EKG | Fellow">
      <script type="application/ld+json">{"@type":"Product","name":"Stagg EKG Electric Kettle"}</script></head>`);
    expect(og.objects).toHaveLength(1);
    const two = page(`<head><script type="application/ld+json">[{"@type":"Product","name":"Stagg EKG Electric Kettle"},{"@type":"Product","name":"Stagg EKG Pro Kettle"}]</script></head>`);
    expect(two.objects).toHaveLength(2);
  });
  it("adds a visible-element corroboration with a text range", () => {
    const r = page(`<head><script type="application/ld+json">{"@type":"Person","name":"Meera Iyer"}</script></head><body><main><h1>Meera Iyer</h1></main></body>`);
    const css = r.objects[0]!.fields["name"]!.evidence.find((e) => e.locator.kind === "css")!;
    expect(css.textRange).toEqual({ start: 0, end: 10 });
    expect(document.querySelector(css.locator.value)?.tagName).toBe("H1");
  });
  it("an evidence pointer that does not contain the value does not resolve", () => {
    page(`<head><meta name="citation_title" content="Real Title"></head>`);
    const ev = { locator: { kind: "meta" as const, value: "citation_title[0]" } };
    expect(createResolver(document)(ev, "A Different Title").ok).toBe(false);
    expect(createResolver(document)(ev, "real title").ok).toBe(true);
  });
  it("returns nothing for a page with no structure", () => {
    expect(page(`<body><h1>Just a page</h1><p>Hello</p></body>`).objects).toEqual([]);
  });
});

describe("DOM heuristics (low confidence, narrow)", () => {
  it("turns a mailto link labelled with a person's name into a Person at 0.6 confidence", () => {
    const r = page(`<body><p>Contact <a href="mailto:Meera.Iyer@example.com?subject=hi">Meera Iyer</a></p></body>`);
    expect(r.objects).toHaveLength(1);
    expect(r.objects[0]).toMatchObject({ type: "Person", properties: { name: "Meera Iyer", email: ["meera.iyer@example.com"] } });
    expect(r.objects[0]!.fields["email"]!.confidence).toBe(0.6);
    expect(r.objects[0]!.provenance.capture.method).toBe("dom");
  });
  it.each(["info@example.com", "Email us", "Contact", "sales team lead", "Support 24x7"])("ignores a mailto labelled %j", (label) => {
    expect(page(`<body><a href="mailto:x@example.com">${label}</a></body>`).objects).toEqual([]);
  });
  it("reads an <address> element as a Location, but not a bare word or an email", () => {
    expect(page(`<body><address>298 100 Feet Road, Indiranagar, Bengaluru 560038</address></body>`).objects[0]).toMatchObject({ type: "Location", properties: { address: "298 100 Feet Road, Indiranagar, Bengaluru 560038" } });
    expect(page(`<body><address>Contact us</address></body>`).objects).toEqual([]);
    expect(page(`<body><address>hello@example.com</address></body>`).objects).toEqual([]);
  });
  it("keeps words apart when an <address> is made of block elements", () => {
    const o = page(`<body><address><div>Tate Modern</div><div>Bankside</div><div>London SE1 9TG</div></address></body>`).objects[0]!;
    expect(o.properties["address"]).toBe("Tate Modern Bankside London SE1 9TG");
    expect(createResolver(document)(o.fields["address"]!.evidence[0]!, o.properties["address"]).ok).toBe(true);
  });
  it("strips phone and email out of an <address>, and ignores one that is only contact details", () => {
    expect(page(`<body><address>Trafalgar Square London WC2N 5DN hello@example.org</address></body>`).objects[0]!.properties["address"]).toBe("Trafalgar Square London WC2N 5DN");
    expect(page(`<body><address>India Toll Free: 1800 11 77 11 Telephone: +91 11 4444 7474</address></body>`).objects).toEqual([]);
  });
  it("merges an <address> into a structured Location with the same address instead of duplicating it", () => {
    const r = page(`<head><script type="application/ld+json">{"@type":"Restaurant","name":"Toit","address":"298 100 Feet Road, Bengaluru"}</script></head>
      <body><address>298 100 Feet Road, Bengaluru</address></body>`);
    expect(r.objects).toHaveLength(1);
    expect(r.objects[0]!.properties["name"]).toBe("Toit");
  });
  it("makes relative URLs absolute, and the evidence still resolves", () => {
    const r = page(`<head><base href="https://shop.example/list"></head><body><div itemscope itemtype="https://schema.org/Product"><h1 itemprop="name">Kettle</h1><a itemprop="url" href="/p/kettle">x</a></div></body>`, "https://shop.example/list");
    expect(r.objects[0]!.properties["url"]).toBe("https://shop.example/p/kettle");
    const ev = r.objects[0]!.fields["url"]!.evidence[0]!;
    expect(createResolver(document)(ev, "https://shop.example/p/kettle").ok).toBe(true);
  });
  it("marks the page's subject primary and other objects related", () => {
    const r = page(`<head><title>Cloud Paint | Shop</title><script type="application/ld+json">{"@type":"Product","name":"Cloud Paint"}</script></head>
      <body><h1>Cloud Paint</h1><div itemscope itemtype="https://schema.org/Product"><span itemprop="name">Boy Brow</span></div></body>`);
    const byName = Object.fromEntries(r.objects.map((o) => [o.properties["name"], r.roles[o.id]]));
    expect(byName).toEqual({ "Cloud Paint": "primary", "Boy Brow": "related" });
  });
});

describe("hostile pages", () => {
  it("ignores itemprop names that would touch an object's prototype", () => {
    const r = page(`<body><div itemscope itemtype="https://schema.org/Person"><span itemprop="name">Meera</span>
      <span itemprop="__proto__">x</span><span itemprop="constructor">y</span></div></body>`);
    expect(r.objects[0]!.properties).toEqual({ name: "Meera" });
    expect(Object.getPrototypeOf(r.objects[0]!.properties)).toBe(Object.prototype);
  });
  it("drops javascript:, data: and file: URLs instead of carrying them", () => {
    const r = page(`<head><script type="application/ld+json">{"@type":"Product","name":"Kettle","url":"javascript:alert(1)","image":"data:image/png;base64,AAAA"}</script></head>`);
    expect(r.objects[0]!.properties["url"]).toBeUndefined();
    expect(r.objects[0]!.properties["image"]).toBeUndefined();
    expect(r.droppedProperties.map((d) => d.property).sort()).toEqual(["image", "url"]);
  });
  it("gives up quickly on an enormous, unrepairable JSON-LD block instead of running a slow regex over it", () => {
    const big = '{"@type":"Person","name":"' + '\\"'.repeat(200_000) + '",}';        // invalid (trailing comma) AND large
    const t0 = performance.now();
    const r = page(`<head><script type="application/ld+json">${big}</script></head>`);
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(r.diagnostics.jsonLdParseFailures).toBe(1);
  });
  it("caps how many microdata items it will walk", () => {
    const items = Array.from({ length: 1500 }, (_, i) => `<div itemscope itemtype="https://schema.org/Product"><span itemprop="name">P${i}</span></div>`).join("");
    const r = page(`<body>${items}</body>`);
    expect(r.diagnostics.microdataItems).toBe(1000);
  });
});

describe("cssPath", () => {
  it("produces a valid, unique selector for ids that start with a digit or contain punctuation", async () => {
    const { cssPath } = await import("../src/dom-util.js");
    document.documentElement.innerHTML = `<body><div id="6abd2780"><p id="a:b.c">x</p></div><div id="6abd2780b"></div></body>`;
    for (const sel of ["#\\36 abd2780 > p", "p"]) void sel;
    const p = document.querySelector("p")!;
    expect(document.querySelector(cssPath(p))).toBe(p);
    expect(document.querySelector(cssPath(document.getElementById("6abd2780")!))).toBe(document.getElementById("6abd2780"));
  });
});
