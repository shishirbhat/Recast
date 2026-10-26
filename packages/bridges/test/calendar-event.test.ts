import { describe, expect, it } from "vitest";
import { commit, InMemoryEventLog, OutcomeUnknownError, plan, propose, resolve, undo, type Candidate, type SemanticObject } from "@recast/core";
import { calendarEventId, DuplicateError, googleCalendar, googleCalendarEvent, googleSheets, googleTasks, googleTasksEntry, gmailDraft, gmailMessageDraft, HttpBridge, notion, type HttpRequest, type HttpResponse, type Spec, type Transport } from "../src";

const NOW = () => "2026-10-19T10:00:00Z";
const event = (props: Record<string, unknown> = {}): SemanticObject => {
  const properties = { title: "Launch dinner", start: "2026-11-14T19:30", end: "2026-11-14T20:30", timezone: "Asia/Kolkata", location: "Toit, Bengaluru", ...props };
  return resolve({ type: "Event", properties, fields: Object.fromEntries(Object.keys(properties).map((k) => [k, { confidence: 0.9, evidence: [{ locator: { kind: "css", value: `#${k}` } }] }])), provenance: { source: { app: "t" }, capture: { method: "composition", adapter: "compose", at: "2026-10-19T09:00:00Z" } } });
};

/** A stand-in for the Calendar API that keeps events by id, the way the real one does (409 on an existing id, cancelled on delete). */
function fakeCalendar(opts: { timeoutOnce?: boolean } = {}) {
  const events = new Map<string, Record<string, unknown>>(); const calls: HttpRequest[] = []; let timeout = opts.timeoutOnce ?? false;
  const t: Transport = async (r) => {
    calls.push(r);
    const id = decodeURIComponent(r.url.split("/events/")[1]?.split("?")[0] ?? "");
    const res = (status: number, json: unknown = {}): HttpResponse => ({ status, json });
    if (r.method === "POST") {
      const body = r.body as { id: string };
      if (events.has(body.id)) return res(409, { error: { message: "The requested identifier already exists." } });
      events.set(body.id, { ...body, status: "confirmed" });
      if (timeout) { timeout = false; return res(504); }   // the write landed, the answer did not
      return res(200, events.get(body.id));
    }
    if (r.method === "GET") return events.has(id) ? res(200, events.get(id)) : res(404);
    if (r.method === "PUT") { events.set(id, r.body as Record<string, unknown>); return res(200, r.body); }
    if (r.method === "DELETE") { if (!events.has(id)) return res(410); events.set(id, { ...events.get(id)!, status: "cancelled" }); return res(204, null); }
    return res(400);
  };
  return { t, calls, events };
}
async function placeEvent(o: SemanticObject, t: Transport, calendarId = "primary") {
  const bridge = new HttpBridge(googleCalendarEvent, { calendarId }, t); const log = new InMemoryEventLog();
  const p = propose(o, bridge.describe())[0]!; expect(p.status).toBe("ready");
  const op = plan(p, { now: NOW });
  return { bridge, log, op, run: () => commit(op, { kind: "release" }, { bridge, log, now: NOW }) };
}

describe("every bridge declares what its operations do", () => {
  for (const [name, spec] of Object.entries({ googleCalendar, googleCalendarEvent, gmailDraft, gmailMessageDraft, googleSheets, googleTasks, googleTasksEntry, notion }) as [string, Spec<unknown>][]) {
    it(name, () => {
      for (const a of spec.contract.accepts) {
        const c = spec.capabilities[a.relationId];
        expect(c, `${name} ${a.relationId}`).toBeDefined();
        if (c!.idempotency === "none") expect(c!.onTimeout).toBe("outcome-unknown");   // an unkeyed write is never "safe to retry"
        if (c!.onTimeout === "safe-to-retry") expect(c!.idempotency === "provider-key" || c!.idempotency === "not-applicable").toBe(true);
      }
    });
  }
});

