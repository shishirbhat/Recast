// Your own webhook through the local program. MOCKED RECEIVER: an in-process stand-in that checks the signature the way a
// real receiver should.
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { newClump, plan, propose, resolve, viewClump } from "@recast/core";
import { CONTRACTS } from "@recast/bridges";
import { createExtensionApi } from "../src/extension-api.js";
import { connectWebhook, webhookFile, webhookUrlProblem } from "../src/webhook.js";

const URL_OK = "https://hooks.example.com/recast";
function receiver(o: { status?: number; redirect?: boolean } = {}) {
  const got: { body: any; headers: Record<string, string>; valid: (secret: string) => boolean }[] = [];
  const f = (async (u: string, init: RequestInit) => {
    if (String(u) !== URL_OK) return new Response("{}", { status: 404 });
    if (init.redirect !== "manual") throw new Error("redirects must not be followed");
    const h = init.headers as Record<string, string>; const body = String(init.body);
    got.push({ body: JSON.parse(body), headers: h, valid: (secret) => h["X-Recast-Signature"] === `sha256=${createHmac("sha256", secret).update(`${h["X-Recast-Timestamp"]}.${body}`).digest("hex")}` });
    if (o.redirect) return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } });
    return new Response(JSON.stringify({ ok: true }), { status: o.status ?? 200 });
  }) as unknown as typeof fetch;
  return { f, got };
}
const dirOf = () => { const d = path.join(mkdtempSync(path.join(tmpdir(), "recast-hook-")), ".secrets"); mkdirSync(d, { recursive: true }); return d; };

describe("your own webhook on this computer", () => {
  it("only https (http just for localhost), no credentials in the address", () => {
    expect(webhookUrlProblem("http://hooks.example.com/x")).toMatch(/https/);
    expect(webhookUrlProblem("https://user:pw@hooks.example.com/x")).toMatch(/name and password/);
    expect(webhookUrlProblem("ftp://x")).toMatch(/https/);
    expect(webhookUrlProblem("http://localhost:5678/hook")).toBeNull();
    expect(webhookUrlProblem(URL_OK)).toBeNull();
  });
  it("is saved only after a signed test ping answered 2xx; a refusal or a redirect saves nothing", async () => {
    const d = dirOf();
    expect(await connectWebhook(d, "Log", URL_OK, receiver({ status: 500 }).f, 0)).toMatchObject({ ok: false, message: /answered 500/ });
    expect(await connectWebhook(d, "Log", URL_OK, receiver({ redirect: true }).f, 0)).toMatchObject({ ok: false, message: /redirect/ });
    expect(existsSync(webhookFile(d))).toBe(false);
    const r = receiver(); const c = await connectWebhook(d, "Team log", URL_OK, r.f, Date.parse("2026-10-29T10:00:00Z"));
    expect(c).toMatchObject({ ok: true, link: { name: "Team log", url: URL_OK } });
    expect(r.got[0]!.body).toMatchObject({ recast: 1, kind: "ping" });
    expect(r.got[0]!.valid((c as any).link.secret)).toBe(true);
    expect(statSync(webhookFile(d)).mode & 0o777).toBe(0o600);
  });
  it("a page is delivered once, signed, after a hold; it cannot be checked or undone, and says so", async () => {
    const d = dirOf(); const r = receiver();
    const c = await connectWebhook(d, "Team log", URL_OK, r.f, Date.now()); if (!c.ok) throw new Error("connect");
    const tokenFile = path.join(d, "google-token.json");   // not signed in to Google: the webhook needs no Google
    const api = createExtensionApi({ clientId: "c", clientSecret: "s", tokenFile, tokenUrl: "https://google.test/token", now: Date.now, stateFile: path.join(d, "t.json"), dir: d, fetch: r.f });
    expect((await api.direct("status", {})).body).toMatchObject({ webhook: "Team log" });
    const page = newClump("obj-1", { id: "pg1", kind: "page", text: "Q3 plan", value: { name: "Q3 plan", url: "https://example.com/q3" }, confidence: 0.95, evidence: [{ locator: { kind: "meta", value: "title" } }], source: { app: "example.com", url: "https://example.com/q3" } });
    const op = plan(propose(resolve(viewClump(page, { now: "2026-10-29T09:00:00Z", timezone: "UTC" }).candidate!), CONTRACTS.webhookPage)[0]!, { now: () => "2026-10-29T09:00:00Z" });
    expect((await api.direct("commit", { destination: "webhook", op, consent: { kind: "confirm" } })).body).toMatchObject({ outcome: "failed" });   // a click is not enough
    const done = await api.direct("commit", { destination: "webhook", op, consent: { kind: "hold", heldMs: 700 } });
    expect(done.body).toMatchObject({ outcome: "done", receipt: { destination: "webhook.page", reversible: false } });
    const delivery = r.got.at(-1)!;
    expect(delivery.body).toMatchObject({ recast: 1, delivery: op.opId, type: "Document", object: { title: "Q3 plan", url: "https://example.com/q3" } });
    expect(delivery.headers["X-Recast-Delivery"]).toBe(op.opId);
    expect(delivery.valid(c.link.secret)).toBe(true);
    expect(JSON.stringify(done.body)).not.toContain(c.link.secret);
    expect((await api.direct("reconcile", { destination: "webhook", op })).body).toMatchObject({ checkable: false });
    expect((await api.direct("undo", { destination: "webhook", receipt: done.body.receipt })).body).toMatchObject({ outcome: "failed" });
    expect(r.got.filter((g) => g.body.kind !== "ping")).toHaveLength(1);
  });
});
