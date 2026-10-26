import { describe, expect, it } from "vitest";
import { compose, readTime, resolve, type Fragment } from "../src/index.js";

// Monday 19 Oct 2026, 09:00 UTC = 14:30 in Bengaluru.
const CTX = { now: "2026-10-19T09:00:00Z", timezone: "Asia/Kolkata" };
let n = 0;
const frag = (kind: Fragment["kind"], text: string, extra: Partial<Fragment> = {}): Fragment => ({
  id: `f${++n}`, kind, text, confidence: 0.9, evidence: [{ locator: { kind: "css", value: `#el${n}` }, excerpt: text }], source: { app: "chrome", url: "https://example.com/invite" }, ...extra,
});

describe("reading times", () => {
  const r = (t: string) => readTime(t, CTX);
  it("absolute dates in common forms", () => {
    expect(r("2026-11-14")).toMatchObject({ date: "2026-11-14", dateOrigin: "extracted" });
    expect(r("Sat, 14 Nov 2026")?.date).toBe("2026-11-14");
    expect(r("November 14th, 2026")?.date).toBe("2026-11-14");
    expect(r("31/12/2026")?.date).toBe("2026-12-31");
  });
  it("dd/mm versus mm/dd is ambiguous when both could be a month, and an impossible date is not a date", () => {
    expect(r("04/05/2026")?.ambiguousDates).toEqual(["2026-05-04", "2026-04-05"]);
    expect(r("2026-02-30")).toBeNull();
  });
  it("times, ranges, noon and zones", () => {
    expect(r("7:30 pm")).toMatchObject({ start: "19:30" });
    expect(r("7pm")).toMatchObject({ start: "19:00" });
    expect(r("19:00-21:30")).toMatchObject({ start: "19:00", end: "21:30" });
    expect(r("7 - 9 pm IST")).toMatchObject({ start: "19:00", end: "21:00", zone: "Asia/Kolkata", zoneText: "IST" });
    expect(r("noon")).toMatchObject({ start: "12:00" });
    expect(r("13pm")).toBeNull();
    expect(r("3pm UTC+05:30")).toMatchObject({ start: "15:00", zone: "+05:30" });
    expect(r("2026-11-14 22:00-01:00")).toMatchObject({ date: "2026-11-14", start: "22:00", end: "01:00" });
    expect(r("2026-11-14 22:00-01:00")?.zone).toBeUndefined();
  });
  it("relative days are inferred from the person's own today, and say so", () => {
    expect(r("tomorrow 6pm")).toMatchObject({ date: "2026-10-20", dateOrigin: "inferred", start: "18:00" });
    expect(r("Friday")).toMatchObject({ date: "2026-10-23", dateOrigin: "inferred", dateNote: '"friday" read as 2026-10-23' });
    expect(r("next monday")).toMatchObject({ date: "2026-10-26" });
    expect(r("Monday")?.date).toBe("2026-10-19");
    expect(r("hello there")).toBeNull();
  });
  it("today is the person's today, not UTC's", () => {
    expect(readTime("today", { now: "2026-10-19T20:00:00Z", timezone: "Asia/Kolkata" })?.date).toBe("2026-10-20");
    expect(readTime("today", { now: "2026-10-19T20:00:00Z", timezone: "America/Los_Angeles" })?.date).toBe("2026-10-19");
  });
});

describe("composed confidence: what the trust model sees", () => {
  it("values the person picked are read with high confidence; an inferred date stays below 0.75 so placing it asks to confirm", async () => {
    const { assessRisk } = await import("../src/index.js");
    const lowPrior = (k: Fragment["kind"], t: string, extra: Partial<Fragment> = {}) => frag(k, t, { confidence: 0.55, ...extra });
    const exact = compose([lowPrior("time", "2026-11-14 7pm"), lowPrior("title", "Dinner")], CTX);
    expect(exact.fields.start!.confidence).toBe(0.9); expect(exact.fields.title!.confidence).toBe(0.9);
    const rel = compose([lowPrior("time", "Friday 7pm"), lowPrior("title", "Dinner")], CTX);
    expect(rel.fields.start!.confidence).toBe(0.6);
    const risk = (c: number) => assessRisk({ baseRisk: "low", flags: [], reversible: true, confidence: c, reliability: "official-api" }).consent;
    expect(risk(Math.min(...Object.values(exact.fields).map((f) => f!.confidence)))).toBe("release");
    expect(risk(Math.min(...Object.values(rel.fields).map((f) => f!.confidence)))).toBe("confirm");
  });
});

