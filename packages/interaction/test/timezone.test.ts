// The person's time zone is where they are now. After a change (travel, a system setting), new readings use the new zone;
// a placement already planned or in flight keeps the zone it was reviewed in, so nothing changes under a confirmation.
import { describe, expect, it } from "vitest";
import { CONTRACTS } from "@recast/bridges";
import type { Fragment } from "@recast/core";
import { initialClumpState, reduceClump, viewOf, type ClumpEvent, type ClumpInput, type ClumpState, type DestinationSpec } from "../src/index.js";

const NOW = Date.parse("2026-10-19T09:00:00Z");
let n = 0;
const frag = (kind: Fragment["kind"], text: string, extra: Partial<Fragment> = {}): Fragment => ({ id: `f${++n}`, kind, text, confidence: 0.9, evidence: [{ locator: { kind: "css", value: `#e${n}` }, excerpt: text }], source: { app: "chrome", url: `https://example.com/${kind}` }, ...extra });
const DESTS: DestinationSpec[] = [{ id: "cal", label: "Calendar", contract: CONTRACTS.googleCalendarEvent }];
function run(events: ClumpInput[], start: ClumpState) {
  let s = start; const errors: string[] = [];
  for (const e of events) { const r = reduceClump(s, { ...e, now: NOW } as ClumpEvent); s = r.state; if (r.error) errors.push(r.error); }
  return { s, errors };
}
const dinner = () => run([
  { type: "capture", fragment: frag("place", "Dakshin", { value: { name: "Dakshin" } }) },
  { type: "capture", fragment: frag("time", "Friday 7:30 PM"), carry: true },
  { type: "approach", target: { kind: "object", id: "obj-1" } }, { type: "drop" }, { type: "settled" },
  { type: "answer", objectId: "obj-1", field: "title", value: "Dinner" },
], initialClumpState({ now: NOW, timezone: "Asia/Kolkata", destinations: DESTS, armed: true })).s;

describe("the time zone follows the person", () => {
  it("a new zone is taken in any phase, and later readings use it", () => {
    const before = dinner();
    expect(viewOf(before, "obj-1").event!.fields.timezone?.value).toBe("Asia/Kolkata");
    const { s, errors } = run([{ type: "setTimezone", timezone: "Europe/Lisbon" }], before);
    expect(errors).toEqual([]);
    expect(s.timezone).toBe("Europe/Lisbon");
    expect(s.phase).toBe(before.phase);
    expect(viewOf(s, "obj-1").event!.fields.timezone?.value).toBe("Europe/Lisbon");
  });
  it("a placement already reviewed keeps the zone it was reviewed in; nothing in flight changes", () => {
    const reviewing = run([{ type: "openWheel" }, { type: "pickDestination", destinationId: "cal" }], dinner()).s;
    const op = reviewing.placement!.op!;
    const moved = run([{ type: "setTimezone", timezone: "Europe/Lisbon" }], reviewing).s;
    expect(moved.placement!.op).toEqual(op);
    const placing = run([{ type: "place", consent: { kind: "confirm" } }], reviewing).s;
    expect(run([{ type: "setTimezone", timezone: "Europe/Lisbon" }], placing).s.placement).toEqual(placing.placement);
  });
  it("the same zone again changes nothing; a name that is not a time zone is refused", () => {
    const s = dinner();
    expect(run([{ type: "setTimezone", timezone: "Asia/Kolkata" }], s).s).toEqual({ ...s, now: NOW });
    const bad = run([{ type: "setTimezone", timezone: "Not/AZone" }], s);
    expect(bad.errors).toEqual(["not a time zone: Not/AZone"]); expect(bad.s.timezone).toBe("Asia/Kolkata");
  });
});
