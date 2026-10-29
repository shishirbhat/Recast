import { hash32, OutcomeUnknownError, type Operation, type OperationCapabilities } from "@recast/core";
import { CONTRACTS } from "./contracts";
import { DestinationError, DuplicateError, need, moved, seg, type Send, type Spec } from "./http";

/** A write that cannot be repeated safely and cannot be read back: an unknown outcome stays unknown until the person checks. */
const unkeyedCreate = (permission: string, reversal: OperationCapabilities["reversal"], o: { readBack?: boolean } = {}): OperationCapabilities => ({ writes: true, idempotency: "none", verifiable: !!o.readBack, reversal, onTimeout: "outcome-unknown", permission });

// ---- reading a placement back (Verify) -----------------------------------------------------------------------------
/** The item, or null when the provider says it is not there (404, 410). Any other refusal is an error, never "absent". */
async function readBack(send: Send, req: Parameters<Send>[0]): Promise<Record<string, unknown> | null> {
  try { return asObj(await send(req)); } catch (e) { if (e instanceof DestinationError && (e.status === 404 || e.status === 410)) return null; throw e; }
}
/** Compare what the provider now holds with what was moved, field by field. `gone` means it is not (or no longer) there. */
function compared(op: Operation, actual: Record<string, string | null> | null, gone: string, link?: unknown) {
  const fields = Object.keys(actual ?? Object.fromEntries(op.dataMoved.map((d) => [d.path, null]))).map((path) => {
    const expected = moved(op, path) ?? ""; const a = actual ? actual[path] ?? null : null;
    return { path, expected, actual: a, match: a !== null && a === expected };
  });
  const href = typeof link === "string" && /^https:\/\//.test(link) ? link : undefined;
  if (!actual) return { ok: false, fields, note: gone };
  return { ok: fields.every((f) => f.match), fields, ...(href ? { link: href } : {}) };
}
/** A draft's raw message, decoded: its To header and its text. */
function parseRaw(raw: string): { to: string | null; body: string | null } {
  const bin = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
  const text = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  const cut = text.search(/\r?\n\r?\n/); const head = cut < 0 ? text : text.slice(0, cut);
  const to = /^to:\s*(.*)$/im.exec(head)?.[1]?.trim() ?? null;
  return { to, body: cut < 0 ? null : text.slice(cut).replace(/^\r?\n\r?\n/, "") };
}

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
  capabilities: { "person-message-recipient": unkeyedCreate("gmail.compose", "delete-created", { readBack: true }) },
  async execute(op, t, send) {
    const r = asObj(await send({ method: "POST", url: `${GMAIL}/${seg(t.userId ?? "me")}/drafts`, body: { message: { raw: rfc822Draft(need(op, "Person.email")) } } }));
    return JSON.stringify({ id: str(r.id, "draft id") });
  },
  async undo(token, t, send) { await send({ method: "DELETE", url: `${GMAIL}/${seg(t.userId ?? "me")}/drafts/${seg((JSON.parse(token) as { id: string }).id)}` }); },
  verify: (token, op, t, send) => verifyDraft(token, op, t, send, { "Person.email": "to" }),
};
/** Read a draft back (drafts.get, raw) and compare its To and text. The link is the Drafts folder: Gmail has no stable address for one draft. */
async function verifyDraft(token: string, op: Operation, t: GmailTarget, send: Send, map: Record<string, "to" | "body">) {
  const d = await readBack(send, { method: "GET", url: `${GMAIL}/${seg(t.userId ?? "me")}/drafts/${seg((JSON.parse(token) as { id: string }).id)}?format=raw` });
  const raw = d ? asObj(d.message).raw : undefined;
  const parsed = typeof raw === "string" ? parseRaw(raw) : null;
  return compared(op, parsed ? Object.fromEntries(Object.entries(map).map(([path, k]) => [path, parsed[k]])) : null, "the draft is not in Gmail", "https://mail.google.com/mail/u/0/#drafts");
}

