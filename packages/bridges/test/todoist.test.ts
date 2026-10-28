// Todoist (API v1). MOCKED PROVIDER: the stand-in keeps tasks the way Todoist's API describes them (id chosen by Todoist,
// `content`, `description`, `due.date`, `checked`, `is_deleted`). A real run needs the owner's API token.
import { describe, expect, it } from "vitest";
import { InMemoryEventLog, commit, plan, propose, resolve, undo, OutcomeUnknownError, type Candidate, type SemanticObject } from "@recast/core";
import { HttpBridge, todoistEntry, todoistTask, type HttpRequest, type HttpResponse, type Spec, type Transport } from "../src";

const NOW = () => "2026-10-01T10:00:00Z";
const obj = (type: Candidate["type"], properties: Record<string, unknown>): SemanticObject => resolve({ type, properties, fields: Object.fromEntries(Object.keys(properties).map((k) => [k, { confidence: 0.95, evidence: [{ locator: { kind: "css", value: `#${k}` } }] }])), provenance: { source: { app: "test" }, capture: { method: "dom", adapter: "test", at: "2026-10-01T09:00:00Z" } } });
const res = (status: number, json: unknown = {}): HttpResponse => ({ status, json });
function standIn() {
  const tasks = new Map<string, Record<string, unknown>>(); const calls: HttpRequest[] = []; let n = 0;
  const t: Transport = async (r) => {
    calls.push(r); const id = r.url.split("/tasks/")[1];
    if (r.method === "POST" && !id) { const b = r.body as Record<string, unknown>; const task = { id: `6X${++n}`, content: b.content, description: b.description ?? "", checked: false, is_deleted: false, project_id: b.project_id ?? "inbox", ...(b.due_date ? { due: { date: b.due_date, is_recurring: false } } : {}) }; tasks.set(task.id, task); return res(200, task); }
    if (r.method === "GET") return tasks.has(id!) ? res(200, tasks.get(id!)) : res(404, "Task not found");
    if (r.method === "DELETE") { tasks.delete(id!); return res(204, null); }
    return res(400);
  };
  return { tasks, calls, t };
}
async function placed<T>(spec: Spec<T>, target: T, t: Transport, o: SemanticObject, relationId: string) {
  const bridge = new HttpBridge(spec, target, t); const log = new InMemoryEventLog();
  const p = propose(o, bridge.describe()).find((x) => x.relationId === relationId)!; expect(p.status).toBe("ready");
  const op = plan(p, { now: NOW }); const receipt = await commit(op, { kind: "confirm" }, { bridge, log, now: NOW });
  return { receipt, op, check: () => bridge.verify(receipt, op), undo: () => undo(receipt, { bridge, log, now: NOW }) };
}

describe("Todoist: a page as a task", () => {
  it("adds the task with the link in its description, reads it back with its link, and Undo deletes it", async () => {
    const s = standIn();
    const p = await placed(todoistTask, {}, s.t, obj("Document", { title: "Read the spec", url: "https://example.com/spec" }), "document-task-reference");
    expect(s.calls[0]).toMatchObject({ method: "POST", url: "https://api.todoist.com/api/v1/tasks", body: { content: "Read the spec", description: "https://example.com/spec" } });
    expect(await p.check()).toMatchObject({ ok: true, link: "https://app.todoist.com/app/task/6X1", fields: [{ path: "Document.title", actual: "Read the spec", match: true }, { path: "Document.url", actual: "https://example.com/spec", match: true }] });
    // Edited in Todoist: the read-back says which field differs.
    s.tasks.set("6X1", { ...s.tasks.get("6X1"), content: "Skim the spec" });
    expect((await p.check()).fields.find((f) => f.path === "Document.title")).toMatchObject({ actual: "Skim the spec", match: false });
    // Completed there: it is not the open task Recast added.
    s.tasks.set("6X1", { ...s.tasks.get("6X1"), checked: true });
    expect(await p.check()).toMatchObject({ ok: false, note: "the task is not in Todoist" });
    s.tasks.set("6X1", { ...s.tasks.get("6X1"), checked: false });
    await p.undo();
    expect(s.calls.at(-1)).toMatchObject({ method: "DELETE", url: "https://api.todoist.com/api/v1/tasks/6X1" });
    expect(s.tasks.size).toBe(0);
    expect(s.calls.filter((c) => c.method === "POST")).toHaveLength(1);   // reading back never writes
  });
  it("goes to the chosen project when one is set", async () => {
    const s = standIn();
    await placed(todoistTask, { projectId: "2203306141" }, s.t, obj("Document", { title: "Read the spec", url: "https://example.com/spec" }), "document-task-reference");
    expect(s.calls[0]!.body).toMatchObject({ project_id: "2203306141" });
  });
});

describe("Todoist: a task due on a day", () => {
  it("sends the date the person saw and compares the date", async () => {
    const s = standIn();
    const p = await placed(todoistEntry, {}, s.t, obj("Task", { title: "Q3 plan", url: "https://example.com/q3", due: "2026-10-23" }), "task-tasklist-entry");
    expect(s.calls[0]!.body).toMatchObject({ content: "Q3 plan", description: "https://example.com/q3", due_date: "2026-10-23" });
    const v = await p.check(); expect(v.ok).toBe(true); expect(v.fields.find((f) => f.path === "Task.due")).toMatchObject({ expected: "2026-10-23", actual: "2026-10-23" });
    s.tasks.set("6X1", { ...s.tasks.get("6X1"), due: { date: "2026-10-24" } });
    expect(await p.check()).toMatchObject({ ok: false });
  });
  it("a lost answer is unknown, never resent", async () => {
    const calls: HttpRequest[] = [];
    const t: Transport = async (r) => { calls.push(r); throw new TypeError("fetch failed"); };
    const bridge = new HttpBridge(todoistEntry, {}, t);
    const p = propose(obj("Task", { title: "Q3 plan", due: "2026-10-23" }), bridge.describe()).find((x) => x.relationId === "task-tasklist-entry")!;
    await expect(commit(plan(p, { now: NOW }), { kind: "confirm" }, { bridge, log: new InMemoryEventLog(), now: NOW })).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(calls).toHaveLength(1);
  });
});
