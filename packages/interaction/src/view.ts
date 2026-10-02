import { CHIP_H } from "./geometry.js";
import type { Chip, Point, Rect, State, Toast } from "./types.js";
import type { Preview } from "@recast/core";

export const GLYPH: Record<string, string> = { Person: "P", Document: "D", Event: "E", Location: "L", Image: "I", Message: "M", Task: "T", Product: "$", ResearchPaper: "R" };

export interface View {
  liftOutline: Rect | null;
  liftGlyph: string | null;
  /** `at` is where the token is anchored. Free: its top-left sits just below-right of the pointer. Snapped: its right edge docks beside the chip. */
  token: { title: string; glyph: string; type: string; favicon?: string; at: Point; snapped: boolean } | null;
  destinationRect: Rect | null;
  chips: (Chip & { active: boolean })[];
  ghost: Preview | null;
  note: string | null;
  hold: { kind: "confirm" | "hold"; progress: number; chipId: string } | null;
  toast: (Toast & { remainingMs: number }) | null;
  live: string;
}

/** What to draw for a state. Pure, so the same view drives the Chromium overlay and any native renderer. */
export function selectView(s: State): View {
  const obj = s.carried;
  const active = s.chips.find((c) => c.proposalId === s.activeChip) ?? null;
  const snapped = !!active && !active.deliberate && s.mode === "pointer" ? true : s.mode === "keyboard" && !!active;
  const title = obj ? String(obj.object.properties["name"] ?? obj.object.properties["title"] ?? obj.object.properties["address"] ?? obj.object.type) : "";
  const at = snapped && active ? { x: active.rect.x - 8, y: active.rect.y + CHIP_H / 2 } : s.pointer;
  return {
    liftOutline: s.phase === "lifting" ? s.hovered?.rect ?? null : null,
    liftGlyph: s.phase === "lifting" && s.hovered ? GLYPH[s.hovered.object.type] ?? "?" : null,
    token: obj ? { title, glyph: GLYPH[obj.object.type] ?? "?", type: obj.object.type, ...(obj.favicon ? { favicon: obj.favicon } : {}), at, snapped } : null,
    destinationRect: s.destination?.rect ?? null,
    chips: s.chips.map((c) => ({ ...c, active: c.proposalId === s.activeChip })),
    ghost: s.preview,
    note: s.blockedNote,
    hold: s.phase === "confirming" && s.pending ? { kind: s.pending.kind, progress: s.hold.progress, chipId: s.activeChip ?? "" } : null,
    toast: s.toast ? { ...s.toast, remainingMs: Math.max(0, s.toast.expiresAt - s.now) } : null,
    live: s.live,
  };
}
