// The test-event buttons over real HTTP, with Google (token endpoint and Calendar API) replaced by a stand-in that keeps
// events by id the way the real API does. Real-Google runs are done by hand from the page (see README, Part 5).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { createLinkServer, SCOPE } from "../src/server.js";

const SECRET = "test-secret-should-never-leak";
const dir = mkdtempSync(path.join(tmpdir(), "recast-test-event-"));
const tokenFile = path.join(dir, ".secrets", "google-token.json");
let clock = Date.parse("2026-10-21T09:00:00Z");
const events = new Map<string, Record<string, unknown>>();
const seen: { url: string; method: string; auth?: string; body?: string }[] = [];
const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fakeGoogle: typeof fetch = async (u, init) => {
  const url = String(u); const method = init?.method ?? "GET"; const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
  seen.push({ url, method, ...(auth ? { auth } : {}), ...(init?.body ? { body: String(init.body) } : {}) });
  if (url === "https://google.test/token") return json(200, { access_token: "AT-new", expires_in: 3600, token_type: "Bearer" });
  if (auth !== "Bearer AT-new") return json(401, { error: { message: "bad token" } });
  const id = decodeURIComponent(url.split("/events/")[1]?.split("?")[0] ?? "");
  if (method === "POST") { const b = JSON.parse(String(init!.body)) as { id: string }; if (events.has(b.id)) return json(409, {}); events.set(b.id, { ...b, status: "confirmed" }); return json(200, events.get(b.id)); }
  if (method === "GET") return events.has(id) ? json(200, events.get(id)) : json(404, {});
  if (method === "PUT") { events.set(id, JSON.parse(String(init!.body))); return json(200, events.get(id)); }
  if (method === "DELETE") { if (!events.has(id)) return json(410, {}); events.set(id, { ...events.get(id)!, status: "cancelled" }); return json(204, null); }
  return json(400, {});
};
const live = () => [...events.values()].filter((e) => e.status !== "cancelled");

let server: Server, base: string;
beforeAll(async () => {
  mkdirSync(path.dirname(tokenFile), { recursive: true });
  // An expired access token with a refresh token: the first call must renew it.
  writeFileSync(tokenFile, JSON.stringify({ access_token: "AT-old", refresh_token: "RT-1", expires_at: clock - 1000, scope: SCOPE, token_type: "Bearer", connected_at: "x" }));
  const probe = createLinkServer({ clientId: "abc.apps.googleusercontent.com", clientSecret: SECRET, port: 0, tokenFile });
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r)); const port = (probe.address() as { port: number }).port; probe.close();
  server = createLinkServer({ clientId: "abc.apps.googleusercontent.com", clientSecret: SECRET, port, tokenFile, fetch: fakeGoogle, tokenUrl: "https://google.test/token", now: () => clock });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r)); base = `http://localhost:${port}`;
});
afterAll(() => { server?.close(); });

async function press(action: string, origin = base) {
  const r = await fetch(`${base}/test/${action}`, { method: "POST", redirect: "manual", headers: { origin } });
  if (r.status !== 303) return { status: r.status, text: "" };
  const page = await (await fetch(base)).text();
  return { status: r.status, text: /role="status">([^<]*)</.exec(page)?.[1] ?? "", page };
}

describe("test event against a stand-in Google Calendar", () => {
  it("Place renews the expired permission, adds one event tomorrow 10:00, and shows no token or secret", async () => {
    const r = await press("place");
    expect(r.text).toMatch(/^Placed/);
    expect(live()).toHaveLength(1);
    expect(live()[0]).toMatchObject({ summary: "Recast test event", location: "Dakshin, 12 MG Road, Bengaluru" });
    expect(seen[0]).toMatchObject({ url: "https://google.test/token" }); expect(new URLSearchParams(seen[0]!.body).get("grant_type")).toBe("refresh_token");
    expect(JSON.parse(readFileSync(tokenFile, "utf8"))).toMatchObject({ access_token: "AT-new", refresh_token: "RT-1" });
    for (const leak of [SECRET, "AT-new", "RT-1"]) expect(r.page).not.toContain(leak);
  });
  it("pressing Place again does not add a second event", async () => {
    expect((await press("place")).text).toMatch(/already in your calendar/);
    expect(live()).toHaveLength(1);
  });
  it("Check asks Google; Undo removes it; Check then says it is gone", async () => {
    expect((await press("check")).text).toMatch(/is in your calendar/);
    expect((await press("undo")).text).toMatch(/^Undone/);
    expect(live()).toHaveLength(0);
    expect((await press("check")).text).toMatch(/is not in your calendar/);
  });
  it("a lost answer: the write lands, Recast says it does not know, Check finds it, Undo still removes it", async () => {
    expect((await press("lost")).text).toMatch(/does not know/);
    expect(live()).toHaveLength(1);
    expect((await press("check")).text).toMatch(/is in your calendar/);
    expect((await press("place")).text).toMatch(/already in your calendar/);
    expect(live()).toHaveLength(1);
    expect((await press("undo")).text).toMatch(/Removed/);
    expect(live()).toHaveLength(0);
  });
  it("another site cannot press the buttons", async () => {
    expect((await press("place", "https://evil.example")).status).toBe(403);
    expect(live()).toHaveLength(0);
  });
});
