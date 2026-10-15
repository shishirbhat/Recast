/** Token bucket per key. Pure and clock-injected, so it can be tested without sleeping. */
export class RateLimiter {
  private b = new Map<string, { tokens: number; at: number }>();
  constructor(private now: () => number) {}
  take(key: string, rps: number, burst: number): { ok: true; remaining: number } | { ok: false; retryAfterSec: number } {
    const t = this.now(); const cur = this.b.get(key) ?? { tokens: burst, at: t };
    const tokens = Math.min(burst, cur.tokens + ((t - cur.at) / 1000) * rps);
    if (tokens >= 1) { this.b.set(key, { tokens: tokens - 1, at: t }); return { ok: true, remaining: Math.floor(tokens - 1) }; }
    this.b.set(key, { tokens, at: t });
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - tokens) / rps)) };
  }
}
