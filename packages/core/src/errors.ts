export type ErrorCode =
  | "INVALID_CANDIDATE" | "INVALID_OBJECT" | "MISSING_EVIDENCE" | "INVALID_CONTRACT"
  | "BLOCKED" | "CONSENT_REQUIRED" | "BRIDGE_MISMATCH" | "ALREADY_UNDONE" | "NOT_REVERSIBLE" | "UNKNOWN_RECEIPT";

export class RecastError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly details: readonly string[] = []) {
    super(message);
    this.name = "RecastError";
  }
}
