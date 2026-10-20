// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { resolve } from "@recast/core";
import { classifyElement, createResolver } from "../src/index.js";

const NOW = "2026-09-30T10:00:00Z";
function at(html: string, selector: string, url = "https://example.org/p") {
  document.documentElement.innerHTML = html;
  return classifyElement(document.querySelector(selector)!, { url, now: NOW });
}

describe("Person", () => {
  it("a name in a heading with a mail link nearby: Person with email, confidence 0.65 to 0.7", () => {
    const [c] = at(`<body><h1>Ruslan Salakhutdinov</h1><p>Professor. <a href="mailto:Rus@cs.example.edu">email</a></p></body>`, "h1");
    expect(c).toMatchObject({ type: "Person", properties: { name: "Ruslan Salakhutdinov" } });
    expect(c!.fields["name"]!.confidence).toBeGreaterThanOrEqual(0.55);
    expect(() => resolve(c!)).not.toThrow();
  });
  it("a capitalised menu label in a heading stays below 0.5", () => {
    const [c] = at(`<body><footer><h3 id="x">Use Eventbrite</h3></footer></body>`, "#x").filter((x) => x.type === "Person");
    expect(c!.fields["name"]!.confidence).toBeLessThan(0.5);
  });
  it("a bare name in running text is still offered, but at a confidence that demands a deliberate choice", () => {
    const [c] = at(`<body><p>The metric was introduced by <span id="n">Kishore Papineni</span> in 2002.</p></body>`, "#n");
    expect(c).toMatchObject({ type: "Person", properties: { name: "Kishore Papineni" } });
    expect(c!.fields["name"]!.confidence).toBeLessThan(0.5);
  });
  it("finds the whole name when the pointer is on one word of it", () => {
    const [c] = at(`<body><h1><span id="a">Meera</span> <span>Iyer</span></h1></body>`, "#a");
    expect(c!.properties["name"]).toBe("Meera Iyer");
  });
  it.each(["Privacy Policy", "Contact Us", "Natural History Museum", "Sign In", "Read More", "Terms and Conditions", "Sale Ends Today", "New York", "hello world", "A", "Meera"])("does not call %j a person", (label) => {
    expect(at(`<body><nav><a id="x" href="#">${label}</a></nav></body>`, "#x").filter((c) => c.type === "Person")).toEqual([]);
  });
  it("evidence points at the element that was pointed at, and resolves", () => {
    const [c] = at(`<body><h2 id="p">Meera Iyer</h2></body>`, "#p");
    const r = createResolver(document)(c!.fields["name"]!.evidence[0]!, "Meera Iyer");
    expect(r.ok).toBe(true); expect(r.element!.id).toBe("p");
  });
});

describe("never attaches a neighbour's details", () => {
  it("a contact without an email does not borrow the email of the contact next to it", () => {
    const html = `<body><section><div><h3 id="a">Meera Iyer</h3> <a href="mailto:meera@example.com">Email</a></div><div><h3 id="b">Priya Nair</h3></div>
      <p>Some long text about the team and the launch plan that goes on for a while so that this section is clearly a whole list and not one person. ${"More words. ".repeat(20)}</p></section></body>`;
    const priya = at(html, "#b").find((c) => c.type === "Person")!;
    expect(priya.properties["email"]).toBeUndefined();
    expect(priya.fields["name"]!.confidence).toBeLessThan(0.5);
    expect(at(html, "#a").find((c) => c.type === "Person")!.properties["email"]).toEqual(["meera@example.com"]);
  });
  it("an address or map link belonging to a different record is not used either", () => {
    const html = `<body><section><div><h3 id="a">Toit</h3> <a href="https://maps.google.com/?q=toit">Map</a></div><div><address id="b">12 Some Road, Pune 411001</address></div>${"<p>Filler text to make the section large enough. </p>".repeat(8)}</section></body>`;
    const addr = at(html, "#b").find((c) => c.type === "Location")!;
    expect(addr.fields["address"]!.confidence).toBeLessThan(0.7);
  });
});

