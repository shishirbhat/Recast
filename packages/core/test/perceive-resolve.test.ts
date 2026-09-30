import { describe, expect, it } from "vitest";
import { deserialize, identityOf, perceive, resolve, serialize, RecastError } from "../src/index.js";
import { AT, SRC, candidate, obj } from "./helpers.js";

const ld = (docs: unknown[]) => perceive({ kind: "jsonld", docs, source: SRC, at: AT });

describe("perceive: JSON-LD", () => {
  it("extracts a Person with evidence on every property", () => {
    const [c] = ld([{ "@type": "Person", name: "Meera Iyer", email: "mailto:Meera@Example.com", jobTitle: "Editor", worksFor: { name: "Kite Press" } }]);
    expect(c!.type).toBe("Person");
    expect(c!.properties).toMatchObject({ name: "Meera Iyer", email: ["Meera@Example.com"], role: "Editor", org: "Kite Press" });
    for (const k of Object.keys(c!.properties)) expect(c!.fields[k]!.evidence.length).toBeGreaterThan(0);
    expect(c!.fields["name"]!.evidence[0]!.locator).toEqual({ kind: "jsonld", value: "/0/name" });
    expect(c!.provenance.capture).toMatchObject({ method: "structured", adapter: "jsonld" });
  });
  it("extracts Event, Restaurant (as Location), ScholarlyArticle and Product from an @graph", () => {
    const cs = ld([{ "@graph": [
      { "@type": "Event", name: "Launch", startDate: "2026-10-05T18:30:00+05:30", location: { "@type": "Place", name: "Blue Tokai" } },
      { "@type": "Restaurant", name: "Toit", address: { streetAddress: "298 100 Feet Rd", addressLocality: "Bengaluru", postalCode: "560038" }, geo: { latitude: "12.979", longitude: 77.640 } },
      { "@type": "ScholarlyArticle", headline: "Attention Is All You Need", author: [{ name: "A. Vaswani" }, "N. Shazeer"], identifier: "https://doi.org/10.5555/3295222.3295349", datePublished: "2017-06-12" },
      { "@type": "Product", name: "Kettle", brand: { name: "Fellow" }, offers: { price: "149", priceCurrency: "usd" } },
    ] }]);
    expect(cs.map((c) => c.type)).toEqual(["Event", "Location", "ResearchPaper", "Product"]);
    expect(cs[0]!.properties["location"]).toBe("Blue Tokai");
    expect(cs[1]!.properties).toMatchObject({ name: "Toit", address: "298 100 Feet Rd, Bengaluru, 560038", lat: 12.979, lng: 77.64 });
    expect(cs[2]!.properties).toMatchObject({ title: "Attention Is All You Need", authors: ["A. Vaswani", "N. Shazeer"], year: 2017 });
    expect(cs[3]!.properties["price"]).toEqual({ amount: 149, currency: "USD" });
    for (const c of cs) expect(() => resolve(c)).not.toThrow();
  });
  it("emits nothing for types it does not understand", () => {
    expect(ld([{ "@type": "WebSite", name: "x" }, { "@type": "Recipe", name: "y" }])).toEqual([]);
  });
});

describe("perceive: citation_* meta", () => {
  const tags = [
    { name: "citation_title", content: " Deep Residual Learning " }, { name: "citation_author", content: "He, Kaiming" },
    { name: "citation_author", content: "Zhang, Xiangyu" }, { name: "citation_doi", content: "doi:10.1109/CVPR.2016.90" },
    { name: "citation_publication_date", content: "2016/06/27" }, { name: "citation_conference_title", content: "CVPR" },
  ];
  it("builds a ResearchPaper and records one evidence entry per author", () => {
    const [c] = perceive({ kind: "meta", tags, source: SRC, at: AT });
    expect(c!.properties).toMatchObject({ title: "Deep Residual Learning", authors: ["He, Kaiming", "Zhang, Xiangyu"], year: 2016, venue: "CVPR" });
    expect(c!.fields["authors"]!.evidence.map((e) => e.locator.value)).toEqual(["citation_author[0]", "citation_author[1]"]);
    const o = resolve(c!);
    expect(o.properties["doi"]).toBe("10.1109/cvpr.2016.90");
  });
  it("returns nothing without citation_title", () => {
    expect(perceive({ kind: "meta", tags: [{ name: "citation_author", content: "x" }], source: SRC, at: AT })).toEqual([]);
  });
});

