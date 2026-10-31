// A recipe run in the state machine: reviewed together, approved once, each step its own outcome. Partial success is
// reported as such; an unknown step is never sent again; Undo is per step and only where the step can be reversed.
import { describe, expect, it } from "vitest";
import { CONTRACTS } from "@recast/bridges";
import type { Fragment, Receipt } from "@recast/core";
import { initialClumpState, recipeOffers, reduceClump, settleLostWrites, viewOf as viewOfFn, type ClumpEvent, type ClumpState, type DestinationSpec } from "../src/index.js";

const NOW = Date.parse("2026-10-19T09:00:00Z");
let n = 0;
const frag = (kind: Fragment["kind"], text: string, value?: Fragment["value"]): Fragment => ({ id: `f${++n}`, kind, text, confidence: 0.9, ...(value ? { value } : {}), evidence: [{ locator: { kind: "css", value: `#e${n}` } }], source: { app: "chrome", url: "https://dakshin.example", title: "Dakshin" } });
const CAL: DestinationSpec = { id: "cal", label: "Calendar", contract: CONTRACTS.googleCalendarEvent, standIn: true };
const MAIL: DestinationSpec = { id: "mail", label: "Mail", contract: CONTRACTS.gmailMessageDraft, standIn: true };
const TASKS: DestinationSpec = { id: "tasks", label: "Tasks", contract: CONTRACTS.googleTasksEntry, standIn: true };
const DOCS: DestinationSpec = { id: "docs", label: "Docs", contract: CONTRACTS.googleDocs, standIn: true };
type Input = ClumpEvent extends infer E ? (E extends ClumpEvent ? Omit<E, "now"> : never) : never;
function run(events: Input[], s: ClumpState) {
  const effects: any[] = []; const errors: string[] = [];
  for (const e of events) { const r = reduceClump(s, { ...e, now: NOW } as ClumpEvent); s = r.state; effects.push(...r.effects); if (r.error) errors.push(r.error); }
  return { s, effects, errors };
}
/** Dinner with Maya at Dakshin, Friday 7:30 PM, composed and titled. */
function dinner(dests: DestinationSpec[], email = "maya@example.com") {
  const s0 = { ...initialClumpState({ now: NOW, timezone: "Asia/Kolkata", destinations: dests }), armed: true };
  const r = run([
    { type: "capture", fragment: frag("place", "Dakshin", { name: "Dakshin", address: "12 MG Road" }) },
    { type: "capture", fragment: frag("person", "Maya Rao", { name: "Maya Rao", ...(email ? { email } : {}) }), carry: true },
    { type: "approach", target: { kind: "object", id: "obj-1" } }, { type: "drop" }, { type: "settled" },
    { type: "capture", fragment: frag("time", "Friday 7:30 PM"), carry: true },
    { type: "approach", target: { kind: "object", id: "obj-1" } }, { type: "drop" }, { type: "settled" },
    { type: "answer", objectId: "obj-1", field: "title", value: "Dinner with Maya" },
  ], s0);
  expect(r.errors).toEqual([]);
  return r.s;
}
const receiptFor = (op: any, ref: string): Receipt => ({ receiptId: `r-${op.opId}`, opId: op.opId, at: "2026-10-19T09:00:01Z", status: "done", objectId: op.proposal.object.id, destination: op.proposal.destination.destination, relationId: op.proposal.relationId, effect: op.proposal.effect, reversible: true, bridgeRef: ref });

