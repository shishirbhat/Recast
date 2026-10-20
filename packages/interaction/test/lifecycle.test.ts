// The object lifecycle under asynchronous outcomes: every answer names its operation; late, duplicate and stale answers
// change nothing; Undo is one guarded step that can fail honestly; an unknown outcome is never a blind retry; a placed
// object retires only after a confirmed placement's receipt is left, and only that object.
import { describe, expect, it } from "vitest";
import { CONTRACTS } from "@recast/bridges";
import type { Fragment, Receipt } from "@recast/core";
import { commandEvents, escapeEvent, initialClumpState, reduceClump, type ClumpEvent, type ClumpInput, type ClumpState, type DestinationSpec } from "../src/index.js";

const NOW = Date.parse("2026-10-19T09:00:00Z");
let n = 0;
const frag = (kind: Fragment["kind"], text: string, extra: Partial<Fragment> = {}): Fragment => ({ id: `f${++n}`, kind, text, confidence: 0.9, evidence: [{ locator: { kind: "css", value: `#e${n}` }, excerpt: text }], source: { app: "chrome", url: `https://example.com/${kind}` }, ...extra });
const DESTS: DestinationSpec[] = [
  { id: "cal", label: "Calendar", contract: CONTRACTS.googleCalendarEvent, standIn: true },
  { id: "mail", label: "Mail", contract: CONTRACTS.gmailMessageDraft, standIn: true },
];
function run(events: ClumpInput[], start: ClumpState) {
  let s = start; const effects: { type: string }[] = []; const errors: string[] = []; const stale: string[] = [];
  for (const e of events) { const r = reduceClump(s, { ...e, now: NOW } as ClumpEvent); s = r.state; effects.push(...r.effects); if (r.error) (r.stale ? stale : errors).push(r.error); }
  return { s, effects, errors, stale };
}
const receiptFor = (s: ClumpState, reversible = true): Receipt => ({ receiptId: `rc-${s.placement!.op!.opId}`, opId: s.placement!.op!.opId, at: "2026-10-19T09:00:01Z", status: "done", objectId: "x", destination: "google-calendar.calendar", relationId: "event-calendar-entry", effect: "Add to calendar", reversible, bridgeRef: "ev-1" });

/** On; Maya pressed into Dakshin with a time: obj-1, a complete event, in the module. */
function ready() {
  const s0 = initialClumpState({ now: NOW, timezone: "Asia/Kolkata", destinations: DESTS, armed: true });
  return run([
    { type: "capture", fragment: frag("place", "Dakshin", { value: { name: "Dakshin", address: "12 MG Road" } }) },
    { type: "capture", fragment: frag("person", "Maya Rao", { value: { name: "Maya Rao" } }), carry: true },
    { type: "approach", target: { kind: "object", id: "obj-1" } }, { type: "drop" }, { type: "settled" },
    { type: "answer", objectId: "obj-1", field: "start", value: "2026-10-23T19:30" },
    { type: "answer", objectId: "obj-1", field: "title", value: "Dinner with Maya" },
  ], s0).s;
}
/** …chosen for the calendar and confirmed: a write is in flight. */
function executing(base = ready()) {
  return run([{ type: "openWheel" }, { type: "pickDestination", destinationId: "cal" }, { type: "place", consent: { kind: "confirm" } }], base);
}
const succeeded = () => { const e = executing().s; return run([{ type: "committed", receipt: receiptFor(e), undoable: true }], e).s; };

describe("every answer names its operation", () => {
  it("an answer for another operation is ignored, whatever it says", () => {
    const e = executing().s;
    const stale: ClumpInput[] = [
      { type: "committed", receipt: { ...receiptFor(e), opId: "op-older" }, undoable: true },
      { type: "commitFailed", opId: "op-older", message: "boom" },
      { type: "outcomeUnknown", opId: "op-older", message: "timeout" },
    ];
    const r = run(stale, e); expect(r.s).toBe(e); expect(r.stale).toHaveLength(3); expect(r.errors).toEqual([]);
  });
  it("a duplicate confirmation after success changes nothing", () => {
    const s = succeeded(); const r = run([{ type: "committed", receipt: receiptFor(s), undoable: true }], s);
    expect(r.s).toBe(s); expect(r.errors).toHaveLength(1);
  });
  it("an answer after the receipt was closed (the object is retired) does not bring it back", () => {
    const s = succeeded(); const opId = s.placement!.op!.opId;
    const done = run([{ type: "dismiss" }], s).s; expect(done.objects["obj-1"]).toBeUndefined();
    const late = run([{ type: "undone", opId }, { type: "committed", receipt: receiptFor(s), undoable: true }], done);
    expect(late.s).toBe(done); expect(late.stale).toHaveLength(2);
  });
});

