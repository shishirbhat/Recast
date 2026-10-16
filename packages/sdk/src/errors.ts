export class RecastError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number) { super(message); this.name = new.target.name; }
}
export class AuthError extends RecastError { constructor(m: string) { super(m, "unauthorized", 401); } }
export class QuotaError extends RecastError { constructor(m: string, readonly used: number | null, readonly limit: number | null) { super(m, "quota_exceeded", 402); } }
export class RateLimitError extends RecastError { constructor(m: string, readonly retryAfterSec: number) { super(m, "rate_limited", 429); } }
export class ValidationError extends RecastError { constructor(m: string, code: string, status: number) { super(m, code, status); } }
export class ServerError extends RecastError { constructor(m: string, status: number) { super(m, "server_error", status); } }
export class NetworkError extends RecastError { constructor(m: string) { super(m, "network_error"); } }
export class CircuitOpenError extends RecastError { constructor() { super("too many recent failures; not calling the API until the cool-down ends", "circuit_open"); } }
/** The destination app (Google, Notion) refused or failed. Not retried: "reconnect" problems do not fix themselves. */
export class DestinationError extends RecastError { constructor(m: string, code: string) { super(m, code, 502); } }
