// Outlook Calendar through the local program. MOCKED PROVIDER: Microsoft's sign-in endpoints and Graph are in-process
// stand-ins; no real Microsoft service is contacted. The real run is docs/REAL_TEST_PLAN.md section M.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { plan, propose, resolve, type Operation } from "@recast/core";
import { CONTRACTS, OUTLOOK_KEY_PROP } from "@recast/bridges";
import { createLink } from "../src/server.js";

const MS_ID = "1b2c3d4e-0000-4000-8000-000000000001";
const EXT = `chrome-extension://${"a".repeat(32)}`;
const dir = mkdtempSync(path.join(tmpdir(), "recast-ms-")); const tokenFile = path.join(dir, ".secrets", "google-token.json");
const msFile = path.join(dir, ".secrets", "microsoft-token.json");
const tokenCalls: URLSearchParams[] = []; let tokenAnswer: { status: number; json: Record<string, unknown> } = { status: 200, json: {} };
const events = new Map<string, Record<string, any>>(); let n = 0; let graphStatus = 0;
const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fakeFetch: typeof fetch = async (u, init) => {
  const url = new URL(String(u)); const method = init?.method ?? "GET";
  if (url.hostname === "login.test") { tokenCalls.push(new URLSearchParams(String(init?.body))); return json(tokenAnswer.status, tokenAnswer.json); }
  expect(url.origin).toBe("https://graph.microsoft.com");
  expect((init?.headers as Record<string, string>).authorization).toMatch(/^Bearer MS-AT/);
  if (graphStatus) return json(graphStatus, { error: { code: "x" } });
  if (method === "GET" && url.pathname === "/v1.0/me/events") { const key = /ep\/value eq '([^']+)'/.exec(url.searchParams.get("$filter") ?? "")?.[1]; return json(200, { value: [...events.values()].filter((e) => e.singleValueExtendedProperties[0].value === key).map((e) => ({ id: e.id })) }); }
  if (method === "POST") { const b = JSON.parse(String(init!.body)); const id = `AAMk${++n}`; events.set(id, { ...b, id, webLink: `https://outlook.office365.com/owa/?itemid=${id}` }); return json(201, events.get(id)); }
  const id = url.pathname.split("/events/")[1]!;
  if (method === "GET") return events.has(id) ? json(200, events.get(id)) : json(404, {});
  if (method === "DELETE") { events.delete(id); return json(204, null); }
  return json(400, {});
};
let server: Server, base: string, direct: ReturnType<typeof createLink>["direct"], port = 0;
beforeAll(async () => {
  const probe = createLink({ clientId: "g.apps.googleusercontent.com", clientSecret: "s", port: 0, tokenFile }).server;
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r)); port = (probe.address() as { port: number }).port; probe.close();
  const link = createLink({ clientId: "g.apps.googleusercontent.com", clientSecret: "GOOGLE-SECRET", port, tokenFile, fetch: fakeFetch, microsoftClientId: MS_ID, msAuthUrl: "https://login.test/authorize", msTokenUrl: "https://login.test/token" });
  server = link.server; direct = link.direct;
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r)); base = `http://localhost:${port}`;
});
afterAll(() => { server?.close(); });
const get = (p: string, headers: Record<string, string> = {}) => fetch(`${base}${p}`, { redirect: "manual", headers });
function eventOp(): Operation {
  const properties = { title: "Design review", start: "2026-10-29T16:00", end: "2026-10-29T17:00", timezone: "Asia/Kolkata", location: "Dakshin" };
  const o = resolve({ type: "Event", properties, fields: Object.fromEntries(Object.keys(properties).map((k) => [k, { confidence: 0.9, evidence: [{ locator: { kind: "css", value: `#${k}` } }] }])), provenance: { source: { app: "t" }, capture: { method: "composition", adapter: "compose", at: "2026-10-26T08:00:00Z" } } });
  return plan(propose(o, CONTRACTS.outlookCalendarEvent)[0]!, { now: () => "2026-10-26T09:00:00Z" });
}

