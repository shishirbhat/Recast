// Personal saved workflows: saved from what the person just did, named by them, run again on new information through the
// same review, approval, commit, read-back and Undo as any recipe. Destinations are stand-ins (CONTRACTS with standIn);
// nothing here reaches a provider.
import { describe, expect, it } from "vitest";
import { CONTRACTS, REGISTRY } from "@recast/bridges";
import type { Fragment, Receipt, Verification } from "@recast/core";
import { initialClumpState, moduleModel, recipeOffers, reduceClump, saveable, viewOf, type ClumpEvent, type ClumpState, type DestinationSpec } from "../src/index.js";

const NOW = Date.parse("2026-10-19T09:00:00Z");
const KNOWN = REGISTRY.map((c) => c.destination);
let n = 0;
const frag = (kind: Fragment["kind"], text: string, value?: Fragment["value"], site = "dakshin.example"): Fragment => ({ id: `f${++n}`, kind, text, confidence: 0.9, ...(value ? { value } : {}), evidence: [{ locator: { kind: "css", value: `#e${n}` } }], source: { app: "chrome", url: `https://${site}/menu`, title: site } });
const CAL: DestinationSpec = { id: "cal", label: "Calendar", contract: CONTRACTS.googleCalendarEvent, standIn: true };
const OUTLOOK: DestinationSpec = { id: "outlook", label: "Outlook", contract: CONTRACTS.outlookCalendarEvent, standIn: true };
const MAIL: DestinationSpec = { id: "mail", label: "Mail", contract: CONTRACTS.gmailMessageDraft, standIn: true };
const EDITOR: DestinationSpec = { id: "editor", label: "Open event", contract: CONTRACTS.googleCalendar, standIn: true };
type Input = ClumpEvent extends infer E ? (E extends ClumpEvent ? Omit<E, "now"> : never) : never;
function run(events: Input[], s: ClumpState) {
  const effects: any[] = []; const errors: string[] = [];
  for (const e of events) { const r = reduceClump(s, { ...e, now: NOW } as ClumpEvent); s = r.state; effects.push(...r.effects); if (r.error) errors.push(r.error); }
  return { s, effects, errors };
}
/** An event composed from three captured pieces, titled. */
function event(dests: DestinationSpec[], o: { place: string; person: string; email?: string; time: string; title?: string; site?: string }, base?: ClumpState) {
  const s0 = base ? { ...base, destinations: dests, phase: "idle" as const, run: null, placement: null } : { ...initialClumpState({ now: NOW, timezone: "Asia/Kolkata", destinations: dests }), armed: true };
  const before = Object.keys(s0.objects).length;
  const id = (k: number) => `obj-${s0.seq + k}`;
  const r = run([
    { type: "capture", fragment: frag("place", o.place, { name: o.place, address: "12 MG Road" }, o.site) },
    { type: "capture", fragment: frag("person", o.person, { name: o.person, ...(o.email ? { email: o.email } : {}) }, o.site), carry: true },
    { type: "approach", target: { kind: "object", id: id(1) } }, { type: "drop" }, { type: "settled" },
    { type: "capture", fragment: frag("time", o.time, undefined, o.site), carry: true },
    { type: "approach", target: { kind: "object", id: id(1) } }, { type: "drop" }, { type: "settled" },
    ...(o.title ? [{ type: "answer", objectId: id(1), field: "title", value: o.title } as Input] : []),
  ], s0);
  expect(r.errors).toEqual([]); expect(Object.keys(r.s.objects).length).toBeGreaterThan(before - 1);
  return { s: r.s, id: id(1) };
}
const receiptFor = (op: any, ref: string): Receipt => ({ receiptId: `r-${op.opId}`, opId: op.opId, at: "2026-10-19T09:00:01Z", status: "done", objectId: op.proposal.object.id, destination: op.proposal.destination.destination, relationId: op.proposal.relationId, effect: op.proposal.effect, reversible: true, bridgeRef: ref });
const okRead = (fields = 3): Verification => ({ ok: true, at: "2026-10-19T09:00:02Z", fields: Array.from({ length: fields }, (_, i) => ({ path: `Event.f${i}`, expected: "x", actual: "x", match: true })) });

