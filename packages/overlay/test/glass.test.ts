// The glass must stay readable whatever is behind it. Blur cannot be relied on (it is unavailable in some browsers and
// turned off by people who reduce transparency), so text is checked over the glass tint composited on the worst
// backdrops, pure black and pure white, and over the solid fallback. WCAG AA: 4.5:1 for body text.
import { describe, expect, it } from "vitest";
import { GLASS_CSS, GLASS_TOKENS } from "../src/glass.js";

const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]: readonly number[]) => 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
const ratio = (a: readonly number[], b: readonly number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
const over = (tint: readonly number[], back: readonly number[]) => [0, 1, 2].map((i) => tint[i]! * tint[3]! + back[i]! * (1 - tint[3]!));

describe("glass contrast", () => {
  for (const [scheme, t] of Object.entries(GLASS_TOKENS)) {
    for (const [name, back] of [["black", [0, 0, 0]], ["white", [255, 255, 255]]] as const) {
      it(`${scheme} glass over ${name}: text and secondary text are at least 4.5:1`, () => {
        const bg = over(t.tint, back);
        expect(ratio(t.ink, bg)).toBeGreaterThanOrEqual(4.5);
        expect(ratio(t.muted, bg)).toBeGreaterThanOrEqual(4.5);
      });
    }
    it(`${scheme} solid fallback and the primary button are at least 4.5:1`, () => {
      expect(ratio(t.ink, t.solid)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t.muted, t.solid)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(t.solid, t.ink)).toBeGreaterThanOrEqual(4.5);      // button text (solid) on the ink button
    });
  }
  it("the stylesheet uses exactly these tokens, and falls back to solid without blur or with reduced transparency", () => {
    for (const t of Object.values(GLASS_TOKENS)) expect(GLASS_CSS).toContain(`--g-tint: rgba(${t.tint.join(", ")})`);
    expect(GLASS_CSS).toMatch(/@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\) \{ \.rg \{ background: var\(--g-solid\); \} \}/);
    expect(GLASS_CSS).toMatch(/prefers-reduced-transparency: reduce\) \{ \.rg \{ background: var\(--g-solid\)/);
    expect(GLASS_CSS).toMatch(/prefers-reduced-motion: reduce/);
  });
});

describe("why a review asks for more, in words", () => {
  it("turns the trust model's reasons into sentences, without internal labels", async () => {
    const { riskWords } = await import("../src/glass.js");
    expect(riskWords(["relation base risk: low", "confidence 0.60 is below 0.75"])).toBe("Recast is not sure of part of this reading: check it before you confirm.");
    expect(riskWords(["relation base risk: low", "notifies someone else", "cannot be undone"])).toBe("Someone else will be notified. It cannot be undone from Recast.");
    expect(riskWords(["relation base risk: medium", "effect is send, delete"])).toBe("It sends something. It deletes something.");
    expect(riskWords(["relation base risk: high"])).toBe("Check it before you confirm.");
  });
});
