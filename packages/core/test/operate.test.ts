import { describe, expect, it } from "vitest";
import { InMemoryEventLog, commit, inspectObject, inspectOperation, plan, preview, propose, serialize, undo, RecastError } from "../src/index.js";
import type { CommitEnv, Receipt } from "../src/index.js";
import { MemoryBridge, calendar, clock, mailSend, obj, tasks } from "./helpers.js";

const meera = () => obj("Person", { name: "Meera Iyer", email: ["m@example.com"] });
const setup = (contract = calendar) => {
  const bridge = new MemoryBridge(contract), log = new InMemoryEventLog();
  const env: CommitEnv = { bridge, log, now: clock };
  return { bridge, log, env };
};

describe("preview and plan", () => {
  it("previews without side effects and shows the data that would move", () => {
    const [p] = propose(meera(), calendar);
    const pv = preview(p!);
    expect(pv.sideEffects).toBe(false);
    expect(pv.summary).toBe("Add attendee: Meera Iyer as attendee");
    expect(pv.ghost.rows).toEqual([{ label: "Person.name", value: "Meera Iyer" }, { label: "Person.email", value: "m@example.com" }]);
  });
  it("refuses to preview or plan a blocked proposal", () => {
    const [p] = propose(obj("Person", { name: "No Email" }), calendar);
    expect(() => preview(p!)).toThrowError(/needs email/);
    expect(() => plan(p!, { now: clock })).toThrow(RecastError);
  });
  it("explains what it believes and what it will do", () => {
    const o = meera();
    expect(inspectObject(o).believes.find((b) => b.property === "email")).toMatchObject({ value: "m@example.com", confidence: 0.95 });
    const op = plan(propose(o, calendar)[0]!, { now: clock });
    expect(inspectOperation(op)).toMatchObject({ receiver: "Google Calendar", reliability: "Official API", consent: "confirm", reversible: true });
  });
});

describe("commit and undo", () => {
  it("enforces consent by tier", async () => {
    const { env } = setup();
    const op = plan(propose(meera(), calendar)[0]!, { now: clock });          // medium: confirm
    await expect(commit(op, { kind: "release" }, env)).rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
    await expect(commit(op, { kind: "confirm" }, env)).resolves.toMatchObject({ status: "done" });
  });
  it("high risk needs a real hold of at least 600ms", async () => {
    const { env } = setup(mailSend);
    const op = plan(propose(meera(), mailSend)[0]!, { now: clock });
    for (const c of [{ kind: "release" }, { kind: "confirm" }, { kind: "hold", heldMs: 599 }] as const) {
      await expect(commit(op, c, env)).rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
    }
    expect((env.bridge as MemoryBridge).state).toEqual([]);
    await expect(commit(op, { kind: "hold", heldMs: 600 }, env)).resolves.toBeTruthy();
  });
  it("applies the change, logs it, and undo really reverses it", async () => {
    const { env, bridge, log } = setup();
    const op = plan(propose(meera(), calendar)[0]!, { now: clock });
    const r = await commit(op, { kind: "confirm" }, env);
    expect(bridge.state).toEqual(["attendee:Meera Iyer|m@example.com"]);
    const u = await undo(r, env);
    expect(bridge.state).toEqual([]);
    expect(u.status).toBe("undone");
    const entries = await log.entries();
    expect(entries.map((e) => [e.seq, e.kind])).toEqual([[1, "commit"], [2, "undo"]]);
  });
  it("cannot undo twice, or something never committed", async () => {
    const { env } = setup();
    const r = await commit(plan(propose(meera(), calendar)[0]!, { now: clock }), { kind: "confirm" }, env);
    await undo(r, env);
    await expect(undo(r, env)).rejects.toMatchObject({ code: "ALREADY_UNDONE" });
    await expect(undo({ ...r, receiptId: "rc_r_nope" }, env)).rejects.toMatchObject({ code: "UNKNOWN_RECEIPT" });
  });
  it("refuses to undo an irreversible operation", async () => {
    const { env } = setup();
    const r = await commit(plan(propose(meera(), calendar)[0]!, { now: clock }), { kind: "confirm" }, env);
    const forged: Receipt = { ...r, reversible: false };
    await expect(undo(forged, env)).rejects.toMatchObject({ code: "NOT_REVERSIBLE" });
  });
  it("rejects a bridge for a different destination", async () => {
    const { env } = setup(tasks);
    const op = plan(propose(meera(), calendar)[0]!, { now: clock });
    await expect(commit(op, { kind: "confirm" }, env)).rejects.toMatchObject({ code: "BRIDGE_MISMATCH" });
  });
  it("logs a failure and rethrows when the destination fails, leaving no state", async () => {
    const { env, bridge, log } = setup();
    bridge.fail = true;
    const op = plan(propose(meera(), calendar)[0]!, { now: clock });
    await expect(commit(op, { kind: "confirm" }, env)).rejects.toThrow("destination unavailable");
    expect(bridge.state).toEqual([]);
    expect((await log.entries()).map((e) => e.kind)).toEqual(["failed"]);
  });
  it("never mutates the source object", async () => {
    const o = meera();
    const before = serialize(o);
    const { env } = setup();
    await commit(plan(propose(o, calendar)[0]!, { now: clock }), { kind: "confirm" }, env);
    expect(serialize(o)).toBe(before);
  });
  it("the log hands out copies, so callers cannot rewrite history", async () => {
    const { env, log } = setup();
    await commit(plan(propose(meera(), calendar)[0]!, { now: clock }), { kind: "confirm" }, env);
    const first = await log.entries();
    (first as unknown[]).length = 0;
    expect(await log.entries()).toHaveLength(1);
  });
});
