import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CORE_DIST } from "../src/paths.js";

describe("bundle hygiene (extension-safe)", () => {
  for (const f of ["recast-core.esm.js", "recast-core.iife.js"]) {
    it(`${f} has no dynamic code execution, network or storage access`, () => {
      const src = readFileSync(path.join(CORE_DIST, f), "utf8");
      for (const pat of [/\bnew Function\s*\(/, /\beval\s*\(/, /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /localStorage/, /indexedDB/, /require\(["']node:/]) {
        expect(src, String(pat)).not.toMatch(pat);
      }
    });
  }
});
