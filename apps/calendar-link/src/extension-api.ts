// The Recast extension's door to the connected Google account (Calendar; Gmail drafts and Tasks if allowed). The extension never sees the Google token: it sends the
// operation it wants (already reviewed and consented to by the person in the glass module), and this server places it
// through the same bridge as the test event, keeps the receipt, and answers with the outcome.
//
// Who may knock: only a browser extension the person approved on http://localhost:8787 (pairing). Web pages cannot
// forge an Origin of chrome-extension://…, and an unapproved extension gets a pending request the person must Allow.
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import { commit, InMemoryEventLog, OutcomeUnknownError, undo, verify, type Consent, type Operation, type Receipt, type Verification } from "@recast/core";
import { calendarEventId, DestinationError, DuplicateError, notion, msTodoEntry, msTodoTask, outlookMessageDraft, outlookCalendarEvent, todoistEntry, todoistTask, outlookEventKey, githubIssue, linearIssue, gmailMessageDraft, googleCalendarEvent, googleDocs, googleTasks, googleTasksEntry, HttpBridge } from "@recast/bridges";
import { type CalendarAccess, googleTransport } from "./test-event.js";
import { hasDocs, hasGmail, hasTasks, readToken } from "./server.js";
import { githubTransport, readGithub } from "./github.js";
import { linearTransport, readLinear } from "./linear.js";
import { readTodoist, todoistTransport } from "./todoist.js";
import { notionTransport, readNotion } from "./notion.js";
import { msAllows, readMicrosoft, type Microsoft } from "./microsoft.js";

interface Pairing { allowed: string[]; pending: { origin: string; code: string; at: number }[] }
const EXT_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const PENDING_TTL_MS = 10 * 60 * 1000;

const readJson = <T>(file: string, fallback: T): T => { try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return fallback; } };
const writePrivate = (file: string, data: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(data), { mode: 0o600 }); chmodSync(file, 0o600);
};

export type ExtReply = { status: number; body: Record<string, unknown> };

