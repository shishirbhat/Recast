// The control center on Postgres, for real: every migration in a Postgres wire server, the built Next.js app through `pg`,
// people signing in with a browser. Local accounts first, then Supabase sessions against a stand-in Supabase Auth.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as httpServer, type Server } from "node:http";
import { createServer as netServer } from "node:net";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import pg from "pg";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { freshDb } from "@recast/store/testing";
import { hashPassword } from "../lib/passwords";
import { signHs256 } from "../lib/session";

const A = "00000000-0000-0000-0000-00000000000a", B = "00000000-0000-0000-0000-00000000000b";
const SECRET = "s".repeat(48), JWT_SECRET = "j".repeat(48);
const freePort = () => new Promise<number>((ok, fail) => { const s = netServer(); s.once("error", fail); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); });
const stop = (p?: ChildProcess) => { try { if (p?.pid) process.kill(-p.pid, "SIGTERM"); } catch { /* gone */ } };
const chromiumPath = () => process.env.RECAST_CHROMIUM ?? (existsSync("/opt/pw-browsers/chromium") && !existsSync("/opt/pw-browsers/chromium/chrome") ? "/opt/pw-browsers/chromium" : undefined);

let socket: PGLiteSocketServer, url: string, browser: Browser;
const q = async (text: string, params: unknown[] = []) => { const c = new pg.Client({ connectionString: url }); await c.connect(); try { return (await c.query(text, params)).rows; } finally { await c.end(); } };

async function start(env: Record<string, string>) {
  const port = await freePort();
  const proc = spawn("npx", ["next", "start", "-p", String(port)], { env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", DATABASE_URL: url, DATABASE_POOL_MAX: "1", DATABASE_IDLE_TIMEOUT_MS: "100", ...env }, stdio: "ignore", detached: true });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 450; i++) { try { await fetch(base + "/signin", { redirect: "manual" }); return { proc, base }; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 200)); }
  throw new Error("server did not start");
}
async function signIn(page: Page, base: string, email: string, password: string, next = "/") {
  await page.goto(`${base}${next}`);
  await page.waitForURL(/\/signin/);
  await page.fill("input[name=email]", email); await page.fill("input[name=password]", password);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/signin") || u.search.includes("error")), page.click("button[type=submit]")]);
}

beforeAll(async () => {
  const db = await freshDb(); socket = new PGLiteSocketServer({ db, port: 0, host: "127.0.0.1", connectionQueueTimeout: 60_000 }); await socket.start();
  const addr = (socket as any).server?.address?.(); url = `postgresql://postgres:postgres@127.0.0.1:${addr?.port ?? (socket as any).port}/postgres`;
  await q(`insert into objects(owner, id, kind, title, data, source) values ($1,'p1','Person','Meera Iyer','{"email":"meera@example.com"}','Page metadata'), ($2,'p1','Person','Only Bee Sees This','{}','Page')`, [A, B]);
  await q(`insert into audit_events(owner, action, subject) values ($1,'object.created','p1'), ($2,'object.created','p1')`, [A, B]);
  browser = await chromium.launch(chromiumPath() ? { executablePath: chromiumPath()! } : {});
}, 120_000);
afterAll(async () => { await browser?.close(); await socket?.stop(); });

describe("local accounts on Postgres", () => {
  let srv: { proc: ChildProcess; base: string };
  beforeAll(async () => {
    const users = `alice@acme.com|${await hashPassword("alice-password-1")}|${A};bee@acme.com|${await hashPassword("bee-password-22")}|${B}`;
    srv = await start({ RECAST_SESSION_SECRET: SECRET, RECAST_LOCAL_USERS: users });
  }, 180_000);
  afterAll(() => stop(srv?.proc));

  it("every page sends a signed-out visitor to sign in, and nothing leaks over plain HTTP", async () => {
    for (const path of ["/", "/privacy", "/approvals", "/history"]) {
      const r = await fetch(srv.base + path, { redirect: "manual" });
      expect(r.status, path).toBe(307); expect(r.headers.get("location")).toContain(`/signin?next=${encodeURIComponent(path)}`);
    }
    const exp = await fetch(srv.base + "/privacy/export", { redirect: "manual" }); expect(exp.status).toBe(307);
    const forged = await fetch(srv.base + "/", { redirect: "manual", headers: { cookie: "recast_session=eyJ1c2VySWQiOiJ4In0.abc" } }); expect(forged.status).toBe(307);
  });
  it("a wrong password is refused with a message; the right one shows only that person's data", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await signIn(page, srv.base, "alice@acme.com", "nope");
    expect(await page.locator("#err").innerText()).toContain("don't match");
    await page.fill("input[name=email]", "alice@acme.com"); await page.fill("input[name=password]", "alice-password-1");
    await Promise.all([page.waitForURL((u) => u.pathname === "/"), page.click("button[type=submit]")]);
    expect(await page.locator("main").innerText()).toContain("Meera Iyer");
    expect(await page.locator("main").innerText()).not.toContain("Only Bee Sees This");
    expect(await page.locator("#who").innerText()).toBe("Signed in as alice@acme.com");
    const cookie = (await ctx.cookies()).find((c) => c.name === "recast_session")!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax" });
    await ctx.close();
  });
  it("after sign-in, people land where they were going; open redirects are ignored", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await signIn(page, srv.base, "bee@acme.com", "bee-password-22", "/history");
    expect(new URL(page.url()).pathname).toBe("/history");
    await page.goto(`${srv.base}/signin?next=${encodeURIComponent("//evil.com")}`);
    expect(new URL(page.url()).host).toBe(new URL(srv.base).host);
    await ctx.close();
  });
  it("Bee forgetting an object and deleting everything changes nothing of Alice's, and the audit log says so in Bee's own history", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await signIn(page, srv.base, "bee@acme.com", "bee-password-22", "/privacy");
    await page.fill("input[name=confirm]", "DELETE"); await Promise.all([page.waitForURL(/deleted=1/), page.getByRole("button", { name: "Delete everything" }).click()]);
    expect(await q(`select owner, title from objects order by owner`)).toEqual([{ owner: A, title: "Meera Iyer" }]);
    expect((await q(`select action from audit_events where owner = $1 order by seq`, [B])).map((r) => r.action)).toEqual(["object.created", "data.deleted"]);
    await ctx.close();
  });
  it("sign out ends the session", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await signIn(page, srv.base, "alice@acme.com", "alice-password-1");
    await Promise.all([page.waitForURL(/\/signin/), page.click("text=Sign out")]);
    await page.goto(srv.base + "/"); expect(new URL(page.url()).pathname).toBe("/signin");
    await ctx.close();
  });
  it("five wrong passwords lock that email for a while", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    for (let i = 0; i < 5; i++) await signIn(page, srv.base, "alice@acme.com", `wrong-${i}`);
    await page.fill("input[name=email]", "alice@acme.com"); await page.fill("input[name=password]", "alice-password-1");
    await Promise.all([page.waitForURL(/error=locked/), page.click("button[type=submit]")]);
    expect(await page.locator("#err").innerText()).toContain("Too many tries");
    await ctx.close();
  });
});

