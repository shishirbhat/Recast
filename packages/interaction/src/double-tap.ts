// The Recast trigger, on the Control key (Control on a Mac, not ⌘; Ctrl on Windows and Linux).
//   Off: press Control twice to turn Recast on.
//   On:  press Control once to turn it off.
//
// Pure, so every host feeds it the same events and a test can play exact timings. A tap is Control pressed and released on
// its own, quickly. Control used in a chord (Ctrl+C, Ctrl+click), held down, or auto-repeating is never a tap, so ordinary
// shortcuts never summon Recast and never dismiss it.
export interface TapInput { type: "keydown" | "keyup" | "pointerdown" | "blur"; key?: string; repeat?: boolean; at: number }

export const DOUBLE_TAP = { key: "Control", maxPressMs: 300, maxGapMs: 400 } as const;

/** Clean taps of one key: "tap" on each, "double" when a second follows quickly. */
export function createTaps(o: { key?: string; maxPressMs?: number; maxGapMs?: number } = {}) {
  const key = o.key ?? DOUBLE_TAP.key, maxPress = o.maxPressMs ?? DOUBLE_TAP.maxPressMs, maxGap = o.maxGapMs ?? DOUBLE_TAP.maxGapMs;
  let downAt: number | null = null;   // the key is down since
  let chord = false;                  // something else happened while it was down
  let lastTap: number | null = null;  // when the previous tap ended
  function feed(e: TapInput): "tap" | "double" | null {
    if (e.type === "blur") { downAt = null; lastTap = null; return null; }
    if (e.type === "pointerdown") { if (downAt !== null) chord = true; lastTap = null; return null; }
    if (e.key !== key) { if (e.type === "keydown") { if (downAt !== null) chord = true; lastTap = null; } return null; }
    if (e.type === "keydown") {
      if (e.repeat) { chord = true; return null; }            // held down: not a tap
      if (downAt === null) { downAt = e.at; chord = false; }
      return null;
    }
    // keyup of the key
    const start = downAt; downAt = null;
    if (start === null || chord || e.at - start > maxPress) { lastTap = null; return null; }
    if (lastTap !== null && e.at - lastTap <= maxGap) { lastTap = null; return "double"; }
    lastTap = e.at; return "tap";
  }
  return { feed, reset: () => { downAt = null; chord = false; lastTap = null; } };
}

/** Kept for hosts that only need "twice": true exactly when the second tap completes. */
export function createDoubleTap(o: { key?: string; maxPressMs?: number; maxGapMs?: number } = {}) {
  const t = createTaps(o);
  return (e: TapInput): boolean => t.feed(e) === "double";
}

/**
 * The whole rule: with Recast off, Control twice → "on"; with Recast on, Control once → "off". After turning off, the
 * detector starts afresh, so the second press of a habitual double tap does not turn it straight back on.
 */
export function createControlTrigger(o: { key?: string; maxPressMs?: number; maxGapMs?: number } = {}) {
  const t = createTaps(o);
  return (e: TapInput, armed: boolean): "on" | "off" | null => {
    const r = t.feed(e);
    if (armed && r) { t.reset(); return "off"; }
    if (!armed && r === "double") return "on";
    return null;
  };
}
