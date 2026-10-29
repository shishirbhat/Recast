// The extension door, without a browser: pairing, and Gmail drafts and Google Tasks only when the person ticked them.
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createExtensionApi } from "../src/extension-api.js";
import { connectGithub, githubFile, readGithub } from "../src/github.js";
import { connectLinear, linearFile } from "../src/linear.js";
import { connectTodoist, todoistFile } from "../src/todoist.js";
import { connectNotion, notionFile } from "../src/notion.js";
import { existsSync, statSync } from "node:fs";
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
  return { api, calls, dir };
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

describe("GitHub issues through the same door (its own connection, not Google's)", () => {
  const TOKEN = "github_pat_" + "a".repeat(40);
  const op = () => {
    const src = { app: "ci.example", url: "https://ci.example/run/42", title: "Build #42" };
    const e = newClump("e", { id: "err", kind: "error", text: "TypeError: Cannot read properties of undefined (reading 'id')", confidence: 0.9, evidence: [{ locator: { kind: "user", value: "selection" } }], source: src });
    const v = viewClump(answerClump(e, "title", "Sign-in crash"), { now: "2026-10-22T09:00:00Z", timezone: "UTC" });
    return plan(propose(resolve(v.candidate!), CONTRACTS.githubIssue)[0]!, { now: () => "2026-10-22T09:00:00Z" });
  };
  it("connecting checks the repository with the token first, and keeps it in a file only this user can read", async () => {
    const a = setup(SCOPE);
    const seen: string[] = [];
    const gh = (status: number) => (async (u: string, init: RequestInit) => { seen.push(`${u} ${(init.headers as Record<string, string>).authorization}`); return new Response("{}", { status }); }) as unknown as typeof fetch;
    expect(await connectGithub(a.dir, TOKEN, "not a repo", gh(200), 0)).toMatchObject({ ok: false, message: /owner\/name/ });
    expect(await connectGithub(a.dir, "hunter2", "acme/app", gh(200), 0)).toMatchObject({ ok: false, message: /does not look like a GitHub token/ });
    expect(await connectGithub(a.dir, TOKEN, "acme/app", gh(404), 0)).toMatchObject({ ok: false, message: /cannot see acme\/app/ });
    expect(readGithub(a.dir)).toBeNull();
    expect(await connectGithub(a.dir, TOKEN, "acme/app", gh(200), 0)).toMatchObject({ ok: true });
    expect(seen.at(-1)).toBe(`https://api.github.com/repos/acme/app Bearer ${TOKEN}`);
    expect(statSync(githubFile(a.dir)).mode & 0o777).toBe(0o600);
  });
  it("refused until connected; then opens one issue with the reviewed title and quoted body, Undo closes it, a lost answer cannot be checked", async () => {
    const issues = new Map<number, { title: string; body: string; state?: string; state_reason?: string }>();
    const a = setup(SCOPE, (url, init) => {
      if (url === "https://api.github.com/repos/acme/app") return new Response("{}", { status: 200 });
      if (init.method === "POST" && url === "https://api.github.com/repos/acme/app/issues") { const n = issues.size + 1; issues.set(n, JSON.parse(String(init.body))); return new Response(JSON.stringify({ number: n, html_url: `https://github.com/acme/app/issues/${n}` }), { status: 201 }); }
      if (init.method === "PATCH") { Object.assign(issues.get(Number(url.split("/").pop()))!, JSON.parse(String(init.body))); return new Response("{}", { status: 200 }); }
      return new Response("{}", { status: 400 });
    });
    await pair(a.api);
    const before = await a.api.handle("commit", EXT, { destination: "github", op: op(), consent: { kind: "confirm" } });
    expect(before.status).toBe(409); expect(String(before.body.message)).toMatch(/GitHub is not connected/);
    expect((await a.api.handle("status", EXT, {})).body).toMatchObject({ github: false });
    const f = (async (u: string, init: RequestInit) => new Response("{}", { status: u.endsWith("/acme/app") ? 200 : 400 })) as unknown as typeof fetch;
    expect((await connectGithub(a.dir, TOKEN, "acme/app", f, 0)).ok).toBe(true);
    expect((await a.api.handle("status", EXT, {})).body).toMatchObject({ github: "acme/app" });
    const r = await a.api.handle("commit", EXT, { destination: "github", op: op(), consent: { kind: "confirm" } });
    expect(r.body).toMatchObject({ outcome: "done", receipt: { destination: "github.issues", reversible: true } });
    expect(issues.get(1)!.title).toBe("Sign-in crash");
    expect(issues.get(1)!.body).toContain("```text\nTypeError: Cannot read properties of undefined (reading 'id')\n```");
    expect(a.calls.some((c) => c.includes("googleapis"))).toBe(false);
    const u = await a.api.handle("undo", EXT, { destination: "github", receipt: r.body.receipt });
    expect(u.body).toEqual({ outcome: "undone" }); expect(issues.get(1)).toMatchObject({ state: "closed", state_reason: "not_planned" });
    expect((await a.api.handle("reconcile", EXT, { destination: "github", op: op() })).body).toMatchObject({ checkable: false });
  });
});

