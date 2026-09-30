// Binding-agnostic conformance runner. It receives the core under test as an argument, so the same
// code runs against the TypeScript source, the ESM bundle and the browser IIFE bundle.
import type * as CoreNS from "@recast/core";
import { ReferenceBridge } from "./reference-bridge.js";
import cases from "../fixtures/cases.json";
import contracts from "../fixtures/contracts.json";

export type Core = typeof CoreNS;
export interface Case {
  name: string; now: string;
  input: { candidate?: CoreNS.Candidate; perception?: CoreNS.PerceptionInput };
  destination?: keyof typeof contracts;
  attempts?: CoreNS.Consent[]; undo?: boolean; expect: Record<string, unknown>;
}
export const CASES = cases as unknown as Case[];
export interface CaseResult { name: string; canonical: string; mismatches: string[] }

const codeOf = (e: unknown) => (e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "error");

export async function transcribe(core: Core, c: Case) {
  let t = Date.parse(c.now);
  const now = () => new Date((t += 1000)).toISOString().replace(".000Z", "Z");
  const candidates = c.input.candidate ? [c.input.candidate] : core.perceive(c.input.perception!);
  const objects = candidates.map((x) => core.resolve(x));
  const serialized = objects.map((o) => core.serialize(o));
  const out = {
    candidates: candidates.length,
    objectTypes: objects.map((o) => o.type),
    objects: objects.map((o, i) => ({ id: o.id, serialized: serialized[i]! })),
    roundTrip: serialized.every((s) => core.serialize(core.deserialize(s)) === s),
    proposals: [] as unknown[], preview: null as unknown, operation: null as unknown,
    attempts: [] as { consent: CoreNS.Consent; result: string }[],
    receipt: null as unknown, undoReceipt: null as unknown,
    bridgeStateAfterCommit: [] as string[], bridgeStateAfterUndo: [] as string[], log: [] as unknown[],
  };
  if (!c.destination) return out;
  const contract = contracts[c.destination] as CoreNS.CapabilityContract;
  const proposals = core.propose(objects[0]!, contract);
  out.proposals = proposals.map((p) => ({
    id: p.id, relationId: p.relationId, status: p.status, confidence: p.confidence, tier: p.risk.tier, consent: p.risk.consent,
    deliberate: p.risk.requiresDeliberateChoice, reliability: p.reliability, blocked: p.blocked?.reason ?? null, reasons: p.risk.reasons,
  }));
  const p = proposals[0];
  if (!p || p.status !== "ready") return out;
  out.preview = core.preview(p);
  const op = core.plan(p, { now });
  out.operation = { opId: op.opId, dataMoved: op.dataMoved, consent: op.risk.consent, reliabilityLabel: op.reliabilityLabel };
  const bridge = new ReferenceBridge(contract), log = new core.InMemoryEventLog();
  const env = { bridge, log, now };
  let receipt: CoreNS.Receipt | undefined;
  for (const consent of c.attempts ?? []) {
    try { receipt = await core.commit(op, consent, env); out.attempts.push({ consent, result: "ok" }); break; }
    catch (e) { out.attempts.push({ consent, result: codeOf(e) }); }
  }
  out.receipt = receipt ?? null;
  out.bridgeStateAfterCommit = [...bridge.state];
  if (receipt && c.undo) {
    out.undoReceipt = await core.undo(receipt, env);
    out.bridgeStateAfterUndo = [...bridge.state];
  }
  out.log = (await log.entries()).map((e) => ({ seq: e.seq, kind: e.kind }));
  return out;
}

/** Hand-written expectations: array lengths must match; objects are matched on the keys the fixture names. */
function subset(actual: unknown, expected: unknown, path: string, out: string[]) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) { out.push(`${path}: expected ${expected.length} items, got ${Array.isArray(actual) ? actual.length : typeof actual}`); return; }
    expected.forEach((e, i) => subset(actual[i], e, `${path}[${i}]`, out));
  } else if (expected && typeof expected === "object") {
    for (const [k, v] of Object.entries(expected)) subset((actual as Record<string, unknown> | null)?.[k], v, `${path}.${k}`, out);
  } else if (actual !== expected) out.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export async function runAll(core: Core): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const c of CASES) {
    const t = await transcribe(core, c);
    const mismatches: string[] = [];
    subset(t, c.expect, c.name, mismatches);
    results.push({ name: c.name, canonical: core.canonicalJson(t), mismatches });
  }
  return results;
}
