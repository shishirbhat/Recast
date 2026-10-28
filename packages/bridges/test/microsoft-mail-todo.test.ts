// Outlook mail drafts and Microsoft To Do through Microsoft Graph. MOCKED PROVIDER: the stand-in keeps messages and tasks
// the way Graph describes them (ids chosen by Graph, isDraft, toRecipients, body.content, status, dueDateTime, the
// default list found by wellknownListName). A real run needs the owner's Microsoft app (REAL_TEST_PLAN M8 onwards).
import { describe, expect, it } from "vitest";
import { InMemoryEventLog, commit, plan, propose, resolve, undo, type Candidate, type SemanticObject } from "@recast/core";
import { HttpBridge, msTodoEntry, msTodoTask, outlookMessageDraft, type HttpRequest, type HttpResponse, type Spec, type Transport } from "../src";

const NOW = () => "2026-10-01T10:00:00Z";
const G = "https://graph.microsoft.com/v1.0";
const obj = (type: Candidate["type"], properties: Record<string, unknown>): SemanticObject => resolve({ type, properties, fields: Object.fromEntries(Object.keys(properties).map((k) => [k, { confidence: 0.95, evidence: [{ locator: { kind: "css", value: `#${k}` } }] }])), provenance: { source: { app: "test" }, capture: { method: "dom", adapter: "test", at: "2026-10-01T09:00:00Z" } } });
const res = (status: number, json: unknown = {}): HttpResponse => ({ status, json });
async function placed<T>(spec: Spec<T>, t: Transport, o: SemanticObject, relationId: string) {
  const bridge = new HttpBridge(spec, {} as T, t); const log = new InMemoryEventLog();
  const p = propose(o, bridge.describe()).find((x) => x.relationId === relationId)!; expect(p.status).toBe("ready");
  const op = plan(p, { now: NOW }); const receipt = await commit(op, { kind: "confirm" }, { bridge, log, now: NOW });
  return { check: () => bridge.verify(receipt, op), undo: () => undo(receipt, { bridge, log, now: NOW }) };
}

describe("Outlook mail: a message saved as a draft", () => {
  it("is a draft in the person's own mailbox; To and text are read back with its link; Undo deletes it", async () => {
    const msgs = new Map<string, Record<string, unknown>>(); const calls: HttpRequest[] = [];
    const t: Transport = async (r) => { calls.push(r); const id = r.url.split("/me/messages/")[1]?.split("?")[0];
      if (r.method === "POST" && r.url === `${G}/me/messages`) { const b = r.body as Record<string, unknown>; const m = { ...b, id: "AAMkD1", isDraft: true, webLink: "https://outlook.office365.com/owa/?ItemID=AAMkD1" }; msgs.set("AAMkD1", m); return res(201, m); }
      if (r.method === "GET") return msgs.has(id!) ? res(200, msgs.get(id!)) : res(404);
      if (r.method === "DELETE") { msgs.delete(id!); return res(204, null); }
      return res(400); };
    const p = await placed(outlookMessageDraft, t, obj("Message", { to: ["maya.rao@example.com"], snippet: "Free for dinner on Friday?" }), "message-draft-entry");
    expect(calls[0]).toMatchObject({ method: "POST", url: `${G}/me/messages`, body: { body: { contentType: "Text", content: "Free for dinner on Friday?" }, toRecipients: [{ emailAddress: { address: "maya.rao@example.com" } }] } });
    expect(JSON.stringify(calls[0]!.body)).not.toMatch(/send/i);   // a draft: nothing is sent
    expect(await p.check()).toMatchObject({ ok: true, link: "https://outlook.office365.com/owa/?ItemID=AAMkD1", fields: [{ path: "Message.to", actual: "maya.rao@example.com", match: true }, { path: "Message.snippet", match: true }] });
    // Sent from Outlook: no longer a draft, so not what Recast placed.
    msgs.set("AAMkD1", { ...msgs.get("AAMkD1"), isDraft: false });
    expect(await p.check()).toMatchObject({ ok: false, note: "the draft is not in Outlook" });
    msgs.set("AAMkD1", { ...msgs.get("AAMkD1"), isDraft: true });
    await p.undo(); expect(msgs.size).toBe(0);
  });
});

describe("Microsoft To Do: the default list", () => {
  function graph() {
    const tasks = new Map<string, Record<string, unknown>>(); const calls: HttpRequest[] = [];
    const t: Transport = async (r) => { calls.push(r);
      if (r.method === "GET" && r.url.startsWith(`${G}/me/todo/lists?`)) return res(200, { value: [{ id: "L-default", wellknownListName: "defaultList", displayName: "Tasks" }] });
      const m = /\/me\/todo\/lists\/([^/]+)\/tasks(?:\/([^/?]+))?/.exec(r.url); if (!m || m[1] !== "L-default") return res(404);
      if (r.method === "POST") { const task = { ...(r.body as object), id: "T1", status: "notStarted" }; tasks.set("T1", task); return res(201, task); }
      if (r.method === "GET") return tasks.has(m[2]!) ? res(200, tasks.get(m[2]!)) : res(404);
      if (r.method === "DELETE") { tasks.delete(m[2]!); return res(204, null); }
      return res(400); };
    return { tasks, calls, t };
  }
  it("a page as a task goes to the default list; read back; a completed task is not there; Undo deletes it from that list", async () => {
    const g = graph();
    const p = await placed(msTodoTask, g.t, obj("Document", { title: "Read the spec", url: "https://example.com/spec" }), "document-task-reference");
    expect(g.calls[1]).toMatchObject({ method: "POST", url: `${G}/me/todo/lists/L-default/tasks`, body: { title: "Read the spec", body: { contentType: "text", content: "https://example.com/spec" } } });
    expect(await p.check()).toMatchObject({ ok: true });
    g.tasks.set("T1", { ...g.tasks.get("T1"), status: "completed" });
    expect(await p.check()).toMatchObject({ ok: false, note: "the task is not in Microsoft To Do" });
    await p.undo(); expect(g.calls.at(-1)).toMatchObject({ method: "DELETE", url: `${G}/me/todo/lists/L-default/tasks/T1` }); expect(g.tasks.size).toBe(0);
  });
  it("a task with a due date is due that day, and the day is what is compared", async () => {
    const g = graph();
    const p = await placed(msTodoEntry, g.t, obj("Task", { title: "Q3 plan", url: "https://example.com/q3", due: "2026-10-23" }), "task-tasklist-entry");
    expect(g.calls[1]!.body).toMatchObject({ title: "Q3 plan", dueDateTime: { dateTime: "2026-10-23T00:00:00.0000000", timeZone: "UTC" } });
    const v = await p.check(); expect(v.ok).toBe(true); expect(v.fields.find((f) => f.path === "Task.due")).toMatchObject({ actual: "2026-10-23", match: true });
    g.tasks.set("T1", { ...g.tasks.get("T1"), dueDateTime: { dateTime: "2026-10-24T00:00:00.0000000", timeZone: "UTC" } });
    expect(await p.check()).toMatchObject({ ok: false });
  });
});
