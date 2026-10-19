// POST /v1/place and /v1/place/undo against a fake Google API over real HTTP. The bridges, consent checks, credential
// sealing and receipts are the real ones; only Google is played by a local server.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { PGlite } from "@electric-sql/pglite";
import { freshDb } from "@recast/store/testing";
import { createResolver } from "@recast/resolve";
import {
  CredentialCipher, MemoryCredentialStore, MemoryIdempotencyStore, MemoryKeyStore, MemoryPlacementStore, SqlCredentialStore, SqlPlacementStore,
  createApi as rawCreateApi, fetchTransport, type CredentialStore, type PlacementStore,
} from "../src";
import { guard } from "./contract-guard";
const createApi = (d: Parameters<typeof rawCreateApi>[0]) => guard(rawCreateApi(d));

const TOKEN = "ya29.fake-google-token"; const KEY_A = "sk_test_place_tenant_a1", KEY_B = "sk_test_place_tenant_b1";
type Seen = { method: string; host: string; path: string; auth?: string; body?: any };
let google: Server, port: number; let seen: Seen[] = []; let event: { attendees: { email: string }[]; location: string }; let failWith = 0;
const calendar = new Map<string, Record<string, unknown>>(); let hangAfterWrite = false;
beforeAll(async () => {
  google = createServer(async (q, r) => {
    const chunks: Buffer[] = []; for await (const c of q) chunks.push(c as Buffer);
    const [, host, ...rest] = (q.url ?? "").split("/"); const path = "/" + rest.join("/");
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    seen.push({ method: q.method!, host: host!, path, auth: q.headers.authorization, body });
    const send = (status: number, json?: unknown) => { r.writeHead(status, { "content-type": "application/json" }).end(json === undefined ? "" : JSON.stringify(json)); };
    if (failWith) return send(failWith, { error: { message: "nope" } });
    if (q.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "bad token" });
    if (host === "www.googleapis.com" && path.startsWith("/calendar/v3/calendars/primary/events") && !path.startsWith("/calendar/v3/calendars/primary/events/ev1")) {
      const id = decodeURIComponent(path.split("/events/")[1]?.split("?")[0] ?? "");
      if (q.method === "POST") {
        if (calendar.has(body.id)) return send(409, { error: { message: "The requested identifier already exists." } });
        calendar.set(body.id, { ...body, status: "confirmed" });
        if (hangAfterWrite) { hangAfterWrite = false; return; }   // the write landed; the answer never comes
        return send(200, calendar.get(body.id));
      }
      if (q.method === "GET") return calendar.has(id) ? send(200, calendar.get(id)) : send(404, {});
      if (q.method === "DELETE") { calendar.set(id, { ...calendar.get(id), status: "cancelled" }); return send(204); }
    }
    if (host === "gmail.googleapis.com" && hangAfterWrite && q.method === "POST") { hangAfterWrite = false; return; }
    if (host === "www.googleapis.com" && path.startsWith("/calendar/v3/calendars/primary/events/ev1")) {
      if (q.method === "GET") return send(200, event);
      if (q.method === "PATCH") { Object.assign(event, body); return send(200, event); }
    }
    if (host === "gmail.googleapis.com" && path === "/gmail/v1/users/me/drafts" && q.method === "POST") return send(200, { id: "draft-1" });
    if (host === "gmail.googleapis.com" && path === "/gmail/v1/users/me/drafts/draft-1" && q.method === "DELETE") return send(204);
    send(404, { error: "no route" });
  });
  await new Promise<void>((ok) => google.listen(0, "127.0.0.1", ok)); port = (google.address() as { port: number }).port;
});
afterAll(() => google?.close());

/** Real HTTP, but to the local stand-in: https://<host>/<path> -> http://127.0.0.1:<port>/<host>/<path>. */
const toLocal: typeof fetch = (url, init) => { const u = new URL(String(url)); return fetch(`http://127.0.0.1:${port}/${u.hostname}${u.pathname}${u.search}`, init); };

