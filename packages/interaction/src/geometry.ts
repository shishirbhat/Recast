import type { Point, Rect } from "./types.js";

export const CHIP_W = 140, CHIP_H = 32, CHIP_GAP = 8, CHIP_OVERHANG = 12, MAGNET = 56;

export const center = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
export const contains = (r: Rect, p: Point) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
export function distanceToRect(r: Rect, p: Point): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w)), dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

/** Landing chips sit on the destination's right edge, stacked, overhanging it slightly. */
export function chipRect(dest: Rect, index: number): Rect {
  return { x: dest.x + dest.w - CHIP_W + CHIP_OVERHANG, y: dest.y + 24 + index * (CHIP_H + CHIP_GAP), w: CHIP_W, h: CHIP_H };
}