/** A composed message (a person and what to say) saved as a draft: To and the text. Still a draft, never a send. */
export const gmailMessageDraft: Spec<GmailTarget> = {
  contract: CONTRACTS.gmailMessageDraft,
  capabilities: { "message-draft-entry": unkeyedCreate("gmail.compose", "delete-created", { readBack: true }) },
  async execute(op, t, send) {
    const r = asObj(await send({ method: "POST", url: `${GMAIL}/${seg(t.userId ?? "me")}/drafts`, body: { message: { raw: rfc822Draft(need(op, "Message.to"), need(op, "Message.snippet")) } } }));
    return JSON.stringify({ id: str(r.id, "draft id") });
  },
  undo: (token, t, send) => gmailDraft.undo(token, t, send),
  verify: (token, op, t, send) => verifyDraft(token, op, t, send, { "Message.to": "to", "Message.snippet": "body" }),
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
  capabilities: { "document-task-reference": unkeyedCreate("tasks", "delete-created", { readBack: true }) },
  async execute(op, t, send) {
    const r = asObj(await send({ method: "POST", url: `${TASKS}/${seg(t.taskListId)}/tasks`, body: { title: need(op, "Document.title"), ...(moved(op, "Document.url") ? { notes: moved(op, "Document.url") } : {}) } }));
    return JSON.stringify({ id: str(r.id, "task id") });
  },
  async undo(token, t, send) { await send({ method: "DELETE", url: `${TASKS}/${seg(t.taskListId)}/tasks/${seg((JSON.parse(token) as { id: string }).id)}` }); },
  verify: (token, op, t, send) => verifyTask(token, op, t, send, { "Document.title": "title", "Document.url": "notes" }),
};
/** Read a task back (tasks.get). A deleted task still answers, marked deleted: that is "not there". */
async function verifyTask(token: string, op: Operation, t: TasksTarget, send: Send, map: Record<string, "title" | "notes" | "due">) {
  const k = await readBack(send, { method: "GET", url: `${TASKS}/${seg(t.taskListId)}/tasks/${seg((JSON.parse(token) as { id: string }).id)}` });
  const there = k && k.deleted !== true;
  const value = (key: "title" | "notes" | "due") => { const v = k?.[key]; return typeof v !== "string" ? null : key === "due" ? v.slice(0, 10) : v; };
  const paths = Object.keys(map).filter((p) => moved(op, p) !== undefined);
  return compared(op, there ? Object.fromEntries(paths.map((p) => [p, map[p] === "due" ? value("due") : value(map[p]!)])) : null, "the task is not in Google Tasks", k?.webViewLink);
}

// A whole task, with its due date. Google keeps only the date of `due` (the time part is discarded), so it is sent as
// midnight UTC of that day: the date the person saw is the date Google shows.
export const googleTasksEntry: Spec<TasksTarget> = {
  contract: CONTRACTS.googleTasksEntry,
  capabilities: { "task-tasklist-entry": unkeyedCreate("tasks", "delete-created", { readBack: true }) },
  async execute(op, t, send) {
    const url = moved(op, "Task.url"), due = moved(op, "Task.due");
    const r = asObj(await send({ method: "POST", url: `${TASKS}/${seg(t.taskListId)}/tasks`, body: { title: need(op, "Task.title"), ...(url ? { notes: url } : {}), ...(due ? { due: `${String(due).slice(0, 10)}T00:00:00.000Z` } : {}) } }));
    return JSON.stringify({ id: str(r.id, "task id") });
  },
  undo: googleTasks.undo,
  // Google keeps only the date of `due`, so the date is what is compared.
  verify: async (token, op, t, send) => {
    const r = await verifyTask(token, op, t, send, { "Task.title": "title", "Task.url": "notes", "Task.due": "due" });
    return { ...r, fields: r.fields.map((f) => f.path === "Task.due" ? { ...f, expected: f.expected.slice(0, 10), match: f.actual === f.expected.slice(0, 10) } : f), ok: r.fields.every((f) => f.path === "Task.due" ? f.actual === f.expected.slice(0, 10) : f.match) && !r.note };
  },
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
  capabilities: { "note-docs-entry": unkeyedCreate("drive.file", "archive", { readBack: true }) },
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
  // Read the document back (documents.get) and compare its title and its text; a trashed one is not there.
  async verify(token, op, _t, send) {
    const id = (JSON.parse(token) as { id: string }).id;
    const d = await readBack(send, { method: "GET", url: `${DOCS}/${seg(id)}` });
    const meta = d ? await readBack(send, { method: "GET", url: `${DRIVE}/${seg(id)}?fields=trashed` }) : null;
    const text = d ? (asObj(d.body).content as unknown[] | undefined ?? []).flatMap((c) => (asObj(asObj(c).paragraph).elements as unknown[] | undefined ?? []).map((e) => String(asObj(asObj(e).textRun).content ?? ""))).join("") : "";
    const there = d && meta?.trashed !== true;
    return compared(op, there ? { "Note.title": typeof d!.title === "string" ? d!.title : null, "Note.body": text.replace(/\n$/, "") } : null, "the document is not in Google Drive", `https://docs.google.com/document/d/${encodeURIComponent(id)}/edit`);
  },
};

