import { describe, expect, it } from "vitest";
import { CAPABILITIES, createRelease, parseOverrides, ReleaseConfigError } from "../src/index.js";

describe("release states", () => {
  it("a capability reaches its own cohort and every earlier one, never a later one", () => {
    const r = createRelease();
    expect(r.state("api.place")).toBe("internal");
    expect(["internal", "private", "preview", "public"].map((c) => r.allows("api.place", c as never))).toEqual([true, false, false, false]);
    expect(["internal", "private", "preview", "public"].map((c) => r.allows("api.resolve", c as never))).toEqual([true, true, false, false]);
  });
  it("disabled means nobody, including internal", () => {
    expect(createRelease().allows("community.recipes", "internal")).toBe(false);
  });
  it("overrides apply per deployment; mistakes stop the server instead of silently opening or closing things", () => {
    const r = createRelease(parseOverrides("api.place=preview, data.library=internal"));
    expect(r.allows("api.place", "preview")).toBe(true); expect(r.allows("data.library", "internal")).toBe(true);
    expect(() => parseOverrides("api.plaec=public")).toThrow(ReleaseConfigError);
    expect(() => parseOverrides("api.place=everyone")).toThrow("not a release state");
  });
  it("nothing is public yet: no surface has met its release gates", () => {
    expect(Object.entries(CAPABILITIES).filter(([, v]) => (v.state as string) === "public")).toEqual([]);
  });
});
