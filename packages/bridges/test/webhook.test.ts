// The person's own webhook. MOCKED RECEIVER: an in-process stand-in that records what it was sent.
import { describe, expect, it } from "vitest";
import { InMemoryEventLog, commit, plan, propose, resolve, OutcomeUnknownError, type Candidate, type SemanticObject } from "@recast/core";
import { HttpBridge, googleTasks, webhookEvent, webhookNote, webhookPage, type HttpRequest, type Transport } from "../src";

const NOW = () => "2026-10-29T10:00:00Z";
const obj = (type: Candidate["type"], properties: Record<string, unknown>): SemanticObject => resolve({ type, properties, fields: Object.fromEntries(Object.keys(properties).map((k) => [k, { confidence: 0.95, evidence: [{ locator: { kind: "css", value: `#${k}` } }] }])), provenance: { source: { app: "test", url: "https://dakshin.example/" }, capture: { method: "dom", adapter: "test", at: "2026-10-29T09:00:00Z" } } });

describe("your own webhook", () => {
  it("an event is sent as JSON once, named by its delivery id; it needs a hold, and offers no Undo and no read-back", async () => {
    const calls: HttpRequest[] = []; const t: Transport = async (r) => { calls.push(r); return { status: 200, json: { ok: true } }; };
    const bridge = new HttpBridge(webhookEvent, { url: "https://hooks.example.com/recast" }, t);
    const p = propose(obj("Event", { title: "Dinner", start: "2026-10-30T19:30", end: "2026-10-30T20:30", timezone: "Asia/Kolkata" }), bridge.describe()).find((x) => x.relationId === "event-calendar-entry")!;
    expect(p.status).toBe("ready"); expect(p.reversible).toBe(false);
    const op = plan(p, { now: NOW });
    // It sends, and cannot be taken back: a person presses and holds (a click is not enough).
    expect(op.risk.consent).toBe("hold");
    for (const consent of [{ kind: "release" }, { kind: "confirm" }, { kind: "hold", heldMs: 300 }] as const) await expect(commit(op, consent, { bridge, log: new InMemoryEventLog(), now: NOW })).rejects.toThrow(/consent/);
    expect(calls).toHaveLength(0);
    const receipt = await commit(op, { kind: "hold", heldMs: 700 }, { bridge, log: new InMemoryEventLog(), now: NOW });
    expect(receipt.reversible).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://hooks.example.com/recast", headers: { "X-Recast-Delivery": op.opId }, body: { recast: 1, delivery: op.opId, effect: "Send to your webhook", type: "Event", object: { title: "Dinner", start: "2026-10-30T19:30", end: "2026-10-30T20:30", timezone: "Asia/Kolkata" }, source: "https://dakshin.example/" } });
    expect(bridge.describe().abilities).toEqual(["create"]);
  });
  it("a page and a note are sent with their own fields", async () => {
    const calls: HttpRequest[] = []; const t: Transport = async (r) => { calls.push(r); return { status: 204, json: null }; };
    for (const [spec, type, props, rel] of [[webhookPage, "Document", { title: "Q3 plan", url: "https://example.com/q3" }, "document-task-reference"], [webhookNote, "Note", { title: "Notes", body: "Two passages" }, "note-docs-entry"]] as const) {
      const bridge = new HttpBridge(spec, { url: "https://hooks.example.com/recast" }, t);
      const p = propose(obj(type, props), bridge.describe()).find((x) => x.relationId === rel)!;
      await commit(plan(p, { now: NOW }), { kind: "hold", heldMs: 700 }, { bridge, log: new InMemoryEventLog(), now: NOW });
    }
    expect(calls.map((c) => (c.body as any).object)).toEqual([{ title: "Q3 plan", url: "https://example.com/q3" }, { title: "Notes", body: "Two passages" }]);
  });
  it("which answers to a write are failures and which are unknown (D61)", async () => {
    for (const [status, unknown] of [[400, false], [401, false], [403, false], [404, false], [408, false], [409, false], [429, false], [503, false], [500, true], [502, true], [504, true]] as const) {
      const b = new HttpBridge(webhookPage, { url: "https://hooks.example.com/recast" }, async () => ({ status, json: {} }));
      const op = plan(propose(obj("Document", { title: "Q3", url: "https://example.com/q3" }), b.describe()).find((x) => x.relationId === "document-task-reference")!, { now: NOW });
      const r = commit(op, { kind: "hold", heldMs: 700 }, { bridge: b, log: new InMemoryEventLog(), now: NOW });
      if (unknown) await expect(r, String(status)).rejects.toBeInstanceOf(OutcomeUnknownError); else await expect(r, String(status)).rejects.not.toBeInstanceOf(OutcomeUnknownError);
    }
    // A DELETE (an undo) sent twice deletes nothing more: a 500 there stays a failure that can be tried again; a 504 is unknown.
    for (const [status, unknown] of [[500, false], [502, false], [504, true]] as const) {
      const b = new HttpBridge(googleTasks, { taskListId: "@default" }, async () => ({ status, json: {} }));
      const u = b.undo({ receiptId: "r", opId: "o", at: "2026-10-19T09:00:00Z", status: "done", objectId: "x", destination: googleTasks.contract.destination, relationId: "document-task-reference", effect: "Add a task", reversible: true, bridgeRef: JSON.stringify({ id: "t1" }) });
      if (unknown) await expect(u, `DELETE ${status}`).rejects.toBeInstanceOf(OutcomeUnknownError); else await expect(u, `DELETE ${status}`).rejects.not.toBeInstanceOf(OutcomeUnknownError);
    }
  });
  it("a refusal is a failure; a lost answer is unknown and never resent", async () => {
    const bridge = (t: Transport) => new HttpBridge(webhookPage, { url: "https://hooks.example.com/recast" }, t);
    const op = (b: HttpBridge<any>) => plan(propose(obj("Document", { title: "Q3", url: "https://example.com/q3" }), b.describe()).find((x) => x.relationId === "document-task-reference")!, { now: NOW });
    const refused = bridge(async () => ({ status: 400, json: {} }));
    await expect(commit(op(refused), { kind: "hold", heldMs: 700 }, { bridge: refused, log: new InMemoryEventLog(), now: NOW })).rejects.not.toBeInstanceOf(OutcomeUnknownError);
    // A server error may come after the receiver acted on it: unknown, like a lost answer (D61).
    const erred = bridge(async () => ({ status: 500, json: {} }));
    await expect(commit(op(erred), { kind: "hold", heldMs: 700 }, { bridge: erred, log: new InMemoryEventLog(), now: NOW })).rejects.toBeInstanceOf(OutcomeUnknownError);
    let n = 0; const lost = bridge(async () => { n++; throw new TypeError("fetch failed"); });
    await expect(commit(op(lost), { kind: "hold", heldMs: 700 }, { bridge: lost, log: new InMemoryEventLog(), now: NOW })).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(n).toBe(1);
  });
});