// ---- GitHub (REST API 2022-11-28: issues.create / issues.update to close) ---------------------------------------------
// Token: a fine-grained personal access token limited to one repository, with Issues: read and write, nothing else.
export interface GithubTarget { owner: string; repo: string }
const GITHUB_HEADERS = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
const issuesUrl = (t: GithubTarget) => `https://api.github.com/repos/${seg(t.owner)}/${seg(t.repo)}/issues`;
export const githubIssue: Spec<GithubTarget> = {
  contract: CONTRACTS.githubIssue,
  // Closing is the reversal GitHub allows (deleting needs admin rights). The issue number is GitHub's: a lost answer
  // cannot be checked exactly, so it stays unknown until the person looks.
  capabilities: { "issue-tracker-entry": unkeyedCreate("issues:write", "archive", { readBack: true }) },
  async execute(op, t, send) {
    const r = asObj(await send({ method: "POST", url: issuesUrl(t), headers: GITHUB_HEADERS, body: { title: need(op, "Issue.title"), body: need(op, "Issue.body") } }));
    if (typeof r.number !== "number") throw new DestinationError("unexpected response: no issue number");
    return JSON.stringify({ number: r.number, ...(typeof r.html_url === "string" ? { url: r.html_url } : {}) });
  },
  async undo(token, t, send) {
    await send({ method: "PATCH", url: `${issuesUrl(t)}/${(JSON.parse(token) as { number: number }).number}`, headers: GITHUB_HEADERS, body: { state: "closed", state_reason: "not_planned" } });
  },
  // Read the issue back; a closed one (Undo's reversal) is not "placed as planned".
  async verify(token, op, t, send) {
    const i = await readBack(send, { method: "GET", url: `${issuesUrl(t)}/${(JSON.parse(token) as { number: number }).number}`, headers: GITHUB_HEADERS });
    const open = i && i.state === "open";
    return compared(op, open ? { "Issue.title": typeof i!.title === "string" ? i!.title : null, "Issue.body": typeof i!.body === "string" ? i!.body : null } : null, i ? "the issue is closed" : "the issue is not in the repository", i?.html_url);
  },
};

// ---- Linear (GraphQL: issueCreate / issueDelete) -----------------------------------------------------------------------
// Values travel as GraphQL variables, never inside the query text. GraphQL reports failures in the body with HTTP 200,
// so `errors` (or success: false) is a failure, never a success.
export interface LinearTarget { teamId: string }
const LINEAR = "https://api.linear.app/graphql";
async function gql(send: Send, query: string, variables: Record<string, unknown>) {
  const r = asObj(await send({ method: "POST", url: LINEAR, body: { query, variables } }));
  if (Array.isArray(r.errors) && r.errors.length) throw new DestinationError(`Linear refused it: ${String(asObj(r.errors[0]).message ?? "error")}`);
  return asObj(r.data);
}
export const linearIssue: Spec<LinearTarget> = {
  contract: CONTRACTS.linearIssue,
  capabilities: { "issue-tracker-entry": unkeyedCreate("issues:create", "delete-created", { readBack: true }) },
  async execute(op, t, send) {
    const d = asObj((await gql(send, "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }",
      { input: { teamId: t.teamId, title: need(op, "Issue.title"), description: need(op, "Issue.body") } })).issueCreate);
    const issue = asObj(d.issue);
    if (d.success !== true) throw new DestinationError("Linear did not create the issue");
    return JSON.stringify({ id: str(issue.id, "issue id"), ...(typeof issue.identifier === "string" ? { identifier: issue.identifier } : {}) });
  },
  async undo(token, _t, send) {
    const d = asObj((await gql(send, "mutation($id: String!) { issueDelete(id: $id) { success } }", { id: (JSON.parse(token) as { id: string }).id })).issueDelete);
    if (d.success !== true) throw new DestinationError("Linear did not delete the issue");
  },
  async verify(token, op, _t, send) {
    const i = asObj((await gql(send, "query($id: String!) { issue(id: $id) { title description url archivedAt trashed } }", { id: (JSON.parse(token) as { id: string }).id })).issue);
    const there = typeof i.title === "string" && !i.archivedAt && i.trashed !== true;
    return compared(op, there ? { "Issue.title": i.title as string, "Issue.body": typeof i.description === "string" ? i.description : null } : null, "the issue is not in Linear", i.url);
  },
};

