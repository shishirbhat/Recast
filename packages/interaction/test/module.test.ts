// The trigger and the action module, as state: Recast is off until invoked; the module opens when a merge settles; the
// selector lists the bridge registry with honest availability; choosing writes nothing; Escape steps back; closing keeps
// the composition and the same command reopens it.
import { describe, expect, it } from "vitest";
import { CONTRACTS, REGISTRY } from "@recast/bridges";
import type { Fragment } from "@recast/core";
import { commandEvents, escapeEvent, initialClumpState, moduleModel, reduceClump, wheelEntries, type ClumpEvent, type ClumpState, type DestinationSpec } from "../src/index.js";

const NOW = Date.parse("2026-10-19T09:00:00Z");
let n = 0;
const frag = (kind: Fragment["kind"], text: string, extra: Partial<Fragment> = {}): Fragment => ({ id: `f${++n}`, kind, text, confidence: 0.9, evidence: [{ locator: { kind: "css", value: `#e${n}` }, excerpt: text }], source: { app: "chrome", url: `https://example.com/${kind}`, title: `${text} page` }, ...extra });
// Stand-ins for the registry's own contracts: the same contract the real bridge performs, executed locally.
const DESTS: DestinationSpec[] = [
  { id: "cal", label: "Calendar", contract: CONTRACTS.googleCalendarEvent, standIn: true },
  { id: "mail", label: "Mail", contract: CONTRACTS.gmailMessageDraft, standIn: true },
];
type Input = ClumpEvent extends infer E ? (E extends ClumpEvent ? Omit<E, "now"> : never) : never;
function run(events: Input[], start: ClumpState = initialClumpState({ now: NOW, timezone: "Asia/Kolkata", destinations: DESTS })) {
  let s = start; const effects: unknown[] = []; const errors: string[] = [];
  for (const e of events) { const r = reduceClump(s, { ...e, now: NOW } as ClumpEvent); s = r.state; effects.push(...r.effects); if (r.error) errors.push(r.error); }
  return { s, effects, errors };
}
const command = (s: ClumpState) => run(commandEvents(s), s);
/** Recast on, Maya pressed into Dakshin, then the time: the acceptance journey up to the module. */
function dinner() {
  const on = command(initialClumpState({ now: NOW, timezone: "Asia/Kolkata", destinations: DESTS })).s;
  return run([
    { type: "capture", fragment: frag("place", "Dakshin", { value: { name: "Dakshin", address: "12 MG Road, Bengaluru" } }) },
    { type: "capture", fragment: frag("person", "Maya Rao", { value: { name: "Maya Rao" } }), carry: true },
    { type: "approach", target: { kind: "object", id: "obj-1" } }, { type: "drop" }, { type: "settled" },
  ], on);
}

describe("the trigger", () => {
  it("Recast starts off: nothing can be picked up, and the module is not shown", () => {
    const s0 = initialClumpState({ now: NOW, timezone: "Asia/Kolkata", destinations: DESTS });
    expect(s0.armed).toBe(false);
    const { s, errors } = run([{ type: "capture", fragment: frag("person", "Maya Rao"), carry: true }], s0);
    expect(errors).toEqual(["Recast is off: turn it on to pick things up"]); expect(s).toEqual(s0);
    expect(moduleModel(s0, REGISTRY)).toEqual({ mode: "off" });
  });
  it("the command turns it on; again with nothing made turns it off; off puts an object in hand back and loses nothing", () => {
    let s = command(initialClumpState({ now: NOW, timezone: "Asia/Kolkata", destinations: DESTS })).s;
    expect(s).toMatchObject({ armed: true, phase: "idle" }); expect(moduleModel(s, REGISTRY)).toMatchObject({ mode: "pill", text: "Drag one thing onto another" });
    s = run([{ type: "capture", fragment: frag("person", "Maya Rao"), carry: true }], s).s;
    expect(commandEvents(s)).toEqual([]);                                     // in hand: invoking again changes nothing
    s = run([{ type: "disarm" }], s).s;
    expect(s).toMatchObject({ armed: false, phase: "idle", carried: null }); expect(s.desk).toEqual(["obj-1"]);
    s = command(s).s; expect(s.armed).toBe(true);
    expect(commandEvents(s)).toEqual([{ type: "disarm" }]);                   // a loose piece is not a composition
  });
});

