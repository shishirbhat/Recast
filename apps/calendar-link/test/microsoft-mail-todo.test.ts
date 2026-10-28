// Outlook mail drafts and Microsoft To Do through the local program: optional permissions on the same Microsoft sign-in.
// MOCKED PROVIDER: Microsoft's sign-in and Graph are in-process stand-ins. The real run is REAL_TEST_PLAN M8 onwards.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { answerClump, newClump, plan, propose, resolve, viewClump, type Operation } from "@recast/core";
import { CONTRACTS } from "@recast/bridges";
import { createLink } from "../src/server.js";

const MS_ID = "1b2c3d4e-0000-4000-8000-000000000002";
const dir = mkdtempSync(path.join(tmpdir(), "recast-ms2-")); const tokenFile = path.join(dir, ".secrets", "google-token.json");
const msFile = path.join(dir, ".secrets", "microsoft-token.json");
const msgs = new Map<string, Record<string, any>>(); const todo = new Map<string, Record<string, any>>();
const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fakeFetch: typeof fetch = async (u, init) => {
  const url = new URL(String(u)); const method = init?.method ?? "GET";
  if (url.origin !== "https://graph.microsoft.com") return json(500, {});
  if ((init?.headers as Record<string, string>).authorization !== "Bearer MS-AT") return json(401, {});
  if (url.pathname === "/v1.0/me/messages" && method === "POST") { const b = JSON.parse(String(init!.body)); msgs.set("D1", { ...b, id: "D1", isDraft: true, webLink: "https://outlook.office365.com/owa/?ItemID=D1" }); return json(201, msgs.get("D1")); }
  if (url.pathname.startsWith("/v1.0/me/messages/")) { const id = url.pathname.split("/").pop()!; if (method === "DELETE") { msgs.delete(id); return json(204, null); } return msgs.has(id) ? json(200, msgs.get(id)) : json(404, {}); }
  if (url.pathname === "/v1.0/me/todo/lists") return json(200, { value: [{ id: "L1", wellknownListName: "defaultList" }] });
  const m = /^\/v1\.0\/me\/todo\/lists\/L1\/tasks(?:\/(.+))?$/.exec(url.pathname);
  if (m && method === "POST") { const b = JSON.parse(String(init!.body)); todo.set("T1", { ...b, id: "T1", status: "notStarted" }); return json(201, todo.get("T1")); }
  if (m && method === "DELETE") { todo.delete(m[1]!); return json(204, null); }
  if (m) return todo.has(m[1]!) ? json(200, todo.get(m[1]!)) : json(404, {});
  return json(404, {});
};
let server: Server, base: string, direct: ReturnType<typeof createLink>["direct"], port = 0;
beforeAll(async () => {
  const probe = createLink({ clientId: "g.apps.googleusercontent.com", clientSecret: "s", port: 0, tokenFile }).server;
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r)); port = (probe.address() as { port: number }).port; probe.close();
  const link = createLink({ clientId: "g.apps.googleusercontent.com", clientSecret: "S", port, tokenFile, fetch: fakeFetch, microsoftClientId: MS_ID, msAuthUrl: "https://login.test/authorize", msTokenUrl: "https://login.test/token" });
  server = link.server; direct = link.direct;
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r)); base = `http://localhost:${port}`;
});
afterAll(() => { server?.close(); });
const signedIn = (scope: string) => { mkdirSync(path.dirname(msFile), { recursive: true }); writeFileSync(msFile, JSON.stringify({ access_token: "MS-AT", refresh_token: "RT", expires_at: Date.now() + 3_600_000, scope, connected_at: "test" })); };
const piece = (id: string, kind: string, text: string, value?: object) => ({ id, kind, text, confidence: 0.95, ...(value ? { value } : {}), evidence: [{ locator: { kind: "css", value: `#${id}` } }], source: { app: "example.com", url: "https://example.com/q3", title: "Q3" } }) as never;
function draftOp(): Operation {
  const o = resolve({ type: "Message", properties: { to: ["maya.rao@example.com"], snippet: "Free on Friday?" }, fields: { to: { confidence: 0.95, evidence: [{ locator: { kind: "css", value: "#to" } }] }, snippet: { confidence: 0.95, evidence: [{ locator: { kind: "css", value: "#s" } }] } }, provenance: { source: { app: "t" }, capture: { method: "dom", adapter: "t", at: "2026-10-26T08:00:00Z" } } });
  return plan(propose(o, CONTRACTS.outlookMessageDraft)[0]!, { now: () => "2026-10-26T09:00:00Z" });
}
function todoOp(): Operation {
  const page = newClump("obj-1", piece("pg1", "page", "Q3 plan", { name: "Q3 plan", url: "https://example.com/q3" }));
  const v = viewClump(answerClump(page, "title", "Q3 plan"), { now: "2026-10-21T09:00:00Z", timezone: "UTC" });
  return plan(propose(resolve(v.candidate!), CONTRACTS.msTodoTask)[0]!, { now: () => "2026-10-21T09:00:00Z" });
}