describe("composing a time and a place into an event", () => {
  it("the acceptance journey: time + place + title becomes a ready candidate with provenance for every field", () => {
    const when = frag("time", "Sat 14 Nov 2026, 7:30 pm");
    const c = compose([when, frag("place", "Toit", { value: { name: "Toit", address: "298 100 Feet Rd, Bengaluru" } }), frag("title", "Launch dinner")], CTX);
    expect(c.status).toBe("ready");
    expect(c.fields.start).toMatchObject({ value: "2026-11-14T19:30", origin: "extracted" });
    expect(c.fields.location).toMatchObject({ value: "Toit, 298 100 Feet Rd, Bengaluru", origin: "extracted", original: "Toit" });
    expect(c.fields.title).toMatchObject({ value: "Launch dinner", origin: "extracted" });
    expect(c.fields.end).toMatchObject({ value: "2026-11-14T20:30", origin: "default" });
    expect(c.fields.timezone).toMatchObject({ value: "Asia/Kolkata", origin: "default" });
    expect(c.assumptions).toEqual(["Time zone Asia/Kolkata (yours; the source named none)", "Ends after 60 minutes (a default; change it if needed)"]);
    const obj = resolve(c.candidate!);
    expect(obj.type).toBe("Event"); expect(obj.provenance.capture.method).toBe("composition");
    expect(obj.fields.start!.evidence.map((e) => [e.locator.value, e.origin, e.source?.url])).toEqual([[when.evidence[0]!.locator.value, "extracted", "https://example.com/invite"]]);
    expect(obj.fields.end!.evidence[0]).toMatchObject({ locator: { kind: "composition", value: "default:end" }, origin: "default" });
  });
  it("a missing title is asked for, with a suggestion that is not filled in", () => {
    const c = compose([frag("time", "2026-11-14 19:00"), frag("place", "Toit", { value: { name: "Toit" } })], CTX);
    expect(c.status).toBe("incomplete"); expect(c.candidate).toBeNull();
    expect(c.missing).toEqual([{ field: "title", reason: "nothing captured reads as a title", suggestions: ["Meet at Toit"] }]);
    expect(c.fields.title).toBeUndefined();
    const answered = compose(c.fragments, { ...CTX, answers: { title: "Dinner with Meera" } });
    expect(answered.status).toBe("ready"); expect(answered.fields.title).toEqual({ value: "Dinner with Meera", origin: "user", fragments: [], confidence: 1 });
    expect(resolve(answered.candidate!).fields.title!.evidence[0]).toMatchObject({ locator: { kind: "user" }, origin: "user" });
  });
  it("a date and a separate time combine; a time with no date asks for the date", () => {
    expect(compose([frag("time", "14 Nov 2026"), frag("time", "7:30 pm"), frag("title", "Dinner")], CTX).fields.start).toMatchObject({ value: "2026-11-14T19:30", original: "14 Nov 2026 + 7:30 pm" });
    expect(compose([frag("time", "7:30 pm"), frag("title", "Dinner")], CTX).missing).toEqual([{ field: "start", reason: "a time (19:30) was captured but no date" }]);
  });
  it("conflicting times are shown, never silently chosen, and picking one resolves it", () => {
    const a = frag("time", "2026-11-14 7pm"), b = frag("time", "2026-11-15 7pm"), t = frag("title", "Dinner");
    const c = compose([a, b, t], CTX);
    expect(c.status).toBe("incomplete");
    expect(c.conflicts).toEqual([{ field: "start", options: [expect.objectContaining({ value: "2026-11-14", fragmentId: a.id, original: a.text }), expect.objectContaining({ value: "2026-11-15", fragmentId: b.id, original: b.text })] }]);
    expect(c.missing).toEqual([]);   // the conflict is the only thing reported about start
    expect(compose([a, b, t], { ...CTX, choose: { start: b.id } }).fields.start).toMatchObject({ value: "2026-11-15T19:00", origin: "extracted" });
  });
  it("conflicting places conflict; the same place twice merges", () => {
    const p1 = frag("place", "Toit", { value: { name: "Toit" } }), p2 = frag("place", "Toit", { value: { name: "Toit" } }), p3 = frag("place", "Cubbon Park", { value: { name: "Cubbon Park" } });
    expect(compose([frag("time", "2026-11-14 7pm"), frag("title", "X"), p1, p2], CTX).fields.location).toMatchObject({ value: "Toit", fragments: [p1.id, p2.id] });
    expect(compose([frag("time", "2026-11-14 7pm"), frag("title", "X"), p1, p3], CTX).conflicts.map((x) => x.field)).toEqual(["location"]);
  });
  it("a relative date is inferred and stated; a date with no time becomes an all-day event, stated", () => {
    const rel = compose([frag("time", "Friday 6pm"), frag("title", "Standup")], CTX);
    expect(rel.fields.start).toMatchObject({ value: "2026-10-23T18:00", origin: "inferred", note: '"friday" read as 2026-10-23' });
    expect(rel.assumptions[0]).toBe('"friday" read as 2026-10-23');
    const allDay = compose([frag("time", "2026-11-14"), frag("title", "Offsite")], CTX);
    expect(allDay.fields.allDay).toMatchObject({ value: true, origin: "inferred" }); expect(allDay.fields.end).toBeUndefined(); expect(allDay.fields.timezone).toBeUndefined();
    expect(allDay.assumptions).toContain("All day, because no time was captured");
  });
  it("the source's own zone and range win over defaults; overnight ranges end the next day", () => {
    const c = compose([frag("time", "14 Nov 2026, 7 - 9 pm IST"), frag("title", "Launch")], { ...CTX, timezone: "Europe/London" });
    expect(c.fields.timezone).toMatchObject({ value: "Asia/Kolkata", origin: "extracted" }); expect(c.fields.end).toMatchObject({ value: "2026-11-14T21:00", origin: "extracted" });
    expect(c.assumptions).toEqual(['"IST" read as Asia/Kolkata']);
    expect(compose([frag("time", "2026-11-14 22:00-01:00"), frag("title", "Late")], CTX).fields.end).toMatchObject({ value: "2026-11-15T01:00" });
  });
  it("ambiguous numeric dates ask which one", () => {
    const c = compose([frag("time", "04/05/2026 7pm"), frag("title", "Call")], CTX);
    expect(c.missing[0]).toMatchObject({ field: "start", suggestions: ["2026-05-04", "2026-04-05"] });
    expect(compose(c.fragments, { ...CTX, answers: { start: "2026-05-04T19:00" } }).status).toBe("ready");
  });
  it("typed values are checked, not guessed at; an end before the start is refused", () => {
    const base = [frag("time", "2026-11-14 7pm"), frag("title", "X")];
    expect(compose(base, { ...CTX, answers: { start: "next week" } }).missing).toEqual([{ field: "start", reason: "use the form 2026-11-14 or 2026-11-14T19:30" }]);
    expect(compose(base, { ...CTX, answers: { end: "2026-11-14T18:00" } }).missing).toEqual([{ field: "end", reason: "the end is before the start" }]);
  });
  it("the sources are never changed, and the same inputs give the same result", () => {
    const fs = [frag("time", "Friday 6pm"), frag("place", "Toit", { value: { name: "Toit" } }), frag("title", "Standup")];
    const before = JSON.stringify(fs);
    const a = compose(fs, CTX), b = compose(fs, CTX);
    expect(JSON.stringify(fs)).toBe(before); expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(resolve(a.candidate!).id).toBe(resolve(b.candidate!).id);
  });
  it("a captured 'time' that holds no time says so instead of guessing; free text becomes a title only when no title was captured", () => {
    expect(compose([frag("time", "soon-ish")], CTX).missing[0]).toEqual({ field: "start", reason: '"soon-ish" was captured as a time but no date or time could be read from it' });
    expect(compose([frag("text", "Quarterly review"), frag("text", "2026-11-14 10am")], CTX).fields.title?.value).toBe("Quarterly review");
  });
});
