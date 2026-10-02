import type { Operation } from "@recast/core";
import { DestinationError, need, moved, seg, type Send, type Spec } from "./http";

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const str = (v: unknown, what: string): string => { if (typeof v !== "string" || !v) throw new DestinationError(`unexpected response: no ${what}`); return v; };

// ---- Google Calendar (Calendar API v3, events.get / events.patch) --------------------------------
export interface CalendarTarget { calendarId: string; eventId: string }
const GCAL = "https://www.googleapis.com/calendar/v3";
const eventUrl = (t: CalendarTarget) => `${GCAL}/calendars/${seg(t.calendarId)}/events/${seg(t.eventId)}`;

export const googleCalendar: Spec<CalendarTarget> = {
  contract: {
    destination: "google-calendar.event-editor", app: "Google Calendar", targetKind: "Event", reliability: "official-api",
    accepts: [
      { relationId: "person-event-attendee", effect: "Add attendee", effectFlags: ["notifies-third-party"], dataMoved: ["Person.name", "Person.email"] },
      { relationId: "location-event-location", effect: "Set location", dataMoved: ["Location.name", "Location.address"] },
    ],
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
export function rfc822Draft(to: string): string {
  const raw = `To: ${headerSafe(to, "recipient")}\r\nContent-Type: text/plain; charset="UTF-8"\r\n\r\n`;
  const bin = Array.from(new TextEncoder().encode(raw), (b) => String.fromCharCode(b)).join("");
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export const gmailDraft: Spec<GmailTarget> = {
  contract: {
    destination: "gmail.compose-draft", app: "Gmail", targetKind: "Message", reliability: "official-api",
    accepts: [{ relationId: "person-message-recipient", effect: "Create a draft to this person", dataMoved: ["Person.email"] }],
  },
  async execute(op, t, send) {
    const r = asObj(await send({ method: "POST", url: `${GMAIL}/${seg(t.userId ?? "me")}/drafts`, body: { message: { raw: rfc822Draft(need(op, "Person.email")) } } }));
    return JSON.stringify({ id: str(r.id, "draft id") });
  },
  async undo(token, t, send) { await send({ method: "DELETE", url: `${GMAIL}/${seg(t.userId ?? "me")}/drafts/${seg((JSON.parse(token) as { id: string }).id)}` }); },
};

// ---- Google Sheets (Sheets API v4, values.append / values.clear) ---------------------------------
export interface SheetTarget { spreadsheetId: string; range: string }
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
export const googleSheets: Spec<SheetTarget> = {
  contract: {
    destination: "google-sheets.range", app: "Google Sheets", targetKind: "Product", reliability: "official-api",
    accepts: [{ relationId: "product-product-compare", effect: "Add a row", dataMoved: ["Product.name", "Product.url"] }],
  },
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
  contract: {
    destination: "google-tasks.list", app: "Google Tasks", targetKind: "Task", reliability: "official-api",
    accepts: [{ relationId: "document-task-reference", effect: "Add a task", dataMoved: ["Document.title", "Document.url"] }],
  },
  async execute(op, t, send) {
    const r = asObj(await send({ method: "POST", url: `${TASKS}/${seg(t.taskListId)}/tasks`, body: { title: need(op, "Document.title"), ...(moved(op, "Document.url") ? { notes: moved(op, "Document.url") } : {}) } }));
    return JSON.stringify({ id: str(r.id, "task id") });
  },
  async undo(token, t, send) { await send({ method: "DELETE", url: `${TASKS}/${seg(t.taskListId)}/tasks/${seg((JSON.parse(token) as { id: string }).id)}` }); },
};

// ---- Notion (API version 2022-06-28, pages.create / pages.update archived) -----------------------
export interface NotionTarget { databaseId: string; titleProperty?: string; urlProperty?: string }
const NOTION = "https://api.notion.com/v1/pages";
const NOTION_HEADERS = { "Notion-Version": "2022-06-28", "Content-Type": "application/json" };
export const notion: Spec<NotionTarget> = {
  contract: {
    destination: "notion.database", app: "Notion", targetKind: "Project", reliability: "official-api",
    accepts: [{ relationId: "document-project-source", effect: "Add a page", dataMoved: ["Document.title", "Document.url"] }],
  },
  async execute(op, t, send) {
    const properties: Record<string, unknown> = { [t.titleProperty ?? "Name"]: { title: [{ text: { content: need(op, "Document.title") } }] } };
    if (moved(op, "Document.url")) properties[t.urlProperty ?? "URL"] = { url: moved(op, "Document.url") };
    const r = asObj(await send({ method: "POST", url: NOTION, headers: NOTION_HEADERS, body: { parent: { database_id: t.databaseId }, properties } }));
    return JSON.stringify({ id: str(r.id, "page id") });
  },
  async undo(token, _t, send) { await send({ method: "PATCH", url: `${NOTION}/${seg((JSON.parse(token) as { id: string }).id)}`, headers: NOTION_HEADERS, body: { archived: true } }); },
};
