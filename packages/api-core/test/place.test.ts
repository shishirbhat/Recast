// POST /v1/place and /v1/place/undo against a fake Google API over real HTTP. The bridges, consent checks, credential
// sealing and receipts are the real ones; only Google is played by a local server.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { PGlite } from "@electric-sql/pglite";
import { freshDb } from "@recast/store/testing";
import { createResolver } from "@recast/resolve";
import {
  CredentialCipher, MemoryCredentialStore, MemoryIdempotencyStore, MemoryKeyStore, MemoryPlacementStore, SqlCredentialStore, SqlPlacementStore,
  createApi, fetchTransport, type CredentialStore, type PlacementStore,
} from "../src";

const TOKEN = "ya29.fake-google-token"; const KEY_A = "sk_test_place_tenant_a1", KEY_B = "sk_test_place_tenant_b1";
type Seen = { method: string; host: string; path: string; auth?: string; body?: any };
let google: Server, port: number; let seen: Seen[] = []; let event: { attendees: { email: string }[]; location: string }; let failWith = 0;
beforeAll(async () => {
  google = createServer(async (q, r) => {
    const chunks: Buffer[] = []; for await (const c of q) chunks.push(c as Buffer);
    const [, host, ...rest] = (q.url ?? "").split("/"); const path = "/" + rest.join("/");
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    seen.push({ method: q.method!, host: host!, path, auth: q.headers.authorization, body });
    const send = (status: number, json?: unknown) => { r.writeHead(status, { "content-type": "application/json" }).end(json === undefined ? "" : JSON.stringify(json)); };
    if (failWith) return send(failWith, { error: { message: "nope" } });
    if (q.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "bad token" });
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
async function setup(stores?: { credentials: CredentialStore; placements: PlacementStore; tenants: [string, string] }) {
  seen = []; failWith = 0; event = { attendees: [{ email: "host@acme.com" }], location: "Old place" };
  tenants = stores?.tenants ?? ["tA", "tB"];
  const keys = new MemoryKeyStore();
  await keys.add(KEY_A, { tenantId: tenants[0], tier: "pro", correctionsOptIn: false }); await keys.add(KEY_B, { tenantId: tenants[1], tier: "pro", correctionsOptIn: false });
  const credentials = stores?.credentials ?? new MemoryCredentialStore(); const placements = stores?.placements ?? new MemoryPlacementStore();
  await credentials.set(tenants[0], "gmail", { accessToken: TOKEN }); await credentials.set(tenants[0], "google_calendar", { accessToken: TOKEN });
  const api = createApi({ resolver: createResolver(), keys, idempotency: new MemoryIdempotencyStore(), placement: { credentials, placements, fetch: toLocal } });
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
    const keys = new MemoryKeyStore(); await keys.add(KEY_A, { tenantId: "tA", tier: "pro", correctionsOptIn: false });
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
    expect((await db.query(`select destination, status from api_placements`)).rows).toEqual([{ destination: "gmail", status: "done" }]);
    const [u1, u2] = await Promise.all([post("/v1/place/undo", { receipt_id: r.json.receipt.id }), post("/v1/place/undo", { receipt_id: r.json.receipt.id })]);
    expect([u1.status, u2.status].sort()).toEqual([200, 409]);
    expect(seen.filter((s) => s.method === "DELETE")).toHaveLength(1);
    expect((await db.query(`select status, undone_at is not null as at from api_placements`)).rows).toEqual([{ status: "undone", at: true }]);
  });
  it("a failed undo returns the placement to 'done' so it can be retried", async () => {
    const placements = new SqlPlacementStore(db);
    const { post } = await setup({ credentials: new SqlCredentialStore(db, cipher), placements, tenants });
    const r = await post("/v1/place", toGmail); failWith = 500;
    expect((await post("/v1/place/undo", { receipt_id: r.json.receipt.id })).json.error.code).toBe("destination_error");
    expect((await db.query(`select status from api_placements`)).rows).toEqual([{ status: "done" }]);
    failWith = 0; expect((await post("/v1/place/undo", { receipt_id: r.json.receipt.id })).status).toBe(200);
  });
});
