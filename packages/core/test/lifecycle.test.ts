import { describe, expect, it } from "vitest";
import { advance, commit, InMemoryEventLog, isTerminal, LifecycleError, OutcomeUnknownError, plan, propose, resolve, startAction, TRANSITIONS, type ActionStatus, type Bridge, type CapabilityContract } from "../src/index.js";

const T = (n: number) => `2026-10-19T09:00:0${n}Z`;
describe("action lifecycle", () => {
  it("the normal paths: placed after approval, then reversed; placed without approval", () => {
    let r = startAction("a1", T(0));
    for (const [to, i] of [["validated", 1], ["awaiting_approval", 2], ["executing", 3], ["succeeded", 4], ["reversed", 5]] as const) r = advance(r, to, T(i));
    expect(r.history.map((h) => h.status)).toEqual(["proposed", "validated", "awaiting_approval", "executing", "succeeded", "reversed"]);
    expect(isTerminal(r.status)).toBe(true);
    const direct = ["validated", "executing", "succeeded"].reduce((x, s) => advance(x, s as ActionStatus, T(1)), startAction("a2", T(0)));
    expect(direct.status).toBe("succeeded");
  });
  it("success is never reachable without executing, and an unknown outcome resolves only to succeeded or failed", () => {
    for (const from of ["proposed", "validated", "awaiting_approval"] as const) expect(TRANSITIONS[from]).not.toContain("succeeded");
    expect(TRANSITIONS.outcome_unknown).toEqual(["succeeded", "failed"]);
    let r = advance(advance(advance(startAction("a", T(0)), "validated", T(1)), "executing", T(2)), "outcome_unknown", T(3), "timeout after sending");
    expect(() => advance(r, "executing", T(4))).toThrow(LifecycleError);   // no blind retry from unknown
    r = advance(r, "succeeded", T(4), "found by reconciliation");
    expect(r.history.at(-1)).toEqual({ status: "succeeded", at: T(4), reason: "found by reconciliation" });
  });
  it("terminal states stay terminal; approval can expire or be denied; records are not edited in place", () => {
    for (const t of ["failed", "cancelled", "denied", "expired", "reversed"] as const) expect(isTerminal(t)).toBe(true);
    const waiting = advance(advance(startAction("a", T(0)), "validated", T(1)), "awaiting_approval", T(2));
    expect(advance(waiting, "expired", T(3)).status).toBe("expired"); expect(advance(waiting, "denied", T(3)).status).toBe("denied");
    expect(waiting.status).toBe("awaiting_approval");
    expect(() => advance(advance(waiting, "denied", T(3)), "executing", T(4))).toThrow("cannot go from denied to executing");
  });
});

describe("commit records an unknown outcome as unknown, not as failure", () => {
  it("a bridge that cannot tell whether its write arrived produces an 'unknown' log entry and the error propagates", async () => {
    const contract: CapabilityContract = { destination: "x.cal", app: "Cal", targetKind: "Calendar", reliability: "official-api", accepts: [{ relationId: "event-calendar-entry", effect: "Add to calendar", dataMoved: ["Event.title"] }] };
    const bridge: Bridge = { describe: () => contract, execute: async () => { throw new OutcomeUnknownError("timed out after sending", "evt-123"); }, undo: async () => {} };
    const obj = resolve({ type: "Event", properties: { title: "Dinner", start: "2026-11-14T19:30" }, fields: { title: { confidence: 0.9, evidence: [{ locator: { kind: "user", value: "t" } }] }, start: { confidence: 0.9, evidence: [{ locator: { kind: "user", value: "s" } }] } }, provenance: { source: { app: "t" }, capture: { method: "user", adapter: "t", at: "2026-10-19T09:00:00Z" } } });
    const op = plan(propose(obj, contract)[0]!, { now: () => T(0) });
    const log = new InMemoryEventLog();
    await expect(commit(op, { kind: "release" }, { bridge, log, now: () => T(1) })).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(await log.entries()).toEqual([{ seq: 1, kind: "unknown", at: T(1), opId: op.opId, reason: "timed out after sending", reconcileRef: "evt-123" }]);
  });
});