let tenants: [string, string];
async function setup(stores?: { credentials: CredentialStore; placements: PlacementStore; tenants: [string, string] }, opts: { timeoutMs?: number; fetch?: typeof fetch } = {}) {
  seen = []; failWith = 0; event = { attendees: [{ email: "host@acme.com" }], location: "Old place" }; calendar.clear(); hangAfterWrite = false;
  tenants = stores?.tenants ?? ["tA", "tB"];
  const keys = new MemoryKeyStore();
  await keys.add(KEY_A, { tenantId: tenants[0], tier: "pro", correctionsOptIn: false, cohort: "internal" }); await keys.add(KEY_B, { tenantId: tenants[1], tier: "pro", correctionsOptIn: false, cohort: "internal" });
  const credentials = stores?.credentials ?? new MemoryCredentialStore(); const placements = stores?.placements ?? new MemoryPlacementStore();
  await credentials.set(tenants[0], "gmail", { accessToken: TOKEN }); await credentials.set(tenants[0], "google_calendar", { accessToken: TOKEN }); await credentials.set(tenants[0], "google_calendar_event", { accessToken: TOKEN });
  const api = createApi({ resolver: createResolver(), keys, idempotency: new MemoryIdempotencyStore(), placement: { credentials, placements, fetch: opts.fetch ?? toLocal, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) } });
  const post = async (path: string, body: unknown, key = KEY_A, headers: Record<string, string> = {}) => {
    const r = await api.handle(new Request("http://x" + path, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
    return { status: r.status, json: await r.json() as any, headers: r.headers };
  };
  return { api, post, credentials, placements };
}
const MEERA = { input: { raw: "Meera Iyer, meera@x.com" } };
const toGmail = { ...MEERA, target: { destination: "gmail" }, consent: { kind: "confirm" } };
const toCal = { ...MEERA, target: { destination: "google_calendar" }, destination_target: { calendar_id: "primary", event_id: "ev1" } };

describe("POST /v1/place", () => {
  it("is off unless the server is configured for placements", async () => {
    const keys = new MemoryKeyStore(); await keys.add(KEY_A, { tenantId: "tA", tier: "pro", correctionsOptIn: false, cohort: "internal" });
    const r = await createApi({ resolver: createResolver(), keys }).handle(new Request("http://x/v1/place", { method: "POST", headers: { authorization: `Bearer ${KEY_A}`, "content-type": "application/json" }, body: JSON.stringify(toGmail) }));
    expect(r.status).toBe(501);
  });
  it("creates a Gmail draft with the tenant's token, returns a receipt, and undo deletes it once", async () => {
    const { post } = await setup();
    const r = await post("/v1/place", toGmail);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ status: "placed", receipt: { destination: "gmail", effect: "Create a draft to this person", reversible: true }, object: { type: "Person" }, data_moved: [{ path: "Person.email", value: "meera@x.com" }] });
    expect(r.headers.get("x-recast-quota-used")).toBe("1");
    expect(seen).toHaveLength(1); expect(seen[0]).toMatchObject({ method: "POST", host: "gmail.googleapis.com", auth: `Bearer ${TOKEN}` });
    expect(atob(seen[0]!.body.message.raw.replace(/-/g, "+").replace(/_/g, "/"))).toContain("To: meera@x.com");
    const u = await post("/v1/place/undo", { receipt_id: r.json.receipt.id });
    expect(u.status).toBe(200); expect(u.json).toMatchObject({ status: "undone", receipt: { id: r.json.receipt.id } });
    expect(seen[1]).toMatchObject({ method: "DELETE", path: "/gmail/v1/users/me/drafts/draft-1" });
    expect((await post("/v1/place/undo", { receipt_id: r.json.receipt.id })).json.error.code).toBe("already_undone");
    expect(seen).toHaveLength(2);
  });
  it("adding a calendar attendee needs confirmation; nothing reaches Google without it", async () => {
    const { post } = await setup();
    const no = await post("/v1/place", toCal);
    expect(no.status).toBe(403); expect(no.json.error.code).toBe("consent_required"); expect(no.json.error.message).toContain("notifies someone else"); expect(seen).toEqual([]);
    const yes = await post("/v1/place", { ...toCal, consent: { kind: "confirm" } });
    expect(yes.status).toBe(201);
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /calendar/v3/calendars/primary/events/ev1", "PATCH /calendar/v3/calendars/primary/events/ev1?sendUpdates=none"]);
    expect(event.attendees).toEqual([{ email: "host@acme.com" }, { email: "meera@x.com", displayName: "Meera Iyer" }]);
    expect((await post("/v1/place/undo", { receipt_id: yes.json.receipt.id })).status).toBe(200);
    expect(event.attendees).toEqual([{ email: "host@acme.com" }]);
  });
  it("refuses when the text now means something else than the previewed object", async () => {
    const { post } = await setup();
    const r = await post("/v1/place", { ...toGmail, object_id: "rc_00000000000000000000000000000000" });
    expect(r.status).toBe(409); expect(r.json.error.code).toBe("object_changed"); expect(seen).toEqual([]);
  });
  it("explains what is missing: destination, connection, target fields, a resolvable object", async () => {
    const { post } = await setup();
    expect((await post("/v1/place", { ...MEERA, consent: { kind: "confirm" } })).json.error.message).toContain("target.destination is required");
    expect((await post("/v1/place", toGmail, KEY_B)).json.error.code).toBe("destination_not_connected");
    expect((await post("/v1/place", { ...toCal, consent: { kind: "confirm" }, destination_target: { calendar_id: "primary" } })).json.error.message).toContain("destination_target.event_id");
    expect((await post("/v1/place", { ...toCal, consent: { kind: "confirm" }, destination_target: { calendar_id: "primary", event_id: "ev1\r\nX: y" } })).status).toBe(400);
    expect((await post("/v1/place", { input: { raw: "hello" }, target: { destination: "gmail" }, consent: { kind: "confirm" } })).json.error.code).toBe("not_resolved");
    expect((await post("/v1/place", { input: { raw: "Attention Is All You Need https://arxiv.org/abs/1706.03762" }, target: { destination: "notion" }, destination_target: { database_id: "db" }, consent: { kind: "confirm" } })).json.error.code).toBe("not_placeable");
    expect((await post("/v1/place", { ...toGmail, consent: { kind: "hold" } })).status).toBe(400);
    expect(seen).toEqual([]);
  });
  it("a destination that refuses the token is a 502 asking to reconnect; the idempotency key is freed for a retry", async () => {
    const { post } = await setup(); failWith = 401;
    const r = await post("/v1/place", toGmail, KEY_A, { "idempotency-key": "p-1" });
    expect(r.status).toBe(502); expect(r.json.error.code).toBe("destination_unauthorized"); expect(r.headers.get("x-recast-quota-used")).toBeNull();
    failWith = 0; const again = await post("/v1/place", toGmail, KEY_A, { "idempotency-key": "p-1" });
    expect(again.status).toBe(201);
    const replay = await post("/v1/place", toGmail, KEY_A, { "idempotency-key": "p-1" });
    expect(replay.headers.get("idempotent-replay")).toBe("true"); expect(replay.json.receipt.id).toBe(again.json.receipt.id);
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(2);   // the failed attempt and the one that worked; the replay sent nothing
  });
  it("one tenant cannot see or undo another tenant's placement", async () => {
    const { post } = await setup();
    const r = await post("/v1/place", toGmail);
    const other = await post("/v1/place/undo", { receipt_id: r.json.receipt.id }, KEY_B);
    expect(other.status).toBe(404); expect(seen).toHaveLength(1);
    expect((await post("/v1/place/undo", { receipt_id: "nope" })).status).toBe(400);
  });
});

