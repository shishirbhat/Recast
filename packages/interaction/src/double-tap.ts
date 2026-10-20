// The Recast trigger: press Control twice. Control on a Mac (not ⌘) and Ctrl on Windows and Linux.
//
// Pure, so every host feeds it the same events and a test can play exact timings. A tap is Control pressed and released on
// its own, quickly. Control used in a chord (Ctrl+C, Ctrl+click), held down, or auto-repeating is never a tap, so ordinary
// shortcuts never summon Recast.
export interface TapInput { type: "keydown" | "keyup" | "pointerdown" | "blur"; key?: string; repeat?: boolean; at: number }

export const DOUBLE_TAP = { key: "Control", maxPressMs: 300, maxGapMs: 400 } as const;

export function createDoubleTap(o: { key?: string; maxPressMs?: number; maxGapMs?: number } = {}) {
  const key = o.key ?? DOUBLE_TAP.key, maxPress = o.maxPressMs ?? DOUBLE_TAP.maxPressMs, maxGap = o.maxGapMs ?? DOUBLE_TAP.maxGapMs;
  let downAt: number | null = null;   // Control is down since
  let chord = false;                  // something else happened while it was down
  let lastTap: number | null = null;  // when the first tap ended
  /** Feed every key, pointer and blur event. Returns true exactly when the second tap completes. */
  return function feed(e: TapInput): boolean {
    if (e.type === "blur") { downAt = null; lastTap = null; return false; }
    if (e.type === "pointerdown") { if (downAt !== null) chord = true; lastTap = null; return false; }
    if (e.key !== key) { if (e.type === "keydown") { if (downAt !== null) chord = true; lastTap = null; } return false; }
    if (e.type === "keydown") {
      if (e.repeat) { chord = true; return false; }            // held down: not a tap
      if (downAt === null) { downAt = e.at; chord = false; }
      return false;
    }
    // keyup of Control
    const start = downAt; downAt = null;
    if (start === null || chord || e.at - start > maxPress) { lastTap = null; return false; }
    if (lastTap !== null && e.at - lastTap <= maxGap) { lastTap = null; return true; }
    lastTap = e.at; return false;
  };
}