describe("the module", () => {
  it("opens when two things have been pressed together, on that composition, with nothing chosen", () => {
    const { s, errors } = dinner();
    expect(errors).toEqual([]);
    expect(s).toMatchObject({ phase: "composed", focus: "obj-1", placement: null });
    const m = moduleModel(s, REGISTRY);
    expect(m).toMatchObject({ mode: "composed", object: { id: "obj-1", view: { label: "Meet Maya at Dakshin", type: "Event" } }, choice: "calendar" });
    if (m.mode !== "composed") throw new Error();
    expect(m.object.ingredients.map((i) => [i.kind, i.text, i.from])).toEqual([["place", "Dakshin", "Dakshin page"], ["person", "Maya Rao", "Maya Rao page"]]);
  });
  it("closing keeps the composition; the command reopens it, once; there is never a second module", () => {
    let s = run([{ type: "cancel" }], dinner().s).s;
    expect(s).toMatchObject({ phase: "idle", focus: "obj-1", armed: true, last: { text: "Closed. Your composition is kept: press Recast to reopen it" } });
    expect(moduleModel(s, REGISTRY)).toMatchObject({ mode: "pill", reopen: "Meet Maya at Dakshin" });
    expect(commandEvents(s)).toEqual([{ type: "openModule" }]);
    s = command(s).s; expect(s.phase).toBe("composed");
    expect(commandEvents(s)).toEqual([]);
    // Turned off with the module open: the composition is still there, and turning on reopens it.
    s = run([{ type: "disarm" }], s).s; expect(s).toMatchObject({ armed: false, phase: "idle", focus: "obj-1" });
    expect(commandEvents(s)).toEqual([{ type: "arm" }, { type: "openModule" }]);
    s = command(s).s; expect(s).toMatchObject({ armed: true, phase: "composed", focus: "obj-1" });
  });
  it("adding another piece closes the module while carrying and reopens it on the grown composition", () => {
    const { s, errors } = run([
      { type: "capture", fragment: frag("time", "Friday, 7:30 PM"), carry: true },
      { type: "approach", target: { kind: "object", id: "obj-1" } }, { type: "drop" }, { type: "settled" },
    ], dinner().s);
    expect(errors).toEqual([]); expect(s).toMatchObject({ phase: "composed", focus: "obj-1" });
    expect(s.objects["obj-1"]!.ingredients).toHaveLength(3);
  });
  it("taking a piece out until one is left: no composition, so the module closes", () => {
    const d = dinner().s; const maya = d.objects["obj-1"]!.ingredients[1]!.id;
    const { s } = run([{ type: "remove", objectId: "obj-1", ingredientId: maya }], d);
    expect(s).toMatchObject({ phase: "idle", focus: null }); expect(s.desk).toHaveLength(2);
  });
});