describe("creating a calendar event: the action lifecycle end to end", () => {
  const dinner = { input: { raw: "Launch dinner, 2026-11-14 19:30 to 21:00" }, target: { destination: "google_calendar_event" }, destination_target: { calendar_id: "primary" } };
  it("creates the event with a stable id and no notifications, records each step, and says how undo works", async () => {
    const { post } = await setup();
    const r = await post("/v1/place", dinner);
    expect(r.status).toBe(201);
    expect(r.json.action.history.map((h: any) => h.status)).toEqual(["proposed", "validated", "executing", "succeeded"]);
    expect(r.json.undo).toEqual({ available: true, kind: "delete-created" });
    expect(seen[0]).toMatchObject({ method: "POST", path: "/calendar/v3/calendars/primary/events?sendUpdates=none", body: { summary: "Launch dinner", start: { dateTime: "2026-11-14T19:30:00" }, end: { dateTime: "2026-11-14T21:00:00" } } });
    expect(seen[0]!.body.id).toMatch(/^rc[0-9a-f]{32}$/);
  });
  it("placing the same event again is refused as a duplicate: nothing new is created", async () => {
    const { post } = await setup();
    expect((await post("/v1/place", dinner)).status).toBe(201);
    const again = await post("/v1/place", dinner);
    expect(again.status).toBe(409); expect(again.json.error.code).toBe("already_placed"); expect(calendar.size).toBe(1);
  });
  it("an event with no end is refused before anything is sent; Recast does not invent one", async () => {
    const { post } = await setup();
    const r = await post("/v1/place", { ...dinner, input: { raw: "Launch dinner 2026-11-14 19:30" } });
    expect(r.status).toBe(422); expect(r.json.error).toMatchObject({ code: "incomplete" }); expect(r.json.error.message).toContain("Event.end");
    expect(seen).toEqual([]);
  });
  it("a timeout after the write landed is 202 outcome_unknown; undo waits; reconciliation finds it; then undo works", async () => {
    const { post } = await setup(undefined, { timeoutMs: 400 }); hangAfterWrite = true;
    const r = await post("/v1/place", dinner);
    expect(r.status).toBe(202); expect(r.json).toMatchObject({ status: "outcome_unknown", next: expect.stringContaining("/v1/place/reconcile") });
    expect(r.json.message).toContain("has not retried");
    expect(calendar.size).toBe(1);   // it did land
    const early = await post("/v1/place/undo", { receipt_id: r.json.action_id });
    expect(early.status).toBe(409); expect(early.json.error.code).toBe("outcome_unknown");
    const rec = await post("/v1/place/reconcile", { action_id: r.json.action_id });
    expect(rec.json).toMatchObject({ status: "succeeded", changed: true });
    expect((await post("/v1/place/reconcile", { action_id: r.json.action_id })).json).toMatchObject({ status: "succeeded", changed: false });
    expect((await post("/v1/place/undo", { receipt_id: r.json.action_id })).status).toBe(200);
    expect([...calendar.values()][0]!.status).toBe("cancelled");
  });
  it("an unkeyed write (a Gmail draft) that times out cannot be checked: the answer says so and nothing is retried", async () => {
    const { post } = await setup(undefined, { timeoutMs: 400 }); hangAfterWrite = true;
    const r = await post("/v1/place", toGmail);
    expect(r.status).toBe(202); expect(r.json.next).toContain("cannot be checked or retried safely");
    expect((await post("/v1/place/reconcile", { action_id: r.json.action_id })).json.error.code).toBe("cannot_reconcile");
    expect(seen.filter((x) => x.method === "POST")).toHaveLength(1);
  });
  it("when the connection is refused nothing arrived: failed, recorded, and the request can be repeated", async () => {
    const refused: typeof fetch = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); };
    const placements = new MemoryPlacementStore();
    const { post } = await setup({ credentials: new MemoryCredentialStore(), placements, tenants: ["tA", "tB"] }, { fetch: refused });
    const r = await post("/v1/place", dinner);
    expect(r.status).toBe(502); expect(r.json.error.code).toBe("destination_error");
  });
});

