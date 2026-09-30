import { describe, expect, it } from "vitest";
import { RELATIONS, assessRisk, checkContract, propose, rankProposals } from "../src/index.js";
import { calendar, mailSend, obj, tasks } from "./helpers.js";

const person = (extra: Record<string, unknown> = { email: ["m@example.com"] }, conf?: number) => obj("Person", { name: "Meera Iyer", ...extra }, conf);

describe("grammar and contracts", () => {
  it("loads all ten relations from data", () => {
    expect(RELATIONS.map((r) => `${r.from}>${r.to}=${r.relation}`).sort()).toEqual([
      "Document>Project=source", "Document>Task=reference", "Image>Project=asset", "Location>Event=location", "Message>Task=source",
      "Person>Event=attendee", "Person>Message=recipient", "Product>Product=compare", "ResearchPaper>Claim=evidence", "ResearchPaper>ResearchPaper=compare",
    ]);
  });
  it("accepts valid contracts", () => { for (const c of [calendar, mailSend, tasks]) expect(checkContract(c)).toBe(c); });
  const bad = (name: string, patch: object, msg: RegExp) =>
    it(`rejects: ${name}`, () => { expect(() => checkContract({ ...calendar, ...patch })).toThrowError(msg); });
  bad("unknown relation", { accepts: [{ relationId: "person-event-boss", effect: "x", dataMoved: [] }] }, /conflicts with grammar/);
  bad("wrong target kind", { targetKind: "Task" }, /conflicts with grammar/);
  bad("lowering risk", { accepts: [{ relationId: "person-event-attendee", effect: "x", risk: "low", dataMoved: ["Person.name"] }] }, /conflicts with grammar/);
  bad("dataMoved from the wrong type", { accepts: [{ relationId: "person-event-attendee", effect: "x", dataMoved: ["Location.name"] }] }, /conflicts with grammar/);
  bad("unsupported destination that accepts things", { reliability: "unsupported" }, /conflicts with grammar/);
  bad("schema violation", { reliability: "magic" }, /fails schema/);
});

describe("propose", () => {
  it("offers only what the destination supports for this type", () => {
    const ps = propose(person(), calendar);
    expect(ps.map((p) => p.relationId)).toEqual(["person-event-attendee"]);
    expect(ps[0]).toMatchObject({ status: "ready", relation: "attendee", reliability: "official-api" });
  });
  it("offers nothing if the destination has no row for the type", () => {
    expect(propose(person(), tasks)).toEqual([]);
  });
  it("is honest when the object lacks what the relation needs", () => {
    const [p] = propose(person({}), calendar);
    expect(p).toMatchObject({ status: "blocked", confidence: 0 });
    expect(p!.blocked!.reason).toBe("needs email");
  });
  it("is deterministic, and its ids depend on object, destination and relation", () => {
    const a = propose(person(), calendar), b = propose(person(), calendar);
    expect(a.map((p) => p.id)).toEqual(b.map((p) => p.id));
    expect(propose(person(), mailSend)[0]!.id).not.toBe(a[0]!.id);
  });
  it("ranks ready before blocked, then approved, then hinted, then by confidence", () => {
    const ready = propose(person(), calendar)[0]!;                       // ready, attendee
    const blocked = propose(person({}), mailSend)[0]!;                    // blocked, recipient
    const lowConf = propose(person({ email: ["m@example.com"] }, 0.6), mailSend)[0]!; // ready, recipient, 0.6
    expect(rankProposals([blocked, lowConf, ready]).map((p) => p.id)).toEqual([ready.id, lowConf.id, blocked.id]);
    expect(rankProposals([ready, lowConf], { hintRelationId: "person-message-recipient" })[0]).toBe(lowConf);
    expect(rankProposals([ready, { ...lowConf, preferred: true }], { hintRelationId: "person-event-attendee" })[0]!.id).toBe(lowConf.id);
    expect(rankProposals([lowConf, ready]).map((p) => p.id)).toEqual(rankProposals([ready, lowConf]).map((p) => p.id));
  });
  it("marks user-approved mappings as preferred", () => {
    const prefs = { approved: [{ destination: calendar.destination, relationId: "person-event-attendee" }] };
    expect(propose(person(), calendar)[0]!.preferred).toBe(false);
    expect(propose(person(), calendar, {}, prefs)[0]!.preferred).toBe(true);
  });
  it("confidence is the weakest property the relation depends on", () => {
    const o = obj("Person", { name: "Meera", email: ["m@example.com"] }, 0.9);
    expect(propose(o, calendar)[0]!.confidence).toBe(0.9);
  });
});

describe("trust model", () => {
  const base = { baseRisk: "low", flags: [], reversible: true, confidence: 0.95, reliability: "official-api" } as const;
  it("low and reversible releases immediately", () => {
    expect(assessRisk(base)).toMatchObject({ tier: "low", consent: "release", requiresDeliberateChoice: false });
  });
  it.each(["send", "delete", "publish", "financial", "modifies-important"] as const)("%s is high and needs a hold", (flag) => {
    expect(assessRisk({ ...base, flags: [flag] })).toMatchObject({ tier: "high", consent: "hold" });
  });
  it("notifying a third party, irreversibility, UI automation and low confidence each raise to medium", () => {
    expect(assessRisk({ ...base, flags: ["notifies-third-party"] }).tier).toBe("medium");
    expect(assessRisk({ ...base, reversible: false }).tier).toBe("medium");
    expect(assessRisk({ ...base, reliability: "ui-automation" }).tier).toBe("medium");
    expect(assessRisk({ ...base, confidence: 0.7 }).tier).toBe("medium");
  });
  it("confidence below 0.5 demands a deliberate choice", () => {
    expect(assessRisk({ ...base, confidence: 0.4 }).requiresDeliberateChoice).toBe(true);
    expect(assessRisk({ ...base, confidence: 0.5 }).requiresDeliberateChoice).toBe(false);
  });
  it("never lowers a tier once raised, and explains why", () => {
    const r = assessRisk({ ...base, baseRisk: "high", confidence: 0.99 });
    expect(r.tier).toBe("high");
    expect(r.reasons[0]).toMatch(/base risk: high/);
  });
  it("flows from the contract into proposals", () => {
    expect(propose(person(), calendar)[0]!.risk).toMatchObject({ tier: "medium", consent: "confirm" });
    expect(propose(person(), mailSend)[0]!.risk).toMatchObject({ tier: "high", consent: "hold" });
  });
});