describe("a write in flight", () => {
  it("cannot be cancelled, escaped, turned off or interrupted by a new pick-up; each refusal says why", () => {
    const e = executing().s;
    expect(escapeEvent(e)).toBeNull(); expect(commandEvents(e)).toEqual([]);
    const r = run([{ type: "cancel" }, { type: "disarm" }, { type: "dismiss" }, { type: "capture", fragment: frag("time", "8 PM"), carry: true }], e);
    expect(r.s).toBe(e); expect(new Set(r.errors)).toEqual(new Set(["Waiting for Calendar to answer. Recast stays on until it does"]));
  });
  it("failure before anything was created: failed, nothing retired, the object can be placed again", () => {
    const e = executing().s; const f = run([{ type: "commitFailed", opId: e.placement!.op!.opId, message: "Calendar refused the event" }], e).s;
    expect(f).toMatchObject({ phase: "failed" }); const d = run([{ type: "dismiss" }], f).s;
    expect(d.desk).toEqual(["obj-1"]); expect(d.uncertain).toEqual({});
    expect(run([{ type: "openModule" }, { type: "openWheel" }, { type: "pickDestination", destinationId: "cal" }], d).s.phase).toBe("previewing");
  });
});

describe("an unknown outcome is never a blind retry", () => {
  const unknown = () => { const e = executing().s; return run([{ type: "outcomeUnknown", opId: e.placement!.op!.opId, message: "Calendar did not answer in time" }], e).s; };
  it("closing the card keeps the object and remembers the doubt; placing it there again goes to the check, with the same operation", () => {
    const u = unknown(); const opId = u.placement!.op!.opId;
    const closed = run([{ type: "dismiss" }], u).s;
    expect(closed).toMatchObject({ phase: "idle", placement: null, desk: ["obj-1"] }); expect(closed.uncertain["obj-1"]).toMatchObject({ destinationId: "cal" });
    const again = run([{ type: "openModule" }, { type: "openWheel" }, { type: "pickDestination", destinationId: "cal" }], closed);
    expect(again.effects).toEqual([]);                                             // no new write
    expect(again.s).toMatchObject({ phase: "unknown", placement: { objectId: "obj-1", op: { opId } } });
    // Found: it was there all along; success, with no second write.
    const found = run([{ type: "reconcile" }, { type: "reconciled", opId, found: true, receipt: receiptFor(again.s) }], again.s);
    expect(found.s.phase).toBe("succeeded"); expect(found.effects.map((x) => x.type)).toEqual(["reconcile"]);
  });
  it("…or not found: failed, the doubt is cleared, and a fresh placement is allowed", () => {
    const u = unknown(); const opId = u.placement!.op!.opId;
    const nf = run([{ type: "reconcile" }, { type: "reconciled", opId, found: false }, { type: "dismiss" }], u).s;
    expect(nf.uncertain).toEqual({});
    const fresh = run([{ type: "openModule" }, { type: "openWheel" }, { type: "pickDestination", destinationId: "cal" }], nf).s;
    // The same object for the same destination plans the same operation id: the core derives it from the content, so it
    // doubles as the idempotency key a destination can use to refuse a duplicate.
    expect(fresh.phase).toBe("previewing"); expect(fresh.placement!.op!.opId).toBe(opId);
  });
  it("the doubt follows the destination, not the tab: a calendar served by a new tab (new id, same contract) still goes to the check", () => {
    const closed = run([{ type: "dismiss" }], unknown()).s;
    const moved = { ...closed, destinations: [{ ...DESTS[0]!, id: "tab9:cal" }, DESTS[1]!] };
    const r = run([{ type: "openModule" }, { type: "openWheel" }, { type: "pickDestination", destinationId: "tab9:cal" }], moved);
    expect(r.effects).toEqual([]); expect(r.s).toMatchObject({ phase: "unknown", placement: { destinationId: "tab9:cal" } });
  });
  it("the doubt is per destination: the same object can still be reviewed for a different one", () => {
    const closed = run([{ type: "dismiss" }], unknown()).s;
    expect(run([{ type: "openModule" }, { type: "openWheel" }, { type: "pickDestination", destinationId: "mail" }], closed).errors).toEqual(["Mail takes messages; this is an event"]);
  });
  it("checking needs the destination: if it is not open here, the check is refused rather than sent nowhere", () => {
    const u = { ...unknown(), destinations: [] };
    const r = run([{ type: "reconcile" }], u); expect(r.effects).toEqual([]); expect(r.errors).toEqual(["Google Calendar is not open here. Open it, then check"]);
  });
  it("the doubt survives being stored as JSON (the extension keeps state in session storage)", () => {
    const closed = run([{ type: "dismiss" }], unknown()).s;
    expect(JSON.parse(JSON.stringify(closed))).toEqual(closed);
  });
});