describe("Outlook mail drafts and Microsoft To Do (optional Microsoft permissions)", () => {
  it("the sign-in asks for mail and To Do only when ticked", async () => {
    const scope = async (q: string) => new URL((await fetch(`${base}/microsoft/start${q}`, { redirect: "manual" })).headers.get("location")!).searchParams.get("scope");
    expect(await scope("")).toBe("offline_access Calendars.ReadWrite");
    expect(await scope("?mail=1")).toBe("offline_access Calendars.ReadWrite Mail.ReadWrite");
    expect(await scope("?mail=1&todo=1")).toBe("offline_access Calendars.ReadWrite Mail.ReadWrite Tasks.ReadWrite");
    expect(await (await fetch(base)).text()).toContain("Outlook mail drafts (Recast saves drafts; it never sends)");
  });
  it("without the ticked permission each is refused before anything reaches Microsoft", async () => {
    signedIn("Calendars.ReadWrite");
    expect((await direct("status", {})).body).toMatchObject({ outlook: true, outlookMail: false, mstodo: false });
    expect((await direct("commit", { destination: "outlook-mail", op: draftOp(), consent: { kind: "confirm" } })).body).toMatchObject({ outcome: "failed", message: /tick mail drafts/ });
    expect((await direct("commit", { destination: "mstodo", op: todoOp(), consent: { kind: "confirm" } })).body).toMatchObject({ outcome: "failed", message: /tick To Do/ });
    expect(msgs.size + todo.size).toBe(0);
  });
  it("with them: a draft in Outlook and a task in To Do, each read back with its link and undone", async () => {
    signedIn("https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Tasks.ReadWrite");
    expect((await direct("status", {})).body).toMatchObject({ outlookMail: true, mstodo: true });
    const d = draftOp(); const r = await direct("commit", { destination: "outlook-mail", op: d, consent: { kind: "confirm" } });
    expect(r.body).toMatchObject({ outcome: "done", receipt: { destination: "outlook-mail.drafts" } });
    expect(msgs.get("D1")).toMatchObject({ toRecipients: [{ emailAddress: { address: "maya.rao@example.com" } }], isDraft: true });
    expect((await direct("verify", { destination: "outlook-mail", op: d, receipt: r.body.receipt })).body).toMatchObject({ verification: { ok: true, link: "https://outlook.office365.com/owa/?ItemID=D1" } });
    expect((await direct("reconcile", { destination: "outlook-mail", op: d })).body).toMatchObject({ checkable: false });
    expect((await direct("undo", { destination: "outlook-mail", receipt: r.body.receipt })).body).toEqual({ outcome: "undone" }); expect(msgs.size).toBe(0);
    const t = todoOp(); const r2 = await direct("commit", { destination: "mstodo", op: t, consent: { kind: "confirm" } });
    expect(r2.body).toMatchObject({ outcome: "done", receipt: { destination: "microsoft-todo.task" } });
    expect((await direct("verify", { destination: "mstodo", op: t, receipt: r2.body.receipt })).body).toMatchObject({ verification: { ok: true } });
    expect((await direct("undo", { destination: "mstodo", receipt: r2.body.receipt })).body).toEqual({ outcome: "undone" }); expect(todo.size).toBe(0);
    expect(JSON.stringify([r.body, r2.body])).not.toContain("MS-AT");
  });
});