describe("recipes in the state machine", () => {
  it("offers only recipes for this kind of object, each available or with its reason", () => {
    const s = dinner([CAL, MAIL]);
    expect(recipeOffers(s, "obj-1")).toEqual([
      expect.objectContaining({ id: "plan-and-invite", available: true }),
      expect.objectContaining({ id: "plan-and-prepare", available: true }),   // the event step can still run
      expect.objectContaining({ id: "plan-prepare-note-invite", available: true }),
    ]);
    const solo = dinner([]);
    expect(recipeOffers(solo, "obj-1")[0]).toMatchObject({ available: false, reason: "a calendar is not connected here" });
  });
  it("review → one approval → each step in turn → both done; Undo per step; Done retires the object", () => {
    let { s, effects, errors } = run([{ type: "openRecipe", recipeId: "plan-and-invite" }], dinner([CAL, MAIL]));
    expect(errors).toEqual([]); expect(effects).toEqual([]);                     // reviewing writes nothing
    expect(s.phase).toBe("planning");
    expect(s.run!.steps.map((x) => [x.id, x.status, x.include, x.destinationLabel])).toEqual([["event", "ready", true, "Calendar"], ["invite", "ready", true, "Mail"]]);
    expect(s.run!.steps[1]!.op!.dataMoved).toEqual([{ path: "Message.to", value: "maya@example.com" }, { path: "Message.snippet", value: "Hi Maya, are you free for Dinner with Maya at Dakshin on Friday 23 October at 7:30 PM?" }]);
    ({ s, effects } = run([{ type: "runRecipe", consent: { kind: "confirm" } }], s));
    expect(s.phase).toBe("running"); expect(effects).toHaveLength(1); expect(effects[0]).toMatchObject({ type: "commit", destinationId: "cal" });
    const op1 = s.run!.steps[0]!.op!, op2 = s.run!.steps[1]!.op!;
    ({ s, effects } = run([{ type: "committed", receipt: receiptFor(op1, "ev-1"), undoable: true }], s));
    // The calendar can be read back: it is checked at once, while the next step is sent.
    expect(effects).toEqual([expect.objectContaining({ type: "verify", destinationId: "cal" }), expect.objectContaining({ type: "commit", destinationId: "mail" })]);
    expect(s.run!.steps[0]!.verification).toBe("checking");
    ({ s, effects } = run([{ type: "committed", receipt: receiptFor(op2, "d-1"), undoable: true }], s));
    expect(s.phase).toBe("ran"); expect(s.last!.text).toBe("Plan and invite: all 2 done");
    ({ s, effects } = run([{ type: "undoStep", stepId: "invite" }], s));
    expect(effects).toEqual([{ type: "undo", receipt: expect.objectContaining({ bridgeRef: "d-1" }), destinationId: "mail" }]);
    ({ s } = run([{ type: "undone", opId: op2.opId }], s));
    expect(s.run!.steps.map((x) => x.status)).toEqual(["done", "undone"]);
    ({ s } = run([{ type: "dismiss" }], s));
    expect(s.phase).toBe("idle"); expect(s.desk).toEqual(["obj-1"]);         // not everything stands: the object stays
  });
  it("partial success is reported as partial; a lost answer is unknown, remembered, and never sent again", () => {
    let { s } = run([{ type: "openRecipe", recipeId: "plan-and-invite" }, { type: "runRecipe", consent: { kind: "confirm" } }], dinner([CAL, MAIL]));
    const [a, b] = s.run!.steps;
    let effects: any[];
    ({ s, effects } = run([{ type: "outcomeUnknown", opId: a!.op!.opId, message: "Calendar did not answer" }], s));
    expect(effects).toEqual([expect.objectContaining({ type: "commit", destinationId: "mail" })]);   // the next step, not a resend
    ({ s } = run([{ type: "commitFailed", opId: b!.op!.opId, message: "Mail refused it" }], s));
    expect(s.phase).toBe("ran");
    expect(s.run!.steps.map((x) => [x.status, x.message])).toEqual([["unknown", "Calendar did not answer"], ["failed", "Mail refused it"]]);
    expect(s.last!.text).toBe("Plan and invite: 0 of 2 done, 1 not known yet");   // what is not known is said (D61)
    expect(s.uncertain["obj-1"]).toMatchObject({ destinationId: "cal" });
    expect(run([{ type: "undoStep", stepId: "event" }], s).errors).toEqual(["this step cannot be undone"]);
  });
  it("a step without what it needs is shown blocked with the reason and left out; the rest can still run", () => {
    let { s } = run([{ type: "openRecipe", recipeId: "plan-and-invite" }], dinner([CAL, MAIL], ""));
    expect(s.run!.steps[1]).toMatchObject({ status: "blocked", include: false, reason: "Maya Rao has no email address on the page" });
    expect(run([{ type: "toggleStep", stepId: "invite" }], s).errors).toEqual(["Maya Rao has no email address on the page"]);
    let effects: any[];
    ({ s, effects } = run([{ type: "runRecipe", consent: { kind: "confirm" } }], s));
    expect(effects).toHaveLength(1);
    ({ s } = run([{ type: "committed", receipt: receiptFor(s.run!.steps[0]!.op, "ev"), undoable: true }], s));
    expect(s.last!.text).toBe("Plan and invite: all 1 done");
  });
  it("a step can be left out before running; nothing runs without a step; cancel writes nothing", () => {
    let { s } = run([{ type: "openRecipe", recipeId: "plan-and-invite" }, { type: "toggleStep", stepId: "event" }, { type: "toggleStep", stepId: "invite" }], dinner([CAL, MAIL]));
    expect(run([{ type: "runRecipe", consent: { kind: "confirm" } }], s).errors).toEqual(["choose at least one step"]);
    const c = run([{ type: "cancel" }], s);
    expect(c.s.phase).toBe("composed"); expect(c.s.run).toBeNull(); expect(c.effects).toEqual([]);
  });
  it("while running nothing else happens, and an answer for an earlier operation is ignored", () => {
    let { s } = run([{ type: "openRecipe", recipeId: "plan-and-invite" }, { type: "runRecipe", consent: { kind: "confirm" } }], dinner([CAL, MAIL]));
    expect(run([{ type: "cancel" }], s).errors[0]).toMatch(/Waiting for the steps to answer/);
    const late = reduceClump(s, { type: "committed", receipt: receiptFor({ opId: "rc_op_old", proposal: s.run!.steps[0]!.op!.proposal }, "x"), undoable: true, now: NOW });
    expect(late.stale).toBe(true); expect(late.state).toBe(s);
  });
  it("an unfinished event can be finished in the recipe's review; the steps are worked out again", () => {
    const s0 = dinner([CAL, MAIL]);
    const untitled = { ...s0, objects: { ...s0.objects, "obj-1": { ...s0.objects["obj-1"]!, answers: {} } } };
    expect(recipeOffers(untitled, "obj-1")[0]).toMatchObject({ available: true });
    let { s } = run([{ type: "openRecipe", recipeId: "plan-and-invite" }], untitled);
    expect(s.run!.steps.map((x) => x.status)).toEqual(["blocked", "blocked"]);
    ({ s } = run([{ type: "answer", objectId: "obj-1", field: "title", value: "Dinner" }], s));
    expect(s.run!.steps.map((x) => x.status)).toEqual(["ready", "ready"]);
  });
});