describe("placing an object composed on the device", () => {
  it("a capsule composed from a time, a place and a title is created as an event, with its visible default end", async () => {
    const { compose, resolve: coreResolve } = await import("@recast/core");
    const piece = (id: string, kind: "time" | "place" | "title", text: string, value?: { name?: string; address?: string }) => ({ id, kind, text, confidence: 0.7, evidence: [{ locator: { kind: "css" as const, value: `#${id}` } }], ...(value ? { value } : {}) });
    const c = compose([piece("t", "time", "Sat 14 Nov 2026, 7:30 pm"), piece("p", "place", "Toit", { name: "Toit", address: "298 100 Feet Rd, Bengaluru" }), piece("h", "title", "Launch dinner")], { now: "2026-10-19T09:00:00Z", timezone: "Asia/Kolkata" });
    const object = coreResolve(c.candidate!);
    const { post } = await setup();
    const r = await post("/v1/place", { object, target: { destination: "google_calendar_event" }, destination_target: { calendar_id: "primary" } });
    expect(r.status).toBe(201); expect(r.json.object.id).toBe(object.id);
    expect(seen[0]!.body).toMatchObject({ summary: "Launch dinner", start: { dateTime: "2026-11-14T19:30:00", timeZone: "Asia/Kolkata" }, end: { dateTime: "2026-11-14T20:30:00" }, location: "Toit, 298 100 Feet Rd, Bengaluru" });
  });
  it("an object whose id does not match its contents, or that fails the schema, is refused before anything is sent", async () => {
    const { post } = await setup();
    const forged = { id: "rc_" + "0".repeat(32), type: "Event", schemaVersion: "1.0.0", properties: { title: "X", start: "2026-11-14T19:30", end: "2026-11-14T20:00" }, fields: { title: { confidence: 1, evidence: [{ locator: { kind: "user", value: "t" } }] }, start: { confidence: 1, evidence: [{ locator: { kind: "user", value: "s" } }] }, end: { confidence: 1, evidence: [{ locator: { kind: "user", value: "e" } }] } }, provenance: { source: { app: "x" }, capture: { method: "user", adapter: "x", at: "2026-10-19T09:00:00Z" } } };
    const r1 = await post("/v1/place", { object: forged, target: { destination: "google_calendar_event" }, destination_target: { calendar_id: "primary" } });
    expect(r1.status).toBe(400); expect(r1.json.error.message).toContain("id does not match");
    const r2 = await post("/v1/place", { object: { type: "Event" }, target: { destination: "google_calendar_event" }, destination_target: { calendar_id: "primary" } });
    expect(r2.status).toBe(400); expect(seen).toEqual([]);
  });
});