describe("Undo", () => {
  it("is one step: a second click, Done, Escape and turning off are all refused until the destination answers", () => {
    const s = succeeded(); const u = run([{ type: "undo" }], s);
    expect(u.s.phase).toBe("undoing"); expect(u.effects.map((x) => x.type)).toEqual(["undo"]);
    const r = run([{ type: "undo" }, { type: "dismiss" }, { type: "cancel" }, { type: "disarm" }], u.s);
    expect(r.s).toBe(u.s); expect(r.effects).toEqual([]); expect(escapeEvent(u.s)).toBeNull();
    expect(r.s.objects["obj-1"]).toBeTruthy();                                    // not retired while undoing
  });
  it("undone: the object stays, ready to go somewhere else", () => {
    const u = run([{ type: "undo" }], succeeded()).s;
    const d = run([{ type: "undone", opId: u.placement!.op!.opId }], u).s;
    expect(d).toMatchObject({ phase: "idle", placement: null, desk: ["obj-1"], last: { kind: "undone" } });
  });
  it("a failed undo is never reported as done: the receipt stays, says so, keeps the object, and Undo can be tried again", () => {
    const u = run([{ type: "undo" }], succeeded()).s; const opId = u.placement!.op!.opId;
    const f = run([{ type: "undoFailed", opId, message: "Calendar refused the delete" }], u).s;
    expect(f).toMatchObject({ phase: "succeeded", placement: { message: "Could not undo: Calendar refused the delete" }, last: { kind: "failed" } });
    expect(f.desk).toEqual(["obj-1"]);
    expect(run([{ type: "undo" }], f).effects.map((x) => x.type)).toEqual(["undo"]);
  });
  it("is not offered when the destination cannot reverse it, nor sent when the destination is not open", () => {
    const e = executing().s; const nr = run([{ type: "committed", receipt: receiptFor(e, false), undoable: false }], e).s;
    expect(run([{ type: "undo" }], nr).errors).toEqual(["this placement cannot be undone"]);
    const gone = { ...succeeded(), destinations: [] };
    const r = run([{ type: "undo" }], gone); expect(r.effects).toEqual([]); expect(r.errors).toEqual(["Google Calendar is not open here. Open it to undo"]);
  });
});

describe("retirement touches only the placed object", () => {
  it("picking up a new piece while the receipt shows retires the placed object and leaves the new one whole", () => {
    const s = succeeded();
    const r = run([{ type: "capture", fragment: frag("person", "Arjun Mehta", { value: { name: "Arjun Mehta" } }), carry: true }], s).s;
    expect(r.objects["obj-1"]).toBeUndefined(); expect(r.carried).toBe("obj-3");
    expect(r.objects["obj-3"]!.ingredients.map((f) => f.text)).toEqual(["Arjun Mehta"]);
  });
  it("picking the placed object itself up again keeps it (the person chose to carry it on)", () => {
    const r = run([{ type: "pickUp", id: "obj-1" }], succeeded()).s;
    expect(r).toMatchObject({ phase: "carrying", carried: "obj-1" }); expect(r.objects["obj-1"]).toBeTruthy();
  });
  it("turning Recast off with the receipt open retires the placed object but keeps every other one", () => {
    const base = run([{ type: "capture", fragment: frag("time", "Saturday 8 PM") }], ready()).s;   // obj-3 on the desk
    const s = executing(base).s; const done = run([{ type: "committed", receipt: receiptFor(s), undoable: true }, { type: "disarm" }], s).s;
    expect(done.armed).toBe(false); expect(done.desk).toEqual(["obj-3"]);
  });
  it("turning off with an unplaced composition keeps it, and the next on reopens it", () => {
    const off = run([{ type: "disarm" }], ready()).s;
    expect(off).toMatchObject({ armed: false, focus: "obj-1" }); expect(off.objects["obj-1"]!.ingredients).toHaveLength(2);
    expect(commandEvents(off)).toEqual([{ type: "arm" }, { type: "openModule" }]);
  });
  it("ids are never reused, so a retired object cannot be confused with a new one", () => {
    const done = run([{ type: "dismiss" }], succeeded()).s;
    const next = run([{ type: "capture", fragment: frag("person", "Arjun Mehta") }], done).s;
    expect(Object.keys(next.objects)).toEqual(["obj-3"]); expect(next.seq).toBe(3);
  });
});
