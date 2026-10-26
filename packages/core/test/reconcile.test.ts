// Context reconciliation: three sources, one conflict. The conflict names its sources; the person's choice is kept with
// what it overruled; the provenance record says where every value came from.
import { describe, expect, it } from "vitest";
import { compose, provenanceOf, readTime, type Fragment } from "../src/index.js";

const NOW = "2026-10-19T09:00:00Z";
let n = 0;
const frag = (kind: Fragment["kind"], text: string, source: Fragment["source"], value?: Fragment["value"]): Fragment => ({ id: `f${++n}`, kind, text, confidence: 0.9, evidence: [{ locator: { kind: "css", value: `#e${n}` }, excerpt: text }], source, ...(value ? { value } : {}) });
const invite = { app: "Mail", title: "Invitation: Design review", url: "mail.example/inbox/inv-1" };
const chat = { app: "Chat", title: "Maya Rao · Chat", url: "chat.example/maya" };
const doc = { app: "Docs", title: "Design review · planning", url: "docs.example/review-plan" };
const pieces = () => [
  frag("title", "Design review", invite), frag("time", "Thursday 3:00 PM", invite),
  frag("time", "Thursday 4:00 PM", chat),
  frag("place", "Dakshin", doc, { name: "Dakshin", address: "12 MG Road, Bengaluru" }),
];

describe("context reconciliation", () => {
  it("two sources disagree on the time: Recast shows both with their sources and composes nothing", () => {
    const c = compose(pieces(), { now: NOW, timezone: "Asia/Kolkata" });
    expect(c.status).toBe("incomplete"); expect(c.candidate).toBeNull();
    const start = c.conflicts.find((x) => x.field === "start")!;
    expect(start.options.map((o) => [o.original, o.source?.title])).toEqual([["Thursday 3:00 PM", "Invitation: Design review"], ["Thursday 4:00 PM", "Maya Rao · Chat"]]);
  });
  it("the person picks the chat's time: the event is ready, and the record keeps what was overruled and every source", () => {
    const ps = pieces(); const chatTime = ps[2]!;
    const c = compose(ps, { now: NOW, timezone: "Asia/Kolkata", choose: { start: chatTime.id } });
    expect(c.status).toBe("ready"); expect(c.fields.start!.value).toBe("2026-10-22T16:00");
    expect(c.resolutions).toEqual([{ field: "start", chosen: expect.objectContaining({ original: "Thursday 4:00 PM", source: chat }), overruled: [expect.objectContaining({ original: "Thursday 3:00 PM", source: invite })] }]);
    const p = provenanceOf(c);
    const row = (f: string) => p.fields.find((x) => x.field === f)!;
    expect(row("title")).toMatchObject({ value: "Design review", origin: "extracted", sources: [invite], overruled: [] });
    // Both say Thursday (so both are sources for the start); only the hour differed, and the invite's hour was overruled.
    // "Thursday" is a weekday read against today, so the start is Recast's reading, not quoted text.
    expect(row("start")).toMatchObject({ origin: "inferred", sources: [invite, chat], overruled: [expect.objectContaining({ original: "Thursday 3:00 PM", source: invite })] });
    expect(row("location").sources).toEqual([doc]);
    expect(row("end")).toMatchObject({ origin: "default", sources: [] });          // a default names no source
    expect(row("timezone")).toMatchObject({ origin: "default", sources: [] });
    expect(p.sources).toEqual([invite, chat, doc]);
  });
  it("sources that agree are both credited, and nothing is called a resolution", () => {
    const a = frag("time", "Thursday 4:00 PM", chat), b = frag("time", "Thu 4 PM", invite), t = frag("title", "Design review", invite);
    const c = compose([t, a, b], { now: NOW, timezone: "Asia/Kolkata" });
    expect(c.status).toBe("ready"); expect(c.resolutions).toEqual([]);
    expect(provenanceOf(c).fields.find((x) => x.field === "start")!.sources).toEqual([chat, invite]);
  });
});

describe("a day and a month with no year are kept as written", () => {
  const ctx = { now: "2026-10-26T09:00:00Z", timezone: "Asia/Kolkata" };   // a Monday
  it("'Friday 23 October' is 23 October (its weekday matches 2026), not the next Friday, even three days later", () => {
    expect(readTime("Friday 23 October, 7:30 PM", ctx)).toMatchObject({ date: "2026-10-23", start: "19:30", dateOrigin: "inferred", dateNote: '"friday 23 october" read as 2026-10-23 (no year was given)' });
    expect(readTime("Oct 23, 7:30 PM", ctx)).toMatchObject({ date: "2026-10-23" });
  });
  it("the weekday picks the year when it can; a weekday that fits neither year is said, never silently fixed", () => {
    expect(readTime("Saturday 23 October", ctx)).toMatchObject({ date: "2027-10-23" });   // 23 Oct 2027 is a Saturday
    expect(readTime("Monday 23 October", ctx)!.dateNote).toBe('"monday 23 october": 2026-10-23 is a friday, not a monday; check the date');
  });
  it("without a weekday: this year, unless that is more than six months past", () => {
    expect(readTime("5 January", ctx)!.date).toBe("2027-01-05");
    expect(readTime("1 September", ctx)!.date).toBe("2026-09-01");
    expect(readTime("30 February", ctx)).toBeNull();
  });
});