describe("Supabase sessions (stand-in Supabase Auth)", () => {
  let srv: { proc: ChildProcess; base: string }; let auth: Server; let refreshCalls = 0; let shortLived = false;
  beforeAll(async () => {
    const token = (sub: string, email: string, ttl: number) => signHs256({ sub, email, aud: "authenticated", role: "authenticated", exp: Math.floor(Date.now() / 1000) + ttl }, JWT_SECRET);
    auth = httpServer(async (rq, rs) => {
      const chunks: Buffer[] = []; for await (const c of rq) chunks.push(c as Buffer); const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const send = (s: number, j: unknown) => rs.writeHead(s, { "content-type": "application/json" }).end(JSON.stringify(j));
      if (rq.headers.apikey !== "anon-key") return send(401, {});
      if (rq.url === "/auth/v1/token?grant_type=password") {
        if (body.email === "alice@acme.com" && body.password === "supabase-pass-1") return send(200, { access_token: await token(A, "alice@acme.com", shortLived ? 2 : 3600), refresh_token: "r-1" });
        return send(400, { error: "invalid_grant" });
      }
      if (rq.url === "/auth/v1/token?grant_type=refresh_token" && body.refresh_token === "r-1") { refreshCalls++; return send(200, { access_token: await token(A, "alice@acme.com", 3600), refresh_token: "r-2" }); }
      if (rq.url === "/auth/v1/logout") return send(204, {});
      send(404, {});
    });
    const ap = await freePort(); await new Promise<void>((ok) => auth.listen(ap, "127.0.0.1", ok));
    srv = await start({ SUPABASE_URL: `http://127.0.0.1:${ap}`, SUPABASE_ANON_KEY: "anon-key", SUPABASE_JWT_SECRET: JWT_SECRET });
  }, 180_000);
  afterAll(() => { stop(srv?.proc); auth?.close(); });

  it("signs in through Supabase Auth and shows that user's rows", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await signIn(page, srv.base, "alice@acme.com", "wrong");
    expect(await page.locator("#err").innerText()).toContain("don't match");
    await page.fill("input[name=email]", "alice@acme.com"); await page.fill("input[name=password]", "supabase-pass-1");
    await Promise.all([page.waitForURL((u) => u.pathname === "/"), page.click("button[type=submit]")]);
    expect(await page.locator("main").innerText()).toContain("Meera Iyer");
    await ctx.close();
  });
  it("an expired access token is renewed with the refresh token instead of signing the person out", async () => {
    shortLived = true; const ctx = await browser.newContext(); const page = await ctx.newPage();
    await signIn(page, srv.base, "alice@acme.com", "supabase-pass-1"); shortLived = false;
    await new Promise((r) => setTimeout(r, 2500));
    await page.goto(srv.base + "/"); expect(new URL(page.url()).pathname).toBe("/");
    expect(refreshCalls).toBeGreaterThan(0);
    expect((await ctx.cookies()).find((c) => c.name === "recast_sb_refresh")?.value).toBe("r-2");
    await ctx.close();
  });
});

