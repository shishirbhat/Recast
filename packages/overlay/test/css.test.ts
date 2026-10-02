import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/overlay.css"), "utf8");

describe("overlay stylesheet is safe inside a shadow root", () => {
  it("targets the shadow host; :root may appear only alongside :host (:root matches nothing inside a shadow tree)", () => {
    const rules = css.split(/[{}]/).filter((_, i) => i % 2 === 0);                      // selector lists
    for (const sel of rules.filter((r) => /:root/.test(r))) expect(sel, `selector ":root" without ":host": ${sel.slice(0, 80)}`).toMatch(/:host/);
    expect(css).toContain(':host([data-theme="dark"])');
    expect(css).toContain(':host(:not([data-theme="light"]))');
  });
  it("redeclares Tailwind's @property defaults as plain custom properties (@property is ignored in shadow roots)", () => {
    // Without these, transforms, borders and shadows silently compute to "none" (this shipped broken once).
    for (const v of ["--tw-border-style:solid", "--tw-translate-x:0", "--tw-shadow:0 0 #0000"]) expect(css, v).toContain(v);
  });
  it("carries both colour schemes and the reduced-motion override", () => {
    expect(css).toMatch(/prefers-color-scheme:\s*dark/);
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
  });
  it("keeps the countdown keyframes that the toast uses", () => {
    expect(css).toContain("@keyframes recast-bar");
  });
});
