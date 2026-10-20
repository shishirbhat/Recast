// Clumps: pieces pressed together into one object, recursively, without losing any ingredient.
import { describe, expect, it } from "vitest";
import { answerClump, canMerge, chooseClump, mergeClumps, newClump, propose, removeIngredient, resolve, typeOf, viewClump, type Clump, type Fragment } from "../src/index.js";
import { relationById } from "../src/rules.js";

const CTX = { now: "2026-10-19T09:00:00Z", timezone: "Asia/Kolkata" };   // Monday 19 Oct 2026, 14:30 in Bengaluru
let n = 0;
const frag = (kind: Fragment["kind"], text: string, extra: Partial<Fragment> = {}): Fragment => ({
  id: `f${++n}`, kind, text, confidence: 0.9, evidence: [{ locator: { kind: "css", value: `#el${n}` }, excerpt: text }], source: { app: "chrome", url: `https://example.com/${kind}` }, ...extra,
});
const one = (kind: Fragment["kind"], text: string, extra: Partial<Fragment> = {}) => newClump(`c${++n}`, frag(kind, text, extra));
const merged = (a: Clump, b: Clump, confirmChange = false) => { const r = mergeClumps(a, b, { confirmChange }); if (!r.ok) throw new Error(r.reason); return r.clump; };

