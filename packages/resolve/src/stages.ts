import type { Embedder } from "./types";

/** Opens after `threshold` failures in a row, lets one trial call through after `cooldownMs`. */
export class CircuitBreaker {
  private failures = 0; private openedAt = 0; private state: "closed" | "open" | "half-open" = "closed";
  constructor(private threshold = 5, private cooldownMs = 30_000, private now: () => number = Date.now) {}
  get isOpen() { return this.state === "open" && this.now() - this.openedAt < this.cooldownMs; }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") { if (this.now() - this.openedAt >= this.cooldownMs) this.state = "half-open"; else throw new Error("circuit open"); }
    try { const r = await fn(); this.failures = 0; this.state = "closed"; return r; }
    catch (e) { this.failures++; if (this.state === "half-open" || this.failures >= this.threshold) { this.state = "open"; this.openedAt = this.now(); } throw e; }
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms); })]).finally(() => clearTimeout(t!));
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, ma = 0, mb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i]! * b[i]!; ma += a[i]! ** 2; mb += b[i]! ** 2; }
  return ma && mb ? dot / Math.sqrt(ma * mb) : 0;
}

/**
 * A deterministic, offline stand-in: hashed character trigrams. It measures surface similarity, NOT meaning.
 * It exists so the pipeline runs end to end without a provider; production should inject a real embedding model.
 */
export function createLocalEmbedder(dim = 256): Embedder {
  return {
    async embed(text: string) {
      const v = new Array<number>(dim).fill(0); const s = ` ${text.toLowerCase().replace(/\s+/g, " ")} `;
      for (let i = 0; i < s.length - 2; i++) { let h = 2166136261; for (const c of s.slice(i, i + 3)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); v[(h >>> 0) % dim]! += 1; }
      return v;
    },
  };
}
