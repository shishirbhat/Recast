/**
 * Recast motion language: physics, not durations. Springs are interruptible: if the person changes direction mid-animation,
 * the spring absorbs it instead of finishing a canned curve. Every value here has one job (docs/04-design-system.md).
 */
export const SPRING = {
  /** Lift, carry, preview, place, undo: the default "object in the hand". */
  carry: { type: "spring", stiffness: 300, damping: 24, mass: 0.8 },
  /** A chip noticing the cursor nearby: quicker and a touch springier. */
  approach: { type: "spring", stiffness: 400, damping: 20 },
  /** The magnet locking: fast, with a small overshoot that reads as a click. */
  snap: { type: "spring", stiffness: 500, damping: 15 },
  /** Esc: the token drops back to where it was lifted, with a small bounce. */
  cancel: { type: "spring", stiffness: 200, damping: 25, mass: 1.2 },
} as const;

/** prefers-reduced-motion: every spring becomes instant; no rotation, wobble, lean or glow pulses. */
export const INSTANT = { duration: 0 } as const;

/** How the carried token leans and lifts with speed. Pixels per second in, degrees and shadow out. */
export const CARRY = { maxTiltDeg: 8, tiltAtSpeed: 1500, liftAtSpeed: 1800 } as const;
/** How far a nearby chip leans toward the pointer (fraction of the distance, capped). */
export const LEAN = { factor: 0.15, maxPx: 6 } as const;
export const HOLD_MS = 600;