describe("Outlook Calendar sign-in and placement through the local program (Microsoft stand-ins)", () => {
  it("before signing in, the page offers it, and placing is refused with the reason", async () => {
    expect(await (await get("/")).text()).toContain("Sign in with Microsoft");
    expect((await direct("commit", { destination: "outlook", op: eventOp(), consent: { kind: "release" } })).body).toMatchObject({ outcome: "failed", message: "Outlook Calendar is not connected. Sign in with Microsoft on the Recast page first." });
  });
  it("the sign-in: PKCE S256, one narrow permission plus renewal, a one-time state in an HttpOnly cookie, no client secret anywhere", async () => {
    const r = await get("/microsoft/start"); const loc = new URL(r.headers.get("location")!);
    expect(Object.fromEntries(loc.searchParams)).toMatchObject({ client_id: MS_ID, response_type: "code", redirect_uri: `http://localhost:${port}/microsoft/callback`, scope: "offline_access Calendars.ReadWrite", code_challenge_method: "S256" });
    const cookie = r.headers.get("set-cookie")!.split(";")[0]!; expect(r.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Lax; Path=\/microsoft; Max-Age=600/);
    const state = loc.searchParams.get("state")!;
    expect((await get(`/microsoft/callback?code=C&state=${state}`)).status).toBe(400);   // no cookie: refused (and the state is spent)
    const s2 = await get("/microsoft/start"); const loc2 = new URL(s2.headers.get("location")!); const c2 = s2.headers.get("set-cookie")!.split(";")[0]!;
    tokenAnswer = { status: 200, json: { access_token: "MS-AT-1", refresh_token: "MS-RT-1", expires_in: 3600, scope: "Calendars.ReadWrite openid" } };
    const ok = await get(`/microsoft/callback?code=CODE-MS&state=${loc2.searchParams.get("state")}`, { cookie: c2 });
    const html = await ok.text(); expect(ok.status).toBe(200); expect(html).toContain("Connected to Outlook Calendar.");
    for (const leak of ["MS-AT-1", "MS-RT-1", "CODE-MS", "GOOGLE-SECRET"]) expect(html).not.toContain(leak);
    const call = tokenCalls.at(-1)!;
    expect(Object.fromEntries(call)).toMatchObject({ grant_type: "authorization_code", code: "CODE-MS", client_id: MS_ID });
    expect(call.has("client_secret")).toBe(false);
    expect(createHash("sha256").update(call.get("code_verifier")!).digest("base64url")).toBe(loc2.searchParams.get("code_challenge"));
    if (process.platform !== "win32") expect(statSync(msFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(msFile, "utf8"))).toMatchObject({ access_token: "MS-AT-1", refresh_token: "MS-RT-1" });
    void cookie;
  });
  it("a sign-in without the calendar permission is not saved", async () => {
    const before = readFileSync(msFile, "utf8");
    const s = await get("/microsoft/start"); const loc = new URL(s.headers.get("location")!);
    tokenAnswer = { status: 200, json: { access_token: "MS-AT-X", scope: "openid profile" } };
    const r = await get(`/microsoft/callback?code=C&state=${loc.searchParams.get("state")}`, { cookie: s.headers.get("set-cookie")!.split(";")[0]! });
    expect(await r.text()).toContain("The calendar permission was not granted"); expect(readFileSync(msFile, "utf8")).toBe(before);
  });
  it("placed in Outlook, read back with its link, refused a second time, checked by key, undone", async () => {
    const op = eventOp();
    expect((await direct("status", {})).body).toMatchObject({ outlook: true });
    const r = await direct("commit", { destination: "outlook", op, consent: { kind: "release" } });
    expect(r.body.outcome).toBe("done");
    const ev = [...events.values()][0]!; expect(ev).toMatchObject({ subject: "Design review", start: { dateTime: "2026-10-29T16:00:00", timeZone: "Asia/Kolkata" } });
    expect(ev.singleValueExtendedProperties[0].id).toBe(OUTLOOK_KEY_PROP);
    const v = (await direct("verify", { destination: "outlook", op, receipt: r.body.receipt })).body.verification as Record<string, unknown>;
    expect(v).toMatchObject({ ok: true, link: "https://outlook.office365.com/owa/?itemid=AAMk1" });
    expect((await direct("commit", { destination: "outlook", op, consent: { kind: "release" } })).body).toEqual({ outcome: "failed", message: "It is already in your Outlook Calendar, so it was not added a second time" });
    expect((await direct("reconcile", { destination: "outlook", op })).body).toMatchObject({ found: true });
    expect((await direct("undo", { destination: "outlook", receipt: r.body.receipt })).body).toEqual({ outcome: "undone" });
    expect(events.size).toBe(0);
    expect((await direct("reconcile", { destination: "outlook", op })).body).toEqual({ found: false });
  });
  it("Microsoft refusing the sign-in is said plainly; the access token is renewed when it expires", async () => {
    graphStatus = 401;
    expect((await direct("commit", { destination: "outlook", op: eventOp(), consent: { kind: "release" } })).body).toEqual({ outcome: "failed", message: "Microsoft no longer accepts this sign-in (expired or revoked). Sign in with Microsoft again on the Recast page" });
    graphStatus = 0;
    const t = JSON.parse(readFileSync(msFile, "utf8")); t.expires_at = 0; (await import("node:fs")).writeFileSync(msFile, JSON.stringify(t));
    tokenAnswer = { status: 200, json: { access_token: "MS-AT-2", expires_in: 3600, scope: "Calendars.ReadWrite" } };
    expect((await direct("commit", { destination: "outlook", op: eventOp(), consent: { kind: "release" } })).body.outcome).toBe("done");
    expect(Object.fromEntries(tokenCalls.at(-1)!)).toMatchObject({ grant_type: "refresh_token", refresh_token: "MS-RT-1" });
    expect(JSON.parse(readFileSync(msFile, "utf8"))).toMatchObject({ access_token: "MS-AT-2", refresh_token: "MS-RT-1" });
  });
  it("Disconnect removes the sign-in from this computer; another site cannot press it", async () => {
    expect((await fetch(`${base}/microsoft/disconnect`, { method: "POST", redirect: "manual", headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect(existsSync(msFile)).toBe(true);
    expect((await fetch(`${base}/microsoft/disconnect`, { method: "POST", redirect: "manual", headers: { origin: base } })).status).toBe(303);
    expect(existsSync(msFile)).toBe(false);
  });
});
