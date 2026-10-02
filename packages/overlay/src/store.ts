import { motionValue } from "motion";
import type { View } from "@recast/interaction";

/** Holds the latest view and the token's target position. The position lives in motion values, not React state,
 *  so following the pointer never re-renders the tree; springs smooth it on the GPU-friendly transform path. */
export function createStore() {
  let view: View | null = null;
  const listeners = new Set<() => void>();
  const x = motionValue(0), y = motionValue(0);
  let placed = false;
  return {
    x, y,
    get: () => view,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    update(next: View) {
      view = next;
      if (next.token) {
        if (!placed) { x.jump(next.token.at.x); y.jump(next.token.at.y); placed = true; }   // first frame: appear at the pointer, do not fly in
        else { x.set(next.token.at.x); y.set(next.token.at.y); }
      } else placed = false;
      for (const l of listeners) l();
    },
  };
}
export type Store = ReturnType<typeof createStore>;
