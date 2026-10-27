// Verify for every connector that can be read back. MOCKED PROVIDERS: each fake keeps what was written the way the real
// API does (shapes from each API's reference); the real runs are docs/REAL_TEST_PLAN.md section L.
import { describe, expect, it } from "vitest";
import { InMemoryEventLog, commit, plan, propose, resolve, type Candidate, type SemanticObject } from "@recast/core";
import { HttpBridge, githubIssue, linearIssue, googleDocs, googleTasks, googleTasksEntry, gmailMessageDraft, type HttpRequest, type HttpResponse, type Spec, type Transport } from "../src";

const NOW = () => "2026-10-01T10:00:00Z";
const obj = (type: Candidate["type"], properties: Record<string, unknown>): SemanticObject => resolve({ type, properties, fields: Object.fromEntries(Object.keys(properties).map((k) => [k, { confidence: 0.95, evidence: [{ locator: { kind: "css", value: `#${k}` } }] }])), provenance: { source: { app: "test" }, capture: { method: "dom", adapter: "test", at: "2026-10-01T09:00:00Z" } } });
const res = (status: number, json: unknown = {}): HttpResponse => ({ status, json });
async function placed<T>(spec: Spec<T>, target: T, t: Transport, o: SemanticObject, relationId: string) {
  const bridge = new HttpBridge(spec, target, t); const log = new InMemoryEventLog();
  const p = propose(o, bridge.describe()).find((x) => x.relationId === relationId)!; expect(p.status).toBe("ready");
  const op = plan(p, { now: NOW }); const receipt = await commit(op, { kind: "hold", heldMs: 700 }, { bridge, log, now: NOW });
  return { check: () => bridge.verify(receipt, op), op };
}
const writes = (calls: HttpRequest[]) => calls.filter((c) => c.method !== "GET" && !(c.body && JSON.stringify(c.body).includes("query(")));

describe("read-back: Gmail draft", () => {
  it("To and text are read back from the draft itself; an edited or deleted draft is reported", async () => {
    const drafts = new Map<string, string>(); const calls: HttpRequest[] = [];
    const t: Transport = async (r) => { calls.push(r); const id = r.url.split("/drafts/")[1]?.split("?")[0];
      if (r.method === "POST") { drafts.set("d1", (r.body as any).message.raw); return res(200, { id: "d1" }); }
      if (r.method === "GET") return drafts.has(id!) ? res(200, { id, message: { raw: drafts.get(id!) } }) : res(404);
      return res(400); };
    const { check } = await placed(gmailMessageDraft, {}, t, obj("Message", { to: ["maya.rao@example.com"], snippet: "Free for dinner this week? — à bientôt" }), "message-draft-entry");
    expect(await check()).toMatchObject({ ok: true, link: "https://mail.google.com/mail/u/0/#drafts", fields: [{ path: "Message.to", actual: "maya.rao@example.com", match: true }, { path: "Message.snippet", actual: "Free for dinner this week? — à bientôt", match: true }] });
    const enc = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    drafts.set("d1", enc("To: someone@else.example\r\n\r\nFree for dinner this week? — à bientôt"));
    expect((await check()).fields.find((f) => f.path === "Message.to")).toMatchObject({ actual: "someone@else.example", match: false });
    drafts.clear(); expect(await check()).toMatchObject({ ok: false, note: "the draft is not in Gmail" });
    expect(writes(calls)).toHaveLength(1);   // reading back never writes
  });
});

describe("read-back: Google Tasks", () => {
  it("a page as a task: title and link are read back; the task's own link comes back; a deleted task is not there", async () => {
    const tasks = new Map<string, Record<string, unknown>>();
    const t: Transport = async (r) => { const id = r.url.split("/tasks/").pop()!;
      if (r.method === "POST") { tasks.set("t1", { ...(r.body as object), id: "t1", webViewLink: "https://tasks.google.com/task/t1" }); return res(200, tasks.get("t1")); }
      if (r.method === "GET") return tasks.has(id) ? res(200, tasks.get(id)) : res(404);
      return res(400); };
    const { check } = await placed(googleTasks, { taskListId: "@default" }, t, obj("Document", { title: "Read the spec", url: "https://example.com/spec" }), "document-task-reference");
    expect(await check()).toMatchObject({ ok: true, link: "https://tasks.google.com/task/t1" });
    tasks.set("t1", { ...tasks.get("t1"), deleted: true });
    expect(await check()).toMatchObject({ ok: false, note: "the task is not in Google Tasks" });
  });
  it("a task with a due date: Google keeps only the date, so the date is what is compared", async () => {
    const tasks = new Map<string, Record<string, unknown>>();
    const t: Transport = async (r) => { if (r.method === "POST") { tasks.set("t1", { ...(r.body as object), id: "t1" }); return res(200, { id: "t1" }); } return tasks.has("t1") ? res(200, tasks.get("t1")) : res(404); };
    const { check } = await placed(googleTasksEntry, { taskListId: "@default" }, t, obj("Task", { title: "Q3 plan", url: "https://example.com/q3", due: "2026-10-23" }), "task-tasklist-entry");
    const v = await check(); expect(v.ok).toBe(true); expect(v.fields.find((f) => f.path === "Task.due")).toMatchObject({ expected: "2026-10-23", actual: "2026-10-23" });
    tasks.set("t1", { ...tasks.get("t1"), due: "2026-10-24T00:00:00.000Z" });
    expect(await check()).toMatchObject({ ok: false });
  });
});

