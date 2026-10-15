import { describe, expect, it } from "vitest";
import { createResolver } from "../src";
import { LABELLED } from "./labelled";

const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)]!; };

describe("latency and cost of the rules stage (measured, printed, budgeted)", () => {
  it("p99 under 5 ms per resolve; 100% of the labelled set never leaves the rules stage; cost is zero model calls", async () => {
    const res = createResolver(); const times: number[] = []; const stages: Record<string, number> = {};
    for (let round = 0; round < 50; round++) for (const l of LABELLED) {
      const t0 = performance.now(); const o = await res.resolve({ raw: l.raw }); times.push(performance.now() - t0);
      stages[o.meta.stage] = (stages[o.meta.stage] ?? 0) + 1;
    }
    console.log(`RULES-ONLY n=${times.length} p50=${pct(times, 50).toFixed(3)}ms p95=${pct(times, 95).toFixed(3)}ms p99=${pct(times, 99).toFixed(3)}ms stages=${JSON.stringify(stages)} modelCalls=0`);
    expect(pct(times, 99)).toBeLessThan(5); expect(Object.keys(stages)).toEqual(["rules"]);
  });
});