describe("resolve", () => {
  it("gives the same id for the same person regardless of email case or spacing", () => {
    const a = obj("Person", { name: "Meera  Iyer", email: ["MEERA@example.com"] });
    const b = obj("Person", { name: "M. Iyer", email: ["meera@example.com"] });
    expect(a.id).toBe(b.id);
    expect(obj("Person", { name: "Someone", email: ["else@example.com"] }).id).not.toBe(a.id);
  });
  it("treats a DOI URL and a bare DOI as the same paper", () => {
    const a = obj("ResearchPaper", { title: "T", authors: ["A"], doi: "https://doi.org/10.1000/ABC" });
    const b = obj("ResearchPaper", { title: "T2", authors: ["B"], doi: "10.1000/abc" });
    expect(a.id).toBe(b.id);
  });
  it("falls back to the next identity group when the first key is absent", () => {
    expect(identityOf("Person", { name: "A" })).not.toBe(identityOf("Person", { name: "B" }));
    expect(identityOf("Person", { name: "A" })).toBe(identityOf("Person", { name: " a " }));
  });
  it.each([
    ["Event with a bad date", "Event", { title: "x", start: "next tuesday" }],
    ["Event without start", "Event", { title: "x" }],
    ["Location with nothing locatable", "Location", { url: "https://x" }],
    ["Location with lat but no lng", "Location", { name: "x", lat: 12 }],
    ["Location with lat out of range", "Location", { name: "x", lat: 120, lng: 1 }],
    ["Person with a bad email", "Person", { name: "x", email: ["nope"] }],
    ["ResearchPaper without authors", "ResearchPaper", { title: "x" }],
    ["Product with a bad currency", "Product", { name: "x", price: { amount: 1, currency: "dollars" } }],
    ["unknown property", "Person", { name: "x", shoeSize: 9 }],
  ] as const)("rejects %s", (_n, type, props) => {
    expect(() => resolve(candidate(type, props as Record<string, unknown>))).toThrow(RecastError);
  });
  it("rejects a property that has no evidence", () => {
    const c = candidate("Person", { name: "x", org: "y" });
    delete c.fields["org"];
    expect(() => resolve(c)).toThrowError(/evidence/);
  });
  it("never mutates its input and returns a deeply frozen object", () => {
    const c = candidate("Person", { name: " Meera ", email: ["A@B.co"] });
    const before = JSON.stringify(c);
    const o = resolve(c);
    expect(JSON.stringify(c)).toBe(before);
    expect(Object.isFrozen(o) && Object.isFrozen(o.properties) && Object.isFrozen(o.fields["name"]!.evidence)).toBe(true);
    expect(() => { (o.properties as Record<string, unknown>)["name"] = "x"; }).toThrow();
  });
  it("round-trips through canonical serialization byte-for-byte", () => {
    const o = obj("Event", { title: "Dinner", start: "2026-10-05T19:00:00Z", location: "Toit" });
    const s = serialize(o);
    expect(serialize(deserialize(s))).toBe(s);
  });
  it("rejects a tampered id and malformed JSON on deserialize", () => {
    const o = obj("Person", { name: "x", email: ["a@b.co"] });
    expect(() => deserialize(serialize(o).replace(o.id, "rc_" + "0".repeat(32)))).toThrowError(/id does not match/);
    expect(() => deserialize("{")).toThrow(RecastError);
  });
});
