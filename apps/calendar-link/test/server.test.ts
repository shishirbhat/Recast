// The sign-in server over real HTTP on 127.0.0.1, with Google's token endpoint replaced by a stand-in (no real Google is
// contacted; that needs your OAuth app). Checks the security properties, not just the happy path.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { createLinkServer, GMAIL_SCOPE, SCOPE } from "../src/server.js";

const SECRET = "test-secret-should-never-leak";
const dir = mkdtempSync(path.join(tmpdir(), "recast-link-"));
const tokenFile = path.join(dir, ".secrets", "google-token.json");
const calls: { url: string; body: URLSearchParams }[] = [];
let tokenAnswer: { status: number; json: Record<string, unknown> } = { status: 200, json: {} };
const fakeFetch: typeof fetch = async (u, init) => {
  calls.push({ url: String(u), body: new URLSearchParams(String(init?.body ?? "")) });
  return new Response(JSON.stringify(tokenAnswer.json), { status: tokenAnswer.status, headers: { "content-type": "application/json" } });
};
let server: Server, port: number, base: string;
beforeAll(async () => {
  server = createLinkServer({ clientId: "abc.apps.googleusercontent.com", clientSecret: SECRET, port: 0, tokenFile, fetch: fakeFetch, tokenUrl: "https://google.test/token", revokeUrl: "https://google.test/revoke" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); port = (server.address() as { port: number }).port;
  // Rebuild with the real port, since the redirect URI and Host check use it.
  server.close();
  server = createLinkServer({ clientId: "abc.apps.googleusercontent.com", clientSecret: SECRET, port, tokenFile, fetch: fakeFetch, tokenUrl: "https://google.test/token", revokeUrl: "https://google.test/revoke" });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r)); base = `http://localhost:${port}`;
});
afterAll(() => { server?.close(); });

const get = (p: string, headers: Record<string, string> = {}) => fetch(`${base}${p}`, { redirect: "manual", headers });
async function start() {
  const r = await get("/oauth/start"); const loc = new URL(r.headers.get("location")!);
  const cookie = r.headers.get("set-cookie")!.split(";")[0]!;
  return { r, loc, cookie, state: loc.searchParams.get("state")! };
}

describe("Google Calendar sign-in (local server, stand-in Google)", () => {
  it("the start redirects to Google with one narrow scope, PKCE S256, a one-time state in an HttpOnly cookie, and the exact redirect URI", async () => {
    const { r, loc, cookie } = await start();
    expect(r.status).toBe(302);
    expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(loc.searchParams)).toMatchObject({ client_id: "abc.apps.googleusercontent.com", redirect_uri: `http://localhost:${port}/oauth/callback`, response_type: "code", scope: `${SCOPE} ${GMAIL_SCOPE}`, code_challenge_method: "S256", access_type: "offline" });
    expect(loc.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Lax; Path=\/oauth; Max-Age=600/);
    expect(cookie).toMatch(/^recast_oauth_state=/);
    expect(loc.toString()).not.toContain(SECRET);
  });
  it("a callback without the matching cookie, with an unknown state, or used twice is refused, and nothing is saved", async () => {
    const { state } = await start();
    expect((await get(`/oauth/callback?code=x&state=${state}`)).status).toBe(400);                       // no cookie
    const s2 = await start();
    expect((await get(`/oauth/callback?code=x&state=forged`, { cookie: s2.cookie })).status).toBe(400);  // wrong state
    expect(existsSync(tokenFile)).toBe(false); expect(calls).toHaveLength(0);
  });
  it("a good callback exchanges the code with the secret and the PKCE verifier (server to Google only), and stores the token privately", async () => {
    tokenAnswer = { status: 200, json: { access_token: "AT-1", refresh_token: "RT-1", expires_in: 3599, scope: SCOPE, token_type: "Bearer" } };
    const { loc, cookie, state } = await start();
    const r = await get(`/oauth/callback?code=CODE-1&state=${state}`, { cookie });
    const html = await r.text();
    expect(r.status).toBe(200); expect(html).toContain("Connected");
    for (const leak of [SECRET, "AT-1", "RT-1", "CODE-1"]) expect(html).not.toContain(leak);
    const call = calls.at(-1)!;
    expect(call.url).toBe("https://google.test/token");
    expect(Object.fromEntries(call.body)).toMatchObject({ grant_type: "authorization_code", code: "CODE-1", client_secret: SECRET, redirect_uri: `http://localhost:${port}/oauth/callback` });
    // The verifier matches the challenge sent to Google.
    const { createHash } = await import("node:crypto");
    const challenge = createHash("sha256").update(call.body.get("code_verifier")!).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(challenge).toBe(loc.searchParams.get("code_challenge"));
    expect(JSON.parse(readFileSync(tokenFile, "utf8"))).toMatchObject({ access_token: "AT-1", refresh_token: "RT-1", scope: SCOPE });
    if (process.platform !== "win32") expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    // The same state cannot be used again.
    expect((await get(`/oauth/callback?code=CODE-1&state=${state}`, { cookie })).status).toBe(400);
    // The home page says connected, and shows no token.
    const home = await (await get("/")).text(); expect(home).toContain("Connected."); expect(home).not.toContain("AT-1");
  });
  it("Google's refusals are explained in plain words without echoing anything secret", async () => {
    tokenAnswer = { status: 401, json: { error: "invalid_client", error_description: "secret mismatch" } };
    const { cookie, state } = await start();
    const html = await (await get(`/oauth/callback?code=C&state=${state}`, { cookie })).text();
    expect(html).toContain("The client ID or secret in your .env file does not match Google's"); expect(html).not.toContain(SECRET);
  });
  it("a sign-in without the calendar permission ticked is not saved as connected", async () => {
    tokenAnswer = { status: 200, json: { access_token: "AT-2", expires_in: 3600, scope: "openid", token_type: "Bearer" } };
    const before = readFileSync(tokenFile, "utf8");
    const { cookie, state } = await start();
    const html = await (await get(`/oauth/callback?code=C&state=${state}`, { cookie })).text();
    expect(html).toContain("calendar permission was not granted"); expect(readFileSync(tokenFile, "utf8")).toBe(before);
  });
  it("only answers to localhost by name (DNS rebinding), and Disconnect is refused from another site", async () => {
    // fetch() ignores a Host header, so send the forged name with a raw request, as a rebinding page's browser would.
    const { request } = await import("node:http");
    const status = await new Promise<number>((ok, no) => { const q = request({ host: "127.0.0.1", port, path: "/", headers: { host: `evil.example:${port}` } }, (r) => { r.resume(); ok(r.statusCode!); }); q.on("error", no); q.end(); });
    expect(status).toBe(421);
    const r = await fetch(`${base}/disconnect`, { method: "POST", redirect: "manual", headers: { origin: "https://evil.example" } });
    expect(r.status).toBe(403); expect(existsSync(tokenFile)).toBe(true);
  });
  it("Disconnect revokes the permission at Google and deletes the local token", async () => {
    const r = await fetch(`${base}/disconnect`, { method: "POST", redirect: "manual", headers: { origin: base } });
    expect(r.status).toBe(303); expect(existsSync(tokenFile)).toBe(false);
    expect(calls.at(-1)).toMatchObject({ url: "https://google.test/revoke" }); expect(calls.at(-1)!.body.get("token")).toBe("RT-1");
  });
});
