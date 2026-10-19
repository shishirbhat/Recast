import { describe, expect, it } from "vitest";
import { createResolver, ResolveInputError, toWire, type ApiType, type Embedder, type Llm, type ResolveInput } from "../src";

const NOW = () => new Date("2026-10-15T10:00:00Z");
const r = (cfg = {}) => createResolver({ now: NOW, ...cfg });
const ok = async (input: ResolveInput, cfg = {}) => r(cfg).resolve(input);

describe("rules stage: typed objects from raw text", () => {
  it("a person with an email resolves with provenance pointing into the text", async () => {
    const o = await ok({ raw: "Meera Iyer, meera@x.com, +91 98765 43210" });
    if (o.status !== "resolved") throw new Error(JSON.stringify(o));
    expect(o.object).toMatchObject({ type: "Person", fields: { name: "Meera Iyer", email: ["meera@x.com"], phone: ["+919876543210"] } });
    expect(o.meta).toEqual({ stage: "rules", schemaVersion: "1.0.0", degraded: false });
    const email = o.object.provenance.find((p) => p.field === "email")!;
    expect(email).toMatchObject({ source: "rules", confidence: 0.97, excerpt: "meera@x.com" });
    expect(o.object.id).toMatch(/^rc_/);
  });

  it("a guessed name keeps the object below 'low': confidence is the weakest field", async () => {
    const o = await ok({ raw: "Meera Iyer, meera@x.com" });
    if (o.status !== "resolved") throw new Error("not resolved");
    expect(o.object.confidence).toBe(0.72); expect(o.object.trust).toBe("medium");
  });

  it("email alone (no name) is unresolved with a suggestion, never a made-up name", async () => {
    const o = await ok({ raw: "meera@x.com" });
    expect(o).toMatchObject({ status: "unresolved", suggestion: "include a name with the email address" });
  });

  it("events: ISO and written dates, with and without a time", async () => {
    const a = await ok({ raw: "Launch dinner 2026-11-14 19:30" });
    const b = await ok({ raw: "Launch dinner on 14 November 2026, 7:30 pm" });
    const c = await ok({ raw: "Founders meetup, Nov 14, 2026" });
    for (const [o, start] of [[a, "2026-11-14T19:30"], [b, "2026-11-14T19:30"], [c, "2026-11-14"]] as const) {
      if (o.status !== "resolved") throw new Error(JSON.stringify(o));
      expect(o.object.type).toBe("Event"); expect(o.object.fields.start).toBe(start);
    }
    if (a.status === "resolved") expect(a.object.fields.title).toBe("Launch dinner");
  });

  it("an impossible date is not an event", async () => {
    expect((await ok({ raw: "Launch dinner 2026-02-31" })).status).toBe("unresolved");
  });

  it("relative dates are not guessed: unresolved, and the suggestion says what to send instead", async () => {
    const o = await ok({ raw: "Team meeting Friday 3pm" });
    expect(o).toMatchObject({ status: "unresolved" });
    expect(o.status === "unresolved" && o.suggestion).toMatch(/full date/);
  });

  it("a postal address resolves to a Location, splitting a leading name", async () => {
    const o = await ok({ raw: "Toit, 298 100 Feet Road, Indiranagar, Bengaluru 560038" });
    if (o.status !== "resolved") throw new Error(JSON.stringify(o));
    expect(o.object.type).toBe("Location"); expect(o.object.fields).toMatchObject({ name: "Toit", address: "298 100 Feet Road, Indiranagar, Bengaluru 560038" });
  });

  it("products: price and currency are parsed, symbols and codes", async () => {
    for (const [raw, amount, currency] of [["Philips Kettle ₹1,499", 1499, "INR"], ["Kettle $24.99", 24.99, "USD"], ["Kettle 24.99 EUR", 24.99, "EUR"]] as const) {
      const o = await ok({ raw });
      if (o.status !== "resolved") throw new Error(raw);
      expect(o.object.fields.price).toEqual({ amount, currency });
    }
  });

  it("papers need a title as well as an identifier; an identifier alone is unresolved", async () => {
    const good = await ok({ raw: "Attention Is All You Need (2017) arXiv:1706.03762" });
    if (good.status !== "resolved") throw new Error(JSON.stringify(good));
    expect(good.object.fields).toMatchObject({ title: "Attention Is All You Need", arxivId: "1706.03762", year: 2017 });
    expect((await ok({ raw: "10.1038/nature14539" })).status).toBe("unresolved");
  });

  it("text with two strong readings is ambiguous, and target.type settles it", async () => {
    const raw = "Founders meetup 2026-11-14 ₹500";
    const a = await ok({ raw });
    expect(a.status).toBe("ambiguous");
    const e = await ok({ raw, target: { type: "Event" } });
    expect(e.status === "resolved" && e.object.type).toBe("Event");
  });

  it("asking for a type the text isn't gives unresolved, naming what it looks like", async () => {
    const o = await ok({ raw: "Toit, 298 100 Feet Road, Bengaluru 560038", target: { type: "Person" } });
    expect(o).toMatchObject({ status: "unresolved" }); expect(o.status === "unresolved" && o.reason).toMatch(/reads as Location/);
  });

  it("below the confidence threshold the answer moves to alternatives", async () => {
    const o = await ok({ raw: "Meera Iyer, meera@x.com", options: { confidenceThreshold: 0.9 } });
    expect(o.status).toBe("ambiguous"); expect(o.status === "ambiguous" && o.alternatives[0]!.type).toBe("Person");
  });

  it("is deterministic: same input, same object id", async () => {
    const a = await ok({ raw: "Meera Iyer, meera@x.com" }); const b = await ok({ raw: "Meera Iyer, meera@x.com" });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("documents: a titled link", () => {
  it("resolves, and routes to Notion and Tasks", async () => {
    for (const dest of ["notion", "google_tasks"]) {
      const o = await ok({ raw: "Read the spec https://example.com/spec", target: { destination: dest } });
      if (o.status !== "resolved") throw new Error(JSON.stringify(o));
      expect(o.object).toMatchObject({ type: "Document", fields: { title: "Read the spec", url: "https://example.com/spec" } });
      expect(o.routing?.bridgeReliability).toBe("official_api"); expect(o.routing?.consent).toBe(dest === "notion" ? "confirm" : "release");   // Notion relies on the guessed title (0.7 < 0.75: asks once); Tasks relies on the link itself (0.97)
    }
  });
  it("a bare link has no title and is not resolved", async () => { expect((await ok({ raw: "https://example.com/spec" })).status).toBe("unresolved"); });
});

describe("routing uses the real contracts, grammar and trust rules", () => {
  it("person to calendar: attendee, official API, asks once because it notifies someone", async () => {
    const o = await ok({ raw: "Meera Iyer, meera@x.com", target: { type: "Person", destination: "google_calendar" } });
    if (o.status !== "resolved" || !o.routing) throw new Error(JSON.stringify(o));
    expect(o.routing).toMatchObject({ action: "Add attendee", relationId: "person-event-attendee", bridge: "google-calendar.event-editor", bridgeReliability: "official_api", reliabilityLabel: "Official API", requiresConfirmation: true, consent: "confirm", risk: "medium" });
    expect(o.object.trust).toBe("medium");
  });

  it("a destination that cannot take the type says so, and the object still resolves", async () => {
    const o = await ok({ raw: "Kettle $24.99", target: { destination: "google_calendar" } });
    if (o.status !== "resolved") throw new Error("not resolved");
    expect(o.routing).toBeNull(); expect(o.routeError).toBe("Google Calendar does not accept a Product");
  });

  it("an unknown destination is the caller's mistake, listed with the known ones", async () => {
    await expect(ok({ raw: "Meera Iyer, meera@x.com", target: { destination: "hubspot" } })).rejects.toThrow(/unknown destination 'hubspot'. Known: google_calendar, google_calendar_event, gmail/);
  });

  it("a person to Gmail makes a draft; a paper to nowhere has no routing", async () => {
    const g = await ok({ raw: "Meera Iyer, meera@x.com", target: { destination: "gmail" } });
    expect(g.status === "resolved" && g.routing?.action).toBe("Create a draft to this person");
    const p = await ok({ raw: "Attention Is All You Need (2017) arXiv:1706.03762" });
    expect(p.status === "resolved" && p.routing).toBeNull();
  });
});

describe("input limits", () => {
  it("rejects empty, oversized and badly-optioned requests as caller errors", async () => {
    await expect(ok({ raw: "   " })).rejects.toBeInstanceOf(ResolveInputError);
    await expect(ok({ raw: "x".repeat(4001) })).rejects.toMatchObject({ code: "input_too_large" });
    await expect(ok({ raw: "Meera Iyer, meera@x.com", options: { confidenceThreshold: 2 } })).rejects.toMatchObject({ code: "bad_option" });
  });
});

describe("hostile text", () => {
  it("script, prototype keys and control characters are just text", async () => {
    const o = await ok({ raw: '<script>alert(1)</script> __proto__ {"constructor":1} Meera Iyer, meera@x.com' });
    expect(["resolved", "unresolved", "ambiguous"]).toContain(o.status);
    expect(Object.prototype.hasOwnProperty.call({}, "polluted")).toBe(false);
  });
  it("a header-injection attempt in an email is not matched as one address", async () => {
    const o = await ok({ raw: "Meera Iyer, meera@x.com\r\nBcc: evil@y.com" });
    if (o.status === "resolved") expect(o.object.fields.email).toEqual(["meera@x.com", "evil@y.com"]);   // both are listed as the text says; the bridge refuses CR/LF on its own
  });
});

describe("cascade: model stages are optional, capped, grounded and breakable", () => {
  const tie = "Founders meetup 2026-11-14 ₹500";
  const embedder = (sim: Partial<Record<ApiType, number>>): Embedder => ({
    async embed(text) { // route texts get fixed vectors; the query gets a vector that is closest to the chosen type
      const order: ApiType[] = ["Person", "Event", "Location", "Product", "Paper", "Document"];
      const v = order.map(() => 0);
      const idx = order.findIndex((t) => text.startsWith(({ Person: "a person", Event: "an event", Location: "a place", Product: "a product", Paper: "an academic", Document: "a web page" } as const)[t]));
      if (idx >= 0) v[idx] = 1; else order.forEach((t, i) => { v[i] = sim[t] ?? 0; });
      return v;
    },
  });
  it("an embedding breaks a tie between two readings, and the stage says so", async () => {
    const o = await ok({ raw: tie }, { embedder: embedder({ Person: 0, Event: 0.95, Location: 0, Product: 0.4, Paper: 0 }) });
    expect(o.status).toBe("resolved"); expect(o.meta.stage).toBe("embedding"); expect(o.status === "resolved" && o.object.type).toBe("Event");
  });
  it("an embedding that cannot separate them leaves it ambiguous rather than guessing", async () => {
    const o = await ok({ raw: tie }, { embedder: embedder({ Person: 0, Event: 0.7, Location: 0, Product: 0.68, Paper: 0 }) });
    expect(o.status).toBe("ambiguous");
  });

  const llm = (out: Awaited<ReturnType<Llm["extract"]>>): Llm => ({ extract: async () => out });
  it("a model fills in when the rules find nothing; confidence is capped so it always asks", async () => {
    const o = await ok({ raw: "Hey it's Aarav from Zoho, aarav@zoho.com" }, { llm: llm({ type: "Person", fields: { name: "Aarav", org: "Zoho", email: ["aarav@zoho.com"] }, confidence: 0.99 }) });
    if (o.status !== "resolved") throw new Error(JSON.stringify(o));
    expect(o.meta.stage).toBe("llm"); expect(o.object.confidence).toBe(0.7); expect(o.object.trust).not.toBe("low");
    expect(o.object.provenance.every((p) => p.source === "llm")).toBe(true);
  });
  it("values the model made up are dropped, not trusted", async () => {
    const o = await ok({ raw: "Hey it's Aarav from Zoho, aarav@zoho.com" }, { llm: llm({ type: "Person", fields: { name: "Aarav", email: ["aarav@zoho.com"], phone: ["+911234567890"], org: "Google" }, confidence: 0.9 }) });
    if (o.status !== "resolved") throw new Error(JSON.stringify(o));
    expect(Object.keys(o.object.fields).sort()).toEqual(["email", "name"]);
  });
  it("a model answer for the wrong type is ignored", async () => {
    const o = await ok({ raw: "Hey it's Aarav from Zoho", target: { type: "Event" } }, { llm: llm({ type: "Person", fields: { name: "Aarav" }, confidence: 0.9 }) });
    expect(o.status).toBe("unresolved");
  });
  it("a failing model never breaks the answer: degraded, and the circuit opens after repeated failures", async () => {
    let calls = 0; const t = { v: 0 };
    const bad: Llm = { extract: async () => { calls++; throw new Error("provider down"); } };
    const res = createResolver({ now: NOW, llm: bad, breaker: { threshold: 3, cooldownMs: 1000, now: () => t.v } });
    for (let i = 0; i < 5; i++) { const o = await res.resolve({ raw: "nothing recognisable here at all" }); expect(o.status).toBe("unresolved"); expect(o.meta.degraded).toBe(true); }
    expect(calls).toBe(3);                         // calls 4 and 5 were short-circuited
    t.v = 2000; await res.resolve({ raw: "nothing recognisable here at all" });
    expect(calls).toBe(4);                         // half-open: one trial call
  });
  it("rules-only works with no stages configured and reports degraded: false", async () => {
    const o = await ok({ raw: "Meera Iyer, meera@x.com" }); expect(o.meta.degraded).toBe(false);
  });
});

describe("wire format", () => {
  it("is snake_case, omits provenance on request, and carries the schema version", async () => {
    const o = await ok({ raw: "Meera Iyer, meera@x.com", target: { destination: "google_calendar" } });
    const w = toWire(o, false) as any;
    expect(w.routing).toMatchObject({ bridge_reliability: "official_api", requires_confirmation: true, relation_id: "person-event-attendee" });
    expect(w.object.provenance).toBeUndefined(); expect(w.meta.schema_version).toBe("1.0.0");
    expect((toWire(o, true) as any).object.provenance.length).toBeGreaterThan(0);
  });
});
