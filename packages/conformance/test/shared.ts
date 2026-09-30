import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CASES, runAll, type Core } from "../src/run-cases.js";
import { GOLDEN } from "../src/paths.js";

/** `pnpm golden` (UPDATE_GOLDEN=1) rewrites goldens from the TypeScript-source binding. Review the diff:
 *  goldens are a regression net; correctness is asserted by the hand-written `expect` blocks. */
export const golden = (name: string, canonical?: string) => {
  if (process.env.UPDATE_GOLDEN && canonical !== undefined) { mkdirSync(GOLDEN, { recursive: true }); writeFileSync(path.join(GOLDEN, `${name}.json`), canonical + "\n"); return canonical; }
  const f = path.join(GOLDEN, `${name}.json`);
  if (!existsSync(f)) throw new Error(`missing golden for '${name}'. Run: pnpm --filter @recast/conformance golden`);
  return readFileSync(f, "utf8").trimEnd();
};

/** Same assertions for every binding: hand-written expectations AND byte-identical canonical output. */
export function conformanceSuite(binding: string, load: () => Promise<Core> | Core, runner?: (core: unknown) => Promise<{ name: string; canonical: string; mismatches: string[] }[]>) {
  describe(`conformance: ${binding}`, () => {
    it(`runs all ${CASES.length} fixture cases`, async () => {
      const results = await (runner ? runner(await load()) : runAll(await load()));
      expect(results.map((r) => r.name)).toEqual(CASES.map((c) => c.name));
      for (const r of results) {
        expect(r.mismatches, `${r.name}: hand-written expectations`).toEqual([]);
        expect(r.canonical, `${r.name}: canonical output vs golden`).toBe(golden(r.name, r.canonical));
      }
    });
  });
}
