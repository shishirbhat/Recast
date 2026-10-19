import type { Bridge, CapabilityContract, Operation, OperationCapabilities, Receipt } from "@recast/core";
import { checkContract, OutcomeUnknownError } from "@recast/core";

export interface HttpRequest { method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; url: string; headers?: Record<string, string>; body?: unknown }
export interface HttpResponse { status: number; json: unknown }
/** The only door to the network. Production passes a function that calls fetch with the user's token; nothing in this package calls fetch. */
export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

/** What one destination knows how to do. `undoToken` is a small JSON string stored in the receipt. */
export interface Spec<Target> {
  contract: CapabilityContract;
  /** What each accepted relation's operation declares about itself (see OperationCapabilities in @recast/core). */
  capabilities: Readonly<Record<string, OperationCapabilities>>;
  execute(op: Operation, target: Target, send: Send): Promise<string>;
  undo(token: string, target: Target, send: Send): Promise<void>;
  /** Before anything is sent: what this operation still needs (for example "Event.end"). Empty means ready. */
  check?(op: Operation): string[];
  /** For verifiable operations: after an unknown outcome, ask the provider whether the change exists. Never re-sends the write. */
  reconcile?(token: string, target: Target, send: Send): Promise<"present" | "absent">;
}
export type Send = (req: HttpRequest) => Promise<unknown>;

export class DestinationError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = "DestinationError"; }
}
/** The same thing was already placed there (a provider key or content id matched). Nothing new was created. */
export class DuplicateError extends DestinationError {
  constructor(message: string, readonly existingToken: string) { super(message, 409); this.name = "DuplicateError"; }
}

/** Looks a moved value up by its path, e.g. "Person.email". Only values the user was shown can be used. */
export function moved(op: Operation, path: string): string | undefined { return op.dataMoved.find((d) => d.path === path)?.value; }
export function need(op: Operation, path: string): string {
  const v = moved(op, path); if (v === undefined || v === "") throw new DestinationError(`missing ${path}`); return v;
}
/** Path segments must be encoded so a value can never change which resource a request points at. */
export const seg = (s: string) => encodeURIComponent(s);

/** Wraps a Spec as a core Bridge. The target says which window or document the user is placing into. */
export class HttpBridge<Target> implements Bridge {
  constructor(private spec: Spec<Target>, private target: Target, private transport: Transport) {}
  describe() { return checkContract(this.spec.contract); }
  capabilities(relationId: string): OperationCapabilities | undefined { return this.spec.capabilities[relationId]; }
  check(op: Operation): string[] { return this.spec.check?.(op) ?? []; }
  async reconcile(token: string): Promise<"present" | "absent"> {
    if (!this.spec.reconcile) throw new DestinationError("this operation cannot be checked with the provider");
    return this.spec.reconcile(token, this.target, this.send);
  }
  private send: Send = async (req) => {
    const r = await this.transport(req);
    // A gateway timeout on a write means the provider may have applied it: unknown, not failed.
    if (r.status === 504 && req.method !== "GET") throw new OutcomeUnknownError(`${new URL(req.url).hostname} timed out behind its gateway; the change may have been made`);
    if (r.status < 200 || r.status >= 300) throw new DestinationError(`${req.method} ${new URL(req.url).hostname} answered ${r.status}`, r.status);
    return r.json;
  };
  async execute(op: Operation) { return { ref: await this.spec.execute(op, this.target, this.send) }; }
  async undo(receipt: Receipt) {
    if (!receipt.bridgeRef) throw new DestinationError("nothing to undo: no reference was stored");
    await this.spec.undo(receipt.bridgeRef, this.target, this.send);
  }
}
