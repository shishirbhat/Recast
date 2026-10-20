// Press Control twice: exact timings, and everything that must NOT count (chords, holds, slow presses, a click between).
import { describe, expect, it } from "vitest";
import { createDoubleTap, type TapInput } from "../src/index.js";

const play = (events: [TapInput["type"], string | undefined, number, boolean?][]) => {
  const feed = createDoubleTap(); return events.map(([type, key, at, repeat]) => feed({ type, ...(key ? { key } : {}), at, ...(repeat ? { repeat } : {}) }));
};
const tap = (at: number, len = 80): [TapInput["type"], string, number][] => [["keydown", "Control", at], ["keyup", "Control", at + len]];

describe("press Control twice", () => {
  it("two quick taps fire once, on the second release", () => {
    expect(play([...tap(0), ...tap(200)])).toEqual([false, false, false, true]);
  });
  it("a third tap starts a new pair instead of firing again", () => {
    expect(play([...tap(0), ...tap(200), ...tap(400)]).filter(Boolean)).toHaveLength(1);
  });
  it("too slow between taps, or one press held too long: nothing", () => {
    expect(play([...tap(0), ...tap(80 + 450)]).some(Boolean)).toBe(false);
    expect(play([...tap(0, 400), ...tap(500)]).some(Boolean)).toBe(false);
  });
  it("Control used for a shortcut (Ctrl+C) is not a tap, before or between", () => {
    expect(play([["keydown", "Control", 0], ["keydown", "c", 40], ["keyup", "Control", 90], ...tap(150)]).some(Boolean)).toBe(false);
    expect(play([...tap(0), ["keydown", "c", 120], ...tap(200)]).some(Boolean)).toBe(false);
  });
  it("Ctrl+click, auto-repeat while held, or leaving the window: nothing", () => {
    expect(play([["keydown", "Control", 0], ["pointerdown", undefined, 30], ["keyup", "Control", 60], ...tap(120)]).some(Boolean)).toBe(false);
    expect(play([["keydown", "Control", 0], ["keydown", "Control", 30, true], ["keyup", "Control", 60], ...tap(120)]).some(Boolean)).toBe(false);
    expect(play([...tap(0), ["blur", undefined, 100], ...tap(150)]).some(Boolean)).toBe(false);
  });
  it("other keys are never the trigger (Shift, Alt, Meta pressed twice)", () => {
    for (const k of ["Shift", "Alt", "Meta"]) expect(play([["keydown", k, 0], ["keyup", k, 50], ["keydown", k, 150], ["keyup", k, 200]]).some(Boolean)).toBe(false);
  });
});
