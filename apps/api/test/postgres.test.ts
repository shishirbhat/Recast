// apps/api on Postgres for real: every migration in a Postgres wire server (PGlite behind pglite-socket), keys issued with the
// recast-keys command as a separate process, then the built Next.js server talking to the database through the `pg` driver.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { CredentialCipher } from "@recast/api-core";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { freshDb } from "@recast/store/testing";
import { runKeysCli } from "@recast/api-core";
import { AuthError, Recast } from "@recast/sdk";

const run = promisify(execFile);
const CRED_KEY = CredentialCipher.generateKey();
let socket: PGLiteSocketServer, url: string, proc: ChildProcess, base: string;
const withPool = async <T>(fn: (p: pg.Pool) => Promise<T>) => { const p = new pg.Pool({ connectionString: url, max: 1 }); try { return await fn(p); } finally { await p.end(); } };
const keysCmd = (...args: string[]) => run("npx", ["tsx", "scripts/recast-keys.ts", ...args], { env: { ...process.env, DATABASE_URL: url } });

let tenant: string, key: string, optTenant: string, optKey: string;
beforeAll(async () => {
  const db = await freshDb(); socket = new PGLiteSocketServer({ db, port: 0, host: "127.0.0.1", connectionQueueTimeout: 60_000 }); await socket.start();
  const addr = (socket as any).server?.address?.() ?? null; url = `postgresql://postgres:postgres@127.0.0.1:${addr?.port ?? (socket as any).port}/postgres`;

  // The real command, as a separate process.
  tenant = (await keysCmd("tenant", "create", "Acme", "--tier", "pro")).stdout.trim();
  const issued = await keysCmd("key", "issue", tenant, "--label", "prod");
  key = issued.stdout.trim(); expect(issued.stderr).toContain("not shown again");
  optTenant = (await keysCmd("tenant", "create", "Beta", "--corrections-opt-in")).stdout.trim();
  optKey = (await keysCmd("key", "issue", optTenant)).stdout.trim();

  // Connect Gmail for Acme: the token goes in on stdin, never on the command line.
  await new Promise<void>((ok, fail) => {
    const c = spawn("npx", ["tsx", "scripts/recast-keys.ts", "credential", "set", tenant, "gmail"], { env: { ...process.env, DATABASE_URL: url, RECAST_CREDENTIALS_KEY: CRED_KEY } });
    c.stdin.end("ya29.test-token\n"); c.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`credential set exited ${code}`))));
  });

  const port = 3500 + Math.floor(Math.random() * 400);
  proc = spawn("npx", ["next", "start", "-p", String(port)], { env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", DATABASE_URL: url, DATABASE_POOL_MAX: "1", DATABASE_IDLE_TIMEOUT_MS: "100", RECAST_API_KEYS: "", RECAST_CREDENTIALS_KEY: CRED_KEY }, stdio: "ignore" });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 450; i++) { try { if ((await fetch(base + "/v1/health")).ok) return; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 200)); }
  throw new Error("server did not start");
}, 180_000);
afterAll(async () => { proc?.kill(); await socket?.stop(); });

describe("recast-keys", () => {
  it("prints a key once and stores only its hash", async () => {
    expect(tenant).toMatch(/^[0-9a-f-]{36}$/); expect(key).toMatch(/^sk_live_[0-9a-f]{48}$/);
    const rows = await withPool(async (p) => (await p.query(`select * from api_keys`)).rows);
    expect(rows).toHaveLength(2); expect(JSON.stringify(rows)).not.toContain(key);
  });
  it("lists keys by hash prefix, never the key", async () => {
    const { stdout } = await keysCmd("key", "list", tenant);
    expect(stdout).toMatch(/^[0-9a-f]{12}…\s+active\s+\S+\s+prod$/m); expect(stdout).not.toContain(key);
  });
  it("refuses bad input with a message and a non-zero exit, and prints usage for unknown commands", async () => {
    await expect(keysCmd("key", "issue", "not-a-uuid")).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("tenant id must be a uuid") });
    await expect(keysCmd("tenant", "create", "X", "--tier", "gold")).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("tier must be one of") });
    await expect(keysCmd("frobnicate")).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("key issue <tenant-id>") });
    await expect(run("npx", ["tsx", "scripts/recast-keys.ts", "key", "list", tenant], { env: { ...process.env, DATABASE_URL: "" } })).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("DATABASE_URL is not set") });
  });
});

