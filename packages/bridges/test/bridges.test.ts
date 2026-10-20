import { describe, expect, it } from "vitest";
import { InMemoryEventLog, commit, plan, propose, resolve, undo, type Candidate, type Receipt, type SemanticObject } from "@recast/core";
import { HttpBridge, DestinationError, rfc822Draft, googleCalendar, googleSheets, googleTasks, gmailDraft, notion, type HttpRequest, type HttpResponse, type Spec, type Transport } from "../src";

const NOW = () => "2026-10-01T10:00:00Z";
function obj(type: Candidate["type"], properties: Record<string, unknown>): SemanticObject {
  return resolve({
    type, properties, fields: Object.fromEntries(Object.keys(properties).map((k) => [k, { confidence: 0.95, evidence: [{ locator: { kind: "css", value: `#${k}` } }] }])),
    provenance: { source: { app: "test" }, capture: { method: "dom", adapter: "test", at: "2026-10-01T09:00:00Z" } },
  });
}
const meera = () => obj("Person", { name: "Meera Iyer", email: ["meera@example.com"] });

/** Records every request and answers like the real API would (shapes follow each API's reference docs). */
function fake(handler: (r: HttpRequest) => HttpResponse) { const calls: HttpRequest[] = []; const t: Transport = async (r) => { calls.push(r); return handler(r); }; return { calls, t }; }
const ok = (json: unknown = {}): HttpResponse => ({ status: 200, json });

/** The real core pipeline: propose -> plan -> commit -> (undo). Only the network is faked. */
async function place<T>(spec: Spec<T>, target: T, t: Transport, object: SemanticObject, relationId: string) {
  const bridge = new HttpBridge(spec, target, t); const log = new InMemoryEventLog();
  const p = propose(object, bridge.describe()).find((x) => x.relationId === relationId)!;
  expect(p.status).toBe("ready");
  const op = plan(p, { now: NOW });
  const receipt = await commit(op, { kind: "hold", heldMs: 700 }, { bridge, log, now: NOW });
  return { receipt, undo: () => undo(receipt, { bridge, log, now: NOW }), log, bridge };
}

describe("every contract passes the real schema and grammar checks", () => {
  for (const [name, spec] of Object.entries({ googleCalendar, gmailDraft, googleSheets, googleTasks, notion })) {
    it(name, () => { expect(() => new HttpBridge(spec as Spec<unknown>, {}, async () => ok()).describe()).not.toThrow(); });
  }
});

describe("Google Calendar", () => {
  const target = { calendarId: "primary", eventId: "ev 1" };
  const server = (event: Record<string, unknown>) => fake((r) => {
    if (r.method === "GET") return ok(event);
    Object.assign(event, r.body); return ok(event);
  });

  it("adds an attendee by sending the existing attendees plus the new one, with no invitation email", async () => {
    const event: Record<string, unknown> = { attendees: [{ email: "a@example.com" }] };
    const s = server(event);
    await place(googleCalendar, target, s.t, meera(), "person-event-attendee");
    expect(s.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://www.googleapis.com/calendar/v3/calendars/primary/events/ev%201",
      "PATCH https://www.googleapis.com/calendar/v3/calendars/primary/events/ev%201?sendUpdates=none",
    ]);
    expect(event.attendees).toEqual([{ email: "a@example.com" }, { email: "meera@example.com", displayName: "Meera Iyer" }]);
  });

  it("undo restores exactly the attendees that were there before", async () => {
    const event: Record<string, unknown> = { attendees: [{ email: "a@example.com" }] };
    const r = await place(googleCalendar, target, server(event).t, meera(), "person-event-attendee");
    await r.undo(); expect(event.attendees).toEqual([{ email: "a@example.com" }]);
  });

  it("an attendee already on the event is not added twice, and undoing that no-op leaves the event alone", async () => {
    const event: Record<string, unknown> = { attendees: [{ email: "meera@example.com" }] }; const s = server(event);
    const r = await place(googleCalendar, target, s.t, meera(), "person-event-attendee");
    await r.undo();
    expect(s.calls.filter((c) => c.method === "PATCH")).toEqual([]);
    expect(event.attendees).toEqual([{ email: "meera@example.com" }]);
  });

  it("sets and restores the location", async () => {
    const event: Record<string, unknown> = { location: "Old room" };
    const r = await place(googleCalendar, target, server(event).t, obj("Location", { name: "Toit", address: "298 100 Feet Rd" }), "location-event-location");
    expect(event.location).toBe("Toit, 298 100 Feet Rd");
    await r.undo(); expect(event.location).toBe("Old room");
  });

  it("a hostile id cannot change which resource is addressed", async () => {
    const s = server({});
    await place(googleCalendar, { calendarId: "primary", eventId: "../../calendarList" }, s.t, meera(), "person-event-attendee");
    expect(s.calls[0]!.url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events/..%2F..%2FcalendarList");
  });

  it("a failing destination fails the placement and nothing is recorded as done", async () => {
    const s = fake(() => ({ status: 403, json: {} }));
    const bridge = new HttpBridge(googleCalendar, target, s.t); const log = new InMemoryEventLog();
    const op = plan(propose(meera(), bridge.describe())[0]!, { now: NOW });
    await expect(commit(op, { kind: "hold", heldMs: 700 }, { bridge, log, now: NOW })).rejects.toThrow(/403/);
    expect((await log.entries()).map((e) => e.kind)).toEqual(["failed"]);
  });
});