/** Place one event in the calendar through the normal review, then save that as "Dinner plan". */
function savedSingle(dests = [CAL, MAIL]) {
  const { s: s1, id } = event(dests, { place: "Dakshin", person: "Maya Rao", email: "maya@example.com", time: "Friday 7:30 PM", title: "Dinner with Maya" });
  let { s, errors } = run([{ type: "openWheel" }, { type: "pickDestination", destinationId: "cal" }], s1);
  expect(errors).toEqual([]); expect(s.phase).toBe("previewing");
  const r = run([{ type: "saveWorkflow", name: "Dinner plan" }], s);
  expect(r.errors).toEqual([]);
  return { s: r.s, effects: r.effects, id };
}

describe("saving a workflow", () => {
  it("saves from the review, only when asked, with the person's name; the host is told to store it", () => {
    const { s: s1 } = event([CAL], { place: "Dakshin", person: "Maya Rao", time: "Friday 7:30 PM", title: "Dinner" });
    const { s: preview } = run([{ type: "openWheel" }, { type: "pickDestination", destinationId: "cal" }], s1);
    // Opening the review saved nothing; Save is offered.
    expect(preview.workflows ?? []).toEqual([]);
    expect(moduleModel(preview, REGISTRY)).toMatchObject({ mode: "preview", save: { ok: true } });
    const { s, effects } = savedSingle();
    expect(s.phase).toBe("previewing");                                       // saving never places or approves anything
    expect(effects).toEqual([{ type: "storeWorkflows", items: [expect.objectContaining({ name: "Dinner plan", origin: "saved", needs: "Event" })] }]);
    expect(s.workflows![0]).toMatchObject({ version: 1, steps: [{ id: "place", targetKind: "Calendar", destination: "google-calendar.calendar", app: "Google Calendar" }], description: "An event → Google Calendar" });
    expect(s.last).toMatchObject({ kind: "saved" });
    expect(moduleModel(s, REGISTRY)).toMatchObject({ save: { ok: true, done: expect.stringContaining("Saved \"Dinner plan\"") } });
  });

  it("keeps no captured content: no words, people, addresses, links or times from what was captured", () => {
    const { s, effects } = savedSingle();
    const stored = JSON.stringify(effects[0].items);
    for (const secret of ["Dakshin", "Maya", "maya@example.com", "MG Road", "dakshin.example", "7:30", "2026-10-23", "Dinner with Maya", "obj-", "f1"]) expect(stored).not.toContain(secret);
    // Exactly the definition fields: nothing else could carry content.
    expect(Object.keys(effects[0].items[0]).sort()).toEqual(["description", "id", "limitations", "name", "needs", "origin", "steps", "version"]);
  });

  it("saves a recipe run as the steps the person kept, each with its exact destination", () => {
    const { s: s1 } = event([OUTLOOK, MAIL], { place: "Dakshin", person: "Maya Rao", email: "maya@example.com", time: "Friday 7:30 PM", title: "Dinner" });
    let { s } = run([{ type: "openRecipe", recipeId: "plan-and-invite" }], s1);
    expect(saveable(s)).toEqual({ ok: true, from: "run" });
    const r = run([{ type: "saveWorkflow", name: "Outlook dinner" }], s);
    expect(r.errors).toEqual([]); expect(r.s.phase).toBe("planning");
    expect(r.s.workflows![0]!.steps.map((x) => [x.id, x.destination])).toEqual([["event", "outlook-calendar.calendar"], ["invite", CONTRACTS.gmailMessageDraft.destination]]);
  });

  it("refuses an empty, too long or duplicate name, and keeps nothing", () => {
    const { s } = savedSingle();
    const { s: again } = run([{ type: "cancel" }, { type: "openWheel" }, { type: "pickDestination", destinationId: "cal" }], s);
    expect(run([{ type: "saveWorkflow", name: "   " }], again)).toMatchObject({ errors: ["give it a name"], effects: [] });
    expect(run([{ type: "saveWorkflow", name: "x".repeat(61) }], again).errors[0]).toMatch(/under 60/);
    expect(run([{ type: "saveWorkflow", name: "dinner PLAN" }], again).errors[0]).toMatch(/already a workflow called/);
    expect(run([{ type: "saveWorkflow", name: "Plan and invite" }], again).errors[0]).toMatch(/already a workflow called/);   // Recast's own recipe names too
  });

  it("is not offered where it cannot be repeated safely: changing one existing item, a chosen slot, nothing open", () => {
    const { s: s1 } = event([EDITOR, CAL], { place: "Dakshin", person: "Maya Rao", email: "maya@example.com", time: "Friday 7:30 PM", title: "Dinner" });
    expect(saveable(s1)).toEqual({ ok: false, reason: "open a review first" });
    const ed = { ...s1, phase: "previewing" as const, placement: { objectId: "obj-1", destinationId: "editor" } };
    expect(saveable(ed)).toMatchObject({ ok: false, reason: expect.stringContaining("one particular item") });
    expect(moduleModel(ed, REGISTRY)).toMatchObject({ save: { ok: false } });
    expect(run([{ type: "saveWorkflow", name: "x" }], ed).errors[0]).toMatch(/^Cannot save this as a workflow/);
    const slot = { ...s1, phase: "previewing" as const, placement: { objectId: "obj-1", destinationId: "cal", slot: "fri-7" } };
    expect(saveable(slot)).toMatchObject({ ok: false, reason: expect.stringContaining("time slot") });
  });
});

