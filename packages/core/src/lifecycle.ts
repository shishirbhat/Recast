// One action lifecycle, shared by the consumer interaction, the API's placements and the agent runtime's executions.
// A person releasing a capsule, an agent receiving approval and a provider completing a request are different events;
// each has its own status, and success is only ever reported after the provider confirmed it.

export type ActionStatus =
  | "proposed"            // described, nothing checked yet
  | "validated"           // fields, destination compatibility and permissions checked
  | "awaiting_approval"   // a person (or policy) must decide first
  | "executing"           // sent to the provider; the result is not known yet
  | "succeeded"           // the provider confirmed it
  | "failed"              // the provider confirmed it did not happen, or it never left
  | "outcome_unknown"     // the provider may have done it (for example a timeout after the request was sent); reconcile, never blindly retry
  | "cancelled"           // the person stopped it before execution
  | "denied"              // validation, permission or policy refused it
  | "expired"             // an approval or grant ran out before execution
  | "reversed";           // undone after success, through a declared reversal

export const TRANSITIONS: Readonly<Record<ActionStatus, readonly ActionStatus[]>> = {
  proposed: ["validated", "denied", "cancelled"],
  validated: ["awaiting_approval", "executing", "denied", "cancelled"],
  awaiting_approval: ["executing", "denied", "expired", "cancelled"],
  executing: ["succeeded", "failed", "outcome_unknown"],
  outcome_unknown: ["succeeded", "failed"],        // only through reconciliation with the provider
  succeeded: ["reversed"],
  failed: [], cancelled: [], denied: [], expired: [], reversed: [],
};
export const isTerminal = (s: ActionStatus) => TRANSITIONS[s].length === 0;

export interface ActionStep { status: ActionStatus; at: string; reason?: string }
export interface ActionRecord { id: string; status: ActionStatus; history: readonly ActionStep[] }

export class LifecycleError extends Error {
  constructor(readonly from: ActionStatus, readonly to: ActionStatus) { super(`an action cannot go from ${from} to ${to}`); this.name = "LifecycleError"; }
}

export function startAction(id: string, at: string): ActionRecord {
  return { id, status: "proposed", history: [{ status: "proposed", at }] };
}
/** Returns a new record; throws if the move is not allowed. Records are never edited in place. */
export function advance(r: ActionRecord, to: ActionStatus, at: string, reason?: string): ActionRecord {
  if (!TRANSITIONS[r.status].includes(to)) throw new LifecycleError(r.status, to);
  return { id: r.id, status: to, history: [...r.history, { status: to, at, ...(reason ? { reason } : {}) }] };
}

/**
 * What a bridge operation declares about itself. Undo, retries and the success message all depend on these, not on hope.
 * - writes: changes something outside Recast.
 * - idempotency: "provider-key" = a client-chosen id makes a repeat a no-op (Calendar event id); "none" = a repeat may duplicate.
 * - verifiable: the result can be read back to confirm or reconcile.
 * - reversal: how undo works, or "none" (then no Undo is offered).
 * - onTimeout: "outcome-unknown" for writes whose request may have arrived; "safe-to-retry" only for reads or keyed writes.
 */
export interface OperationCapabilities {
  writes: boolean;
  idempotency: "provider-key" | "none" | "not-applicable";
  verifiable: boolean;
  reversal: "delete-created" | "restore-previous" | "archive" | "none";
  onTimeout: "outcome-unknown" | "safe-to-retry";
  /** The permission the destination account must have granted. */
  permission: string;
}

/** Thrown by a bridge when a write may or may not have happened. Callers record outcome_unknown and reconcile. */
export class OutcomeUnknownError extends Error {
  constructor(message: string, readonly reconcileRef?: string) { super(message); this.name = "OutcomeUnknownError"; }
}
