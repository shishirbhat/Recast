// Outlook Calendar through Microsoft Graph. MOCKED PROVIDER: a Graph stand-in that keeps events the way Graph does
// (Graph assigns ids; Recast's key is an extended property; deleted events are gone; times come back in the Prefer zone).
// The real run is docs/REAL_TEST_PLAN.md section M.
import { describe, expect, it } from "vitest";
import { InMemoryEventLog, OutcomeUnknownError, commit, plan, propose, resolve, undo, type SemanticObject } from "@recast/core";
import { DuplicateError, HttpBridge, OUTLOOK_KEY_PROP, outlookCalendarEvent, type HttpRequest, type HttpResponse, type Transport } from "../src";

const NOW = () => "2026-10-26T09:00:00Z";
const event = (props: Record<string, unknown> = {}): SemanticObject => {
  const properties = { title: "Design review", start: "2026-10-29T16:00", end: "2026-10-29T17:00", timezone: "Asia/Kolkata", location: "Dakshin, 12 MG Road, Bengaluru", ...props };
  return resolve({ type: "Event", properties, fields: Object.fromEntries(Object.keys(properties).map((k) => [k, { confidence: 0.9, evidence: [{ locator: { kind: "css", value: `#${k}` } }] }])), provenance: { source: { app: "t" }, capture: { method: "composition", adapter: "compose", at: "2026-10-26T08:00:00Z" } } });
};
function graph(o: { loseAnswerOnce?: boolean } = {}) {
  const events = new Map<string, Record<string, any>>(); const calls: HttpRequest[] = []; let lose = o.loseAnswerOnce ?? false; let n = 0;
  const res = (status: number, json: unknown = {}): HttpResponse => ({ status, json });
  const t: Transport = async (r) => {
    calls.push(r); const u = new URL(r.url);
    if (r.method === "GET" && u.pathname === "/v1.0/me/events") {
      const f = u.searchParams.get("$filter") ?? ""; const key = /ep\/value eq '([^']+)'/.exec(f)?.[1];
      expect(f).toContain(OUTLOOK_KEY_PROP);
      return res(200, { value: [...events.values()].filter((e) => e.singleValueExtendedProperties?.[0]?.value === key).map((e) => ({ id: e.id, isCancelled: false })) });
    }
    if (r.method === "POST") {
      const b = r.body as Record<string, any>;
      if ([...events.values()].some((e) => e.transactionId === b.transactionId)) return res(201, [...events.values()].find((e) => e.transactionId === b.transactionId));   // Graph drops a retry
      const id = `AAMk${++n}`; events.set(id, { ...b, id, webLink: `https://outlook.office365.com/owa/?itemid=${id}` });
      if (lose) { lose = false; return res(504); }
      return res(201, events.get(id));
    }
    const id = decodeURIComponent(u.pathname.split("/events/")[1] ?? "");
    if (r.method === "GET") { const e = events.get(id); if (!e) return res(404); expect(r.headers?.Prefer).toBe(`outlook.timezone="Asia/Kolkata"`); return res(200, e); }
    if (r.method === "DELETE") { if (!events.delete(id)) return res(404); return res(204, null); }
    return res(400);
  };
  return { t, calls, events };
}
async function placeIn(o: SemanticObject, t: Transport) {
  const bridge = new HttpBridge(outlookCalendarEvent, {}, t); const log = new InMemoryEventLog();
  const p = propose(o, bridge.describe())[0]!; expect(p.status).toBe("ready");
  const op = plan(p, { now: NOW });
  return { bridge, log, op, run: () => commit(op, { kind: "release" }, { bridge, log, now: NOW }) };
}

describe("Outlook Calendar", () => {
  it("creates the event with its times in the event's zone, Recast's key and a transactionId; reads it back with its link; Undo deletes it", async () => {
    const g = graph(); const { run, bridge, log, op } = await placeIn(event(), g.t);
    const receipt = await run();
    const post = g.calls.find((c) => c.method === "POST")!;
    expect(post).toMatchObject({ url: "https://graph.microsoft.com/v1.0/me/events", body: { subject: "Design review", start: { dateTime: "2026-10-29T16:00:00", timeZone: "Asia/Kolkata" }, end: { dateTime: "2026-10-29T17:00:00", timeZone: "Asia/Kolkata" }, isAllDay: false, location: { displayName: "Dakshin, 12 MG Road, Bengaluru" } } });
    const key = (post.body as any).transactionId; expect(key).toMatch(/^rc[a-z0-9]+$/); expect((post.body as any).singleValueExtendedProperties).toEqual([{ id: OUTLOOK_KEY_PROP, value: key }]);
    const v = await bridge.verify(receipt, op);
    expect(v).toMatchObject({ ok: true, link: "https://outlook.office365.com/owa/?itemid=AAMk1" });
    expect(v.fields.map((f) => [f.path, f.match])).toEqual([["Event.title", true], ["Event.start", true], ["Event.end", true], ["Event.timezone", true], ["Event.location", true]]);
    // Edited in Outlook: the read-back names the field.
    g.events.get("AAMk1")!.subject = "Design review (moved)";
    expect((await bridge.verify(receipt, op)).fields.find((f) => f.path === "Event.title")).toMatchObject({ actual: "Design review (moved)", match: false });
    await undo(receipt, { bridge, log, now: NOW });
    expect(g.events.size).toBe(0);
    expect(await bridge.verify(receipt, op)).toMatchObject({ ok: false, note: "the event is not in the calendar" });
  });
  it("placing the same event again is a duplicate, found by Recast's key before anything is written", async () => {
    const g = graph(); const o = event();
    await (await placeIn(o, g.t)).run();
    await expect((await placeIn(o, g.t)).run()).rejects.toBeInstanceOf(DuplicateError);
    expect(g.events.size).toBe(1); expect(g.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
  it("a lost answer is unknown; the check finds the event by key; nothing is written twice", async () => {
    const g = graph({ loseAnswerOnce: true }); const p = await placeIn(event(), g.t);
    const err = await p.run().catch((e) => e); expect(err).toBeInstanceOf(OutcomeUnknownError);
    expect(await p.bridge.reconcile(err.reconcileRef)).toBe("present");
    expect(g.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(await p.bridge.reconcile(JSON.stringify({ key: "rcnothere" }))).toBe("absent");
  });
  it("an all-day event runs midnight to midnight the next day; a timed event without an end is refused before sending", async () => {
    const g = graph();
    await (await placeIn(event({ start: "2026-10-29", end: undefined, allDay: true, timezone: undefined }), g.t)).run();
    expect(g.calls.find((c) => c.method === "POST")!.body).toMatchObject({ isAllDay: true, start: { dateTime: "2026-10-29T00:00:00" }, end: { dateTime: "2026-10-30T00:00:00" } });
    expect(outlookCalendarEvent.check!({ dataMoved: [{ path: "Event.start", value: "2026-10-29T16:00" }] } as never)).toEqual(["Event.end"]);
  });
});
