// preview -> plan -> commit -> undo, plus the append-only log and inspection.
import { RecastError } from "./errors.js";
import { hash32 } from "./canonical.js";
import { assertReady } from "./propose.js";
import { HOLD_MS, RELIABILITY_LABEL } from "./trust.js";
import type {
  Bridge, CommitEnv, Consent, Env, EventLog, LogEntry, NewLogEntry, Operation, Preview, Proposal, Receipt, SemanticObject,
} from "./types.js";

const show = (v: unknown): string =>
  Array.isArray(v) ? v.map(show).join(", ") : v !== null && typeof v === "object" ? Object.values(v).map(show).join(" ") : String(v);

const titleOf = (o: SemanticObject) => show(o.properties["title"] ?? o.properties["name"] ?? o.properties["subject"] ?? o.properties["address"] ?? o.id);

function moved(p: Proposal): { path: string; value: string }[] {
  return p.dataMoved.flatMap((path) => {
    const key = path.split(".")[1]!;
    const v = p.object.properties[key];
    return v === undefined ? [] : [{ path, value: show(v) }];
  });
}

/** What the result would look like. No side effects. */
export function preview(p: Proposal): Preview {
  assertReady(p);
  return {
    summary: `${p.effect}: ${titleOf(p.object)} as ${p.relation}`,
    ghost: { targetKind: p.destination.targetKind, effect: p.effect, rows: moved(p).map((m) => ({ label: m.path, value: m.value })) },
    sideEffects: false,
  };
}

export function plan(p: Proposal, env: Env): Operation {
  assertReady(p);
  const at = env.now();
  return {
    opId: "rc_op_" + hash32(`${p.id}\n${at}`), at, proposal: p, risk: p.risk,
    dataMoved: moved(p), reliabilityLabel: RELIABILITY_LABEL[p.reliability],
  };
}

export function checkConsent(op: Operation, consent: Consent): void {
  const need = op.risk.consent;
  const ok =
    need === "release" ? true :
    need === "confirm" ? consent.kind === "confirm" || (consent.kind === "hold" && consent.heldMs >= HOLD_MS) :
    consent.kind === "hold" && consent.heldMs >= HOLD_MS;
  if (!ok) throw new RecastError("CONSENT_REQUIRED", `this operation needs consent '${need}'${need === "hold" ? ` (hold at least ${HOLD_MS}ms)` : ""}`, op.risk.reasons);
}

export class InMemoryEventLog implements EventLog {
  private list: LogEntry[] = [];
  async append(e: NewLogEntry): Promise<void> { this.list.push(Object.freeze({ ...e, seq: this.list.length + 1 }) as LogEntry); }
  async entries(): Promise<readonly LogEntry[]> { return [...this.list]; }
}

function assertBridge(bridge: Bridge, p: Proposal) {
  if (bridge.describe().destination !== p.destination.destination) {
    throw new RecastError("BRIDGE_MISMATCH", `bridge serves '${bridge.describe().destination}', operation targets '${p.destination.destination}'`);
  }
}

export async function commit(op: Operation, consent: Consent, env: CommitEnv): Promise<Receipt> {
  checkConsent(op, consent);
  assertBridge(env.bridge, op.proposal);
  const p = op.proposal;
  let ref: string | undefined;
  try { ({ ref } = await env.bridge.execute(op)); }
  catch (e) {
    await env.log.append({ kind: "failed", at: env.now(), opId: op.opId, reason: e instanceof Error ? e.message : String(e) });
    throw e;
  }
  const at = env.now();
  const receipt: Receipt = {
    receiptId: "rc_r_" + hash32(`${op.opId}\ncommit`), opId: op.opId, at, status: "done", objectId: p.object.id,
    destination: p.destination.destination, relationId: p.relationId, effect: p.effect, reversible: p.reversible,
    ...(ref !== undefined ? { bridgeRef: ref } : {}),
  };
  await env.log.append({ kind: "commit", at, receipt });
  return receipt;
}

export async function undo(receipt: Receipt, env: CommitEnv): Promise<Receipt> {
  const entries = await env.log.entries();
  const committed = entries.find((e) => e.kind === "commit" && e.receipt.receiptId === receipt.receiptId);
  if (!committed) throw new RecastError("UNKNOWN_RECEIPT", "receipt is not in the history log");
  if (entries.some((e) => e.kind === "undo" && e.receipt.receiptId === receipt.receiptId)) throw new RecastError("ALREADY_UNDONE", "already undone");
  if (!receipt.reversible) throw new RecastError("NOT_REVERSIBLE", "this operation cannot be undone");
  if (env.bridge.describe().destination !== receipt.destination) throw new RecastError("BRIDGE_MISMATCH", "wrong bridge for this receipt");
  await env.bridge.undo(receipt);
  const at = env.now();
  const undone: Receipt = { ...receipt, status: "undone", at };
  await env.log.append({ kind: "undo", at, receipt: undone });
  return undone;
}

export interface Explanation { believes: { property: string; value: string; confidence: number; evidence: string[] }[]; source: string; capturedBy: string }
export function inspectObject(o: SemanticObject): Explanation {
  return {
    believes: Object.keys(o.properties).sort().map((k) => ({
      property: k, value: show(o.properties[k]), confidence: o.fields[k]!.confidence,
      evidence: o.fields[k]!.evidence.map((e) => `${e.locator.kind}:${e.locator.value}`),
    })),
    source: [o.provenance.source.app, o.provenance.source.url].filter(Boolean).join(" "),
    capturedBy: `${o.provenance.capture.method} via ${o.provenance.capture.adapter}`,
  };
}
export interface OperationExplanation { willDo: string; receiver: string; reliability: string; dataMoved: { path: string; value: string }[]; risk: string; consent: string; reversible: boolean }
export function inspectOperation(op: Operation): OperationExplanation {
  return {
    willDo: `${op.proposal.effect}: ${titleOf(op.proposal.object)} as ${op.proposal.relation}`,
    receiver: op.proposal.destination.app, reliability: op.reliabilityLabel, dataMoved: op.dataMoved,
    risk: op.risk.tier, consent: op.risk.consent, reversible: op.proposal.reversible,
  };
}