describe("Linear issues through the same door (its own connection)", () => {
  const KEY = "lin_api_" + "b".repeat(32);
  const op = () => {
    const e = newClump("e", { id: "err", kind: "error", text: "panic: index out of range", confidence: 0.9, evidence: [{ locator: { kind: "user", value: "selection" } }], source: { app: "ci", url: "https://ci.example/7" } });
    const v = viewClump(answerClump(e, "title", "Index panic"), { now: "2026-10-22T09:00:00Z", timezone: "UTC" });
    return plan(propose(resolve(v.candidate!), CONTRACTS.linearIssue)[0]!, { now: () => "2026-10-22T09:00:00Z" });
  };
  const created: Record<string, unknown>[] = []; let deleted = "";
  const linear = (url: string, init: RequestInit) => {
    if (url !== "https://api.linear.app/graphql" || (init.headers as Record<string, string>).authorization !== KEY) return new Response("{}", { status: 401 });
    const b = JSON.parse(String(init.body));
    if (b.query.includes("teams")) return new Response(JSON.stringify({ data: { teams: { nodes: b.variables.key === "ENG" ? [{ id: "team-1", key: "ENG", name: "Engineering" }] : [] } } }), { status: 200 });
    if (b.query.includes("issueCreate")) { created.push(b.variables.input); return new Response(JSON.stringify({ data: { issueCreate: { success: true, issue: { id: "lin-1", identifier: "ENG-1" } } } }), { status: 200 }); }
    if (b.query.includes("issueDelete")) { deleted = b.variables.id; return new Response(JSON.stringify({ data: { issueDelete: { success: true } } }), { status: 200 }); }
    return new Response("{}", { status: 400 });
  };
  const asFetch = (async (u: string, i: RequestInit) => linear(String(u), i)) as unknown as typeof fetch;
  it("connecting finds the team by its key first, and saves nothing otherwise", async () => {
    const a = setup(SCOPE);
    expect(await connectLinear(a.dir, "nope", "ENG", asFetch, 0)).toMatchObject({ ok: false, message: /lin_api_/ });
    expect(await connectLinear(a.dir, KEY, "eng-1", asFetch, 0)).toMatchObject({ ok: false, message: /team's key/ });
    expect(await connectLinear(a.dir, KEY, "OPS", asFetch, 0)).toMatchObject({ ok: false, message: /No team with the key OPS/ });
    expect(await connectLinear(a.dir, "lin_api_" + "z".repeat(32), "ENG", asFetch, 0)).toMatchObject({ ok: false, message: /did not accept/ });
    expect(await connectLinear(a.dir, KEY, "eng", asFetch, 0)).toMatchObject({ ok: true, link: { teamId: "team-1", teamName: "Engineering" } });
    expect(statSync(linearFile(a.dir)).mode & 0o777).toBe(0o600);
  });
  it("refused until connected; then one issue on that team, Undo deletes it, a lost answer cannot be checked", async () => {
    const a = setup(SCOPE, linear); await pair(a.api);
    const before = await a.api.handle("commit", EXT, { destination: "linear", op: op(), consent: { kind: "confirm" } });
    expect(before.status).toBe(409); expect(String(before.body.message)).toMatch(/Linear is not connected/);
    expect((await connectLinear(a.dir, KEY, "ENG", asFetch, 0)).ok).toBe(true);
    expect((await a.api.handle("status", EXT, {})).body).toMatchObject({ linear: "Engineering" });
    const r = await a.api.handle("commit", EXT, { destination: "linear", op: op(), consent: { kind: "confirm" } });
    expect(r.body).toMatchObject({ outcome: "done", receipt: { destination: "linear.issues", reversible: true } });
    expect(created.at(-1)).toMatchObject({ teamId: "team-1", title: "Index panic" });
    expect(String(created.at(-1)!["description"])).toContain("```text\npanic: index out of range\n```");
    expect((await a.api.handle("undo", EXT, { destination: "linear", receipt: r.body.receipt })).body).toEqual({ outcome: "undone" });
    expect(deleted).toBe("lin-1");
    expect((await a.api.handle("reconcile", EXT, { destination: "linear", op: op() })).body).toMatchObject({ checkable: false });
  });
});

describe("Todoist through the same door (its own connection; Todoist stand-in)", () => {
  const TOKEN = "0123456789abcdef0123456789abcdef01234567";
  const op = (contract: "todoistTask" | "todoistEntry" = "todoistTask") => {
    const page = newClump("obj-1", { id: "pg1", kind: "page", text: "Q3 plan", value: { name: "Q3 plan", url: "https://example.com/q3" }, confidence: 0.95, evidence: [{ locator: { kind: "meta", value: "title" } }], source: { app: "example.com", url: "https://example.com/q3" } });
    const v = viewClump(page, { now: "2026-10-21T09:00:00Z", timezone: "UTC" });
    return plan(propose(resolve(v.candidate!), CONTRACTS[contract])[0]!, { now: () => "2026-10-21T09:00:00Z" });
  };
  const tasks = new Map<string, Record<string, unknown>>();
  const todoist = (url: string, init: RequestInit) => {
    if ((init.headers as Record<string, string>)?.authorization !== `Bearer ${TOKEN}`) return new Response("Forbidden", { status: 401 });
    if (url === "https://api.todoist.com/api/v1/projects") return new Response(JSON.stringify({ results: [{ id: "inbox", name: "Inbox" }] }), { status: 200 });
    const id = url.split("/tasks/")[1];
    if (init.method === "POST" && url === "https://api.todoist.com/api/v1/tasks") { const b = JSON.parse(String(init.body)); const t = { id: "6X1", content: b.content, description: b.description ?? "", checked: false }; tasks.set("6X1", t); return new Response(JSON.stringify(t), { status: 200 }); }
    if (init.method === "DELETE" && id) { tasks.delete(id); return new Response(null, { status: 204 }); }
    if (id) return tasks.has(id) ? new Response(JSON.stringify(tasks.get(id)), { status: 200 }) : new Response("Not found", { status: 404 });
    return new Response("{}", { status: 400 });
  };
  const asFetch = (async (u: string, i: RequestInit) => todoist(String(u), i ?? {})) as unknown as typeof fetch;
  it("connecting checks the token with Todoist first and keeps it in a 0600 file", async () => {
    const a = setup(SCOPE);
    expect(await connectTodoist(a.dir, "nope", asFetch, 0)).toMatchObject({ ok: false, message: /does not look like a Todoist API token/ });
    expect(await connectTodoist(a.dir, "f".repeat(40), asFetch, 0)).toMatchObject({ ok: false, message: /did not accept/ });
    expect(existsSync(todoistFile(a.dir))).toBe(false);
    expect(await connectTodoist(a.dir, TOKEN, asFetch, 0)).toMatchObject({ ok: true });
    expect(statSync(todoistFile(a.dir)).mode & 0o777).toBe(0o600);
  });
  it("places only once connected; reads back with its link; cannot be asked about a lost one; Undo deletes it", async () => {
    tasks.clear();
    const a = setup(SCOPE, todoist); await pair(a.api);
    const before = await a.api.handle("commit", EXT, { destination: "todoist", op: op(), consent: { kind: "confirm" } });
    expect(before.status).toBe(409); expect(String(before.body.message)).toMatch(/Todoist is not connected/);
    expect((await connectTodoist(a.dir, TOKEN, asFetch, 0)).ok).toBe(true);
    expect((await a.api.handle("status", EXT, {})).body).toMatchObject({ todoist: true });
    const o = op();
    const r = await a.api.handle("commit", EXT, { destination: "todoist", op: o, consent: { kind: "confirm" } });
    expect(r.body).toMatchObject({ outcome: "done", receipt: { destination: "todoist.task", reversible: true } });
    expect((await a.api.handle("verify", EXT, { destination: "todoist", op: o, receipt: r.body.receipt })).body).toMatchObject({ verification: { ok: true, link: "https://app.todoist.com/app/task/6X1" } });
    expect((await a.api.handle("reconcile", EXT, { destination: "todoist", op: o })).body).toMatchObject({ checkable: false });
    expect((await a.api.handle("undo", EXT, { destination: "todoist", receipt: r.body.receipt })).body).toEqual({ outcome: "undone" });
    expect(tasks.size).toBe(0);
    // The token is never part of any answer.
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
  });
  it("a refused token is said plainly, never echoed", async () => {
    tasks.clear();
    const a = setup(SCOPE, (u, i) => (u.endsWith("/projects") ? todoist(u, i) : new Response("Forbidden", { status: 401 }))); await pair(a.api);
    expect((await connectTodoist(a.dir, TOKEN, asFetch, 0)).ok).toBe(true);
    const r = await a.api.handle("commit", EXT, { destination: "todoist", op: op(), consent: { kind: "confirm" } });
    expect(r.body).toMatchObject({ outcome: "failed", message: "Todoist no longer accepts the saved key. Connect it again on the Recast page" });
  });
});

describe("Notion through the same door (its own connection; Notion stand-in)", () => {
  const TOKEN = "ntn_" + "a1b2c3d4e5".repeat(4);
  const DB = "0123456789abcdef0123456789abcdef";
  const op = () => {
    const page = newClump("obj-1", { id: "pg1", kind: "page", text: "Q3 plan", value: { name: "Q3 plan", url: "https://example.com/q3" }, confidence: 0.95, evidence: [{ locator: { kind: "meta", value: "title" } }], source: { app: "example.com", url: "https://example.com/q3" } });
    const v = viewClump(page, { now: "2026-10-21T09:00:00Z", timezone: "UTC" });
    return plan(propose(resolve(v.candidate!), CONTRACTS.notion)[0]!, { now: () => "2026-10-21T09:00:00Z" });
  };
  let columns: Record<string, { type: string }> = { Name: { type: "title" }, Link: { type: "url" }, Status: { type: "select" } };
  const pages = new Map<string, any>();
  const notionApi = (url: string, init: RequestInit) => {
    const h = init.headers as Record<string, string>;
    if (h?.authorization !== `Bearer ${TOKEN}` || h["Notion-Version"] !== "2022-06-28") return new Response(JSON.stringify({ object: "error", code: "unauthorized" }), { status: 401 });
    if (url === `https://api.notion.com/v1/databases/${DB}`) return new Response(JSON.stringify({ id: DB, title: [{ plain_text: "Reading list" }], properties: columns }), { status: 200 });
    if (url.startsWith("https://api.notion.com/v1/databases/")) return new Response("{}", { status: 404 });
    if (url === "https://api.notion.com/v1/pages" && init.method === "POST") { const b = JSON.parse(String(init.body)); const pg = { id: "pg-1", url: "https://www.notion.so/pg1", archived: false, parent: b.parent, properties: { Name: { title: [{ plain_text: b.properties.Name.title[0].text.content }] }, ...(b.properties.Link ? { Link: { url: b.properties.Link.url } } : {}) } }; pages.set("pg-1", pg); return new Response(JSON.stringify(pg), { status: 200 }); }
    const id = url.split("/v1/pages/")[1];
    if (id && init.method === "PATCH") { pages.set(id, { ...pages.get(id), archived: true }); return new Response(JSON.stringify(pages.get(id)), { status: 200 }); }
    if (id) return pages.has(id) ? new Response(JSON.stringify(pages.get(id)), { status: 200 }) : new Response("{}", { status: 404 });
    return new Response("{}", { status: 400 });
  };
  const asFetch = (async (u: string, i: RequestInit) => notionApi(String(u), i ?? {})) as unknown as typeof fetch;
  it("connecting finds the database and its title and link columns first; a database not shared with the integration says how to share it", async () => {
    const a = setup(SCOPE);
    expect(await connectNotion(a.dir, "nope", DB, asFetch, 0)).toMatchObject({ ok: false, message: /integration token/ });
    expect(await connectNotion(a.dir, TOKEN, "not a link", asFetch, 0)).toMatchObject({ ok: false, message: /database's link/ });
    expect(await connectNotion(a.dir, TOKEN, "f".repeat(32), asFetch, 0)).toMatchObject({ ok: false, message: /Connections, add your integration/ });
    expect(existsSync(notionFile(a.dir))).toBe(false);
    const r = await connectNotion(a.dir, TOKEN, `https://www.notion.so/acme/Reading-list-${DB}?v=1234`, asFetch, 0);
    expect(r).toMatchObject({ ok: true, link: { databaseId: DB, databaseName: "Reading list", titleProperty: "Name", urlProperty: "Link" } });
    expect(statSync(notionFile(a.dir)).mode & 0o777).toBe(0o600);
  });
  it("places a page in that database, reads it back with its link, cannot be asked about a lost one, and Undo archives it", async () => {
    pages.clear(); columns = { Name: { type: "title" }, Link: { type: "url" } };
    const a = setup(SCOPE, notionApi); await pair(a.api);
    expect((await a.api.handle("commit", EXT, { destination: "notion", op: op(), consent: { kind: "confirm" } })).body).toMatchObject({ outcome: "failed", message: /Notion is not connected/ });
    expect((await connectNotion(a.dir, TOKEN, DB, asFetch, 0)).ok).toBe(true);
    expect((await a.api.handle("status", EXT, {})).body).toMatchObject({ notion: "Reading list" });
    const o = op(); const r = await a.api.handle("commit", EXT, { destination: "notion", op: o, consent: { kind: "confirm" } });
    expect(r.body).toMatchObject({ outcome: "done", receipt: { destination: "notion.database", reversible: true } });
    expect(pages.get("pg-1")).toMatchObject({ parent: { database_id: DB }, properties: { Name: { title: [{ plain_text: "Q3 plan" }] }, Link: { url: "https://example.com/q3" } } });
    expect((await a.api.handle("verify", EXT, { destination: "notion", op: o, receipt: r.body.receipt })).body).toMatchObject({ verification: { ok: true, link: "https://www.notion.so/pg1" } });
    expect((await a.api.handle("reconcile", EXT, { destination: "notion", op: o })).body).toMatchObject({ checkable: false });
    expect((await a.api.handle("undo", EXT, { destination: "notion", receipt: r.body.receipt })).body).toEqual({ outcome: "undone" });
    expect(pages.get("pg-1").archived).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain(TOKEN);
  });
});
