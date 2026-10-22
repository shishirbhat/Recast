// The Recast extension's door to the connected Google account (Calendar; Gmail drafts and Tasks if allowed). The extension never sees the Google token: it sends the
// operation it wants (already reviewed and consented to by the person in the glass module), and this server places it
// through the same bridge as the test event, keeps the receipt, and answers with the outcome.
//
// Who may knock: only a browser extension the person approved on http://localhost:8787 (pairing). Web pages cannot
// forge an Origin of chrome-extension://…, and an unapproved extension gets a pending request the person must Allow.
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import { commit, InMemoryEventLog, OutcomeUnknownError, undo, type Consent, type Operation, type Receipt } from "@recast/core";
import { calendarEventId, DuplicateError, githubIssue, gmailMessageDraft, googleCalendarEvent, googleDocs, googleTasks, googleTasksEntry, HttpBridge } from "@recast/bridges";
import { type CalendarAccess, googleTransport } from "./test-event.js";
import { hasDocs, hasGmail, hasTasks, readToken } from "./server.js";
import { githubTransport, readGithub } from "./github.js";

interface Pairing { allowed: string[]; pending: { origin: string; code: string; at: number }[] }
const EXT_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const PENDING_TTL_MS = 10 * 60 * 1000;

const readJson = <T>(file: string, fallback: T): T => { try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return fallback; } };
const writePrivate = (file: string, data: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(data), { mode: 0o600 }); chmodSync(file, 0o600);
};

export type ExtReply = { status: number; body: Record<string, unknown> };

export function createExtensionApi(a: CalendarAccess & { dir: string }) {
  const pairFile = path.join(a.dir, "extensions.json"), receiptFile = path.join(a.dir, "receipts.json");
  const pairing = (): Pairing => {
    const p = readJson<Pairing>(pairFile, { allowed: [], pending: [] });
    return { allowed: p.allowed, pending: p.pending.filter((x) => a.now() - x.at < PENDING_TTL_MS) };
  };
  const receipts = () => readJson<Receipt[]>(receiptFile, []);
  const keep = (r: Receipt) => writePrivate(receiptFile, [...receipts().filter((x) => x.receiptId !== r.receiptId), r].slice(-200));
  // Three destinations behind one sign-in. Gmail and Tasks only if the person ticked them (each its own permission).
  type Dest = "calendar" | "gmail" | "tasks" | "docs" | "github";
  // Tasks has two contracts on the same list: a document as a task, and a whole task with its due date.
  const bridge = (d: Dest = "calendar", destination?: string) => d === "gmail" ? new HttpBridge(gmailMessageDraft, { userId: "me" }, googleTransport(a))
    : d === "docs" ? new HttpBridge(googleDocs, {}, googleTransport(a))
    : d === "github" ? (() => { const g = readGithub(a.dir)!; return new HttpBridge(githubIssue, { owner: g.owner, repo: g.repo }, githubTransport(g, a.fetch)); })()
    : d === "tasks" ? new HttpBridge(destination === googleTasksEntry.contract.destination ? googleTasksEntry : googleTasks, { taskListId: "@default" }, googleTransport(a))
    : new HttpBridge(googleCalendarEvent, { calendarId: "primary" }, googleTransport(a));
  const destOf = (destination: string): Dest => destination === githubIssue.contract.destination ? "github" : destination === googleDocs.contract.destination ? "docs" : destination === gmailMessageDraft.contract.destination ? "gmail" : destination === googleTasks.contract.destination || destination === googleTasksEntry.contract.destination ? "tasks" : "calendar";
  const statusBody = () => { const t = readToken(a.tokenFile); return { paired: true, connected: !!t, gmail: hasGmail(t), tasks: hasTasks(t), docs: hasDocs(t), github: (() => { const g = readGithub(a.dir); return g ? `${g.owner}/${g.repo}` : false; })() }; };
  const iso = () => new Date(a.now()).toISOString();

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
      if (route === "status") return { status: 200, body: statusBody() };
      const dest: Dest = body.destination === "gmail" ? "gmail" : body.destination === "tasks" ? "tasks" : body.destination === "docs" ? "docs" : body.destination === "github" ? "github" : "calendar";
      // GitHub stands alone: it needs its own connection, not Google's.
      if (dest === "github" && !readGithub(a.dir)) return { status: 409, body: { outcome: "failed", message: "GitHub is not connected. Connect a repository on the Recast page first." } };
      if (dest !== "github" && !readToken(a.tokenFile)) return { status: 409, body: { outcome: "failed", message: "Google is not connected. Sign in on the Recast page first." } };
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
          if (e instanceof OutcomeUnknownError) return { status: 200, body: { outcome: "unknown", message: dest === "gmail" ? "Gmail did not answer; the draft may have been saved" : dest === "docs" ? "Google Docs did not answer; the document may have been created" : dest === "github" ? "GitHub did not answer; the issue may have been opened" : dest === "tasks" ? "Google Tasks did not answer; the task may have been added" : "Google Calendar did not answer; it may have been added" } };
          if (e instanceof DuplicateError) return { status: 200, body: { outcome: "failed", message: "It is already in your Google Calendar, so it was not added a second time" } };
          return { status: 200, body: { outcome: "failed", message: e instanceof Error ? e.message : String(e) } };
        }
      }
      if (route === "reconcile") {
        // Ask Google about the event this operation would have made. Found: it was placed, and gets a receipt for Undo.
        const op = body.op as Operation;
        // Gmail drafts carry no key Recast chose, so Gmail cannot be asked about one: say so, never guess "absent".
        if (dest === "gmail") return { status: 200, body: { checkable: false, message: "Gmail can't be asked about one draft. Look in Gmail Drafts: if it's there, keep it; if not, dismiss this and place again." } };
        // The same for Google Tasks: a task's id is Google's, not Recast's, so there is nothing exact to ask about.
        if (dest === "github") return { status: 200, body: { checkable: false, message: "GitHub can't be asked about one issue. Look at the repository's issues: if it's there, keep it; if not, dismiss this and place again." } };
        if (dest === "docs") return { status: 200, body: { checkable: false, message: "Google Docs can't be asked about one document. Look in Google Drive: if it's there, keep it; if not, dismiss this and place again." } };
        if (dest === "tasks") return { status: 200, body: { checkable: false, message: "Google Tasks can't be asked about one task. Look in Google Tasks: if it's there, keep it; if not, dismiss this and place again." } };
        const ref = JSON.stringify({ id: calendarEventId(op.proposal.object.id, "primary") });
        const found = (await bridge().reconcile(ref)) === "present";
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
        catch (e) { return { status: 200, body: { outcome: "failed", message: e instanceof Error ? e.message : String(e) } }; }
        writePrivate(receiptFile, receipts().filter((r) => r.receiptId !== id));
        return { status: 200, body: { outcome: "undone" } };
      }
      return { status: 404, body: { error: "unknown route" } };
    },
  };
}