describe("pressing pieces together", () => {
  it("Maya + a restaurant is one object: a plan to meet there, still missing a time", () => {
    const maya = one("person", "Maya Rao", { value: { name: "Maya Rao", email: "maya@example.com" } });
    const dakshin = one("place", "Dakshin", { value: { name: "Dakshin", address: "12 MG Road, Bengaluru" } });
    const c = merged(dakshin, maya);
    expect(c.id).toBe(dakshin.id);   // the object that was already there, grown
    const v = viewClump(c, CTX);
    expect(v).toMatchObject({ type: "Event", label: "Meet Maya at Dakshin", proposed: true, placeableAs: ["Calendar"], candidate: null });
    expect(v.summary).toEqual(["Maya Rao", "Dakshin"]);
    expect(v.missing.map((m) => m.field).sort()).toEqual(["start", "title"]);
    expect(v.event!.fields.description).toMatchObject({ value: "With Maya Rao", origin: "extracted" });
  });
  it("the plan + a time is a proposed event, and every ingredient is still there with its source", () => {
    const plan = merged(one("place", "Dakshin", { value: { name: "Dakshin" } }), one("person", "Maya Rao"));
    const c = merged(plan, one("time", "Friday 7:30 PM"));
    expect(c.ingredients.map((f) => f.kind)).toEqual(["place", "person", "time"]);
    const v = viewClump(c, CTX);
    expect(v.event!.fields.start).toMatchObject({ value: "2026-10-23T19:30", origin: "inferred" });
    expect(v.summary).toEqual(["Maya Rao", "Dakshin", "Fri, 23 Oct, 7:30 PM"]);
    expect(v.missing.map((m) => m.field)).toEqual(["title"]);   // never invented: the person accepts the suggestion
    const ready = viewClump(answerClump(c, "title", v.missing[0]!.suggestions![0]!), CTX);
    expect(ready).toMatchObject({ label: "Meet Maya at Dakshin", proposed: false });
    expect(ready.candidate!.type).toBe("Event");
    for (const field of ["location", "start", "description"]) expect(ready.candidate!.fields[field]!.evidence[0]!.source?.url).toMatch(/^https:\/\/example\.com\//);
  });
  it("a composed event goes through the normal proposal path to a calendar, with the usual risk", () => {
    const c = answerClump(merged(merged(one("place", "Dakshin"), one("person", "Maya Rao")), one("time", "2026-10-23 19:30")), "title", "Dinner with Maya");
    const obj = resolve(viewClump(c, CTX).candidate!);
    const contract = { destination: "calendar.agenda", app: "Calendar", targetKind: "Calendar" as const, reliability: "official-api" as const, accepts: [{ relationId: "event-calendar-entry", effect: "Add to calendar", dataMoved: ["Event.title", "Event.start"] }] };
    const [p] = propose(obj, contract);
    expect(p).toMatchObject({ status: "ready", relationId: "event-calendar-entry" });
    expect(relationById("event-calendar-entry")!.risk).toBe("low");
  });
  it("merging a whole clump into another works (recursive), and order of ingredients is kept", () => {
    const a = merged(one("person", "Maya Rao"), one("person", "Arjun Mehta"));
    expect(viewClump(a, CTX)).toMatchObject({ type: "People", label: "Maya Rao + Arjun Mehta", placeableAs: [] });
    const b = merged(one("place", "Dakshin"), one("time", "2026-10-23 19:30"));
    const c = merged(b, a);
    expect(viewClump(c, CTX).event!.fields.description!.value).toBe("With Maya Rao, Arjun Mehta");
    expect(c.ingredients).toHaveLength(4);
  });
  it("a person + a sentence is a message draft; it needs an address the page did not give", () => {
    const c = merged(one("person", "Maya Rao"), one("text", "Can we move dinner to Saturday?"));
    let v = viewClump(c, CTX);
    expect(v).toMatchObject({ type: "Message", label: "Message Maya", placeableAs: ["Drafts"], candidate: null });
    expect(v.missing[0]!.reason).toMatch(/Maya Rao has no email address on the page/);
    v = viewClump(answerClump(c, "to", "not-an-email"), CTX); expect(v.missing[0]!.reason).toMatch(/does not look like an email/);
    v = viewClump(answerClump(c, "to", "maya@example.com"), CTX);
    expect(v.candidate).toMatchObject({ type: "Message", properties: { to: ["maya@example.com"], snippet: "Can we move dinner to Saturday?" } });
  });
});

describe("what does not merge silently", () => {
  it("a product cannot join a plan; two bare sentences do not make an object; an object cannot merge with itself", () => {
    const plan = merged(one("place", "Dakshin"), one("person", "Maya Rao"));
    const kettle = one("thing", "Stagg EKG Kettle");
    expect(mergeClumps(plan, kettle)).toMatchObject({ ok: false, code: "incompatible", reason: expect.stringMatching(/cannot be combined/) });
    expect(mergeClumps(one("text", "hello"), one("text", "world"))).toMatchObject({ ok: false, code: "incompatible" });
    expect(mergeClumps(plan, plan)).toMatchObject({ ok: false, code: "same_object" });
  });
  it("a message that gains a time would become an event: the person has to confirm that", () => {
    const msg = merged(one("person", "Maya Rao"), one("text", "Dinner?"));
    expect(canMerge(msg, one("time", "Friday 7 PM"))).toMatchObject({ ok: true, becomes: "Event", change: { from: "Message", to: "Event" } });
    const r = mergeClumps(msg, one("time", "Friday 7 PM"));
    expect(r).toMatchObject({ ok: false, code: "needs_confirmation", becomes: "Event" });
    expect(mergeClumps(msg, one("time", "Friday 7 PM"), { confirmChange: true }).ok).toBe(true);
  });
  it("two different times stay a visible conflict until the person chooses", () => {
    const t1 = frag("time", "Friday 7:30 PM"), t2 = frag("time", "Saturday 8 PM");
    let c = merged(merged(newClump("x", t1), one("place", "Dakshin")), newClump("y", t2));
    const v = viewClump(c, CTX); expect(v.conflicts[0]!.field).toBe("start"); expect(v.candidate).toBeNull();
    c = chooseClump(c, "start", t2.id); expect(viewClump(c, CTX).event!.fields.start!.value).toBe("2026-10-24T20:00");
  });
});

describe("pulling apart", () => {
  it("removing an ingredient gives it back as its own object and recalculates the rest", () => {
    const time = frag("time", "Friday 7:30 PM");
    const c = merged(merged(one("place", "Dakshin"), one("person", "Maya Rao")), newClump("t", time));
    const { rest, released } = removeIngredient(c, time.id, "back");
    expect(released).toEqual({ id: "back", ingredients: [time], answers: {}, choices: {} });
    expect(rest!.id).toBe(c.id); expect(viewClump(rest!, CTX).missing.map((m) => m.field)).toContain("start");
    const last = removeIngredient(removeIngredient(rest!, rest!.ingredients[1]!.id, "r1").rest!, rest!.ingredients[0]!.id, "r2");
    expect(last.rest).toBeNull();
  });
  it("a choice about a removed ingredient goes with it", () => {
    const t1 = frag("time", "Friday 7:30 PM"), t2 = frag("time", "Saturday 8 PM");
    const c = chooseClump(merged(newClump("a", t1), newClump("b", t2)), "start", t2.id);
    expect(removeIngredient(c, t2.id, "z").rest!.choices).toEqual({});
  });
  it("composing is pure: same inputs, same answer, nothing mutated", () => {
    const a = one("place", "Dakshin"), b = one("person", "Maya Rao"); const snapshot = JSON.stringify([a, b]);
    expect(JSON.stringify(viewClump(merged(a, b), CTX))).toBe(JSON.stringify(viewClump(merged(a, b), CTX)));
    expect(JSON.stringify([a, b])).toBe(snapshot);
    expect(typeOf([frag("place", "x")])).toBe("Fragment");
  });
});
