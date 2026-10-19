// SDK place/undo against the real API core over real HTTP; Google is a local stand-in reached through the API's fetch.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryCredentialStore, MemoryKeyStore, MemoryPlacementStore, createApi } from "@recast/api-core";
import { createResolver } from "@recast/resolve";
import { DestinationError, Recast, ValidationError } from "../src";

let api: Server, google: Server, base: string; let drafts = 0; let googleDown = false;
const KEY = "sk_test_sdk_place_0001";
const listen = async (s: Server) => { await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok)); return (s.address() as { port: number }).port; };
beforeAll(async () => {
  google = createServer((q, r) => {
    if (googleDown) { r.writeHead(401).end("{}"); return; }
    if (q.method === "POST") { drafts++; r.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "d1" })); return; }
    if (q.method === "DELETE") { drafts--; r.writeHead(204).end(); return; }
    r.writeHead(404).end();
  });
  const gport = await listen(google);
  const keys = new MemoryKeyStore(); await keys.add(KEY, { tenantId: "t1", tier: "pro", correctionsOptIn: false });
  const credentials = new MemoryCredentialStore(); await credentials.set("t1", "gmail", { accessToken: "tok" });
  const core = createApi({ resolver: createResolver(), keys, placement: { credentials, placements: new MemoryPlacementStore(), fetch: (u, i) => { const x = new URL(String(u)); return fetch(`http://127.0.0.1:${gport}${x.pathname}`, i); } } });
  api = createServer(async (q, r) => {
    const chunks: Buffer[] = []; for await (const c of q) chunks.push(c as Buffer);
    const res = await core.handle(new Request(`http://localhost${q.url}`, { method: q.method!, headers: q.headers as Record<string, string>, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }));
    r.writeHead(res.status, Object.fromEntries(res.headers)); r.end(await res.text());
  });
  base = `http://127.0.0.1:${await listen(api)}`;
});
afterAll(() => { api?.close(); google?.close(); });

describe("SDK placements", () => {
  const sdk = () => new Recast({ apiKey: KEY, baseUrl: base, sleep: async () => {} });
  it("resolve to preview, then place with the previewed object id and the consent the route asked for, then undo", async () => {
    const s = sdk(); const preview = await s.resolve({ raw: "Meera Iyer, meera@x.com", target: { destination: "gmail" } });
    if (preview.status !== "resolved" || !preview.routing) throw new Error("no route");
    const p = await s.place({ raw: "Meera Iyer, meera@x.com", destination: "gmail", consent: preview.routing.consent === "hold" ? { kind: "hold", heldMs: 600 } : preview.routing.consent, objectId: preview.object.id });
    if (p.status !== "placed") throw new Error("not placed");
    expect(p.history.map((h) => h.status)).toEqual(["proposed", "validated", "executing", "succeeded"]);
    expect(p).toMatchObject({ receipt: { destination: "gmail", effect: "Create a draft to this person", reversible: true }, object: { id: preview.object.id, type: "Person" }, dataMoved: [{ path: "Person.email", value: "meera@x.com" }] });
    expect(drafts).toBe(1);
    expect((await s.placements.undo(p.receipt.id)).id).toBe(p.receipt.id); expect(drafts).toBe(0);
    await expect(s.placements.undo(p.receipt.id)).rejects.toMatchObject({ code: "already_undone" });
  });
  it("without consent nothing moves and the error says why", async () => {
    const e = await sdk().place({ raw: "Meera Iyer, meera@x.com", destination: "gmail" }).catch((x) => x);
    expect(e).toBeInstanceOf(ValidationError); expect(e.code).toBe("consent_required"); expect(drafts).toBe(0);
  });
  it("a destination that refuses the credential is a DestinationError, raised at once (no retries)", async () => {
    googleDown = true; let calls = 0;
    const s = new Recast({ apiKey: KEY, baseUrl: base, sleep: async () => {}, fetch: (u, i) => { calls++; return fetch(u, i); } });
    const e = await s.place({ raw: "Meera Iyer, meera@x.com", destination: "gmail", consent: "confirm" }).catch((x) => x);
    googleDown = false;
    expect(e).toBeInstanceOf(DestinationError); expect(e.code).toBe("destination_unauthorized"); expect(calls).toBe(1);
  });
});

describe("SDK: an unknown outcome is not a success", () => {
  it("a 202 becomes { status: 'outcome_unknown' } with what to do next, and reconcile reports the answer", async () => {
    const calls: string[] = [];
    const stub: typeof fetch = async (u) => {
      calls.push(String(u));
      const body = String(u).endsWith("/v1/place") ? { status: "outcome_unknown", action_id: "rc_r_" + "a".repeat(32), message: "x did not answer. Recast has not retried it.", next: "POST /v1/place/reconcile with this action_id" }
        : { status: "succeeded", action_id: "rc_r_" + "a".repeat(32), changed: true };
      return new Response(JSON.stringify(body), { status: String(u).endsWith("/v1/place") ? 202 : 200, headers: { "content-type": "application/json" } });
    };
    const s = new Recast({ apiKey: KEY, baseUrl: "https://api.test", fetch: stub, sleep: async () => {} });
    const r = await s.place({ raw: "Launch dinner, 2026-11-14 19:30 to 21:00", destination: "google_calendar_event", target: { calendar_id: "primary" } });
    expect(r).toEqual({ status: "outcome_unknown", actionId: "rc_r_" + "a".repeat(32), message: "x did not answer. Recast has not retried it.", next: "POST /v1/place/reconcile with this action_id" });
    expect(await s.placements.reconcile("rc_r_" + "a".repeat(32))).toEqual({ status: "succeeded", changed: true });
    expect(calls).toEqual(["https://api.test/v1/place", "https://api.test/v1/place/reconcile"]);   // one request each: no retry of the write
  });
});