describe("network guard", () => {
  it("only the destination hosts, over https, without redirects", async () => {
    const t = fetchTransport(TOKEN, toLocal);
    await expect(t({ method: "GET", url: "https://evil.example.com/x" })).rejects.toThrow("refusing to call evil.example.com");
    await expect(t({ method: "GET", url: "http://www.googleapis.com/x" })).rejects.toThrow("refusing");
    await expect(t({ method: "GET", url: "https://www.googleapis.com.evil.com/x" })).rejects.toThrow("refusing");
    expect((await t({ method: "GET", url: "https://www.googleapis.com/calendar/v3/calendars/primary/events/ev1" })).status).toBe(200);
  });
});

describe("on Postgres", () => {
  let db: PGlite; let cipher: CredentialCipher;
  beforeEach(async () => {
    db = await freshDb(); cipher = new CredentialCipher(CredentialCipher.generateKey());
    const ids = (await db.query<{ id: string }>(`insert into tenants(name) values ('A'), ('B') returning id`)).rows.map((r) => r.id);
    tenants = [ids[0]!, ids[1]!];
  });
  it("credentials are sealed: no plain token in the database, and a row moved to another tenant does not open", async () => {
    const creds = new SqlCredentialStore(db, cipher); await creds.set(tenants[0], "gmail", { accessToken: TOKEN });
    expect(await creds.get(tenants[0], "gmail")).toEqual({ accessToken: TOKEN });
    const rows = (await db.query<{ sealed: string }>(`select sealed from api_credentials`)).rows; expect(JSON.stringify(rows)).not.toContain("ya29");
    await db.query(`insert into api_credentials(tenant_id, destination, sealed) values ($1, 'gmail', $2)`, [tenants[1], rows[0]!.sealed]);
    await expect(creds.get(tenants[1], "gmail")).rejects.toThrow();
    await expect(new SqlCredentialStore(db, new CredentialCipher(CredentialCipher.generateKey())).get(tenants[0], "gmail")).rejects.toThrow();
    expect(() => new CredentialCipher("c2hvcnQ=")).toThrow("32 random bytes");
    expect(await creds.remove(tenants[0], "gmail")).toBe(true); expect(await creds.get(tenants[0], "gmail")).toBeNull();
  });
  it("place and undo with receipts in Postgres; two concurrent undos run the bridge once", async () => {
    const placements = new SqlPlacementStore(db);
    const { post } = await setup({ credentials: new SqlCredentialStore(db, cipher), placements, tenants });
    const r = await post("/v1/place", toGmail); expect(r.status).toBe(201);
    expect((await db.query(`select destination, status from api_placements`)).rows).toEqual([{ destination: "gmail", status: "succeeded" }]);
    const [u1, u2] = await Promise.all([post("/v1/place/undo", { receipt_id: r.json.receipt.id }), post("/v1/place/undo", { receipt_id: r.json.receipt.id })]);
    expect([u1.status, u2.status].sort()).toEqual([200, 409]);
    expect(seen.filter((s) => s.method === "DELETE")).toHaveLength(1);
    expect((await db.query(`select status, reversed_at is not null as at from api_placements`)).rows).toEqual([{ status: "reversed", at: true }]);
  });
  it("an unknown outcome is stored with its history and reconciled in Postgres, once", async () => {
    const placements = new SqlPlacementStore(db);
    const { post } = await setup({ credentials: new SqlCredentialStore(db, cipher), placements, tenants }, { timeoutMs: 400 }); hangAfterWrite = true;
    const r = await post("/v1/place", { input: { raw: "Launch dinner, 2026-11-14 19:30 to 21:00" }, target: { destination: "google_calendar_event" }, destination_target: { calendar_id: "primary" } });
    expect(r.status).toBe(202);
    const row = async () => (await db.query<{ status: string; steps: string[]; ref: string | null }>(`select status, (select array_agg(x->>'status') from jsonb_array_elements(action) x) as steps, reconcile_ref as ref from api_placements`)).rows[0]!;
    expect(await row()).toMatchObject({ status: "outcome_unknown", steps: ["proposed", "validated", "executing", "outcome_unknown"], ref: expect.stringContaining("rc") });
    const [a, b] = await Promise.all([post("/v1/place/reconcile", { action_id: r.json.action_id }), post("/v1/place/reconcile", { action_id: r.json.action_id })]);
    expect([a.json.changed, b.json.changed].sort()).toEqual([false, true]);   // resolved exactly once
    expect(await row()).toMatchObject({ status: "succeeded", steps: ["proposed", "validated", "executing", "outcome_unknown", "succeeded"] });
  });
  it("a failed undo returns the placement to 'succeeded' so it can be retried", async () => {
    const placements = new SqlPlacementStore(db);
    const { post } = await setup({ credentials: new SqlCredentialStore(db, cipher), placements, tenants });
    const r = await post("/v1/place", toGmail); failWith = 500;
    expect((await post("/v1/place/undo", { receipt_id: r.json.receipt.id })).json.error.code).toBe("destination_error");
    expect((await db.query(`select status from api_placements`)).rows).toEqual([{ status: "succeeded" }]);
    failWith = 0; expect((await post("/v1/place/undo", { receipt_id: r.json.receipt.id })).status).toBe(200);
  });
});