describe("the built API on Postgres", () => {
  it("authenticates an issued key, resolves, and counts usage in the database", async () => {
    const r = await new Recast({ apiKey: key, baseUrl: base }).resolve({ raw: "Meera Iyer, meera@x.com", target: { destination: "gmail" } });
    expect(r.status).toBe("resolved");
    const raw = await fetch(base + "/v1/resolve", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ input: { raw: "Launch dinner 2026-11-14" } }) });
    expect(raw.status).toBe(200); expect(raw.headers.get("x-recast-quota-limit")).toBe("50000"); expect(raw.headers.get("x-recast-quota-used")).toBe("2");
    const used = await withPool(async (p) => (await p.query(`select resolutions from api_usage where tenant_id = $1`, [tenant])).rows[0]?.resolutions);
    expect(Number(used)).toBe(2);
    expect(await withPool(async (p) => (await p.query(`select bucket from api_rate_buckets`)).rows)).toEqual([{ bucket: tenant }]);
  });
  it("idempotency records live in the database: a replay is served from there", async () => {
    const send = () => fetch(base + "/v1/resolve", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "idempotency-key": "pg-1" }, body: JSON.stringify({ input: { raw: "Meera Iyer, meera@x.com" } }) });
    const a = await send(); const b = await send();
    expect(b.headers.get("idempotent-replay")).toBe("true"); expect(await b.json()).toEqual(await a.json());
    expect(await withPool(async (p) => (await p.query(`select key, status from api_idempotency where tenant_id = $1 and key = 'pg-1'`, [tenant])).rows)).toEqual([{ key: "pg-1", status: 200 }]);
  });
  it("stores corrections only for the tenant that opted in", async () => {
    const post = (k: string) => fetch(base + "/v1/corrections", { method: "POST", headers: { authorization: `Bearer ${k}`, "content-type": "application/json" }, body: JSON.stringify({ object_id: "obj_1", kind: "edit", field: "email", new_value: "m@x.com" }) });
    expect((await post(key)).status).toBe(403); expect((await post(optKey)).status).toBe(201);
    const rows = await withPool(async (p) => (await p.query(`select tenant_id, field from api_corrections`)).rows);
    expect(rows).toEqual([{ tenant_id: optTenant, field: "email" }]);
  });
  it("placement is wired: consent is checked before anything leaves, and an unconnected tenant is told to connect", async () => {
    const place = (k: string, consent?: unknown) => fetch(base + "/v1/place", { method: "POST", headers: { authorization: `Bearer ${k}`, "content-type": "application/json" }, body: JSON.stringify({ input: { raw: "Meera Iyer, meera@x.com" }, target: { destination: "gmail" }, ...(consent ? { consent } : {}) }) }).then(async (r) => ({ status: r.status, json: await r.json() as any }));
    expect(await place(key)).toMatchObject({ status: 403, json: { error: { code: "consent_required" } } });
    expect(await place(optKey, { kind: "confirm" })).toMatchObject({ status: 403, json: { error: { code: "destination_not_connected" } } });
    expect(await withPool(async (p) => (await p.query(`select destination from api_credentials where tenant_id = $1`, [tenant])).rows)).toEqual([{ destination: "gmail" }]);
  });
  it("a tier change applies on the next request; a revoked key is refused immediately", async () => {
    await withPool((p) => runKeysCli(["tenant", "set", tenant, "--tier", "scale"], p, () => {}));
    const r = await fetch(base + "/v1/bridges", { headers: { authorization: `Bearer ${key}` } });
    expect(r.status).toBe(200); expect(r.headers.get("ratelimit-limit")).toBe("500");
    expect((await keysCmd("key", "revoke", key)).stdout.trim()).toBe("revoked");
    await expect(new Recast({ apiKey: key, baseUrl: base }).resolve({ raw: "x" })).rejects.toBeInstanceOf(AuthError);
    await expect(keysCmd("key", "revoke", key)).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining("no live key matched") });
  });
});