// ---- Todoist (API v1: POST /tasks, GET /tasks/{id}, DELETE /tasks/{id}) --------------------------------------------------
// Todoist chooses the task id, so a lost answer cannot be looked up exactly: it stays unknown until the person looks.
// The page's link goes in the description; the due date is a plain date (YYYY-MM-DD), as the person saw it.
export interface TodoistTarget { projectId?: string }
const TODOIST = "https://api.todoist.com/api/v1/tasks";
const todoistLink = (id: string) => `https://app.todoist.com/app/task/${seg(id)}`;
async function todoistCreate(t: TodoistTarget, body: Record<string, unknown>, send: Send) {
  const r = asObj(await send({ method: "POST", url: TODOIST, body: { ...body, ...(t.projectId ? { project_id: t.projectId } : {}) } }));
  return JSON.stringify({ id: str(r.id, "task id") });
}
async function verifyTodoist(token: string, op: Operation, send: Send, map: Record<string, "content" | "description" | "due">) {
  const id = (JSON.parse(token) as { id: string }).id;
  const k = await readBack(send, { method: "GET", url: `${TODOIST}/${seg(id)}` });
  // A completed or deleted task is no longer the task Recast added.
  const there = k && k.is_deleted !== true && k.checked !== true;
  const due = (k?.due && typeof k.due === "object" ? (k.due as Record<string, unknown>).date : null);
  const value = (key: "content" | "description" | "due") => key === "due" ? (typeof due === "string" ? due.slice(0, 10) : null) : typeof k?.[key] === "string" ? (k[key] as string) : null;
  const paths = Object.keys(map).filter((p) => moved(op, p) !== undefined);
  return compared(op, there ? Object.fromEntries(paths.map((p) => [p, value(map[p]!)])) : null, "the task is not in Todoist", todoistLink(id));
}
export const todoistTask: Spec<TodoistTarget> = {
  contract: CONTRACTS.todoistTask,
  capabilities: { "document-task-reference": unkeyedCreate("data:read_write", "delete-created", { readBack: true }) },
  execute: (op, t, send) => todoistCreate(t, { content: need(op, "Document.title"), ...(moved(op, "Document.url") ? { description: moved(op, "Document.url") } : {}) }, send),
  async undo(token, _t, send) { await send({ method: "DELETE", url: `${TODOIST}/${seg((JSON.parse(token) as { id: string }).id)}` }); },
  verify: (token, op, _t, send) => verifyTodoist(token, op, send, { "Document.title": "content", "Document.url": "description" }),
};
export const todoistEntry: Spec<TodoistTarget> = {
  contract: CONTRACTS.todoistEntry,
  capabilities: { "task-tasklist-entry": unkeyedCreate("data:read_write", "delete-created", { readBack: true }) },
  execute(op, t, send) {
    const url = moved(op, "Task.url"), due = moved(op, "Task.due");
    return todoistCreate(t, { content: need(op, "Task.title"), ...(url ? { description: url } : {}), ...(due ? { due_date: String(due).slice(0, 10) } : {}) }, send);
  },
  undo: todoistTask.undo,
  async verify(token, op, _t, send) {
    const r = await verifyTodoist(token, op, send, { "Task.title": "content", "Task.url": "description", "Task.due": "due" });
    const fields = r.fields.map((f) => f.path === "Task.due" ? { ...f, expected: f.expected.slice(0, 10), match: f.actual === f.expected.slice(0, 10) } : f);
    return { ...r, fields, ok: !r.note && fields.every((f) => f.match) };
  },
};