describe("the destination selector", () => {
  it("lists the registry in five places; only what fits AND is connected is available, the rest say why", () => {
    const s = dinner().s;
    const e = wheelEntries(s, "obj-1", REGISTRY);
    expect(e.map((x) => [x.key, x.available, x.reason ?? x.destinationId])).toEqual([
      ["calendar", true, "cal"],
      ["mail", false, "Gmail takes messages; this is an event"],
      ["tasks", false, "Google Tasks takes documents (a page or a file); this is an event"],
      ["documents", false, "Notion takes documents (a page or a file); this is an event"],
      ["more", false, "Nothing else Recast connects to takes an event"],
    ]);
    expect(e[0]!.standIn).toBe(true);
    // "More" holds the rest of the registry, each with its own reason; nothing outside the registry appears.
    expect(e[4]!.options.map((o) => o.destination).sort()).toEqual(["gmail.compose-draft", "google-calendar.event-editor", "google-sheets.range"]);
    expect(e.flatMap((x) => x.options).length).toBe(REGISTRY.length);
  });
  it("a fitting destination that is not connected is unavailable, with that reason", () => {
    const s = { ...dinner().s, destinations: [] };
    expect(wheelEntries(s, "obj-1", REGISTRY)[0]).toMatchObject({ key: "calendar", available: false, reason: "Google Calendar is not connected here" });
  });
  it("a message: Mail is available and Calendar says why not", () => {
    const on = command(initialClumpState({ now: NOW, timezone: "Asia/Kolkata", destinations: DESTS })).s;
    const { s } = run([
      { type: "capture", fragment: frag("text", "Free for dinner this week?") },
      { type: "capture", fragment: frag("person", "Maya Rao", { value: { name: "Maya Rao", email: "maya.rao@example.com" } }), carry: true },
      { type: "approach", target: { kind: "object", id: "obj-1" } }, { type: "drop" }, { type: "settled" },
    ], on);
    const e = wheelEntries(s, s.focus!, REGISTRY);
    expect(e.filter((x) => x.available).map((x) => x.key)).toEqual(["mail"]);
    expect(e[0]!.reason).toBe("Google Calendar takes events; this is a message");
    expect(moduleModel(s, REGISTRY)).toMatchObject({ choice: "mail" });   // lands on what works
  });
  it("highlighting and opening the selector write nothing; picking opens a preview, still nothing written", () => {
    const { s, effects, errors } = run([{ type: "openWheel" }, { type: "select", choice: "mail" }, { type: "select", choice: "calendar" }], dinner().s);
    expect(errors).toEqual([]); expect(effects).toEqual([]); expect(s).toMatchObject({ phase: "choosing", choice: "calendar" });
    const p = run([{ type: "pickDestination", destinationId: "cal" }], s);
    expect(p.effects).toEqual([]); expect(p.s).toMatchObject({ phase: "previewing", placement: { objectId: "obj-1", destinationId: "cal", via: "module" } });
    expect(p.s.placement!.op).toBeUndefined();                                  // no time yet: nothing can be placed
    expect(moduleModel(p.s, REGISTRY)).toMatchObject({ mode: "preview", destination: { app: "Google Calendar", standIn: true } });
  });
  it("an unfit pick is refused with the reason and the selector stays open", () => {
    const { s, errors } = run([{ type: "openWheel" }, { type: "pickDestination", destinationId: "mail" }], dinner().s);
    expect(errors).toEqual(["Mail takes messages; this is an event"]); expect(s.phase).toBe("choosing");
  });
  it("the preview goes through the trust model: consent first, success only on the receipt, undo only if reversible", () => {
    const d = dinner().s;
    const r = run([
      { type: "openWheel" }, { type: "pickDestination", destinationId: "cal" },
      { type: "answer", objectId: "obj-1", field: "start", value: "2026-10-23T19:30" },
      { type: "answer", objectId: "obj-1", field: "title", value: "Meet Maya at Dakshin" },
    ], d);
    expect(r.errors).toEqual([]); expect(r.s.placement!.op).toBeDefined();
    const placed = run([{ type: "place", consent: { kind: "confirm" } }], r.s);
    expect(placed.s.phase).toBe("executing"); expect(placed.effects).toMatchObject([{ type: "commit", destinationId: "cal" }]);
    expect(moduleModel(placed.s, REGISTRY).mode).toBe("executing");          // not "succeeded": no receipt yet
  });
});