describe("Gmail", () => {
  it("creates a draft, never a send, and undo deletes that draft", async () => {
    const s = fake((r) => (r.method === "POST" ? ok({ id: "d/1" }) : ok()));
    const r = await place(gmailDraft, {}, s.t, meera(), "person-message-recipient");
    expect(s.calls[0]).toMatchObject({ method: "POST", url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts" });
    expect(s.calls[0]!.url).not.toMatch(/send/);
    const raw = (s.calls[0]!.body as { message: { raw: string } }).message.raw;
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);                                     // base64url, as the API requires
    expect(atob(raw.replace(/-/g, "+").replace(/_/g, "/"))).toBe('To: meera@example.com\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n');
    await r.undo(); expect(s.calls[1]).toMatchObject({ method: "DELETE", url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts/d%2F1" });
  });

  it("refuses a recipient containing a line break, so a page cannot slip in a Bcc header", () => {
    expect(() => rfc822Draft("a@example.com\r\nBcc: attacker@example.com")).toThrow(DestinationError);
    expect(() => rfc822Draft("a@example.com\nBcc: x")).toThrow(/line break/);
  });
});

describe("Google Sheets", () => {
  const target = { spreadsheetId: "sheet1", range: "Compare!A:B" };
  const product = (name: string) => obj("Product", { name, url: "https://shop.example/p/1" });

  it("appends a row as raw text and undo clears exactly that range", async () => {
    const s = fake((r) => (r.url.includes(":append") ? ok({ updates: { updatedRange: "Compare!A5:B5" } }) : ok()));
    const r = await place(googleSheets, target, s.t, product("Kettle"), "product-product-compare");
    expect(s.calls[0]).toMatchObject({ method: "POST", body: { values: [["Kettle", "https://shop.example/p/1"]] } });
    expect(s.calls[0]!.url).toBe("https://sheets.googleapis.com/v4/spreadsheets/sheet1/values/Compare!A%3AB:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS");
    await r.undo(); expect(s.calls[1]!.url).toBe("https://sheets.googleapis.com/v4/spreadsheets/sheet1/values/Compare!A5%3AB5:clear");
  });

  it("never lets a product name become a spreadsheet formula (RAW, not USER_ENTERED)", async () => {
    const s = fake(() => ok({ updates: { updatedRange: "Compare!A6:B6" } }));
    await place(googleSheets, target, s.t, product('=IMPORTXML("https://evil.example","//x")'), "product-product-compare");
    expect(s.calls[0]!.url).toContain("valueInputOption=RAW"); expect(s.calls[0]!.url).not.toContain("USER_ENTERED");
  });

  it("a response without the written range is an error, not a silent success", async () => {
    await expect(place(googleSheets, target, fake(() => ok({})).t, product("Kettle"), "product-product-compare")).rejects.toThrow(/updatedRange/);
  });
});

describe("Google Tasks", () => {
  it("adds a task with the page address in the notes, and undo deletes it", async () => {
    const s = fake((r) => (r.method === "POST" ? ok({ id: "t1" }) : ok()));
    const r = await place(googleTasks, { taskListId: "@default" }, s.t, obj("Document", { title: "Read the spec", url: "https://example.com/spec" }), "document-task-reference");
    expect(s.calls[0]).toMatchObject({ method: "POST", url: "https://tasks.googleapis.com/tasks/v1/lists/%40default/tasks", body: { title: "Read the spec", notes: "https://example.com/spec" } });
    await r.undo(); expect(s.calls[1]).toMatchObject({ method: "DELETE", url: "https://tasks.googleapis.com/tasks/v1/lists/%40default/tasks/t1" });
  });
});

describe("Notion", () => {
  it("creates a page in the chosen database with the version header, and undo archives it", async () => {
    const s = fake((r) => (r.method === "POST" ? ok({ id: "page-1" }) : ok()));
    const r = await place(notion, { databaseId: "db1" }, s.t, obj("Document", { title: "Read the spec", url: "https://example.com/spec" }), "document-project-source");
    expect(s.calls[0]).toMatchObject({ method: "POST", url: "https://api.notion.com/v1/pages", headers: { "Notion-Version": "2022-06-28" } });
    expect(s.calls[0]!.body).toEqual({ parent: { database_id: "db1" }, properties: { Name: { title: [{ text: { content: "Read the spec" } }] }, URL: { url: "https://example.com/spec" } } });
    await r.undo(); expect(s.calls[1]).toMatchObject({ method: "PATCH", url: "https://api.notion.com/v1/pages/page-1", body: { archived: true } });
  });

  it("uses the database's own title and URL property names when given", async () => {
    const s = fake(() => ok({ id: "p" }));
    await place(notion, { databaseId: "db1", titleProperty: "Title", urlProperty: "Link" }, s.t, obj("Document", { title: "X", url: "https://e.com/" }), "document-project-source");
    expect(Object.keys((s.calls[0]!.body as { properties: object }).properties)).toEqual(["Title", "Link"]);
  });
});

describe("shared behaviour", () => {
  it("undo without a stored reference fails loudly", async () => {
    const b = new HttpBridge(googleTasks, { taskListId: "x" }, async () => ok());
    await expect(b.undo({ receiptId: "r", opId: "o", at: NOW(), status: "done", objectId: "x", destination: "google-tasks.list", relationId: "document-task-reference", effect: "Add a task", reversible: true } as Receipt)).rejects.toThrow(/no reference/);
  });
  it("nothing in this package reaches for the network on its own", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const src = readdirSync(new URL("../src/", import.meta.url)).map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")).join("\n");
    expect(src).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket/);
  });
});