describe("Google Calendar: creating an event", () => {
  it("inserts with a stable client id, no notifications, the right times, and undo deletes it", async () => {
    const g = fakeCalendar(); const o = event(); const { run, bridge, log } = await placeEvent(o, g.t);
    const receipt = await run();
    const id = calendarEventId(o.id, "primary");
    expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(g.calls[0]).toMatchObject({ method: "POST", url: "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none",
      body: { id, summary: "Launch dinner", start: { dateTime: "2026-11-14T19:30:00", timeZone: "Asia/Kolkata" }, end: { dateTime: "2026-11-14T20:30:00", timeZone: "Asia/Kolkata" }, location: "Toit, Bengaluru" } });
    expect(bridge.capabilities("event-calendar-entry")).toMatchObject({ idempotency: "provider-key", reversal: "delete-created" });
    await undo(receipt, { bridge, log, now: NOW });
    expect(g.calls.at(-1)).toMatchObject({ method: "DELETE" }); expect(g.events.get(id)?.status).toBe("cancelled");
  });
  it("all-day events use dates, with an exclusive end the day after", async () => {
    const g = fakeCalendar(); const { run } = await placeEvent(event({ start: "2026-11-14", end: undefined, allDay: true, timezone: undefined }), g.t);
    await run();
    expect(g.calls[0]!.body).toMatchObject({ start: { date: "2026-11-14" }, end: { date: "2026-11-15" } });
  });
  it("placing the identical event in the same calendar again is a duplicate: reported, nothing new created", async () => {
    const g = fakeCalendar(); const o = event();
    await (await placeEvent(o, g.t)).run();
    await expect((await placeEvent(o, g.t)).run()).rejects.toBeInstanceOf(DuplicateError);
    expect(g.events.size).toBe(1);
    await (await placeEvent(o, g.t, "work@group.calendar.google.com")).run();   // another calendar is a different place
    expect(g.events.size).toBe(2);
  });
  it("an event that was placed, then deleted, is restored rather than refused", async () => {
    const g = fakeCalendar(); const o = event();
    const first = await placeEvent(o, g.t); const r = await first.run(); await undo(r, { bridge: first.bridge, log: first.log, now: NOW });
    await (await placeEvent(o, g.t)).run();
    expect(g.events.get(calendarEventId(o.id, "primary"))?.status).toBe("confirmed");
    expect(g.calls.map((c) => c.method)).toEqual(["POST", "DELETE", "POST", "GET", "PUT"]);
  });
  it("a timeout after sending is an unknown outcome; reconciliation finds the event; a retry with the same id cannot duplicate", async () => {
    const g = fakeCalendar({ timeoutOnce: true }); const o = event();
    const { run, bridge, log } = await placeEvent(o, g.t);
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(OutcomeUnknownError);
    expect((await log.entries())[0]).toMatchObject({ kind: "unknown", reconcileRef: JSON.stringify({ id: calendarEventId(o.id, "primary") }) });
    expect(await bridge.reconcile(err.reconcileRef)).toBe("present");
    await expect((await placeEvent(o, g.t)).run()).rejects.toBeInstanceOf(DuplicateError);
    expect(g.events.size).toBe(1);
    expect(await bridge.reconcile(JSON.stringify({ id: "rcnothere000" }))).toBe("absent");
  });
});

describe("Google Calendar: verifying a placement by reading it back", () => {
  it("every moved field is read back and compared; a later edit or a deletion is reported, never assumed", async () => {
    const g = fakeCalendar(); const o = event(); const { run, bridge, op } = await placeEvent(o, g.t);
    const receipt = await run();
    const v = await bridge.verify(receipt, op);
    expect(v.ok).toBe(true);
    expect(v.fields.map((f) => [f.path, f.match])).toEqual([["Event.title", true], ["Event.start", true], ["Event.end", true], ["Event.timezone", true], ["Event.location", true]]);
    // Google answers with an offset; the local time and zone still match.
    const id = calendarEventId(o.id, "primary"); const ev = g.events.get(id)!;
    g.events.set(id, { ...ev, start: { dateTime: "2026-11-14T19:30:00+05:30", timeZone: "Asia/Kolkata" } });
    expect((await bridge.verify(receipt, op)).ok).toBe(true);
    // The calendar's own link to the event comes back with it; anything but https is dropped.
    g.events.set(id, { ...g.events.get(id)!, htmlLink: "https://www.google.com/calendar/event?eid=abc" });
    expect((await bridge.verify(receipt, op)).link).toBe("https://www.google.com/calendar/event?eid=abc");
    g.events.set(id, { ...g.events.get(id)!, htmlLink: "javascript:alert(1)" });
    expect((await bridge.verify(receipt, op)).link).toBeUndefined();
    // Someone edits the title in the calendar: the check says which field differs and what it now holds.
    g.events.set(id, { ...g.events.get(id)!, summary: "Dinner (moved?)" });
    const edited = await bridge.verify(receipt, op);
    expect(edited.ok).toBe(false);
    expect(edited.fields.find((f) => f.path === "Event.title")).toEqual({ path: "Event.title", expected: "Launch dinner", actual: "Dinner (moved?)", match: false });
    // Deleted: not there, every field unmatched.
    g.events.set(id, { ...g.events.get(id)!, status: "cancelled" });
    const gone = await bridge.verify(receipt, op);
    expect(gone).toMatchObject({ ok: false, note: "the event is not in the calendar" });
    expect(g.calls.filter((c) => c.method !== "GET")).toHaveLength(1);   // checking never writes
  });
  it("a destination with no read-back says it was not checked", async () => {
    const b = new HttpBridge(gmailMessageDraft, {}, async () => ({ status: 200, json: {} }));
    const v = await b.verify({ receiptId: "r", opId: "o", at: "x", status: "done", objectId: "x", destination: "gmail.drafts", relationId: "message-draft-entry", effect: "", reversible: true, bridgeRef: "{}" }, {} as never);
    expect(v).toMatchObject({ ok: false, fields: [], note: "Gmail cannot be read back, so this was not checked" });
  });
});

describe("a connection failure during a write", () => {
  it("is an unknown outcome (checked, never resent); a failed read stays an error", async () => {
    let fail = true; const g = fakeCalendar();
    const t: Transport = async (r) => { if (fail) throw new TypeError("fetch failed"); return g.t(r); };
    const { run } = await placeEvent(event(), t);
    await expect(run()).rejects.toBeInstanceOf(OutcomeUnknownError);
    const b = new HttpBridge(googleCalendarEvent, { calendarId: "primary" }, t);
    await expect(b.reconcile(JSON.stringify({ id: "x" }))).rejects.toBeInstanceOf(TypeError);
    fail = false; expect(await b.reconcile(JSON.stringify({ id: "x" }))).toBe("absent");
  });
});