// ---- Notion (API version 2022-06-28, pages.create / pages.update archived) -----------------------
/** `urlProperty: false`: the database has no link column, so the link goes in the page's text instead. */
export interface NotionTarget { databaseId: string; titleProperty?: string; urlProperty?: string | false }
const NOTION = "https://api.notion.com/v1/pages";
const NOTION_HEADERS = { "Notion-Version": "2022-06-28", "Content-Type": "application/json" };
export const notion: Spec<NotionTarget> = {
  contract: CONTRACTS.notion,
  capabilities: { "document-project-source": unkeyedCreate("insert_content", "archive", { readBack: true }) },
  async execute(op, t, send) {
    const properties: Record<string, unknown> = { [t.titleProperty ?? "Name"]: { title: [{ text: { content: need(op, "Document.title") } }] } };
    const url = moved(op, "Document.url");
    if (url && t.urlProperty !== false) properties[t.urlProperty ?? "URL"] = { url };
    const children = url && t.urlProperty === false ? [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: url, link: { url } } }] } }] : undefined;
    const r = asObj(await send({ method: "POST", url: NOTION, headers: NOTION_HEADERS, body: { parent: { database_id: t.databaseId }, properties, ...(children ? { children } : {}) } }));
    return JSON.stringify({ id: str(r.id, "page id") });
  },
  async undo(token, _t, send) { await send({ method: "PATCH", url: `${NOTION}/${seg((JSON.parse(token) as { id: string }).id)}`, headers: NOTION_HEADERS, body: { archived: true } }); },
  // Read the page back: its title (all of the title's text runs) and its link property. An archived page is not there.
  async verify(token, op, t, send) {
    const pg = await readBack(send, { method: "GET", url: `${NOTION}/${seg((JSON.parse(token) as { id: string }).id)}`, headers: NOTION_HEADERS });
    const props = asObj(pg?.properties);
    const title = asObj(props[t.titleProperty ?? "Name"]).title;
    const text = Array.isArray(title) ? title.map((r) => String(asObj(r).plain_text ?? asObj(asObj(r).text).content ?? "")).join("") : null;
    // Without a link column the link is in the page's text: the title is what can be compared.
    const link = moved(op, "Document.url") !== undefined && t.urlProperty !== false ? (typeof asObj(props[t.urlProperty ?? "URL"]).url === "string" ? asObj(props[t.urlProperty ?? "URL"]).url as string : null) : undefined;
    const there = pg && pg.archived !== true && pg.in_trash !== true;
    const r = compared(op, there ? { "Document.title": text, ...(link !== undefined ? { "Document.url": link } : {}) } : null, "the page is not in Notion", pg?.url);
    return there ? { ...r, fields: r.fields.filter((f) => f.path === "Document.title" || link !== undefined) } : r;
  },
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
  // Read the event back and compare each moved field with what was sent. Google returns times with an offset
  // ("2026-10-22T16:00:00+05:30") and its own time zone field, so the local time and the zone are compared separately.
  async verify(token, op, t, send) {
    const id = (JSON.parse(token) as { id: string }).id;
    let cur: { status?: string; summary?: string; location?: string; htmlLink?: string; start?: { dateTime?: string; date?: string; timeZone?: string }; end?: { dateTime?: string; date?: string; timeZone?: string } } | null;
    try { cur = (await send({ method: "GET", url: `${GCAL}/calendars/${seg(t.calendarId)}/events/${seg(id)}` })) as typeof cur; }
    catch (e) { if (e instanceof DestinationError && (e.status === 404 || e.status === 410)) cur = null; else throw e; }
    const want = eventBody(op, id);
    const local = (w?: { dateTime?: string; date?: string }) => (w?.date ?? w?.dateTime?.slice(0, 19) ?? null);
    const rows: { path: string; expected: string; actual: string | null }[] = [
      { path: "Event.title", expected: want.summary, actual: cur?.summary ?? null },
      { path: "Event.start", expected: local(want.start)!, actual: local(cur?.start) },
      { path: "Event.end", expected: local(want.end)!, actual: local(cur?.end) },
    ];
    const tz = (want.start as { timeZone?: string }).timeZone; if (tz) rows.push({ path: "Event.timezone", expected: tz, actual: cur?.start?.timeZone ?? null });
    if (want.location) rows.push({ path: "Event.location", expected: want.location, actual: cur?.location ?? null });
    const fields = rows.map((r) => ({ ...r, match: r.actual === r.expected }));
    if (!cur || cur.status === "cancelled") return { ok: false, fields: fields.map((f) => ({ ...f, actual: null, match: false })), note: "the event is not in the calendar" };
    const link = typeof cur.htmlLink === "string" && /^https:\/\//.test(cur.htmlLink) ? cur.htmlLink : undefined;
    return { ok: fields.every((f) => f.match), fields, ...(link ? { link } : {}) };
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

// ---- Outlook Calendar (Microsoft Graph v1.0: POST /me/events, GET, DELETE) -------------------------------------------
// Graph chooses the event id, so Recast also writes its own key on the event (a single-value extended property) and sends
// the same key as transactionId (Graph drops a retried create with the same transactionId). With the key Recast can tell
// a duplicate before writing, and after a lost answer find the event by key instead of writing again.
export interface OutlookTarget { /** Absent: the person's default calendar. */ calendarId?: string }
const GRAPH = "https://graph.microsoft.com/v1.0";
/** Recast's own property set on Outlook events (a fixed GUID, so every Recast install reads the same property). */
export const OUTLOOK_KEY_PROP = "String {4f0f6e3c-2b1d-4c8e-9a7b-5d2e8c1f7a90} Name RecastKey";
const outlookEvents = (t: OutlookTarget) => t.calendarId ? `${GRAPH}/me/calendars/${seg(t.calendarId)}/events` : `${GRAPH}/me/events`;
export const outlookEventKey = (objectId: string, t: OutlookTarget) => `rc${hash32(`${objectId}|outlook|${t.calendarId ?? "default"}`)}`;
function outlookBody(op: Operation, key: string) {
  const start = need(op, "Event.start"); const end = moved(op, "Event.end"); const tz = moved(op, "Event.timezone") ?? "UTC";
  const allDay = moved(op, "Event.allDay") === "true" || !start.includes("T");
  if (!allDay && !end) throw new DestinationError("missing Event.end");
  const nextDay = (d: string) => { const x = new Date(`${d.slice(0, 10)}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
  // Graph takes a local date-time and a zone name (IANA names are accepted); an all-day event runs midnight to midnight.
  const at = (v: string) => ({ dateTime: allDay ? `${v.slice(0, 10)}T00:00:00` : v.length === 16 ? `${v}:00` : v.slice(0, 19), timeZone: tz });
  return {
    subject: need(op, "Event.title"), start: at(start), end: at(allDay ? (end ? end.slice(0, 10) : nextDay(start)) : end!), isAllDay: allDay,
    ...(moved(op, "Event.location") ? { location: { displayName: moved(op, "Event.location") } } : {}),
    transactionId: key, singleValueExtendedProperties: [{ id: OUTLOOK_KEY_PROP, value: key }],
  };
}
async function outlookFind(key: string, t: OutlookTarget, send: Send): Promise<Record<string, unknown> | null> {
  const filter = `singleValueExtendedProperties/Any(ep: ep/id eq '${OUTLOOK_KEY_PROP}' and ep/value eq '${key}')`;
  const r = asObj(await send({ method: "GET", url: `${outlookEvents(t)}?$filter=${encodeURIComponent(filter)}&$select=id,isCancelled` }));
  const found = (Array.isArray(r.value) ? r.value : []).map(asObj).find((e) => e.isCancelled !== true);
  return found ?? null;
}
/** The event's Graph id: kept in the token, or (after a lost answer, when only the key is known) found by Recast's key. */
async function outlookIdOf(token: string, t: OutlookTarget, send: Send): Promise<string | null> {
  const k = JSON.parse(token) as { id?: string; key: string };
  if (k.id) return k.id;
  const found = await outlookFind(k.key, t, send);
  return found ? str(found.id, "event id") : null;
}
export const outlookCalendarEvent: Spec<OutlookTarget> = {
  contract: CONTRACTS.outlookCalendarEvent,
  capabilities: { "event-calendar-entry": { writes: true, idempotency: "provider-key", verifiable: true, reversal: "delete-created", onTimeout: "safe-to-retry", permission: "Calendars.ReadWrite" } },
  check: (op) => { const start = moved(op, "Event.start") ?? ""; const allDay = moved(op, "Event.allDay") === "true" || !start.includes("T"); return !allDay && !moved(op, "Event.end") ? ["Event.end"] : []; },
  async execute(op, t, send) {
    const key = outlookEventKey(op.proposal.object.id, t);
    // The same event already there (placed before, not deleted): a duplicate, reported, never written twice.
    const existing = await outlookFind(key, t, send);
    if (existing) throw new DuplicateError("this event is already in that calendar", JSON.stringify({ key, id: str(existing.id, "event id") }));
    try {
      const r = asObj(await send({ method: "POST", url: outlookEvents(t), body: outlookBody(op, key) }));
      return JSON.stringify({ key, id: str(r.id, "event id") });
    } catch (e) {
      if (e instanceof OutcomeUnknownError) throw new OutcomeUnknownError(e.message, JSON.stringify({ key }));
      throw e;
    }
  },
  async undo(token, t, send) {
    const id = await outlookIdOf(token, t, send);
    if (!id) throw new DestinationError("the event is not in the calendar");
    await send({ method: "DELETE", url: `${GRAPH}/me/events/${seg(id)}` });
  },
  async reconcile(token, t, send) {
    const { key } = JSON.parse(token) as { key: string };
    return (await outlookFind(key, t, send)) ? "present" : "absent";
  },
  // Read the event back in its own zone (Graph converts to the zone in the Prefer header) and compare each field.
  async verify(token, op, t, send) {
    const id = await outlookIdOf(token, t, send);
    const tz = moved(op, "Event.timezone") ?? "UTC"; const want = outlookBody(op, "");
    const e = id ? await readBack(send, { method: "GET", url: `${GRAPH}/me/events/${seg(id)}?$select=subject,start,end,location,isCancelled,webLink`, headers: { Prefer: `outlook.timezone="${tz}"` } }) : null;
    const there = e && e.isCancelled !== true;
    const local = (w: unknown) => { const v = asObj(w).dateTime; return typeof v === "string" ? v.slice(0, 19) : null; };
    const actual = there ? {
      "Event.title": typeof e!.subject === "string" ? e!.subject : null,
      "Event.start": local(e!.start), "Event.end": local(e!.end),
      ...(moved(op, "Event.timezone") ? { "Event.timezone": typeof asObj(e!.start).timeZone === "string" ? asObj(e!.start).timeZone as string : null } : {}),
      ...(want.location ? { "Event.location": typeof asObj(e!.location).displayName === "string" ? asObj(e!.location).displayName as string : null } : {}),
    } : null;
    const expected: Record<string, string> = { "Event.title": want.subject, "Event.start": want.start.dateTime, "Event.end": want.end.dateTime, ...(moved(op, "Event.timezone") ? { "Event.timezone": tz } : {}), ...(want.location ? { "Event.location": want.location.displayName! } : {}) };
    const fields = Object.keys(expected).map((path) => { const a = actual ? (actual as Record<string, string | null>)[path] ?? null : null; return { path, expected: expected[path]!, actual: a, match: a === expected[path] }; });
    const link = typeof e?.webLink === "string" && /^https:\/\//.test(e.webLink) ? e.webLink : undefined;
    if (!there) return { ok: false, fields, note: "the event is not in the calendar" };
    return { ok: fields.every((f) => f.match), fields, ...(link ? { link } : {}) };
  },
};

// ---- Outlook mail drafts (Graph: POST /me/messages creates a draft; GET; DELETE) ----------------------------------------
// The draft goes in the signed-in person's own mailbox (/me), never another's. Graph chooses the id, so a lost answer
// stays unknown until the person looks in Drafts.
export type OutlookMailTarget = Record<string, never>;
export const outlookMessageDraft: Spec<OutlookMailTarget> = {
  contract: CONTRACTS.outlookMessageDraft,
  capabilities: { "message-draft-entry": unkeyedCreate("Mail.ReadWrite", "delete-created", { readBack: true }) },
  async execute(op, _t, send) {
    const r = asObj(await send({ method: "POST", url: `${GRAPH}/me/messages`, body: { body: { contentType: "Text", content: need(op, "Message.snippet") }, toRecipients: [{ emailAddress: { address: need(op, "Message.to") } }] } }));
    if (r.isDraft === false) throw new DestinationError("Outlook did not keep it as a draft");
    return JSON.stringify({ id: str(r.id, "message id") });
  },
  async undo(token, _t, send) { await send({ method: "DELETE", url: `${GRAPH}/me/messages/${seg((JSON.parse(token) as { id: string }).id)}` }); },
  async verify(token, op, _t, send) {
    const m = await readBack(send, { method: "GET", url: `${GRAPH}/me/messages/${seg((JSON.parse(token) as { id: string }).id)}?$select=toRecipients,body,isDraft,webLink`, headers: { Prefer: 'outlook.body-content-type="text"' } });
    const to = Array.isArray(m?.toRecipients) ? (m!.toRecipients as unknown[]).map((x) => asObj(asObj(x).emailAddress).address).filter((x) => typeof x === "string").join(", ") : null;
    const text = typeof asObj(m?.body).content === "string" ? (asObj(m!.body).content as string).replace(/\r\n/g, "\n").trim() : null;
    return compared(op, m && m.isDraft !== false ? { "Message.to": to || null, "Message.snippet": text } : null, "the draft is not in Outlook", m?.webLink);
  },
};

// ---- Microsoft To Do (Graph: the default list; POST/GET/DELETE /me/todo/lists/{list}/tasks/{id}) -------------------------
// The default list is looked up when placing, and its id is kept with the task, so Undo and read-back go to the same list.
export type TodoTarget = Record<string, never>;
const TODO = `${GRAPH}/me/todo/lists`;
async function todoDefaultList(send: Send): Promise<string> {
  const r = asObj(await send({ method: "GET", url: `${TODO}?$filter=${encodeURIComponent("wellknownListName eq 'defaultList'")}` }));
  const list = Array.isArray(r.value) ? asObj(r.value[0]) : {};
  return str(list.id, "default To Do list");
}
async function todoCreate(body: Record<string, unknown>, send: Send) {
  const list = await todoDefaultList(send);
  const r = asObj(await send({ method: "POST", url: `${TODO}/${seg(list)}/tasks`, body }));
  return JSON.stringify({ list, id: str(r.id, "task id") });
}
const todoUrl = (token: string) => { const k = JSON.parse(token) as { list: string; id: string }; return `${TODO}/${seg(k.list)}/tasks/${seg(k.id)}`; };
async function verifyTodo(token: string, op: Operation, send: Send, map: Record<string, "title" | "body" | "due">) {
  const k = await readBack(send, { method: "GET", url: todoUrl(token) });
  const there = k && k.status !== "completed";
  const value = (key: "title" | "body" | "due") => key === "title" ? (typeof k?.title === "string" ? k.title : null)
    : key === "body" ? (typeof asObj(k?.body).content === "string" ? (asObj(k!.body).content as string).trim() : null)
    : (typeof asObj(k?.dueDateTime).dateTime === "string" ? (asObj(k!.dueDateTime).dateTime as string).slice(0, 10) : null);
  const paths = Object.keys(map).filter((p) => moved(op, p) !== undefined);
  return compared(op, there ? Object.fromEntries(paths.map((p) => [p, value(map[p]!)])) : null, "the task is not in Microsoft To Do", "https://to-do.office.com/tasks/");
}
export const msTodoTask: Spec<TodoTarget> = {
  contract: CONTRACTS.msTodoTask,
  capabilities: { "document-task-reference": unkeyedCreate("Tasks.ReadWrite", "delete-created", { readBack: true }) },
  execute: (op, _t, send) => todoCreate({ title: need(op, "Document.title"), ...(moved(op, "Document.url") ? { body: { contentType: "text", content: moved(op, "Document.url") } } : {}) }, send),
  async undo(token, _t, send) { await send({ method: "DELETE", url: todoUrl(token) }); },
  verify: (token, op, _t, send) => verifyTodo(token, op, send, { "Document.title": "title", "Document.url": "body" }),
};
// To Do keeps a due date as a day: it is sent as that day at midnight, in UTC, and the day is what is compared.
export const msTodoEntry: Spec<TodoTarget> = {
  contract: CONTRACTS.msTodoEntry,
  capabilities: { "task-tasklist-entry": unkeyedCreate("Tasks.ReadWrite", "delete-created", { readBack: true }) },
  execute(op, _t, send) {
    const url = moved(op, "Task.url"), due = moved(op, "Task.due");
    return todoCreate({ title: need(op, "Task.title"), ...(url ? { body: { contentType: "text", content: url } } : {}), ...(due ? { dueDateTime: { dateTime: `${String(due).slice(0, 10)}T00:00:00.0000000`, timeZone: "UTC" } } : {}) }, send);
  },
  undo: msTodoTask.undo,
  async verify(token, op, _t, send) {
    const r = await verifyTodo(token, op, send, { "Task.title": "title", "Task.url": "body", "Task.due": "due" });
    const fields = r.fields.map((f) => f.path === "Task.due" ? { ...f, expected: f.expected.slice(0, 10), match: f.actual === f.expected.slice(0, 10) } : f);
    return { ...r, fields, ok: !r.note && fields.every((f) => f.match) };
  },
};
