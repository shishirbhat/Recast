import { hash32, OutcomeUnknownError, type Operation, type OperationCapabilities } from "@recast/core";
import { CONTRACTS } from "./contracts";
import { DestinationError, DuplicateError, need, moved, seg, type Send, type Spec } from "./http";

/** A write that cannot be repeated safely and cannot be read back: an unknown outcome stays unknown until the person checks. */
const unkeyedCreate = (permission: string, reversal: OperationCapabilities["reversal"]): OperationCapabilities => ({ writes: true, idempotency: "none", verifiable: false, reversal, onTimeout: "outcome-unknown", permission });

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const str = (v: unknown, what: string): string => { if (typeof v !== "string" || !v) throw new DestinationError(`unexpected response: no ${what}`); return v; };

// ---- Google Calendar (Calendar API v3, events.get / events.patch) --------------------------------
export interface CalendarTarget { calendarId: string; eventId: string }
const GCAL = "https://www.googleapis.com/calendar/v3";
const eventUrl = (t: CalendarTarget) => `${GCAL}/calendars/${seg(t.calendarId)}/events/${seg(t.eventId)}`;

export const googleCalendar: Spec<CalendarTarget> = {
  contract: CONTRACTS.googleCalendar,
  // PATCH sets a value: repeating the same request gives the same result, and the event can be read back.
  capabilities: {
    "person-event-attendee": { writes: true, idempotency: "not-applicable", verifiable: true, reversal: "restore-previous", onTimeout: "safe-to-retry", permission: "calendar.events" },
    "location-event-location": { writes: true, idempotency: "not-applicable", verifiable: true, reversal: "restore-previous", onTimeout: "safe-to-retry", permission: "calendar.events" },
  },
  async execute(op: Operation, t: CalendarTarget, send: Send) {
    const cur = asObj(await send({ method: "GET", url: eventUrl(t) }));
    if (op.proposal.relationId === "person-event-attendee") {
      const email = need(op, "Person.email"); const before = Array.isArray(cur.attendees) ? cur.attendees : [];
      if (before.some((a) => asObj(a).email === email)) return JSON.stringify({ kind: "attendee", noop: true });
      // events.patch replaces the whole attendees array, so we send the existing ones plus the new one.
      // sendUpdates=none: Recast never emails the invitee on its own; the user's calendar decides.
      await send({ method: "PATCH", url: `${eventUrl(t)}?sendUpdates=none`, body: { attendees: [...before, { email, ...(moved(op, "Person.name") ? { displayName: moved(op, "Person.name") } : {}) }] } });
      return JSON.stringify({ kind: "attendee", before });
    }
    const location = [moved(op, "Location.name"), moved(op, "Location.address")].filter(Boolean).join(", ");
    if (!location) throw new DestinationError("missing Location.name or Location.address");
    const before = typeof cur.location === "string" ? cur.location : "";   // read before writing: undo must restore this
    await send({ method: "PATCH", url: eventUrl(t), body: { location } });
    return JSON.stringify({ kind: "location", before });
  },
  async undo(token, t, send) {
    const u = JSON.parse(token) as { kind: string; noop?: boolean; before?: unknown };
    if (u.noop) return;
    await send({ method: "PATCH", url: u.kind === "attendee" ? `${eventUrl(t)}?sendUpdates=none` : eventUrl(t), body: u.kind === "attendee" ? { attendees: u.before } : { location: u.before } });
  },
};

