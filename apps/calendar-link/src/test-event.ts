// "Place a test event": one real event in the connected Google Calendar, placed through the same bridge Recast uses
// (googleCalendarEvent), then removed with Undo. It also exercises the two safety paths against real Google:
// - pressing Place twice still gives one event (the event id is derived from the content, so Google refuses the copy);
// - a lost answer: the write is sent for real, the reply is thrown away here, and Check asks Google what happened.
// The access token is only ever put in the Authorization header of requests to Google; it is never returned or logged.
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { commit, deserialize, InMemoryEventLog, OutcomeUnknownError, plan, propose, resolve, serialize, undo, type Receipt, type SemanticObject } from "@recast/core";
import { calendarEventId, DuplicateError, googleCalendarEvent, HttpBridge, type Transport } from "@recast/bridges";
import { readToken, type StoredToken } from "./server.js";

export interface CalendarAccess {
  clientId: string; clientSecret: string; tokenFile: string;
  tokenUrl: string; fetch: typeof fetch; now: () => number;
  /** Where the last test event is remembered (git-ignored). */
  stateFile: string;
}
interface TestState { object: string; receipt?: Receipt; placedAt?: string }
export type Outcome = { ok: boolean; text: string };

const writePrivate = (file: string, data: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(data), { mode: 0o600 }); chmodSync(file, 0o600);
};
const readState = (file: string): TestState | null => { try { return JSON.parse(readFileSync(file, "utf8")) as TestState; } catch { return null; } };

/** A valid access token, refreshed with the refresh token when it is (nearly) expired. */
export async function accessToken(a: CalendarAccess): Promise<string> {
  const t = readToken(a.tokenFile);
  if (!t) throw new Error("Not connected. Sign in with Google first.");
  if (t.expires_at - 60_000 > a.now()) return t.access_token;
  if (!t.refresh_token) throw new Error("The permission has expired and cannot be renewed. Disconnect, then sign in again.");
  const r = await a.fetch(a.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: a.clientId, client_secret: a.clientSecret }) });
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok || typeof body.access_token !== "string") throw new Error(`Google would not renew the permission (${String(body.error ?? r.status)}). Disconnect, then sign in again.`);
  const next: StoredToken = { ...t, access_token: body.access_token, expires_at: a.now() + Number(body.expires_in ?? 3600) * 1000 };
  writePrivate(a.tokenFile, next);
  return next.access_token;
}

/** Calls Google with the user's token. `dropAnswer` lets a write succeed for real, then pretends the reply never came. */
function transport(a: CalendarAccess, dropAnswer = false): Transport {
  return async (req) => {
    const r = await a.fetch(req.url, { method: req.method,
      headers: { authorization: `Bearer ${await accessToken(a)}`, ...(req.body !== undefined ? { "content-type": "application/json" } : {}), ...req.headers },
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}) });
    const json = r.status === 204 ? null : await r.json().catch(() => null);
    if (dropAnswer && req.method !== "GET" && r.ok) return { status: 504, json: null };
    return { status: r.status, json };
  };
}

/** Tomorrow 10:00–11:00 in this computer's time zone. */
function testObject(now: number): SemanticObject {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now + 86_400_000));
  const properties = { title: "Recast test event", start: `${day}T10:00`, end: `${day}T11:00`, timezone: tz, location: "Dakshin, 12 MG Road, Bengaluru" };
  return resolve({ type: "Event", properties,
    fields: Object.fromEntries(Object.keys(properties).map((k) => [k, { confidence: 0.9, evidence: [{ locator: { kind: "css", value: `#${k}` } }] }])),
    provenance: { source: { app: "recast-calendar-link" }, capture: { method: "composition", adapter: "compose", at: new Date(now).toISOString() } } });
}

export function createTestEvents(a: CalendarAccess) {
  const iso = () => new Date(a.now()).toISOString();
  const bridge = (dropAnswer = false) => new HttpBridge(googleCalendarEvent, { calendarId: "primary" }, transport(a, dropAnswer));
  // The history log Undo checks against; rebuilt from the state file so Undo still works after a restart.
  const logFor = async (s: TestState) => { const log = new InMemoryEventLog(); if (s.receipt) await log.append({ at: s.receipt.at, kind: "commit", receipt: s.receipt }); return log; };
  const current = (): TestState => readState(a.stateFile) ?? { object: serialize(testObject(a.now())) };
  const refOf = (o: SemanticObject) => JSON.stringify({ id: calendarEventId(o.id, "primary") });

  async function place(dropAnswer = false): Promise<Outcome> {
    const s = current(); const o = deserialize(s.object); const b = bridge(dropAnswer); const log = new InMemoryEventLog();
    const p = propose(o, b.describe())[0];
    if (!p || p.status !== "ready") return { ok: false, text: "The test event could not be prepared for Google Calendar." };
    try {
      const receipt = await commit(plan(p, { now: iso }), { kind: "release" }, { bridge: b, log, now: iso });
      writePrivate(a.stateFile, { object: s.object, receipt, placedAt: iso() } satisfies TestState);
      return { ok: true, text: `Placed “Recast test event” for ${String(o.properties.start).replace("T", " ")} in your calendar.` };
    } catch (e) {
      writePrivate(a.stateFile, { object: s.object, ...(s.receipt ? { receipt: s.receipt } : {}) } satisfies TestState);
      if (e instanceof DuplicateError) return { ok: true, text: "It is already in your calendar, so it was not added a second time." };
      if (e instanceof OutcomeUnknownError) return { ok: true, text: "No answer came back (on purpose, for this test), so Recast does not know whether it was added. Press Check." };
      return { ok: false, text: `Not placed: ${(e as Error).message}` };
    }
  }

  async function check(): Promise<Outcome> {
    const o = deserialize(current().object);
    const found = await bridge().reconcile(refOf(o));
    return found === "present" ? { ok: true, text: "Google says the test event is in your calendar." } : { ok: true, text: "Google says the test event is not in your calendar." };
  }

  async function remove(): Promise<Outcome> {
    const s = readState(a.stateFile);
    if (!s?.receipt) {
      // Placed with a lost answer, so there is no receipt: remove by its known id if Google has it.
      if (!s) return { ok: false, text: "There is no test event to undo." };
      const o = deserialize(s.object); const b = bridge();
      if ((await b.reconcile(refOf(o))) === "absent") return { ok: true, text: "Nothing to undo: Google has no test event." };
      await googleCalendarEvent.undo(refOf(o), { calendarId: "primary" }, async (req) => { const r = await transport(a)(req); if (r.status >= 300) throw new Error(`Google answered ${r.status}`); return r.json; });
      writePrivate(a.stateFile, { object: s.object } satisfies TestState);
      return { ok: true, text: "Removed the test event from your calendar." };
    }
    const b = bridge();
    try { await undo(s.receipt, { bridge: b, log: await logFor(s), now: iso }); }
    catch (e) { return { ok: false, text: `Not removed: ${(e as Error).message}` }; }
    writePrivate(a.stateFile, { object: s.object } satisfies TestState);
    return { ok: true, text: "Undone: the test event was removed from your calendar." };
  }

  return { place: () => place(false), placeLosingAnswer: () => place(true), check, undo: remove, hasReceipt: () => !!readState(a.stateFile)?.receipt };
}