describe("loading, renaming and deleting", () => {
  it("loads stored workflows and checks each one; invalid entries are kept aside with the reason, never run", () => {
    const { s: saved } = savedSingle();
    const good = saved.workflows![0];
    const s0 = initialClumpState({ now: NOW, timezone: "Asia/Kolkata", destinations: [CAL] });
    const items: unknown[] = [
      good,
      { ...good, id: "wf_old", version: 2 },                                                          // outdated
      { ...good, id: "wf_gone", name: "Old notes", steps: [{ ...good!.steps[0], destination: "evernote.notes" }] },   // unsupported destination
      { ...good, id: "wf_leak", note: "Dinner with Maya at Dakshin" },                                // an extra field that could carry content
      { ...good, id: "wf_bad", steps: [{ id: "delete-everything", label: "x", targetKind: "Calendar" }] },
      "not even an object",
    ];
    const { s } = run([{ type: "setWorkflows", items, known: KNOWN }], s0);
    expect(s.workflows!.map((w) => w.id)).toEqual([good!.id]);
    expect(s.workflowIssues!.map((x) => x.reason)).toEqual([
      "it was saved by a different version of Recast",
      "it goes to evernote.notes, which Recast cannot place in any more",
      "unexpected note",
      "a step (delete-everything) is not one Recast can run",
      "not a workflow",
    ]);
  });

  it("renames and deletes, telling the host to store the new list; unusable entries can be deleted too", () => {
    const { s: saved } = savedSingle();
    const good = saved.workflows![0]!;
    const { s: loaded } = run([{ type: "setWorkflows", items: [good, { ...good, id: "wf_old", version: 9 }, 42], known: KNOWN }], initialClumpState({ now: NOW, timezone: "Asia/Kolkata", destinations: [CAL] }));
    let { s, effects, errors } = run([{ type: "renameWorkflow", id: good.id, name: "  Friday   dinners " }], loaded);
    expect(errors).toEqual([]); expect(s.workflows![0]!.name).toBe("Friday dinners");
    // Unusable entries stay stored as they were, so a newer Recast can still read them.
    expect(effects[0].items).toEqual([expect.objectContaining({ name: "Friday dinners" }), expect.objectContaining({ id: "wf_old", version: 9 }), 42]);
    expect(run([{ type: "renameWorkflow", id: "wf_nope", name: "x" }], s).errors).toEqual(["no such workflow"]);
    ({ s, effects } = run([{ type: "deleteWorkflow", id: "wf_old" }, { type: "deleteWorkflow", id: "#0" }], s));
    expect(s.workflowIssues).toEqual([]); expect(effects.at(-1).items).toEqual([expect.objectContaining({ id: good.id })]);
    ({ s, effects } = run([{ type: "deleteWorkflow", id: good.id }], s));
    expect(s.workflows).toEqual([]); expect(effects).toEqual([{ type: "storeWorkflows", items: [] }]);
    expect(s.last!.text).toMatch(/Nothing already placed was changed/);
  });
});

