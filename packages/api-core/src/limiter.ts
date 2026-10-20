export type TakeResult = { ok: true; remaining: number } | { ok: false; retryAfterSec: number };
/** One token per request from a per-tenant bucket. Shared implementations make every server instance enforce the same limit. */
export interface Limiter { take(key: string, rps: number, burst: number): TakeResult | Promise<TakeResult> }

/** Turns "tokens left after taking one" (negative when refused) into a result. Shared by the memory and SQL limiters. */
export const takeResult = (left: number, rps: number): TakeResult =>
  left >= 0 ? { ok: true, remaining: Math.floor(left) } : { ok: false, retryAfterSec: Math.max(1, Math.ceil(-left / rps)) };

/** Token bucket per key, in this process. Pure and clock-injected, so it can be tested without sleeping. */
export class RateLimiter implements Limiter {
  private b = new Map<string, { tokens: number; at: number }>();
  constructor(private now: () => number) {}
  take(key: string, rps: number, burst: number): TakeResult {
    const t = this.now(); const cur = this.b.get(key) ?? { tokens: burst, at: t };
    const tokens = Math.min(burst, cur.tokens + (Math.max(0, t - cur.at) / 1000) * rps);
    this.b.set(key, { tokens: tokens >= 1 ? tokens - 1 : tokens, at: Math.max(cur.at, t) });
    return takeResult(tokens - 1, rps);
  }
}