describe("the capture stack holds no accidental copies", () => {
  it("the same piece from the same page again is the object already there; carried, it is that one in hand", () => {
    const s0 = { ...initialClumpState({ now: NOW, timezone: "Asia/Kolkata", destinations: [CAL] }), armed: true };
    const piece = () => ({ ...frag("time", "Friday 7:30 PM"), id: `t${++n}` });
    let r = run([{ type: "capture", fragment: piece() }, { type: "capture", fragment: piece() }], s0);
    expect(r.s.desk).toEqual(["obj-1"]); expect(r.s.last!.text).toBe("Friday 7:30 PM is already on your desk");
    const again = reduceClump(r.s, { type: "capture", fragment: piece(), carry: true, now: NOW });
    expect(again.captured).toBe("obj-1"); expect(again.state).toMatchObject({ carried: "obj-1", phase: "carrying", desk: [] });
    // From another page, or another kind, it is a different piece.
    r = run([{ type: "capture", fragment: { ...piece(), source: { app: "chrome", url: "https://other.example" } } }], r.s);
    expect(Object.keys(r.s.objects)).toHaveLength(2);
  });

  it("the conference recipe: four related objects, each its own operation; the note quotes every piece with its source; version and limitations travel with the run", () => {
    let { s, errors } = run([{ type: "openRecipe", recipeId: "plan-prepare-note-invite" }], dinner([CAL, MAIL, TASKS, DOCS]));
    expect(errors).toEqual([]);
    expect(s.run).toMatchObject({ version: 1, limitations: expect.arrayContaining([expect.stringMatching(/never sent/)]) });
    expect(s.run!.steps.map((x) => [x.id, x.status, x.destinationLabel, x.after ?? ""])).toEqual([["event", "ready", "Calendar", ""], ["prepare", "ready", "Tasks", "event"], ["note", "ready", "Docs", ""], ["invite", "ready", "Mail", ""]]);
    const note = s.run!.steps[2]!.op!.dataMoved;
    expect(note.find((d) => d.path === "Note.title")!.value).toBe("Notes: Dinner with Maya");
    expect(String(note.find((d) => d.path === "Note.body")!.value)).toBe("“Dakshin”\n— Dakshin, https://dakshin.example\n\n“Maya Rao”\n— Dakshin, https://dakshin.example\n\n“Friday 7:30 PM”\n— Dakshin, https://dakshin.example");
  });
  it("a step that waits for another is not run when that one fails, and says why; the failed one can be tried again with the same operation, then the waiting one", () => {
    let { s, effects } = run([{ type: "openRecipe", recipeId: "plan-and-prepare" }, { type: "runRecipe", consent: { kind: "confirm" } }], dinner([CAL, TASKS]));
    const op1 = s.run!.steps[0]!.op!;
    ({ s, effects } = run([{ type: "commitFailed", opId: op1.opId, message: "Calendar said no (403)" }], s));
    expect(s.phase).toBe("ran"); expect(effects).toEqual([]);                       // the task was never sent
    expect(s.run!.steps.map((x) => [x.status, x.message])).toEqual([["failed", "Calendar said no (403)"], ["skipped", "\"Add the event to your calendar\" did not succeed, so this was not run"]]);
    expect(s.last).toMatchObject({ kind: "failed", text: "Plan and prepare: 0 of 2 done" });
    // The waiting one cannot jump the queue; the failed one is sent again as the same operation (the same id).
    expect(run([{ type: "retryStep", stepId: "prepare" }], s).errors[0]).toMatch(/has to succeed first/);
    ({ s, effects } = run([{ type: "retryStep", stepId: "event" }], s));
    expect(s.phase).toBe("running"); expect(effects).toEqual([expect.objectContaining({ type: "commit", op: expect.objectContaining({ opId: op1.opId }) })]);
    ({ s } = run([{ type: "committed", receipt: receiptFor(op1, "ev-1"), undoable: true }], s));
    expect(s.phase).toBe("ran"); expect(s.last!.text).toBe("Plan and prepare: 1 of 2 done");
    ({ s, effects } = run([{ type: "retryStep", stepId: "prepare" }], s));
    expect(effects).toEqual([expect.objectContaining({ type: "commit", destinationId: "tasks" })]);
    ({ s } = run([{ type: "committed", receipt: receiptFor(s.run!.steps[1]!.op!, "t-1"), undoable: true }], s));
    expect(s.last!.text).toBe("Plan and prepare: all 2 done");
  });
  it("an unknown outcome is never tried again; leaving out the step another waits for leaves that one out too, with the reason", () => {
    let { s } = run([{ type: "openRecipe", recipeId: "plan-and-invite" }, { type: "runRecipe", consent: { kind: "confirm" } }], dinner([CAL, MAIL]));
    ({ s } = run([{ type: "outcomeUnknown", opId: s.run!.steps[0]!.op!.opId, message: "no answer" }], s));
    ({ s } = run([{ type: "committed", receipt: receiptFor(s.run!.steps[1]!.op!, "d-1"), undoable: true }], s));
    expect(run([{ type: "retryStep", stepId: "event" }], s).errors[0]).toMatch(/never sent twice/);
    let r = run([{ type: "openRecipe", recipeId: "plan-and-prepare" }, { type: "toggleStep", stepId: "event" }, { type: "runRecipe", consent: { kind: "confirm" } }], dinner([CAL, TASKS]));
    expect(r.effects).toEqual([]); expect(r.s.phase).toBe("ran");
    expect(r.s.run!.steps[1]).toMatchObject({ status: "skipped", message: expect.stringMatching(/which was left out/) });
  });
});