// ---- Gmail (Gmail API v1, users.drafts.create / users.drafts.delete). A draft, never a send. -----
export interface GmailTarget { userId?: string }
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users";
/** CR or LF in a header value would let a page-supplied string add headers (e.g. Bcc). Reject, don't strip. */
export function headerSafe(v: string, what: string): string {
  if (/[\r\n\0]/.test(v)) throw new DestinationError(`${what} contains a line break`); return v;
}
export function rfc822Draft(to: string, body = ""): string {
  // The body follows the blank line, so it cannot add headers; it is sent as written.
  const raw = `To: ${headerSafe(to, "recipient")}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n${body}`;
  const bin = Array.from(new TextEncoder().encode(raw), (b) => String.fromCharCode(b)).join("");
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export const gmailDraft: Spec<GmailTarget> = {
  contract: CONTRACTS.gmailDraft,
  capabilities: { "person-message-recipient": unkeyedCreate("gmail.compose", "delete-created") },
  async execute(op, t, send) {
    const r = asObj(await send({ method: "POST", url: `${GMAIL}/${seg(t.userId ?? "me")}/drafts`, body: { message: { raw: rfc822Draft(need(op, "Person.email")) } } }));
    return JSON.stringify({ id: str(r.id, "draft id") });
  },
  async undo(token, t, send) { await send({ method: "DELETE", url: `${GMAIL}/${seg(t.userId ?? "me")}/drafts/${seg((JSON.parse(token) as { id: string }).id)}` }); },
};

/** A composed message (a person and what to say) saved as a draft: To and the text. Still a draft, never a send. */
export const gmailMessageDraft: Spec<GmailTarget> = {
  contract: CONTRACTS.gmailMessageDraft,
  capabilities: { "message-draft-entry": unkeyedCreate("gmail.compose", "delete-created") },
  async execute(op, t, send) {
    const r = asObj(await send({ method: "POST", url: `${GMAIL}/${seg(t.userId ?? "me")}/drafts`, body: { message: { raw: rfc822Draft(need(op, "Message.to"), need(op, "Message.snippet")) } } }));
    return JSON.stringify({ id: str(r.id, "draft id") });
  },
  undo: (token, t, send) => gmailDraft.undo(token, t, send),
};

// ---- Google Sheets (Sheets API v4, values.append / values.clear) ---------------------------------
export interface SheetTarget { spreadsheetId: string; range: string }
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
export const googleSheets: Spec<SheetTarget> = {
  contract: CONTRACTS.googleSheets,
  capabilities: { "product-product-compare": unkeyedCreate("spreadsheets", "delete-created") },
  async execute(op, t, send) {
    const row = [need(op, "Product.name"), moved(op, "Product.url") ?? ""];
    // RAW, not USER_ENTERED: a product called "=IMPORTXML(...)" must land as text, never as a formula.
    const r = asObj(await send({ method: "POST", url: `${SHEETS}/${seg(t.spreadsheetId)}/values/${seg(t.range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, body: { values: [row] } }));
    return JSON.stringify({ range: str(asObj(r.updates).updatedRange, "updatedRange") });
  },
  async undo(token, t, send) {
    await send({ method: "POST", url: `${SHEETS}/${seg(t.spreadsheetId)}/values/${seg((JSON.parse(token) as { range: string }).range)}:clear`, body: {} });
  },
};

// ---- Google Tasks (Tasks API v1, tasks.insert / tasks.delete) ------------------------------------
export interface TasksTarget { taskListId: string }
const TASKS = "https://tasks.googleapis.com/tasks/v1/lists";
export const googleTasks: Spec<TasksTarget> = {
  contract: CONTRACTS.googleTasks,
  capabilities: { "document-task-reference": unkeyedCreate("tasks", "delete-created") },
  async execute(op, t, send) {
    const r = asObj(await send({ method: "POST", url: `${TASKS}/${seg(t.taskListId)}/tasks`, body: { title: need(op, "Document.title"), ...(moved(op, "Document.url") ? { notes: moved(op, "Document.url") } : {}) } }));
    return JSON.stringify({ id: str(r.id, "task id") });
  },
  async undo(token, t, send) { await send({ method: "DELETE", url: `${TASKS}/${seg(t.taskListId)}/tasks/${seg((JSON.parse(token) as { id: string }).id)}` }); },
};

// A whole task, with its due date. Google keeps only the date of `due` (the time part is discarded), so it is sent as
// midnight UTC of that day: the date the person saw is the date Google shows.
export const googleTasksEntry: Spec<TasksTarget> = {
  contract: CONTRACTS.googleTasksEntry,
  capabilities: { "task-tasklist-entry": unkeyedCreate("tasks", "delete-created") },
  async execute(op, t, send) {
    const url = moved(op, "Task.url"), due = moved(op, "Task.due");
    const r = asObj(await send({ method: "POST", url: `${TASKS}/${seg(t.taskListId)}/tasks`, body: { title: need(op, "Task.title"), ...(url ? { notes: url } : {}), ...(due ? { due: `${String(due).slice(0, 10)}T00:00:00.000Z` } : {}) } }));
    return JSON.stringify({ id: str(r.id, "task id") });
  },
  undo: googleTasks.undo,
};

// ---- Google Docs (Docs API v1 documents.create + batchUpdate; Drive API v3 files.update to trash) --------------------
// Scope: drive.file, the narrowest: Recast can see and change only the documents it created, nothing else in Drive.
export type DocsTarget = Record<string, never>;
const DOCS = "https://docs.googleapis.com/v1/documents";
const DRIVE = "https://www.googleapis.com/drive/v3/files";
const trash = (id: string, send: Send) => send({ method: "PATCH", url: `${DRIVE}/${seg(id)}`, body: { trashed: true } });
export const googleDocs: Spec<DocsTarget> = {
  contract: CONTRACTS.googleDocs,
  // Undo trashes (the person can restore it from the Drive trash): "archive". Google's document id is Google's, so a lost
  // answer cannot be checked exactly: unknown stays unknown until the person looks.
  capabilities: { "note-docs-entry": unkeyedCreate("drive.file", "archive") },
  async execute(op, _t, send) {
    const r = asObj(await send({ method: "POST", url: DOCS, body: { title: need(op, "Note.title") } }));
    const id = str(r.documentId, "documentId"); const token = JSON.stringify({ id });
    // The text goes in as plain text (insertText), never as markup: a passage cannot add links, styles or anything else.
    try { await send({ method: "POST", url: `${DOCS}/${seg(id)}:batchUpdate`, body: { requests: [{ insertText: { location: { index: 1 }, text: need(op, "Note.body") } }] } }); }
    catch (e) {
      if (e instanceof OutcomeUnknownError) throw new OutcomeUnknownError(`${e.message}; the document was created, its text may be missing`, token);
      // An empty document is not what the person reviewed: take it back out, then report the failure.
      try { await trash(id, send); } catch { throw new DestinationError("the document was created but its text could not be added, and it could not be removed: look in Google Drive"); }
      throw e;
    }
    return token;
  },
  async undo(token, _t, send) { await trash((JSON.parse(token) as { id: string }).id, send); },
};

// ---- Notion (API version 2022-06-28, pages.create / pages.update archived) -----------------------
export interface NotionTarget { databaseId: string; titleProperty?: string; urlProperty?: string }
const NOTION = "https://api.notion.com/v1/pages";
const NOTION_HEADERS = { "Notion-Version": "2022-06-28", "Content-Type": "application/json" };
export const notion: Spec<NotionTarget> = {
  contract: CONTRACTS.notion,
  capabilities: { "document-project-source": unkeyedCreate("insert_content", "archive") },
  async execute(op, t, send) {
    const properties: Record<string, unknown> = { [t.titleProperty ?? "Name"]: { title: [{ text: { content: need(op, "Document.title") } }] } };
    if (moved(op, "Document.url")) properties[t.urlProperty ?? "URL"] = { url: moved(op, "Document.url") };
    const r = asObj(await send({ method: "POST", url: NOTION, headers: NOTION_HEADERS, body: { parent: { database_id: t.databaseId }, properties } }));
    return JSON.stringify({ id: str(r.id, "page id") });
  },
  async undo(token, _t, send) { await send({ method: "PATCH", url: `${NOTION}/${seg((JSON.parse(token) as { id: string }).id)}`, headers: NOTION_HEADERS, body: { archived: true } }); },
};

// ---- Google Calendar, new event (Calendar API v3, events.insert with a client-chosen id / events.get / events.delete) ----
export interface CalendarListTarget { calendarId: string }

/**
 * The event id is derived from the object's content id and the calendar, so:
 * - a retry of the same placement is a no-op (Google answers 409 for an id that exists), never a duplicate;
 * - placing the identical event in the same calendar again is detected as a duplicate and reported, not created;
 * - after a timeout the event can be looked up by id (reconciliation) instead of being sent again.
 * Google event ids use base32hex (0-9, a-v), 5 to 1024 characters; "rc" + 32 hex characters fits.
 * Invitations: composed events carry no attendees, so sendUpdates=none; nobody is emailed.
 */
export const calendarEventId = (objectId: string, calendarId: string) => `rc${hash32(`${objectId}|${calendarId}`)}`;

function eventBody(op: Operation, id: string) {
  const start = need(op, "Event.start"); const end = moved(op, "Event.end"); const tz = moved(op, "Event.timezone");
  const allDay = moved(op, "Event.allDay") === "true" || !start.includes("T");
  const when = (v: string) => allDay ? { date: v.slice(0, 10) } : { dateTime: v.length === 16 ? `${v}:00` : v, ...(tz ? { timeZone: tz } : {}) };
  const nextDay = (d: string) => { const t = new Date(`${d.slice(0, 10)}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };
  if (!allDay && !end) throw new DestinationError("missing Event.end");
  return {
    id, summary: need(op, "Event.title"),
    start: when(start), end: allDay ? { date: end ? end.slice(0, 10) : nextDay(start) } : when(end!),
    ...(moved(op, "Event.location") ? { location: moved(op, "Event.location") } : {}),
  };
}

export const googleCalendarEvent: Spec<CalendarListTarget> = {
  contract: CONTRACTS.googleCalendarEvent,
  capabilities: { "event-calendar-entry": { writes: true, idempotency: "provider-key", verifiable: true, reversal: "delete-created", onTimeout: "safe-to-retry", permission: "calendar.events" } },
  // A timed event needs an end; Recast does not invent one here (composition offers a visible default instead).
  check: (op) => { const start = moved(op, "Event.start") ?? ""; const allDay = moved(op, "Event.allDay") === "true" || !start.includes("T"); return !allDay && !moved(op, "Event.end") ? ["Event.end"] : []; },
  async execute(op, t, send) {
    const id = calendarEventId(op.proposal.object.id, t.calendarId);
    const token = JSON.stringify({ id });
    const url = `${GCAL}/calendars/${seg(t.calendarId)}/events`;
    try {
      await send({ method: "POST", url: `${url}?sendUpdates=none`, body: eventBody(op, id) });
      return token;
    } catch (e) {
      if (e instanceof OutcomeUnknownError) throw new OutcomeUnknownError(e.message, token);
      if (!(e instanceof DestinationError) || e.status !== 409) throw e;
      // The id exists: the same event was placed before. If it was since deleted, restore it; otherwise it is a duplicate.
      const cur = (await send({ method: "GET", url: `${url}/${seg(id)}` })) as { status?: string } | null;
      if (cur?.status === "cancelled") { await send({ method: "PUT", url: `${url}/${seg(id)}?sendUpdates=none`, body: { ...eventBody(op, id), status: "confirmed" } }); return token; }
      throw new DuplicateError("this event is already in that calendar", token);
    }
  },
  async undo(token, t, send) {
    await send({ method: "DELETE", url: `${GCAL}/calendars/${seg(t.calendarId)}/events/${seg((JSON.parse(token) as { id: string }).id)}?sendUpdates=none` });
  },
  async reconcile(token, t, send) {
    try {
      const cur = (await send({ method: "GET", url: `${GCAL}/calendars/${seg(t.calendarId)}/events/${seg((JSON.parse(token) as { id: string }).id)}` })) as { status?: string } | null;
      return cur && cur.status !== "cancelled" ? "present" : "absent";
    } catch (e) { if (e instanceof DestinationError && (e.status === 404 || e.status === 410)) return "absent"; throw e; }
  },
};
