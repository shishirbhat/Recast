// The clump gesture as a state machine: legal transitions only, nothing written before an explicit placement, and the
// action lifecycle's rules (no false success, reconcile unknown outcomes, undo only when the destination can).
import { describe, expect, it } from "vitest";
import type { CapabilityContract, Fragment, Receipt } from "@recast/core";
import { initialClumpState, reduceClump, viewOf, type ClumpEvent, type ClumpState } from "../src/index.js";

const NOW = Date.parse("2026-10-19T09:00:00Z");
let n = 0;
const frag = (kind: Fragment["kind"], text: string, extra: Partial<Fragment> = {}): Fragment => ({ id: `f${++n}`, kind, text, confidence: 0.9, evidence: [{ locator: { kind: "css", value: `#e${n}` }, excerpt: text }], source: { app: "chrome", url: `https://example.com/${kind}` }, ...extra });
const calendar: CapabilityContract = { destination: "calendar.agenda", app: "Calendar", targetKind: "Calendar", reliability: "official-api", accepts: [{ relationId: "event-calendar-entry", effect: "Add to calendar", dataMoved: ["Event.title", "Event.start", "Event.end", "Event.location", "Event.description"] }] };
const drafts: CapabilityContract = { destination: "mail.drafts", app: "Mail", targetKind: "Drafts", reliability: "official-api", accepts: [{ relationId: "message-draft-entry", effect: "Save as draft", dataMoved: ["Message.to", "Message.snippet"] }] };
const DESTS = [{ id: "cal", label: "Calendar", contract: calendar, slots: [{ id: "fri-1930", label: "Fri 23 Oct, 7:30 PM", start: "2026-10-23T19:30" }] }, { id: "mail", label: "Mail drafts", contract: drafts }];

type Input = ClumpEvent extends infer E ? (E extends ClumpEvent ? Omit<E, "now"> : never) : never;
function run(events: Input[], start: ClumpState = initialClumpState({ now: NOW, timezone: "Asia/Kolkata", destinations: DESTS, armed: true })) {
  let s = start; const effects: unknown[] = []; const errors: string[] = [];
  for (const e of events) { const r = reduceClump(s, { ...e, now: NOW } as ClumpEvent); s = r.state; effects.push(...r.effects); if (r.error) errors.push(r.error); }
  return { s, effects, errors };
}
const receipt = (opId = "op1"): Receipt => ({ receiptId: "r1", opId, at: "2026-10-19T09:00:01Z", status: "done", objectId: "x", destination: "calendar.agenda", relationId: "event-calendar-entry", effect: "Add to calendar", reversible: true, bridgeRef: "ev-1" });

/** Maya (carried) pressed into the restaurant, then the time pressed into that object. */
function mayaDinner() {
  const maya = frag("person", "Maya Rao"), dakshin = frag("place", "Dakshin", { value: { name: "Dakshin" } }), time = frag("time", "7:30 PM");
  return run([
    { type: "capture", fragment: dakshin },                       // obj-1 on the desk
    { type: "capture", fragment: time },                          // obj-2 on the desk
    { type: "capture", fragment: maya, carry: true },             // obj-3 in hand
    { type: "approach", target: { kind: "object", id: "obj-1" } },
    { type: "drop" }, { type: "settled" },                        // obj-1 = Dakshin + Maya
    { type: "pickUp", id: "obj-2" }, { type: "approach", target: { kind: "object", id: "obj-1" } }, { type: "drop" }, { type: "settled" },
  ]);
}