describe("the person's defaults (D59)", () => {
  const OUTLOOK: DestinationSpec = { id: "outlook", label: "Outlook", contract: CONTRACTS.outlookCalendarEvent, standIn: true };
  it("a default calendar is where the wheel and recipes go; it is stored, shown, cleared; a bad stored value is dropped", async () => {
    const { wheelEntries } = await import("../src/wheel.js");
    const { REGISTRY } = await import("@recast/bridges");
    let s = dinner([CAL, OUTLOOK, MAIL]);
    expect(wheelEntries(s, "obj-1", REGISTRY)[0]).toMatchObject({ key: "calendar", destinationId: "cal" });
    let r = run([{ type: "setPreset", key: "calendar", value: CONTRACTS.outlookCalendarEvent.destination }], s);
    expect(r.effects).toEqual([{ type: "storePresets", presets: { places: { calendar: CONTRACTS.outlookCalendarEvent.destination } } }]);
    s = r.s;
    expect(wheelEntries(s, "obj-1", REGISTRY)[0]).toMatchObject({ destinationId: "outlook", preset: CONTRACTS.outlookCalendarEvent.app });
    expect(run([{ type: "openRecipe", recipeId: "plan-and-invite" }], s).s.run!.steps[0]!.destinationId).toBe("outlook");
    // An explicit pick for this object is still the person's: choosing Google Calendar goes there.
    expect(run([{ type: "openWheel" }, { type: "pickDestination", destinationId: "cal" }], s).s.placement!.destinationId).toBe("cal");
    expect(run([{ type: "setPreset", key: "calendar", value: null }], s).s.presets).toEqual({ places: {} });
    expect(run([{ type: "loadPresets", presets: { places: { calendar: "<script>", mail: 3 }, durationMin: 61, extra: "x" } }], s).s.presets).toEqual({});
    expect(run([{ type: "setPreset", key: "duration", value: 61 }], s).errors[0]).toMatch(/choose one of/);
  });
  it("a default meeting length is used only when nothing gave an end, and says it is yours", () => {
    let s = run([{ type: "setPreset", key: "duration", value: 90 }], dinner([CAL])).s;
    const r = run([{ type: "openWheel" }, { type: "pickDestination", destinationId: "cal" }], s);
    const end = r.s.placement!.op!.dataMoved.find((d) => d.path === "Event.end")!.value;
    expect(end).toBe("2026-10-23T21:00");
    expect(viewOfEvent(r.s).assumptions).toContain("Ends after 90 minutes (your default; change it if needed)");
    const typed = run([{ type: "answer", objectId: "obj-1", field: "end", value: "2026-10-23T20:00" }], r.s);
    expect(typed.s.placement!.op!.dataMoved.find((d) => d.path === "Event.end")!.value).toBe("2026-10-23T20:00");
  });
});
function viewOfEvent(s: ClumpState) { return viewOfFn(s, "obj-1").event!; }