describe("Location", () => {
  it("an address block becomes a Location with the address", () => {
    const [c] = at(`<body><div id="a">60 East 65th Street, New York, NY 10065</div></body>`, "#a");
    expect(c).toMatchObject({ type: "Location", properties: { address: "60 East 65th Street, New York, NY 10065" } });
  });
  it("an <address> element with a map link scores higher, and phone/email are stripped", () => {
    const [c] = at(`<body><address id="a"><div>Tate Modern</div><div>Bankside</div><div>London SE1 9TG</div> <a href="mailto:x@y.org">x@y.org</a></address><a href="https://maps.google.com/?q=tate">Map</a></body>`, "#a");
    expect(c!.properties["address"]).toBe("Tate Modern Bankside London SE1 9TG");
    expect(c!.fields["address"]!.confidence).toBeGreaterThanOrEqual(0.6);
  });
  it("a place name is offered only as a weak reading (0.4) that must be chosen deliberately", () => {
    const cs = at(`<body><h2 id="n">Yosemite National Park</h2><p>We serve dinner.</p></body>`, "#n");
    const c = cs.find((x) => x.type === "Location")!;
    expect(c.properties).toEqual({ name: "Yosemite National Park" });
    expect(c.fields["name"]!.confidence).toBe(0.4);
  });
  it("a heading that is an event title near an address is NOT promoted to a confident place name", () => {
    const cs = at(`<body><section><h2 id="n">Hidden Spaces Tours</h2><p>42 East 20th Street, New York, NY 10003</p></section></body>`, "#n");
    for (const c of cs) for (const m of Object.values(c.fields)) expect(m.confidence).toBeLessThan(0.5);
  });
  it("does not offer a sentence or a lowercase phrase as a place name", () => {
    expect(at(`<body><p id="n">We serve dinner from five until late.</p></body>`, "#n")).toEqual([]);
    expect(at(`<body><p id="n">opening hours</p></body>`, "#n")).toEqual([]);
  });
  it("a whole pane of text that happens to contain an address is not an address", () => {
    const html = `<body><section id="pane"><h1>Launch planning</h1><h2>Contacts</h2><div>Meera Iyer</div><h2>Venue</h2><address>298 100 Feet Road, Indiranagar, Bengaluru 560038</address><p id="n">Notes: bring the signed agreement and the printed schedule for the team.</p></section></body>`;
    expect(at(html, "#n").filter((c) => c.type === "Location" && c.properties["address"])).toEqual([]);
    expect(at(html, "address")[0]!.properties["address"]).toBe("298 100 Feet Road, Indiranagar, Bengaluru 560038");
  });
  it.each(["arXiv:2302.13971", "https://doi.org/10.48550/arXiv.1207.0580", "40+32 pages", "(or arXiv:1406.2661v1 [stat.ML] for this version)", "+91 11 4444 7474", "hello@example.com", "Call us today", "1800 11 77 11"])("does not treat %j as an address", (t) => {
    expect(at(`<body><p id="x">${t}</p></body>`, "#x").filter((c) => c.type === "Location")).toEqual([]);
  });
});

describe("Event and Product", () => {
  it("a <time datetime> with a heading above it is a weak Event reading; explicit event markup makes it confident", () => {
    const [c] = at(`<body><section><h2>Launch Night</h2><time id="t" datetime="2026-10-05T18:30:00+05:30">Mon 5 Oct, 6:30 PM</time></section></body>`, "#t");
    expect(c).toMatchObject({ type: "Event", properties: { title: "Launch Night", start: "2026-10-05" } });
    expect(c!.fields["start"]!.confidence).toBeLessThan(0.5);
    const [e] = at(`<body><section><h2>Launch Night</h2><time id="t" class="event-start" datetime="2026-10-05">5 Oct</time></section></body>`, "#t");
    expect(e!.fields["start"]!.confidence).toBeGreaterThanOrEqual(0.5);
  });
  it.each(["Published: 25 January 2017", "Retrieved 27 February 2018", "[Submitted on 27 Feb 2023]"])("a publication date (%j) is never a confident Event", (t) => {
    for (const c of at(`<body><h1>A Paper</h1><p id="d">${t}</p></body>`, "#d")) for (const m of Object.values(c.fields)) expect(m.confidence).toBeLessThan(0.5);
  });
  it("a date with a year in text works; a date without a year is not guessed", () => {
    expect(at(`<body><h1>Conference</h1><p id="d">Sat, 17 October 2026</p></body>`, "#d")[0]).toMatchObject({ type: "Event", properties: { start: "2026-10-17" } });
    expect(at(`<body><h1>Conference</h1><p id="d">Sat, Oct 17</p></body>`, "#d")).toEqual([]);
  });
  it("a price next to a title is a Product with the right currency (confident only with price markup)", () => {
    const [c] = at(`<body><div><h1>Kettle</h1><span id="p" class="price">₹1,499.00</span></div></body>`, "#p");
    expect(c).toMatchObject({ type: "Product", properties: { name: "Kettle", price: { amount: 1499, currency: "INR" } } });
    expect(c!.fields["price"]!.confidence).toBeGreaterThanOrEqual(0.5);
    expect(at(`<body><div><h1>Kettle</h1><span id="p">₹1,499.00</span></div></body>`, "#p")[0]!.fields["price"]!.confidence).toBeLessThan(0.5);
  });
  it("a price with no title nearby is not a product", () => {
    expect(at(`<body><p id="p">Free shipping over $100</p></body>`, "#p").filter((c) => c.type === "Product")).toEqual([]);
  });
});

describe("guarantees", () => {
  it("everything it returns is low confidence, method dom, and valid against the schema", () => {
    const pages: [string, string][] = [
      [`<body><h1 id="x">Meera Iyer</h1></body>`, "#x"], [`<body><div id="x">60 East 65th Street, New York, NY 10065</div></body>`, "#x"],
      [`<body><h2>Launch</h2><time id="x" datetime="2026-10-05">5 Oct</time></body>`, "#x"], [`<body><h1>Kettle</h1><b id="x">$20</b></body>`, "#x"],
    ];
    for (const [html, sel] of pages) for (const c of at(html, sel)) {
      expect(c.provenance.capture.method).toBe("dom");
      for (const m of Object.values(c.fields)) expect(m.confidence).toBeLessThanOrEqual(0.75);
      expect(() => resolve(c)).not.toThrow();
    }
  });
  it("returns nothing for a plain paragraph", () => {
    expect(at(`<body><p id="x">Training deep neural networks is complicated by the fact that the distribution shifts.</p></body>`, "#x")).toEqual([]);
  });
});