describe("making one object out of three pieces", () => {
  it("each press grows the same object; the carried pieces are gone from the desk, not lost", () => {
    const { s, errors } = mayaDinner();
    expect(errors).toEqual([]); expect(s.phase).toBe("composed"); expect(s.focus).toBe("obj-1");
    expect(s.desk).toEqual(["obj-1"]); expect(Object.keys(s.objects)).toEqual(["obj-1"]);
    expect(s.objects["obj-1"]!.ingredients.map((f) => f.text)).toEqual(["Dakshin", "Maya Rao", "7:30 PM"]);
    expect(viewOf(s, "obj-1")).toMatchObject({ type: "Event", label: "Meet Maya at Dakshin", proposed: true });
    expect(s.last!.text).toBe("Now one object: Meet Maya at Dakshin");
  });
  it("while approaching, the target says what the result would be before anything changes", () => {
    const r = run([{ type: "capture", fragment: frag("place", "Dakshin") }, { type: "capture", fragment: frag("person", "Maya Rao"), carry: true }, { type: "approach", target: { kind: "object", id: "obj-1" } }]);
    expect(r.s).toMatchObject({ phase: "approaching", verdict: { ok: true, becomes: "Event" } });
    expect(r.s.objects["obj-1"]!.ingredients).toHaveLength(1);
  });
  it("is plain JSON: the whole state survives storage, which is how it crosses tabs", () => {
    const { s } = mayaDinner(); const back = JSON.parse(JSON.stringify(s)) as ClumpState;
    expect(back).toEqual(s); expect(viewOf(back, "obj-1").label).toBe("Meet Maya at Dakshin");
  });
});

describe("placing it", () => {
  it("dropping on a calendar slot opens a preview, fills the time from the slot, and writes nothing", () => {
    const m = mayaDinner();
    const r = run([{ type: "pickUp", id: "obj-1" }, { type: "approach", target: { kind: "destination", id: "cal", slot: "fri-1930" } }, { type: "drop" }], m.s);
    expect(r.effects).toEqual([]); expect(r.s.phase).toBe("previewing");
    expect(r.s.placement!.op).toBeUndefined();                       // still needs a title
    expect(viewOf(r.s, "obj-1").missing.map((x) => x.field)).toEqual(["title"]);
    expect(r.errors).toEqual([]);
    const placed = run([{ type: "place", consent: { kind: "release" } }], r.s);
    expect(placed.errors).toEqual(["this is not complete yet: answer what is missing first"]);
  });
  it("answer the title, place, and the commit effect carries the composed event; success only on the receipt", () => {
    const m = mayaDinner();
    const r = run([{ type: "pickUp", id: "obj-1" }, { type: "approach", target: { kind: "destination", id: "cal" } }, { type: "drop" }, { type: "answer", objectId: "obj-1", field: "start", value: "2026-10-23T19:30" }, { type: "answer", objectId: "obj-1", field: "title", value: "Meet Maya at Dakshin" }, { type: "place", consent: { kind: "release" } }], m.s);
    expect(r.errors).toEqual([]); expect(r.s.phase).toBe("executing");
    const commit = r.effects[0] as { type: string; op: { dataMoved: { path: string; value: string }[] } };
    expect(commit.type).toBe("commit");
    expect(Object.fromEntries(commit.op.dataMoved.map((d) => [d.path, d.value]))).toMatchObject({ "Event.title": "Meet Maya at Dakshin", "Event.start": "2026-10-23T19:30", "Event.location": "Dakshin", "Event.description": "With Maya Rao" });
    expect(run([{ type: "cancel" }], r.s).errors).toEqual(["Waiting for Calendar to answer. Recast stays on until it does"]);   // it is already on its way
    const opId = r.s.placement!.op!.opId;
    const done = run([{ type: "committed", receipt: receipt(opId), undoable: true }], r.s);
    expect(done.s).toMatchObject({ phase: "succeeded", last: { kind: "placed", text: "Placed in Calendar" } });
    const undo = run([{ type: "undo" }], done.s); expect(undo.effects).toEqual([{ type: "undo", receipt: receipt(opId), destinationId: "cal" }]);
    expect(undo.s.phase).toBe("undoing");
    expect(run([{ type: "undone", opId }], undo.s).s.phase).toBe("idle");
  });
  it("an unknown outcome is reconciled, never retried; not found means failed and safe to place again", () => {
    const m = mayaDinner();
    const r = run([{ type: "pickUp", id: "obj-1" }, { type: "approach", target: { kind: "destination", id: "cal", slot: "fri-1930" } }, { type: "drop" }, { type: "answer", objectId: "obj-1", field: "title", value: "Dinner" }, { type: "place", consent: { kind: "release" } }], m.s);
    const opId = r.s.placement!.op!.opId; Object.assign(r, run([{ type: "outcomeUnknown", opId, message: "timed out" }], r.s));
    expect(r.s.phase).toBe("unknown"); expect(run([{ type: "place", consent: { kind: "release" } }], r.s).errors).toEqual(["Recast doesn't know yet whether Calendar has it. Check Calendar first"]);
    const rec = run([{ type: "reconcile" }], r.s); expect((rec.effects[0] as { type: string }).type).toBe("reconcile");
    expect(run([{ type: "reconciled", opId, found: false }], rec.s).s).toMatchObject({ phase: "failed", last: { text: expect.stringMatching(/safe to place again/) } });
    expect(run([{ type: "reconciled", opId, found: true, receipt: receipt(opId) }], rec.s).s.phase).toBe("succeeded");
  });
  it("a message cannot go into a calendar; the object goes back on the desk whole", () => {
    const r = run([{ type: "capture", fragment: frag("text", "Running late!") }, { type: "capture", fragment: frag("person", "Maya Rao", { value: { name: "Maya Rao", email: "maya@x.com" } }), carry: true }, { type: "approach", target: { kind: "object", id: "obj-1" } }, { type: "drop" }, { type: "settled" },
      { type: "pickUp", id: "obj-1" }, { type: "approach", target: { kind: "destination", id: "cal" } }]);
    expect(r.s.verdict).toMatchObject({ ok: false, reason: expect.stringMatching(/takes events; this is a message/) });
    const d = run([{ type: "drop" }], r.s); expect(d.s).toMatchObject({ phase: "idle", desk: ["obj-1"], last: { kind: "refused" } });
    const mail = run([{ type: "pickUp", id: "obj-1" }, { type: "approach", target: { kind: "destination", id: "mail" } }, { type: "drop" }], d.s);
    expect(mail.s.placement!.op!.risk.tier).toBe("low");
  });
});