describe("recovery and honest summaries (D61)", () => {
  it("after a restart mid-run: the step in flight is unknown (never resent), the ones never sent are 'not run' and can be tried again", () => {
    let { s } = run([{ type: "openRecipe", recipeId: "plan-and-invite" }, { type: "runRecipe", consent: { kind: "confirm" } }], dinner([CAL, MAIL]));
    expect(s.run!.steps.map((x) => x.status)).toEqual(["running", "waiting"]);
    const r = settleLostWrites(s, NOW);
    expect(r.phase).toBe("ran");
    expect(r.run!.steps.map((x) => [x.status, x.message])).toEqual([["unknown", "Recast closed before the answer came"], ["skipped", "Recast closed before this was sent"]]);
    expect(r.uncertain!["obj-1"]).toBeDefined();                                     // placing it there again checks first
    expect(r.last!.text).toBe("Plan and invite: 0 of 2 done, 1 not known yet");
    expect(run([{ type: "retryStep", stepId: "event" }], r).errors[0]).toMatch(/never sent twice/);
    const again = run([{ type: "retryStep", stepId: "invite" }], r);
    expect(again.effects).toEqual([expect.objectContaining({ type: "commit", destinationId: "mail" })]);
    // A single placement in flight: unknown, with the reason; an undo in flight: not confirmed, still there.
    const one = run([{ type: "openWheel" }, { type: "pickDestination", destinationId: "cal" }, { type: "place", consent: { kind: "confirm" } }], dinner([CAL])).s;
    expect(one.phase).toBe("executing");
    expect(settleLostWrites(one, NOW, "The browser's Recast worker")).toMatchObject({ phase: "unknown", placement: { message: "The browser's Recast worker closed before the answer came" } });
    const idle = dinner([CAL]); expect(settleLostWrites(idle, NOW)).toBe(idle);   // nothing in flight: unchanged
  });
  it("an undone step is not counted as done when the run is summed up again", () => {
    let { s } = run([{ type: "openRecipe", recipeId: "plan-and-invite" }, { type: "runRecipe", consent: { kind: "confirm" } }], dinner([CAL, MAIL]));
    ({ s } = run([{ type: "committed", receipt: receiptFor(s.run!.steps[0]!.op!, "ev-1"), undoable: true }], s));
    ({ s } = run([{ type: "commitFailed", opId: s.run!.steps[1]!.op!.opId, message: "Mail said no (400)" }], s));
    ({ s } = run([{ type: "undoStep", stepId: "event" }, { type: "undone", opId: s.run!.steps[0]!.op!.opId }], s));
    ({ s } = run([{ type: "retryStep", stepId: "invite" }], s));
    ({ s } = run([{ type: "committed", receipt: receiptFor(s.run!.steps[1]!.op!, "d-1"), undoable: true }], s));
    expect(s.last!.text).toBe("Plan and invite: 1 of 2 done");
    // An undo in flight when the app closed: not confirmed, the step stays done with the reason.
    ({ s } = run([{ type: "undoStep", stepId: "invite" }], s));
    expect(settleLostWrites(s, NOW).run!.steps[1]).toMatchObject({ status: "done", message: "Could not undo: Recast closed before the undo was confirmed" });
  });
});
