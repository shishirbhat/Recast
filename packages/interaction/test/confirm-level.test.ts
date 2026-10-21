// D24: how much Recast asks is the person's choice. "high" (the default) always opens a review; "none" places a
// complete, low-risk, reversible choice at once. Anything riskier, incomplete or uncertain still asks.
import { describe, expect, it } from "vitest";
import { CONTRACTS } from "@recast/bridges";
import type { Fragment } from "@recast/core";
import { initialClumpState, reduceClump, type ClumpEvent, type ClumpInput, type ClumpState, type ConfirmLevel, type DestinationSpec } from "../src/index.js";

const NOW = Date.parse("2026-10-19T09:00:00Z");
let n = 0;
const frag = (kind: Fragment["kind"], text: string, extra: Partial<Fragment> = {}): Fragment => ({ id: `f${++n}`, kind, text, confidence: 0.9, evidence: [{ locator: { kind: "css", value: `#e${n}` }, excerpt: text }], source: { app: "chrome", url: `https://example.com/${kind}` }, ...extra });
const DESTS: DestinationSpec[] = [{ id: "cal", label: "Calendar", contract: CONTRACTS.googleCalendarEvent }, { id: "mail", label: "Mail", contract: CONTRACTS.gmailMessageDraft }];
function run(events: ClumpInput[], start: ClumpState) {
  let s = start; const effects: { type: string; consent?: unknown }[] = []; const errors: string[] = [];
  for (const e of events) { const r = reduceClump(s, { ...e, now: NOW } as ClumpEvent); s = r.state; effects.push(...r.effects); if (r.error) errors.push(r.error); }
  return { s, effects, errors };
}
function dinner(confirm?: ConfirmLevel, title = true) {
  const s0 = initialClumpState({ now: NOW, timezone: "Asia/Kolkata", destinations: DESTS, armed: true, ...(confirm ? { confirm } : {}) });
  return run([
    { type: "capture", fragment: frag("place", "Dakshin", { value: { name: "Dakshin", address: "12 MG Road" } }) },
    { type: "capture", fragment: frag("person", "Maya Rao", { value: { name: "Maya Rao" } }), carry: true },
    { type: "approach", target: { kind: "object", id: "obj-1" } }, { type: "drop" }, { type: "settled" },
    { type: "answer", objectId: "obj-1", field: "start", value: "2026-10-23T19:30" },
    ...(title ? [{ type: "answer", objectId: "obj-1", field: "title", value: "Dinner with Maya" } as ClumpInput] : []),
  ], s0).s;
}
const pick = (s: ClumpState, d = "cal") => run([{ type: "openWheel" }, { type: "pickDestination", destinationId: d }], s);

describe("confirmation level", () => {
  it("high (and unset) opens the review; nothing is written until the person confirms", () => {
    for (const level of [undefined, "high"] as const) {
      const r = pick(dinner(level));
      expect(r.s.phase).toBe("previewing"); expect(r.effects).toHaveLength(0);
    }
  });
  it("none: choosing Calendar places a complete event at once, with a plain release the trust model accepts", () => {
    const r = pick(dinner("none"));
    expect(r.s.phase).toBe("executing");
    expect(r.effects).toEqual([expect.objectContaining({ type: "commit", consent: { kind: "release" }, destinationId: "cal" })]);
    // The receipt keeps Undo: fewer questions, not fewer ways back.
    const op = r.s.placement!.op!;
    const done = run([{ type: "committed", receipt: { receiptId: "rc", opId: op.opId, at: "x", status: "done", objectId: "obj-1", destination: op.proposal.destination.destination, relationId: op.proposal.relationId, effect: op.proposal.effect, reversible: true, bridgeRef: "r" }, undoable: true }], r.s).s;
    expect(done.phase).toBe("succeeded"); expect(done.placement!.undoable).toBe(true);
  });
  it("none still asks when something is missing (no title yet)", () => {
    const r = pick(dinner("none", false));
    expect(r.s.phase).toBe("previewing"); expect(r.effects).toHaveLength(0);
  });
  it("none still asks for anything that notifies someone else or needs a hold (adding an attendee)", () => {
    const attendee: DestinationSpec = { id: "inv", label: "Calendar invite", contract: CONTRACTS.googleCalendar };
    const s0 = initialClumpState({ now: NOW, timezone: "Asia/Kolkata", destinations: [attendee], armed: true, confirm: "none" });
    const s = run([{ type: "capture", fragment: frag("person", "Maya Rao", { value: { name: "Maya Rao", email: "maya@example.com" } }), carry: true }, { type: "approach", target: { kind: "destination", id: "inv" } }, { type: "drop" }], s0);
    expect(s.effects.filter((e) => e.type === "commit")).toHaveLength(0);
  });
  it("none: a reading Recast is unsure of (below 0.75) goes through only when chosen in the module, never on a blind drop", () => {
    const unsure = (confirm: ConfirmLevel) => {
      const s0 = initialClumpState({ now: NOW, timezone: "Asia/Kolkata", destinations: DESTS, armed: true, confirm });
      return run([
        { type: "capture", fragment: frag("place", "Dakshin", { confidence: 0.6, value: { name: "Dakshin", address: "12 MG Road" } }) },
        { type: "capture", fragment: frag("time", "Friday 23 October, 7:30 PM", { confidence: 0.6 }), carry: true },
        { type: "approach", target: { kind: "object", id: "obj-1" } }, { type: "drop" }, { type: "settled" },
        { type: "answer", objectId: "obj-1", field: "title", value: "Table at Dakshin" },
      ], s0).s;
    };
    const viaModule = pick(unsure("none"));
    expect(viaModule.s.placement!.op!.risk.consent).toBe("confirm");
    expect(viaModule.effects).toEqual([expect.objectContaining({ type: "commit", consent: { kind: "confirm" } })]);
    // Dropped straight onto the calendar: not seen in the module, so the review opens.
    const s = unsure("none");
    const drop = run([{ type: "pickUp", id: "obj-1" }, { type: "approach", target: { kind: "destination", id: "cal" } }, { type: "drop" }], s);
    expect(drop.s.phase).toBe("previewing"); expect(drop.effects).toHaveLength(0);
    expect(pick(unsure("high")).s.phase).toBe("previewing");
  });
  it("can be changed at any time, even mid-write, without touching what is in flight", () => {
    const r = pick(dinner("none"));
    const after = reduceClump(r.s, { type: "setConfirm", level: "high", now: NOW });
    expect(after.state.phase).toBe("executing"); expect(after.state.confirm).toBe("high"); expect(after.effects).toHaveLength(0);
    expect(pick(dinner("high")).s.phase).toBe("previewing");
  });
});
