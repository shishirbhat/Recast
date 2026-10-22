// Press Control twice: exact timings, and everything that must NOT count (chords, holds, slow presses, a click between).
import { describe, expect, it } from "vitest";
import { createControlTrigger, createDoubleTap, type TapInput } from "../src/index.js";

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

describe("on with Control twice, off with Control once", () => {
  /** Plays the events against a host that keeps `armed` as the trigger says, and returns what it said, in order. */
  function host(events: [TapInput["type"], string | undefined, number][], armed = false) {
    const trigger = createControlTrigger(); const said: string[] = [];
    for (const [type, key, at] of events) { const r = trigger({ type, ...(key ? { key } : {}), at }, armed); if (r) { said.push(r); armed = r === "on"; } }
    return { said, armed };
  }
  it("off: one tap does nothing; two turn it on", () => {
    expect(host([...tap(0)])).toEqual({ said: [], armed: false });
    expect(host([...tap(0), ...tap(200)])).toEqual({ said: ["on"], armed: true });
  });
  it("on: a single tap turns it off, straight away", () => {
    expect(host([...tap(0), ...tap(200), ...tap(1000)])).toEqual({ said: ["on", "off"], armed: false });
  });
  it("a habitual double tap while on turns it off and leaves it off (the second press does not turn it back on)", () => {
    expect(host([...tap(0), ...tap(200), ...tap(1000), ...tap(1200)])).toEqual({ said: ["on", "off"], armed: false });
  });
  it("on: Ctrl+C, Ctrl+click and holding Control never turn it off", () => {
    const r = host([...tap(0), ...tap(200), ["keydown", "Control", 900], ["keydown", "c", 930], ["keyup", "Control", 980],
      ["keydown", "Control", 1500], ["pointerdown", undefined, 1520], ["keyup", "Control", 1560],
      ["keydown", "Control", 2000], ["keyup", "Control", 2600]]);
    expect(r).toEqual({ said: ["on"], armed: true });
  });
});

describe("timing boundaries and broken sequences (deterministic)", () => {
  it("a press of exactly 300 ms counts, 301 ms does not; a gap of exactly 400 ms counts, 401 ms does not", () => {
    expect(play([...tap(0, 300), ...tap(400, 300)]).filter(Boolean)).toHaveLength(1);      // up at 300 and 700: 400 ms apart
    expect(play([...tap(0, 301), ...tap(500)]).some(Boolean)).toBe(false);
    expect(play([...tap(0), ...tap(80 + 400 - 80, 80)]).some(Boolean)).toBe(true);    // second tap ends 400 ms after the first ended
    expect(play([...tap(0), ...tap(80 + 401 - 80, 80)]).some(Boolean)).toBe(false);
  });
  it("AltGr (sent by Windows as Control, then Alt) and Ctrl+V are chords, not taps", () => {
    expect(play([["keydown", "Control", 0], ["keydown", "AltGraph", 2], ["keyup", "AltGraph", 60], ["keyup", "Control", 62], ...tap(150)]).some(Boolean)).toBe(false);
    expect(play([["keydown", "Control", 0], ["keydown", "v", 30], ["keyup", "v", 60], ["keyup", "Control", 80], ...tap(150)]).some(Boolean)).toBe(false);
  });
  it("a keyup that never arrived (focus moved mid-press) cannot leave it stuck: the next real taps work", () => {
    // keydown, no keyup (the release happened in another window), then later two clean taps.
    expect(play([["keydown", "Control", 0], ...tap(5000), ...tap(5200)]).filter(Boolean)).toHaveLength(1);
    // With a blur in between, the half-press is forgotten at once.
    expect(play([["keydown", "Control", 0], ["blur", undefined, 10], ...tap(100), ...tap(300)]).filter(Boolean)).toHaveLength(1);
  });
  it("a keyup with no keydown (the press started in another window) is not a tap", () => {
    expect(play([["keyup", "Control", 0], ...tap(100)]).some(Boolean)).toBe(false);
  });
});