describe("Escape, one step at a time", () => {
  it("preview → selector → module → closed → off; nothing is written and the composition survives", () => {
    let s = run([{ type: "openWheel" }, { type: "pickDestination", destinationId: "cal" }], dinner().s).s;
    const steps: string[] = [];
    for (let i = 0; i < 4; i++) { const e = escapeEvent(s)!; s = run([e], s).s; steps.push(`${s.phase}${s.armed ? "" : " (off)"}`); }
    expect(steps).toEqual(["choosing", "composed", "idle", "idle (off)"]);
    expect(escapeEvent(s)).toBeNull();
    expect(s.focus).toBe("obj-1"); expect(s.objects["obj-1"]!.ingredients).toHaveLength(2);
  });
  it("Escape does nothing while writing, undoing or while an outcome is unknown, and Recast cannot be turned off then (it says why)", () => {
    const why = { executing: /^Waiting for .* to answer\. Recast stays on until it does$/, undoing: /^Waiting for .* to confirm the undo\. Recast stays on until it does$/, unknown: /^Recast doesn't know yet whether .* has it\. Check .* first$/, merging: /^One moment: still pressing them together$/ };
    for (const phase of ["executing", "undoing", "unknown", "merging"] as const) {
      const s = { ...dinner().s, phase } as ClumpState;
      expect(escapeEvent(s)).toBeNull(); expect(commandEvents(s)).toEqual([]);
      const r = reduceClump(s, { type: "disarm", now: NOW }); expect(r.error).toMatch(why[phase]); expect(r.state).toBe(s);
    }
  });
});

describe("a placed object leaves the desk", () => {
  const receipt = { receiptId: "r1", opId: "op1", at: "2026-10-19T09:00:01Z", status: "done" as const, objectId: "x", destination: "google-calendar.calendar", relationId: "event-calendar-entry", effect: "Add to calendar", reversible: true, bridgeRef: "ev-1" };
  function placed() {
    const r = run([
      { type: "openWheel" }, { type: "pickDestination", destinationId: "cal" },
      { type: "answer", objectId: "obj-1", field: "start", value: "2026-10-23T19:30" },
      { type: "answer", objectId: "obj-1", field: "title", value: "Meet Maya at Dakshin" },
      { type: "place", consent: { kind: "confirm" } },
    ], dinner().s).s;
    return run([{ type: "committed", receipt: { ...receipt, opId: r.placement!.op!.opId }, undoable: true }], r).s;
  }
  const opOf = (s: ClumpState) => s.placement!.op!.opId;
  it("it stays while the receipt shows (Undo needs it), and is gone once the receipt is closed", () => {
    const s = placed(); expect(s.phase).toBe("succeeded"); expect(s.desk).toEqual(["obj-1"]);
    const done = run([{ type: "dismiss" }], s).s;
    expect(done).toMatchObject({ phase: "idle", focus: null, desk: [] }); expect(done.objects["obj-1"]).toBeUndefined();
    expect(moduleModel(done, REGISTRY)).toMatchObject({ mode: "pill", text: "Drag one thing onto another" });
  });
  it("moving on from the receipt any other way also retires it: Escape, turning off, picking up something new", () => {
    for (const e of [{ type: "cancel" }, { type: "disarm" }, { type: "capture", fragment: frag("person", "Arjun Mehta"), carry: true }] as const) {
      const after = run([e], placed()).s; expect(after.objects["obj-1"]).toBeUndefined(); expect(after.desk).not.toContain("obj-1");
    }
  });
  it("undone, it stays: the person can place it somewhere else", () => {
    const p = placed(); const s = run([{ type: "undo" }, { type: "undone", opId: opOf(p) }], p).s;
    expect(s.phase).toBe("idle"); expect(s.desk).toEqual(["obj-1"]); expect(s.objects["obj-1"]!.ingredients).toHaveLength(2);
  });
  it("found by reconciliation after an unknown outcome, then closed: gone as well", () => {
    const p = placed(); const opId = opOf(p);
    const s = run([{ type: "outcomeUnknown", opId, message: "Calendar did not answer" }], { ...p, phase: "executing" } as ClumpState).s;
    const r = run([{ type: "reconcile" }, { type: "reconciled", opId, found: true, receipt: { ...receipt, opId } }, { type: "dismiss" }], s).s;
    expect(r.desk).toEqual([]);
  });
});
