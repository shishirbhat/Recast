export type AuthCode = "malformed" | "bad_algorithm" | "unknown_agent" | "agent_revoked" | "bad_signature" | "expired" | "not_yet_valid" | "wrong_audience" | "ttl_too_long" | "token_revoked";
export class AuthError extends Error { constructor(readonly code: AuthCode, message: string) { super(message); this.name = "AuthError"; } }