export function createExtensionApi(a: CalendarAccess & { dir: string; microsoft?: Microsoft }) {
  const pairFile = path.join(a.dir, "extensions.json"), receiptFile = path.join(a.dir, "receipts.json");
  const pairing = (): Pairing => {
    const p = readJson<Pairing>(pairFile, { allowed: [], pending: [] });
    return { allowed: p.allowed, pending: p.pending.filter((x) => a.now() - x.at < PENDING_TTL_MS) };
  };
  const receipts = () => readJson<Receipt[]>(receiptFile, []);
  const keep = (r: Receipt) => writePrivate(receiptFile, [...receipts().filter((x) => x.receiptId !== r.receiptId), r].slice(-200));
  // Three destinations behind one sign-in. Gmail and Tasks only if the person ticked them (each its own permission).
  type Dest = "calendar" | "gmail" | "tasks" | "docs" | "github" | "linear" | "outlook" | "todoist" | "outlook-mail" | "mstodo" | "notion";
  // Tasks has two contracts on the same list: a document as a task, and a whole task with its due date.
  const bridge = (d: Dest = "calendar", destination?: string) => d === "notion" ? (() => { const n = readNotion(a.dir)!; return new HttpBridge(notion, { databaseId: n.databaseId, titleProperty: n.titleProperty, urlProperty: n.urlProperty }, notionTransport(n, a.fetch)); })()
    : d === "outlook-mail" ? new HttpBridge(outlookMessageDraft, {}, a.microsoft!.transport())
    : d === "mstodo" ? new HttpBridge(destination === msTodoEntry.contract.destination ? msTodoEntry : msTodoTask, {}, a.microsoft!.transport())
    : d === "outlook" ? new HttpBridge(outlookCalendarEvent, {}, a.microsoft!.transport())
    : d === "gmail" ? new HttpBridge(gmailMessageDraft, { userId: "me" }, googleTransport(a))
    : d === "docs" ? new HttpBridge(googleDocs, {}, googleTransport(a))
    // Todoist, like Tasks, has two contracts: a page as a task, and a whole task with its due date.
    : d === "todoist" ? (() => { const l = readTodoist(a.dir)!; return new HttpBridge(destination === todoistEntry.contract.destination ? todoistEntry : todoistTask, {}, todoistTransport(l, a.fetch)); })()
    : d === "linear" ? (() => { const l = readLinear(a.dir)!; return new HttpBridge(linearIssue, { teamId: l.teamId }, linearTransport(l, a.fetch)); })()
    : d === "github" ? (() => { const g = readGithub(a.dir)!; return new HttpBridge(githubIssue, { owner: g.owner, repo: g.repo }, githubTransport(g, a.fetch)); })()
    : d === "tasks" ? new HttpBridge(destination === googleTasksEntry.contract.destination ? googleTasksEntry : googleTasks, { taskListId: "@default" }, googleTransport(a))
    : new HttpBridge(googleCalendarEvent, { calendarId: "primary" }, googleTransport(a));
  const destOf = (destination: string): Dest => destination === notion.contract.destination ? "notion" : destination === outlookMessageDraft.contract.destination ? "outlook-mail" : destination === msTodoTask.contract.destination || destination === msTodoEntry.contract.destination ? "mstodo" : destination === todoistTask.contract.destination || destination === todoistEntry.contract.destination ? "todoist" : destination === outlookCalendarEvent.contract.destination ? "outlook" : destination === linearIssue.contract.destination ? "linear" : destination === githubIssue.contract.destination ? "github" : destination === googleDocs.contract.destination ? "docs" : destination === gmailMessageDraft.contract.destination ? "gmail" : destination === googleTasks.contract.destination || destination === googleTasksEntry.contract.destination ? "tasks" : "calendar";
  const statusBody = () => { const t = readToken(a.tokenFile); return { paired: true, connected: !!t, gmail: hasGmail(t), tasks: hasTasks(t), docs: hasDocs(t), github: (() => { const g = readGithub(a.dir); return g ? `${g.owner}/${g.repo}` : false; })(), linear: (() => { const l = readLinear(a.dir); return l ? l.teamName : false; })(), outlook: !!a.microsoft && !!readMicrosoft(a.dir), outlookMail: !!a.microsoft && msAllows(readMicrosoft(a.dir), "mail"), mstodo: !!a.microsoft && msAllows(readMicrosoft(a.dir), "todo"), todoist: !!readTodoist(a.dir), notion: (() => { const n = readNotion(a.dir); return n ? n.databaseName : false; })() }; };
  const iso = () => new Date(a.now()).toISOString();
  const APP: Record<Dest, string> = { calendar: "Google Calendar", gmail: "Gmail", tasks: "Google Tasks", docs: "Google Docs", github: "GitHub", linear: "Linear", outlook: "Outlook Calendar", todoist: "Todoist", "outlook-mail": "Outlook", mstodo: "Microsoft To Do", notion: "Notion" };
  /** A provider's refusal in words a person can act on. Never echoes a token or a response body. */
  const explain = (e: unknown, dest: Dest): string => {
    const where = APP[dest]; const microsoft = dest === "outlook" || dest === "outlook-mail" || dest === "mstodo";
    const google = dest !== "github" && dest !== "linear" && dest !== "todoist" && dest !== "notion" && !microsoft;
    if (microsoft && e instanceof DestinationError && e.status === 401) return "Microsoft no longer accepts this sign-in (expired or revoked). Sign in with Microsoft again on the Recast page";
    if (microsoft && e instanceof DestinationError && e.status === 403) return `Microsoft refused: this sign-in does not allow ${where}. Sign in with Microsoft again on the Recast page`;
    if (e instanceof DestinationError && e.status === 401) return google ? "Google no longer accepts this sign-in (expired or revoked). Sign in again on the Recast page" : `${where} no longer accepts the saved key. Connect it again on the Recast page`;
    if (e instanceof DestinationError && e.status === 403) return google ? `Google refused: this sign-in does not allow ${where}. Sign in again on the Recast page and tick it` : `${where} refused: the saved key does not allow this`;
    if (e instanceof DestinationError && e.status === 404) return `${where} could not find it`;
    if (e instanceof DestinationError && e.status === 429) return `${where} asked Recast to slow down. Try again in a minute`;
    if (e instanceof TypeError) return `${where} could not be reached. Check the internet connection`;
    return e instanceof Error ? e.message : String(e);
  };

  return {
    isAllowed: (origin: string | undefined) => !!origin && pairing().allowed.includes(origin),
    pending: () => pairing().pending,
    allowed: () => pairing().allowed,
    /** From the page (same-origin form): the person allows or refuses a pending extension. */
    decide(origin: string, allow: boolean) {
      const p = pairing(); if (!p.pending.some((x) => x.origin === origin)) return;
      writePrivate(pairFile, { allowed: allow ? [...new Set([...p.allowed, origin])] : p.allowed, pending: p.pending.filter((x) => x.origin !== origin) });
    },
    forget(origin: string) { const p = pairing(); writePrivate(pairFile, { ...p, allowed: p.allowed.filter((x) => x !== origin) }); },

    async handle(route: string, origin: string | undefined, body: Record<string, unknown>): Promise<ExtReply> {
      if (!origin || !EXT_ORIGIN.test(origin)) return { status: 403, body: { error: "only a browser extension may use this" } };
      if (route === "pair") {
        const p = pairing();
        if (p.allowed.includes(origin)) return { status: 200, body: statusBody() };
        const existing = p.pending.find((x) => x.origin === origin);
        const code = existing?.code ?? String(randomInt(1000, 10000));
        if (!existing) writePrivate(pairFile, { ...p, pending: [...p.pending, { origin, code, at: a.now() }].slice(-5) });
        return { status: 202, body: { paired: false, code } };
      }
      if (!pairing().allowed.includes(origin)) return { status: 403, body: { error: "not paired: allow this extension on the Recast page first" } };
      return act(route, body);
    },
    /**
     * The same operations for a caller in this process (the Recast desktop app), which needs no pairing: it is this
     * program. Never exposed over HTTP.
     */
    direct: (route: string, body: Record<string, unknown>) => act(route, body),
  };

  async function act(route: string, body: Record<string, unknown>): Promise<ExtReply> {
      if (route === "status") return { status: 200, body: statusBody() };
      const dest: Dest = body.destination === "notion" ? "notion" : body.destination === "outlook-mail" ? "outlook-mail" : body.destination === "mstodo" ? "mstodo" : body.destination === "todoist" ? "todoist" : body.destination === "outlook" ? "outlook" : body.destination === "gmail" ? "gmail" : body.destination === "tasks" ? "tasks" : body.destination === "docs" ? "docs" : body.destination === "github" ? "github" : body.destination === "linear" ? "linear" : "calendar";
      // GitHub stands alone: it needs its own connection, not Google's.
      if (dest === "github" && !readGithub(a.dir)) return { status: 409, body: { outcome: "failed", message: "GitHub is not connected. Connect a repository on the Recast page first." } };
      if (dest === "linear" && !readLinear(a.dir)) return { status: 409, body: { outcome: "failed", message: "Linear is not connected. Connect a team on the Recast page first." } };
      if (dest === "notion" && !readNotion(a.dir)) return { status: 409, body: { outcome: "failed", message: "Notion is not connected. Connect a database on the Recast page first." } };
      if (dest === "todoist" && !readTodoist(a.dir)) return { status: 409, body: { outcome: "failed", message: "Todoist is not connected. Connect it on the Recast page first." } };
      if ((dest === "outlook-mail" || dest === "mstodo") && (!a.microsoft || !readMicrosoft(a.dir))) return { status: 409, body: { outcome: "failed", message: `${APP[dest]} is not connected. Sign in with Microsoft on the Recast page first.` } };
      if (dest === "outlook-mail" && !msAllows(readMicrosoft(a.dir), "mail")) return { status: 409, body: { outcome: "failed", message: "Outlook mail drafts are not allowed. Sign in with Microsoft again on the Recast page and tick mail drafts." } };
      if (dest === "mstodo" && !msAllows(readMicrosoft(a.dir), "todo")) return { status: 409, body: { outcome: "failed", message: "Microsoft To Do is not allowed. Sign in with Microsoft again on the Recast page and tick To Do." } };
      if (dest === "outlook" && (!a.microsoft || !readMicrosoft(a.dir))) return { status: 409, body: { outcome: "failed", message: "Outlook Calendar is not connected. Sign in with Microsoft on the Recast page first." } };
      if (dest !== "github" && dest !== "linear" && dest !== "outlook" && dest !== "todoist" && dest !== "outlook-mail" && dest !== "mstodo" && dest !== "notion" && !readToken(a.tokenFile)) return { status: 409, body: { outcome: "failed", message: "Google is not connected. Sign in on the Recast page first." } };
      if (dest === "gmail" && !hasGmail(readToken(a.tokenFile))) return { status: 409, body: { outcome: "failed", message: "Gmail drafts are not allowed. Sign in again on the Recast page and tick Gmail." } };
      if (dest === "docs" && !hasDocs(readToken(a.tokenFile))) return { status: 409, body: { outcome: "failed", message: "Google Docs is not allowed. Sign in again on the Recast page and tick Google Drive (only the files Recast creates)." } };
      if (dest === "tasks" && !hasTasks(readToken(a.tokenFile))) return { status: 409, body: { outcome: "failed", message: "Google Tasks is not allowed. Sign in again on the Recast page and tick Tasks." } };

      if (route === "commit") {
        const op = body.op as Operation, consent = body.consent as Consent;
        const b = bridge(dest, op?.proposal?.destination?.destination); const log = new InMemoryEventLog();
        try {
          const receipt = await commit(op, consent, { bridge: b, log, now: iso });
          keep(receipt);
          return { status: 200, body: { outcome: "done", receipt } };
        } catch (e) {
          if (e instanceof OutcomeUnknownError) return { status: 200, body: { outcome: "unknown", message: dest === "gmail" ? "Gmail did not answer; the draft may have been saved" : dest === "docs" ? "Google Docs did not answer; the document may have been created" : dest === "github" ? "GitHub did not answer; the issue may have been opened" : dest === "linear" ? "Linear did not answer; the issue may have been created" : dest === "tasks" ? "Google Tasks did not answer; the task may have been added" : dest === "todoist" ? "Todoist did not answer; the task may have been added" : dest === "notion" ? "Notion did not answer; the page may have been added" : dest === "outlook-mail" ? "Outlook did not answer; the draft may have been saved" : dest === "mstodo" ? "Microsoft To Do did not answer; the task may have been added" : `${APP[dest]} did not answer; it may have been added` } };
          if (e instanceof DuplicateError) return { status: 200, body: { outcome: "failed", message: `It is already in your ${APP[dest]}, so it was not added a second time` } };
          return { status: 200, body: { outcome: "failed", message: explain(e, dest) } };
        }
      }
      if (route === "reconcile") {
        // Ask Google about the event this operation would have made. Found: it was placed, and gets a receipt for Undo.
        const op = body.op as Operation;
        // Gmail drafts carry no key Recast chose, so Gmail cannot be asked about one: say so, never guess "absent".
        if (dest === "gmail") return { status: 200, body: { checkable: false, message: "Gmail can't be asked about one draft. Look in Gmail Drafts: if it's there, keep it; if not, dismiss this and place again." } };
        // The same for Google Tasks: a task's id is Google's, not Recast's, so there is nothing exact to ask about.
        if (dest === "linear") return { status: 200, body: { checkable: false, message: "Linear can't be asked about one issue. Look at the team's issues: if it's there, keep it; if not, dismiss this and place again." } };
        if (dest === "github") return { status: 200, body: { checkable: false, message: "GitHub can't be asked about one issue. Look at the repository's issues: if it's there, keep it; if not, dismiss this and place again." } };
        if (dest === "docs") return { status: 200, body: { checkable: false, message: "Google Docs can't be asked about one document. Look in Google Drive: if it's there, keep it; if not, dismiss this and place again." } };
        if (dest === "notion") return { status: 200, body: { checkable: false, message: "Notion can't be asked about one page. Look in the database: if it's there, keep it; if not, dismiss this and place again." } };
        if (dest === "outlook-mail") return { status: 200, body: { checkable: false, message: "Outlook can't be asked about one draft. Look in your Outlook Drafts: if it's there, keep it; if not, dismiss this and place again." } };
        if (dest === "mstodo") return { status: 200, body: { checkable: false, message: "Microsoft To Do can't be asked about one task. Look in To Do: if it's there, keep it; if not, dismiss this and place again." } };
        if (dest === "todoist") return { status: 200, body: { checkable: false, message: "Todoist can't be asked about one task. Look in your Todoist Inbox: if it's there, keep it; if not, dismiss this and place again." } };
        if (dest === "tasks") return { status: 200, body: { checkable: false, message: "Google Tasks can't be asked about one task. Look in Google Tasks: if it's there, keep it; if not, dismiss this and place again." } };
        // Outlook: found by Recast's own key on the event. Google: the event id is Recast's.
        const ref = dest === "outlook" ? JSON.stringify({ key: outlookEventKey(op.proposal.object.id, {}) }) : JSON.stringify({ id: calendarEventId(op.proposal.object.id, "primary") });
        let found: boolean;
        try { found = (await bridge(dest).reconcile(ref)) === "present"; }
        catch (e) { return { status: 200, body: { checkable: false, message: `It could not be checked: ${explain(e, dest)}` } }; }
        if (!found) return { status: 200, body: { found: false } };
        const p = op.proposal;
        const receipt: Receipt = { receiptId: `rc-${op.opId}`, opId: op.opId, at: iso(), status: "done", objectId: p.object.id, destination: p.destination.destination, relationId: p.relationId, effect: p.effect, reversible: p.reversible, bridgeRef: ref };
        keep(receipt);
        return { status: 200, body: { found: true, receipt } };
      }
      if (route === "undo") {
        // Only a receipt this server issued can be undone: the extension names it, the stored copy is used.
        const id = (body.receipt as Receipt | undefined)?.receiptId;
        const stored = receipts().find((r) => r.receiptId === id);
        if (!stored) return { status: 200, body: { outcome: "failed", message: "That placement is not one this computer made" } };
        const log = new InMemoryEventLog(); await log.append({ at: stored.at, kind: "commit", receipt: stored });
        try { await undo(stored, { bridge: bridge(destOf(stored.destination), stored.destination), log, now: iso }); }
        catch (e) { return { status: 200, body: { outcome: "failed", message: explain(e, destOf(stored.destination)) } }; }
        writePrivate(receiptFile, receipts().filter((r) => r.receiptId !== id));
        return { status: 200, body: { outcome: "undone" } };
      }
      if (route === "verify") {
        // Read a placement back from the provider and compare it with the plan. Only a receipt this program issued, for
        // the same operation; the stored copy is used. "Verified" is the provider's own answer, never assumed.
        const op = body.op as Operation | undefined; const id = (body.receipt as Receipt | undefined)?.receiptId;
        const stored = receipts().find((r) => r.receiptId === id);
        const notChecked = (note: string): ExtReply => ({ status: 200, body: { verification: { ok: false, at: iso(), fields: [], note } satisfies Verification } });
        if (!stored || !op || op.opId !== stored.opId) return notChecked("that placement is not one this computer made");
        const log = new InMemoryEventLog(); await log.append({ at: stored.at, kind: "commit", receipt: stored });
        try { return { status: 200, body: { verification: await verify(stored, op, { bridge: bridge(destOf(stored.destination), stored.destination), log, now: iso }) } }; }
        catch (e) { return notChecked(`it could not be read back: ${explain(e, destOf(stored.destination))}`); }
      }
      return { status: 404, body: { error: "unknown route" } };
  }
}
