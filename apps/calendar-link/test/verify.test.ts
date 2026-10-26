// Verify and Confirm through the local program, with Google replaced by an in-process stand-in (MOCKED PROVIDER: no real
// Google is contacted). The real-Google run is docs/REAL_TEST_PLAN.md, section L.
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { plan, propose, resolve, type Operation, type Receipt } from "@recast/core";
import { CONTRACTS } from "@recast/bridges";
import { createExtensionApi } from "../src/extension-api.js";
import { SCOPE } from "../src/server.js";

const EXT = `chrome-extension://${"a".repeat(32)}`;
const NOW = Date.parse("2026-10-26T09:00:00Z");
type Ev = Record<string, unknown>;

function setup() {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "recast-verify-")), ".secrets"); mkdirSync(dir, { recursive: true });
  const tokenFile = path.join(dir, "google-token.json");
  writeFileSync(tokenFile, JSON.stringify({ access_token: "AT", refresh_token: "RT", expires_at: NOW + 3_600_000, scope: SCOPE, token_type: "Bearer", connected_at: "x" }));
  const events = new Map<string, Ev>(); const calls: string[] = [];
  const g = { down: false, status: 0 as number, events, calls };
  const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = (async (u: string, init?: RequestInit) => {
    const method = init?.method ?? "GET"; calls.push(`${method} ${u}`);
    if (g.down) throw new TypeError("fetch failed");
    if (g.status) return json(g.status, { error: { message: "no" } });
    const id = decodeURIComponent(String(u).split("/events/")[1]?.split("?")[0] ?? "");
    if (method === "POST") { const b = JSON.parse(String(init!.body)) as Ev & { id: string }; if (events.has(b.id)) return json(409, {}); events.set(b.id, { ...b, status: "confirmed", htmlLink: `https://www.google.com/calendar/event?eid=${b.id}` }); return json(200, events.get(b.id)); }
    if (method === "GET") return events.has(id) ? json(200, events.get(id)) : json(404, {});
    if (method === "DELETE") { events.set(id, { ...events.get(id)!, status: "cancelled" }); return json(204, null); }
    return json(400, {});
  }) as unknown as typeof globalThis.fetch;
  const api = createExtensionApi({ clientId: "c", clientSecret: "s", tokenFile, tokenUrl: "https://google.test/token", now: () => NOW, stateFile: path.join(dir, "t.json"), dir, fetch });
  return { api, g };
}
async function paired() { const x = setup(); await x.api.handle("pair", EXT, {}); x.api.decide(EXT, true); return x; }
function eventOp(title = "Design review"): Operation {
  const properties = { title, start: "2026-10-29T16:00", end: "2026-10-29T17:00", timezone: "Asia/Kolkata", location: "Dakshin, 12 MG Road, Bengaluru" };
  const o = resolve({ type: "Event", properties, fields: Object.fromEntries(Object.keys(properties).map((k) => [k, { confidence: 0.9, evidence: [{ locator: { kind: "css", value: `#${k}` } }] }])), provenance: { source: { app: "t" }, capture: { method: "composition", adapter: "compose", at: "2026-10-26T08:00:00Z" } } });
  return plan(propose(o, CONTRACTS.googleCalendarEvent)[0]!, { now: () => "2026-10-26T09:00:00Z" });
}
const place = async (api: ReturnType<typeof setup>["api"], op: Operation) => (await api.handle("commit", EXT, { destination: "calendar", op, consent: { kind: "confirm" } })).body;

describe("verify through the local program (Google stand-in)", () => {
  it("placed, then read back from Google: every field matches, and the event's own link comes back", async () => {
    const { api, g } = await paired(); const op = eventOp();
    const r = await place(api, op); expect(r.outcome).toBe("done");
    const v = (await api.handle("verify", EXT, { destination: "calendar", op, receipt: r.receipt })).body.verification as Record<string, unknown>;
    expect(v).toMatchObject({ ok: true, link: expect.stringMatching(/^https:\/\/www\.google\.com\/calendar\/event\?eid=/) });
    expect((v.fields as { match: boolean }[]).every((f) => f.match)).toBe(true);
    expect(g.calls.filter((c) => !c.startsWith("GET"))).toHaveLength(1);   // reading back never writes
  });
  it("an edit in Google after placing is reported field by field; a deleted event is 'not in the calendar'", async () => {
    const { api, g } = await paired(); const op = eventOp(); const r = await place(api, op);
    const [id] = [...g.events.keys()];
    g.events.set(id!, { ...g.events.get(id!)!, summary: "Design review (moved)" });
    let v = (await api.handle("verify", EXT, { destination: "calendar", op, receipt: r.receipt })).body.verification as { ok: boolean; fields: { path: string; actual: string | null; match: boolean }[] };
    expect(v.ok).toBe(false); expect(v.fields.filter((f) => !f.match)).toEqual([expect.objectContaining({ path: "Event.title", actual: "Design review (moved)" })]);
    g.events.set(id!, { ...g.events.get(id!)!, status: "cancelled" });
    v = (await api.handle("verify", EXT, { destination: "calendar", op, receipt: r.receipt })).body.verification as typeof v;
    expect(v).toMatchObject({ ok: false, note: "the event is not in the calendar" });
  });
  it("only a receipt this program issued, for the same operation, is checked", async () => {
    const { api, g } = await paired(); const op = eventOp(); const r = await place(api, op);
    const forged = { ...(r.receipt as Receipt), receiptId: "rc-forged" };
    expect((await api.handle("verify", EXT, { destination: "calendar", op, receipt: forged })).body.verification).toMatchObject({ ok: false, note: "that placement is not one this computer made" });
    expect((await api.handle("verify", EXT, { destination: "calendar", op: eventOp("Another"), receipt: r.receipt })).body.verification).toMatchObject({ ok: false });
    const before = g.calls.length;
    expect((await api.handle("verify", `chrome-extension://${"b".repeat(32)}`, { op, receipt: r.receipt })).status).toBe(403);   // not paired
    expect(g.calls.length).toBe(before);
  });
  it("a read-back that cannot be made is 'not confirmed', with the reason; never verified", async () => {
    const { api, g } = await paired(); const op = eventOp(); const r = await place(api, op);
    g.down = true;
    expect((await api.handle("verify", EXT, { destination: "calendar", op, receipt: r.receipt })).body.verification).toMatchObject({ ok: false, fields: [], note: "it could not be read back: Google Calendar could not be reached. Check the internet connection" });
    g.down = false; g.status = 401;
    expect(((await api.handle("verify", EXT, { destination: "calendar", op, receipt: r.receipt })).body.verification as { note: string }).note).toMatch(/Google no longer accepts this sign-in \(expired or revoked\)\. Sign in again/);
  });
  it("sign-in and permission refusals are said in words a person can act on, and nothing is reported as placed", async () => {
    const { api, g } = await paired();
    g.status = 401; expect(await place(api, eventOp())).toEqual({ outcome: "failed", message: "Google no longer accepts this sign-in (expired or revoked). Sign in again on the Recast page" });
    g.status = 403; expect(await place(api, eventOp())).toEqual({ outcome: "failed", message: "Google refused: this sign-in does not allow Google Calendar. Sign in again on the Recast page and tick it" });
    g.status = 0; g.down = true; expect((await place(api, eventOp())).outcome).toBe("unknown");   // a network failure mid-write may have landed: unknown, not failed
    expect(g.events.size).toBe(0);
  });
});