describe("the Agent Runtime link (operator token stays behind membership)", () => {
  const TENANT = "00000000-0000-0000-0000-0000000000c1"; const SPACE = "11111111-1111-4111-8111-111111111111";
  let runtime: Server, runtimeUrl: string; const seen: string[] = []; const bodies: string[] = [];
  let srv: { proc: ChildProcess; base: string }; let open: { proc: ChildProcess; base: string };
  beforeAll(async () => {
    runtime = httpServer((rq, rs) => {
      seen.push(`${rq.method} ${rq.url}`); let b = ""; rq.on("data", (c) => { b += c; }); rq.on("end", () => { if (b) bodies.push(b); });
      const send = (b: unknown) => { rs.writeHead(rq.headers.authorization === "Bearer runtime-admin-token-0123456789" ? 200 : 401, { "content-type": "application/json" }); rs.end(JSON.stringify(b)); };
      const space = { id: SPACE, agentId: "agt_aaaaaaaaaaaa", name: "Live space", state: "active", tools: [{ tool: "notes", action: "append" }], calls: 0, spentMinor: 0, budget: { maxCalls: 5 }, expiresAt: "2026-12-01T00:00:00.000Z" };
      if (rq.url?.startsWith("/admin/agents")) return send({ agents: [{ agentId: "agt_aaaaaaaaaaaa", name: "live-bot", createdAt: "2026-10-19T00:00:00.000Z", revoked: false, scopes: [] }] });
      if (rq.url?.startsWith("/admin/spaces?")) return send({ spaces: [space] });
      if (rq.url === `/admin/spaces/${SPACE}/stop`) return send({ space: { ...space, state: "stopped" } });
      send({ approvals: [], total: 0, entries: [], verification: { ok: true, entries: 0 } });
    });
    await new Promise<void>((ok) => runtime.listen(0, "127.0.0.1", ok)); runtimeUrl = `http://127.0.0.1:${(runtime.address() as any).port}`;
    await q(`insert into tenants(id, name) values ($1, 'Acme agents')`, [TENANT]); await q(`insert into tenant_members(tenant_id, user_id, role) values ($1, $2, 'owner')`, [TENANT, A]);
    const users = `alice@acme.com|${await hashPassword("alice-password-1")}|${A};bee@acme.com|${await hashPassword("bee-password-22")}|${B}`;
    const link = { RUNTIME_URL: runtimeUrl, RUNTIME_ADMIN_TOKEN: "runtime-admin-token-0123456789", RUNTIME_TENANT_ID: TENANT };
    [srv, open] = await Promise.all([start({ RECAST_SESSION_SECRET: SECRET, RECAST_LOCAL_USERS: users, ...link }), start({ DATABASE_URL: "", ...link })]);
  }, 240_000);
  afterAll(() => { stop(srv?.proc); stop(open?.proc); runtime?.close(); });

  it("a member sees the live runtime and can stop a Space, recorded under their name", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    await signIn(page, srv.base, "alice@acme.com", "alice-password-1", "/agents");
    const main = await page.locator("main").innerText(); expect(main).toContain("live-bot"); expect(main).toContain("Live space");
    await page.getByRole("button", { name: "Stop Live space" }).click(); await page.getByRole("status").filter({ hasText: "Stopped" }).waitFor();
    expect(seen).toContain(`POST /admin/spaces/${SPACE}/stop`);
    expect(JSON.parse(bodies.at(-1)!)).toEqual({ tenant: TENANT, by: "alice@acme.com (local)" });
    await ctx.close();
  });
  it("a signed-in person who is not a member is refused, and nothing reaches the runtime for them", async () => {
    const ctx = await browser.newContext(); const page = await ctx.newPage(); const before = seen.length;
    await signIn(page, srv.base, "bee@acme.com", "bee-password-22", "/agents");
    for (const path of ["/agents", "/approvals", "/audit"]) { await page.goto(srv.base + path); expect(await page.locator("main").innerText(), path).toContain("You are not a member of the account these agents belong to"); }
    expect(seen.slice(before)).toEqual([]);
    await ctx.close();
  });
  it("without sign-in, a runtime link is refused outright instead of opening it to anonymous visitors", async () => {
    const before = seen.length;
    for (const path of ["/agents", "/approvals", "/audit"]) expect((await fetch(open.base + path)).status, path).toBe(500);
    expect(seen.slice(before)).toEqual([]);
  });
});