describe("running a saved workflow on new information", () => {
  /** A second, different event on the same desk, with the saved workflow loaded. */
  function second(dests = [CAL, MAIL], o: Partial<Parameters<typeof event>[1]> = {}) {
    const { s: saved } = savedSingle();
    const wf = saved.workflows![0]!;
    const fresh = run([{ type: "setWorkflows", items: [wf], known: KNOWN }], { ...initialClumpState({ now: NOW, timezone: "Asia/Kolkata", destinations: dests }), armed: true }).s;
    const { s, id } = event(dests, { place: "Toit", person: "Arjun Mehta", email: "arjun@example.com", time: "Saturday 1 PM", title: "Lunch with Arjun", site: "toit.example", ...o }, fresh);
    return { s, id, wf };
  }

  it("is offered with the recipes for this kind of object; the run uses the new information, and writes nothing until approved", () => {
    const { s: s1, id, wf } = second();
    expect(recipeOffers(s1, id)).toContainEqual(expect.objectContaining({ id: wf.id, name: "Dinner plan", saved: true, available: true }));
    let { s, effects, errors } = run([{ type: "openRecipe", recipeId: wf.id }], s1);
    expect(errors).toEqual([]); expect(effects).toEqual([]);
    expect(s.phase).toBe("planning"); expect(s.run).toMatchObject({ saved: true, name: "Dinner plan" });
    const step = s.run!.steps[0]!;
    expect(step).toMatchObject({ id: "place", status: "ready", destinationId: "cal" });
    expect(JSON.stringify(step.op!.dataMoved)).toContain("Lunch with Arjun");
    expect(JSON.stringify(step.op!.dataMoved)).not.toContain("Maya");
    // No approval, no write: a run without the person's consent is refused.
    expect(run([{ type: "runRecipe", consent: { kind: "release" } }], s).errors[0]).toMatch(/confirm/);
    ({ s, effects } = run([{ type: "runRecipe", consent: { kind: "confirm" } }], s));
    expect(effects).toEqual([expect.objectContaining({ type: "commit", destinationId: "cal" })]);
    // Committed → read back from the destination; done only says "checking" until it answers.
    const op = s.run!.steps[0]!.op!;
    ({ s, effects } = run([{ type: "committed", receipt: receiptFor(op, "ev-2"), undoable: true }], s));
    expect(effects).toEqual([expect.objectContaining({ type: "verify", destinationId: "cal" })]);
    expect(s.run!.steps[0]!.verification).toBe("checking");
    ({ s } = run([{ type: "verified", opId: op.opId, verification: okRead() }], s));
    expect(s.run!.steps[0]!.verification).toMatchObject({ ok: true });
    expect(s.last!.text).toBe("Dinner plan: all 1 done");
    // A late second read-back answer changes nothing.
    expect(reduceClump(s, { type: "verified", opId: op.opId, verification: okRead(), now: NOW }).stale).toBe(true);
    ({ s, effects } = run([{ type: "undoStep", stepId: "place" }], s));
    expect(effects).toEqual([{ type: "undo", receipt: expect.objectContaining({ bridgeRef: "ev-2" }), destinationId: "cal" }]);
  });

  it("shows what is missing and lets it be finished in the review", () => {
    const { s: s1, id, wf } = second(undefined, { title: undefined });
    expect(recipeOffers(s1, id).find((o) => o.id === wf.id)).toMatchObject({ available: true });
    let { s } = run([{ type: "openRecipe", recipeId: wf.id }], s1);
    expect(s.run!.steps[0]).toMatchObject({ status: "blocked", reason: expect.stringMatching(/^the event is not complete: title/) });
    ({ s } = run([{ type: "answer", objectId: id, field: "title", value: "Lunch" }], s));
    expect(s.run!.steps[0]).toMatchObject({ status: "ready", include: true });
  });

  it("shows conflicting information and runs only once the person settles it", () => {
    const { s: s0, id, wf } = second();
    // A second, different time for the same event from another page.
    let { s } = run([{ type: "capture", fragment: frag("time", "Sunday 8 PM", undefined, "chat.example"), carry: true }, { type: "approach", target: { kind: "object", id } }, { type: "drop" }, { type: "settled" }], s0);
    const c = viewOf(s, id).conflicts[0]!; expect(c.field).toBe("start");
    ({ s } = run([{ type: "openRecipe", recipeId: wf.id }], s));
    expect(s.run!.steps[0]).toMatchObject({ status: "blocked", reason: expect.stringContaining("not complete") });
    expect(run([{ type: "runRecipe", consent: { kind: "confirm" } }], s).errors).toEqual(["choose at least one step"]);
    ({ s } = run([{ type: "choose", objectId: id, field: "start", ingredientId: c.options[1]!.fragmentId }], s));
    expect(s.run!.steps[0]).toMatchObject({ status: "ready" });
    expect(JSON.stringify(s.run!.steps[0]!.op!.dataMoved)).toMatch(/T20:00/);
  });

  it("names a destination that is not connected here, and never sends to a look-alike", () => {
    const { s: s1, id, wf } = second([OUTLOOK, MAIL]);     // saved for Google Calendar; only Outlook is connected now
    expect(recipeOffers(s1, id).find((o) => o.id === wf.id)).toMatchObject({ available: false, reason: "Google Calendar is not connected here" });
    expect(run([{ type: "openRecipe", recipeId: wf.id }], s1).s.run!.steps[0]).toMatchObject({ status: "blocked", include: false });
  });

  it("does not fit a different kind of object", () => {
    const { s: saved } = savedSingle();
    const wf = saved.workflows![0]!;
    let s = run([{ type: "setWorkflows", items: [wf], known: KNOWN }], { ...initialClumpState({ now: NOW, timezone: "Asia/Kolkata", destinations: [CAL] }), armed: true }).s;
    s = run([{ type: "capture", fragment: frag("place", "Toit", { name: "Toit", address: "1 Road" }) }], s).s;
    expect(recipeOffers(s, "obj-1").some((o) => o.id === wf.id)).toBe(false);
    expect(run([{ type: "openModule", id: "obj-1" }, { type: "openRecipe", recipeId: wf.id }], s).s.run?.steps[0]).toMatchObject({ status: "blocked", reason: expect.stringContaining("this workflow takes an event") });
  });

  it("cancel writes nothing; a failure is reported as such; a lost answer is unknown and never sent again", () => {
    const { s: s1, wf } = second();
    const c = run([{ type: "openRecipe", recipeId: wf.id }, { type: "cancel" }], s1);
    expect(c.effects).toEqual([]); expect(c.s.phase).toBe("composed");
    let { s } = run([{ type: "openRecipe", recipeId: wf.id }, { type: "runRecipe", consent: { kind: "confirm" } }], s1);
    const op = s.run!.steps[0]!.op!;
    const failed = run([{ type: "commitFailed", opId: op.opId, message: "Calendar refused it" }], s);
    expect(failed.s.run!.steps[0]).toMatchObject({ status: "failed", message: "Calendar refused it" }); expect(failed.s.last!.text).toBe("Dinner plan: 0 of 1 done");
    let effects: any[];
    ({ s, effects } = run([{ type: "outcomeUnknown", opId: op.opId, message: "Calendar did not answer" }], s));
    expect(effects).toEqual([]); expect(s.run!.steps[0]!.status).toBe("unknown");
    expect(s.uncertain[s.run!.objectId]).toMatchObject({ destinationId: "cal" });
    // Placing that object there again goes to the check first, never to a second blind write.
    ({ s } = run([{ type: "dismiss" }], s));
    const again = run([{ type: "openModule" }, { type: "openWheel" }, { type: "pickDestination", destinationId: "cal" }], s);
    expect(again.effects.filter((e) => e.type === "commit")).toEqual([]);
  });

  it("a saved workflow cannot be deleted while it runs; settings still apply mid-run", () => {
    const { s: s1, wf } = second();
    const { s } = run([{ type: "openRecipe", recipeId: wf.id }, { type: "runRecipe", consent: { kind: "confirm" } }], s1);
    expect(run([{ type: "deleteWorkflow", id: wf.id }], s).errors[0]).toMatch(/it is running/);
    expect(run([{ type: "setConfirm", level: "none" }], s)).toMatchObject({ errors: [], s: { confirm: "none", phase: "running" } });
  });
});
