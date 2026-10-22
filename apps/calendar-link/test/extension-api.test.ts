// The extension door, without a browser: pairing, and Gmail drafts and Google Tasks only when the person ticked them.
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createExtensionApi } from "../src/extension-api.js";
import { DOCS_SCOPE, GMAIL_SCOPE, SCOPE, TASKS_SCOPE } from "../src/server.js";
import { answerClump, mergeClumps, newClump, plan, propose, resolve, viewClump } from "@recast/core";
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
  it("a page with a date goes to the same list as a whole task, due that day; Undo deletes it", async () => {
    const page = newClump("obj-2", { id: "pg2", kind: "page", text: "Q3 plan", value: { name: "Q3 plan", url: "https://example.com/q3" }, confidence: 0.95, evidence: [{ locator: { kind: "meta", value: "title" } }], source: { app: "example.com", url: "https://example.com/q3" } });
    const withDate = mergeClumps(page, newClump("obj-3", { id: "tm", kind: "time", text: "2026-10-23", confidence: 0.9, evidence: [{ locator: { kind: "css", value: "#due" } }] }), { confirmChange: true });
    if (!withDate.ok) throw new Error(withDate.reason);
    const v = viewClump(withDate.clump, { now: "2026-10-21T09:00:00Z", timezone: "UTC" });
    const taskOp = plan(propose(resolve(v.candidate!), CONTRACTS.googleTasksEntry)[0]!, { now: () => "2026-10-21T09:00:00Z" });
    const tasks = new Map<string, unknown>();
    const b = setup(`${SCOPE} ${TASKS_SCOPE}`, (url, init) => {
      if (init.method === "POST") { const id = `t${tasks.size + 1}`; tasks.set(id, JSON.parse(String(init.body))); return new Response(JSON.stringify({ id }), { status: 200 }); }
      if (init.method === "DELETE") { tasks.delete(url.split("/tasks/").pop()!); return new Response(null, { status: 204 }); }
      return new Response("{}", { status: 400 });
    });
    await pair(b.api);
    const r = await b.api.handle("commit", EXT, { destination: "tasks", op: taskOp, consent: { kind: "confirm" } });
    expect(r.body).toMatchObject({ outcome: "done", receipt: { destination: "google-tasks.tasklist", relationId: "task-tasklist-entry" } });
    expect([...tasks.values()]).toEqual([{ title: "Q3 plan", notes: "https://example.com/q3", due: "2026-10-23T00:00:00.000Z" }]);
    expect((await b.api.handle("undo", EXT, { destination: "tasks", receipt: r.body.receipt })).body).toEqual({ outcome: "undone" });
    expect(tasks.size).toBe(0);
  });
  it("a lost answer cannot be checked against Google Tasks, and the check says so instead of guessing", async () => {
    const b = setup(`${SCOPE} ${TASKS_SCOPE}`); await pair(b.api);
    const r = await b.api.handle("reconcile", EXT, { destination: "tasks", op: op() });
    expect(r.body).toMatchObject({ checkable: false }); expect(String(r.body.message)).toMatch(/Look in Google Tasks/); expect(b.calls).toHaveLength(0);
  });
});

describe("Google Docs through the same door", () => {
  // Two passages pressed into a note, titled, reviewed in the module: the operation the extension sends.
  const op = () => {
    const q = (id: string, text: string, url: string, title: string) => newClump(id, { id: `t-${id}`, kind: "text", text, confidence: 0.9, evidence: [{ locator: { kind: "css", value: `#${id}` } }], source: { app: "chrome", url, title } });
    const m = mergeClumps(q("a", "Interfaces should disappear.", "https://a.example/essay", "On tools"), q("b", "Make the common case fast.", "https://b.example/notes", "Notes"));
    if (!m.ok) throw new Error(m.reason);
    const v = viewClump(answerClump(m.clump, "title", "Design reading"), { now: "2026-10-21T09:00:00Z", timezone: "UTC" });
    return plan(propose(resolve(v.candidate!), CONTRACTS.googleDocs)[0]!, { now: () => "2026-10-21T09:00:00Z" });
  };
  it("without the Drive permission a note is refused before anything reaches Google", async () => {
    const a = setup(`${SCOPE} ${TASKS_SCOPE}`); await pair(a.api);
    expect((await a.api.handle("status", EXT, {})).body).toMatchObject({ docs: false });
    const r = await a.api.handle("commit", EXT, { destination: "docs", op: op(), consent: { kind: "release" } });
    expect(r.status).toBe(409); expect(String(r.body.message)).toMatch(/Google Docs is not allowed/); expect(a.calls).toHaveLength(0);
  });
  it("creates one document with the title and the passages with their sources; Undo moves exactly that one to the trash; a lost answer cannot be checked", async () => {
    const docs = new Map<string, { title: string; text?: string; trashed?: boolean }>();
    const b = setup(`${SCOPE} ${DOCS_SCOPE}`, (url, init) => {
      const body = init.body ? JSON.parse(String(init.body)) : {};
      if (init.method === "POST" && url === "https://docs.googleapis.com/v1/documents") { const id = `d${docs.size + 1}`; docs.set(id, { title: body.title }); return new Response(JSON.stringify({ documentId: id }), { status: 200 }); }
      if (init.method === "POST" && url.endsWith(":batchUpdate")) { docs.get(url.split("/").pop()!.replace(":batchUpdate", ""))!.text = body.requests[0].insertText.text; return new Response("{}", { status: 200 }); }
      if (init.method === "PATCH" && url.startsWith("https://www.googleapis.com/drive/v3/files/")) { docs.get(url.split("/").pop()!)!.trashed = body.trashed; return new Response("{}", { status: 200 }); }
      return new Response("{}", { status: 400 });
    });
    await pair(b.api);
    expect((await b.api.handle("status", EXT, {})).body).toMatchObject({ docs: true });
    const r = await b.api.handle("commit", EXT, { destination: "docs", op: op(), consent: { kind: "confirm" } });
    expect(r.body).toMatchObject({ outcome: "done", receipt: { destination: "google-docs.new-document", reversible: true } });
    expect([...docs.values()]).toEqual([{ title: "Design reading", text: "“Interfaces should disappear.”\n— On tools, https://a.example/essay\n\n“Make the common case fast.”\n— Notes, https://b.example/notes" }]);
    const u = await b.api.handle("undo", EXT, { destination: "docs", receipt: r.body.receipt });
    expect(u.body).toEqual({ outcome: "undone" }); expect(docs.get("d1")!.trashed).toBe(true);
    const c = await b.api.handle("reconcile", EXT, { destination: "docs", op: op() });
    expect(c.body).toMatchObject({ checkable: false });
  });
});