describe("changing your mind", () => {
  it("Escape puts a carried object back, closes a merge question, and abandons a preview without writing", () => {
    expect(run([{ type: "capture", fragment: frag("place", "Dakshin"), carry: true }, { type: "cancel" }]).s).toMatchObject({ phase: "idle", desk: ["obj-1"], carried: null });
    const msg = run([{ type: "capture", fragment: frag("text", "Dinner?") }, { type: "capture", fragment: frag("person", "Maya Rao"), carry: true }, { type: "approach", target: { kind: "object", id: "obj-1" } }, { type: "drop" }, { type: "settled" }, { type: "capture", fragment: frag("time", "7 PM"), carry: true }, { type: "approach", target: { kind: "object", id: "obj-1" } }, { type: "drop" }]);
    expect(msg.s).toMatchObject({ phase: "confirmingMerge", pendingMerge: { becomes: "Event", reason: "this turns the message into an event" } });
    expect(run([{ type: "cancel" }], msg.s).s).toMatchObject({ phase: "idle", desk: ["obj-1", "obj-3"] });
    expect(run([{ type: "confirmMerge", yes: true }, { type: "settled" }], msg.s).s.objects["obj-1"]!.ingredients).toHaveLength(3);
    const prev = run([{ type: "pickUp", id: "obj-1" }, { type: "approach", target: { kind: "destination", id: "cal" } }, { type: "drop" }, { type: "cancel" }], mayaDinner().s);
    expect(prev.effects).toEqual([]); expect(prev.s).toMatchObject({ phase: "idle", placement: null, last: { text: "Not placed; nothing was written" } });
  });
  it("a refused merge keeps both objects whole", () => {
    const r = run([{ type: "capture", fragment: frag("place", "Dakshin") }, { type: "capture", fragment: frag("thing", "Stagg EKG Kettle"), carry: true }, { type: "approach", target: { kind: "object", id: "obj-1" } }]);
    expect(r.s.verdict).toMatchObject({ ok: false, reason: expect.stringMatching(/cannot be combined/) });
    const d = run([{ type: "drop" }], r.s); expect(d.s.desk).toEqual(["obj-1", "obj-2"]); expect(d.s.objects["obj-1"]!.ingredients).toHaveLength(1);
  });
  it("taking an ingredient out puts it back on the desk, and an open preview is recalculated", () => {
    const m = mayaDinner();
    const p = run([{ type: "pickUp", id: "obj-1" }, { type: "approach", target: { kind: "destination", id: "cal" } }, { type: "drop" }, { type: "answer", objectId: "obj-1", field: "title", value: "Dinner" }, { type: "answer", objectId: "obj-1", field: "start", value: "2026-10-23T19:30" }], m.s);
    expect(p.s.placement!.op).toBeDefined();
    const mayaId = p.s.objects["obj-1"]!.ingredients[1]!.id;
    const r = run([{ type: "remove", objectId: "obj-1", ingredientId: mayaId }], p.s);
    expect(r.s.desk).toContain("obj-4"); expect(viewOf(r.s, "obj-4")).toMatchObject({ type: "Fragment", label: "Maya Rao" });
    expect(viewOf(r.s, "obj-1").event!.fields.description).toBeUndefined();
    expect((r.s.placement!.op!.dataMoved.find((d) => d.path === "Event.description"))).toBeUndefined();
  });
  it("a piece can be moved, replaced by what the person types (marked as theirs), and the whole object discarded without a write", () => {
    const m = mayaDinner(); const ids = m.s.objects["obj-1"]!.ingredients.map((f) => f.id);
    const moved = run([{ type: "move", objectId: "obj-1", ingredientId: ids[2]!, by: -1 }], m.s);
    expect(moved.s.objects["obj-1"]!.ingredients.map((f) => f.text)).toEqual(["Dakshin", "7:30 PM", "Maya Rao"]);
    expect(run([{ type: "move", objectId: "obj-1", ingredientId: ids[0]!, by: -1 }], m.s).s.objects["obj-1"]!.ingredients[0]!.id).toBe(ids[0]);   // already first
    // The time was wrong: typed again, it is read as a time and marked as typed by the person, in the same place.
    const fixed = run([{ type: "replace", objectId: "obj-1", ingredientId: ids[2]!, text: "8:15 PM" }], m.s);
    expect(fixed.errors).toEqual([]);
    const f = fixed.s.objects["obj-1"]!.ingredients[2]!;
    expect(f).toMatchObject({ kind: "time", text: "8:15 PM", source: { title: "typed by you" }, evidence: [{ locator: { kind: "user", value: "typed" } }] });
    expect(viewOf(fixed.s, "obj-1").missing.find((x) => x.field === "start")!.reason).toMatch(/20:15/);
    expect(fixed.s.last).toMatchObject({ kind: "replaced" });
    // A replacement that would make it something it cannot be is refused, and nothing changes.
    const bad = run([{ type: "replace", objectId: "obj-1", ingredientId: ids[0]!, text: "TypeError: x is undefined" }], m.s);
    expect(bad.errors[0]).toMatch(/is an error/); expect(bad.s).toBe(m.s);
    expect(run([{ type: "replace", objectId: "obj-1", ingredientId: ids[1]!, text: "  " }], m.s).errors[0]).toMatch(/type what it should be/);
    // Discarding the composition: gone from the desk, no effect of any kind.
    const gone = run([{ type: "discard", id: "obj-1" }], m.s);
    expect(gone.effects).toEqual([]); expect(gone.s.desk).toEqual([]); expect(gone.s.objects).toEqual({}); expect(gone.s.focus).toBeNull();
    expect(gone.s.last).toMatchObject({ kind: "discarded", text: expect.stringMatching(/nothing was written anywhere/) });
  });
  it("illegal moves are refused with a reason and change nothing", () => {
    const s = initialClumpState({ now: NOW, timezone: "UTC", destinations: DESTS });
    for (const e of [{ type: "drop" }, { type: "settled" }, { type: "place", consent: { kind: "release" } }, { type: "committed", receipt: receipt(), undoable: true }, { type: "pickUp", id: "nope" }] as const) {
      const r = reduceClump(s, { ...e, now: NOW } as ClumpEvent); expect(r.error, e.type).toBeTruthy(); expect(r.state).toBe(s);
    }
  });
});