describe("read-back: Google Docs", () => {
  it("title and text are read from the document; its address is the link; a trashed document is not there", async () => {
    let doc: Record<string, unknown> | null = null; let trashed = false;
    const t: Transport = async (r) => {
      if (r.method === "POST" && r.url.endsWith("/documents")) { doc = { documentId: "doc1", title: (r.body as any).title, body: { content: [] } }; return res(200, doc); }
      if (r.method === "POST") { const text = (r.body as any).requests[0].insertText.text as string; doc!.body = { content: [{ paragraph: { elements: [{ textRun: { content: `${text}\n` } }] } }] }; return res(200, {}); }
      if (r.method === "GET" && r.url.includes("/drive/")) return res(200, { trashed });
      if (r.method === "GET") return doc ? res(200, doc) : res(404);
      if (r.method === "PATCH") { trashed = true; return res(200, {}); }
      return res(400); };
    const { check } = await placed(googleDocs, {}, t, obj("Note", { title: "Design reading", body: "“Make the common case fast.”\n— Notes", sources: ["https://b.example/notes"] }), "note-docs-entry");
    expect(await check()).toMatchObject({ ok: true, link: "https://docs.google.com/document/d/doc1/edit" });
    trashed = true; expect(await check()).toMatchObject({ ok: false, note: "the document is not in Google Drive" });
  });
});

describe("read-back: GitHub and Linear issues", () => {
  it("GitHub: title and body read back with the issue's own link; a closed issue is not 'placed as planned'", async () => {
    let issue: Record<string, unknown> = {};
    const t: Transport = async (r) => { if (r.method === "POST") { issue = { number: 7, title: (r.body as any).title, body: (r.body as any).body, state: "open", html_url: "https://github.com/acme/app/issues/7" }; return res(201, issue); } if (r.method === "GET") return res(200, issue); return res(400); };
    const { check } = await placed(githubIssue, { owner: "acme", repo: "app" }, t, obj("Issue", { title: "Sign-in crash", body: "**Error**\n```text\nTypeError: x\n```" }), "issue-tracker-entry");
    expect(await check()).toMatchObject({ ok: true, link: "https://github.com/acme/app/issues/7" });
    issue.state = "closed"; expect(await check()).toMatchObject({ ok: false, note: "the issue is closed" });
  });
  it("Linear: the issue is queried by id (variables, never inside the query); a trashed issue is not there", async () => {
    let issue: Record<string, unknown> | null = null; const queries: HttpRequest[] = [];
    const t: Transport = async (r) => { const b = r.body as any; queries.push(r);
      if (b.query.startsWith("mutation")) { issue = { id: "lin1", title: b.variables.input.title, description: b.variables.input.description, url: "https://linear.app/acme/issue/ENG-1", trashed: false }; return res(200, { data: { issueCreate: { success: true, issue: { id: "lin1", identifier: "ENG-1" } } } }); }
      return res(200, { data: { issue } }); };
    const { check } = await placed(linearIssue, { teamId: "team1" }, t, obj("Issue", { title: "Sign-in crash", body: "TypeError: x" }), "issue-tracker-entry");
    expect(await check()).toMatchObject({ ok: true, link: "https://linear.app/acme/issue/ENG-1" });
    expect(queries.at(-1)!.body).toMatchObject({ variables: { id: "lin1" } }); expect(JSON.stringify((queries.at(-1)!.body as any).query)).not.toContain("lin1");
    issue!.trashed = true; expect(await check()).toMatchObject({ ok: false, note: "the issue is not in Linear" });
  });
});
