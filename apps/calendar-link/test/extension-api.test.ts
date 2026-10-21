// The extension door, without a browser: pairing, and Gmail drafts and Google Tasks only when the person ticked them.
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createExtensionApi } from "../src/extension-api.js";
import { GMAIL_SCOPE, SCOPE, TASKS_SCOPE } from "../src/server.js";
import { newClump, plan, propose, resolve, viewClump } from "@recast/core";
import { CONTRACTS } from "@recast/bridges";

const EXT = `chrome-extension://${"a".repeat(32)}`;
function setup(scope: string, google?: (url: string, init: RequestInit) => Response) {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "recast-ext-api-")), ".secrets"); mkdirSync(dir, { recursive: true });
  const tokenFile = path.join(dir, "google-token.json");
  writeFileSync(tokenFile, JSON.stringify({ access_token: "AT", expires_at: Date.now() + 3_600_000, scope, token_type: "Bearer", connected_at: "x" }));
  const calls: string[] = [];
  const api = createExtensionApi({ clientId: "c", clientSecret: "s", tokenFile, tokenUrl: "https://google.test/token", now: Date.now, stateFile: path.join(dir, "t.json"), dir,
    fetch: (async (u: string, init: RequestInit) => { calls.push(`${init?.method ?? "GET"} ${u}`); return google ? google(String(u), init) : new Response("{}", { status: 500 }); }) as unknown as typeof fetch });
  return { api, calls };
}
async function pair(api: ReturnType<typeof setup>["api"]) {
  const r = await api.handle("pair", EXT, {}); expect(r.status).toBe(202); expect(String(r.body.code)).toMatch(/^\d{4}$/);
  expect((await api.handle("status", EXT, {})).status).toBe(403);           // pending is not allowed
  api.decide(EXT, true);
}

describe("extension door", () => {
  it("status reports whether Gmail drafts were allowed", async () => {
    const a = setup(SCOPE); await pair(a.api);
    expect((await a.api.handle("status", EXT, {})).body).toMatchObject({ paired: true, connected: true, gmail: false });
    const b = setup(`${SCOPE} ${GMAIL_SCOPE}`); await pair(b.api);
    expect((await b.api.handle("status", EXT, {})).body).toMatchObject({ gmail: true });
  });
  it("Gmail is refused without the Gmail permission, before anything reaches Google", async () => {
    const a = setup(SCOPE); await pair(a.api);
    const r = await a.api.handle("commit", EXT, { destination: "gmail", op: {}, consent: { kind: "release" } });
    expect(r.status).toBe(409); expect(String(r.body.message)).toMatch(/Gmail drafts are not allowed/); expect(a.calls).toHaveLength(0);
  });
  it("Gmail cannot be asked about one draft: the check says so instead of guessing 'not there'", async () => {
    const b = setup(`${SCOPE} ${GMAIL_SCOPE}`); await pair(b.api);
    const r = await b.api.handle("reconcile", EXT, { destination: "gmail", op: {} });
    expect(r.body).toMatchObject({ checkable: false }); expect(r.body).not.toHaveProperty("found"); expect(b.calls).toHaveLength(0);
  });
  it("undo only works on a receipt this program issued", async () => {
    const b = setup(SCOPE); await pair(b.api);
    expect((await b.api.handle("undo", EXT, { receipt: { receiptId: "rc-forged" } })).body).toMatchObject({ outcome: "failed", message: "That placement is not one this computer made" });
  });
});

describe("Google Tasks through the same door", () => {
  // A page taken whole, reviewed in the module: the operation the extension sends.
  const op = () => {
    const page = newClump("obj-1", { id: "pg1", kind: "page", text: "Q3 plan", value: { name: "Q3 plan", url: "https://example.com/q3" }, confidence: 0.95, evidence: [{ locator: { kind: "meta", value: "title" } }], source: { app: "example.com", url: "https://example.com/q3" } });
    const v = viewClump(page, { now: "2026-10-21T09:00:00Z", timezone: "UTC" });
    return plan(propose(resolve(v.candidate!), CONTRACTS.googleTasks)[0]!, { now: () => "2026-10-21T09:00:00Z" });
  };
  it("status reports whether Tasks was allowed; without it a task is refused before anything reaches Google", async () => {
    const a = setup(`${SCOPE} ${GMAIL_SCOPE}`); await pair(a.api);
    expect((await a.api.handle("status", EXT, {})).body).toMatchObject({ tasks: false });
    const r = await a.api.handle("commit", EXT, { destination: "tasks", op: op(), consent: { kind: "release" } });
    expect(r.status).toBe(409); expect(String(r.body.message)).toMatch(/Google Tasks is not allowed/); expect(a.calls).toHaveLength(0);
    const b = setup(`${SCOPE} ${TASKS_SCOPE}`); await pair(b.api);
    expect((await b.api.handle("status", EXT, {})).body).toMatchObject({ gmail: false, tasks: true });
  });
  it("adds one task to the default list (title, and the link as its notes); Undo deletes exactly that task", async () => {
    const tasks = new Map<string, unknown>();
    const b = setup(`${SCOPE} ${TASKS_SCOPE}`, (url, init) => {
      if (init.method === "POST" && url === "https://tasks.googleapis.com/tasks/v1/lists/%40default/tasks") { const id = `t${tasks.size + 1}`; tasks.set(id, JSON.parse(String(init.body))); return new Response(JSON.stringify({ id }), { status: 200 }); }
      if (init.method === "DELETE") { tasks.delete(url.split("/tasks/").pop()!); return new Response(null, { status: 204 }); }
      return new Response("{}", { status: 400 });
    });
    await pair(b.api);
    const r = await b.api.handle("commit", EXT, { destination: "tasks", op: op(), consent: { kind: "confirm" } });
    expect(r.body).toMatchObject({ outcome: "done", receipt: { destination: "google-tasks.list", reversible: true } });
    expect([...tasks.values()]).toEqual([{ title: "Q3 plan", notes: "https://example.com/q3" }]);
    const u = await b.api.handle("undo", EXT, { destination: "tasks", receipt: r.body.receipt });
    expect(u.body).toEqual({ outcome: "undone" }); expect(tasks.size).toBe(0);
    expect(b.calls.at(-1)).toBe("DELETE https://tasks.googleapis.com/tasks/v1/lists/%40default/tasks/t1");
  });
  it("a lost answer cannot be checked against Google Tasks, and the check says so instead of guessing", async () => {
    const b = setup(`${SCOPE} ${TASKS_SCOPE}`); await pair(b.api);
    const r = await b.api.handle("reconcile", EXT, { destination: "tasks", op: op() });
    expect(r.body).toMatchObject({ checkable: false }); expect(String(r.body.message)).toMatch(/Look in Google Tasks/); expect(b.calls).toHaveLength(0);
  });
});
