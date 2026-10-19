import { APPROACH, CHIP_H, distanceToRect } from "./geometry.js";
import type { Chip, Point, Rect, State, Toast } from "./types.js";
import type { Composition, Preview } from "@recast/core";

export const FRAGMENT_GLYPH: Record<string, string> = { time: "T", place: "L", title: "A", text: "A" };
export const GLYPH: Record<string, string> = { Person: "P", Document: "D", Event: "E", Location: "L", Image: "I", Message: "M", Task: "T", Product: "$", ResearchPaper: "R" };

export interface View {
  liftOutline: Rect | null;
  liftGlyph: string | null;
  /** `at` is where the token is anchored. Free: its top-left sits just below-right of the pointer. Snapped: its right edge docks beside the chip. */
  token: { title: string; glyph: string; type: string; favicon?: string; at: Point; snapped: boolean; pieces?: number } | null;
  /** The pieces collected so far and what they compose into: values with their origin, what is missing, what conflicts, what was assumed. */
  capsule: {
    pieces: { kind: string; text: string; candidateId: string }[];
    status: "ready" | "incomplete";
    fields: { name: string; value: string; origin: string; note?: string }[];
    missing: Composition["missing"]; conflicts: Composition["conflicts"]; assumptions: string[];
  } | null;
  /** True while the person is filling in what an incomplete capsule needs before it can be placed. */
  completing: boolean;
  /** The questions asked when completion began, with the current answers and choices, and whether it is now complete. */
  completion: { missing: Composition["missing"]; conflicts: Composition["conflicts"]; answers: Record<string, string | boolean>; choices: Record<string, string>; ready: boolean; assumptions: string[] } | null;
  /** While carrying a capsule with the lift key down: the piece under the pointer that a click would add. */
  capsuleOutline: Rect | null;
  destinationRect: Rect | null;
  /** `near`: inside the approach radius but not locked yet; the renderer leans it toward the pointer. */
  chips: (Chip & { active: boolean; near: boolean })[];
  pointer: Point;
  /** The carry just ended without placing (Esc, dropped nowhere): the renderer drops the token back to where it was lifted. */
  cancelled: boolean;
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
  const capsule = s.capsule;
  const title = obj?.object ? String(obj.object.properties["name"] ?? obj.object.properties["title"] ?? obj.object.properties["address"] ?? obj.object.type)
    : capsule ? String(capsule.composition.fields.title?.value ?? capsule.fragments.map((f) => f.text).join(" + ")) : "";
  const tokenType = obj?.object?.type ?? (capsule ? "Event" : "");
  const nearest = s.mode === "pointer" && obj ? s.chips.reduce<{ id: string; d: number } | null>((b, c) => { const d = distanceToRect(c.rect, s.pointer); return d <= APPROACH && (!b || d < b.d) ? { id: c.proposalId, d } : b; }, null)?.id ?? null : null;
  const at = snapped && active ? { x: active.rect.x - 8, y: active.rect.y + CHIP_H / 2 } : s.pointer;
  return {
    liftOutline: s.phase === "lifting" ? s.hovered?.rect ?? null : null,
    liftGlyph: s.phase === "lifting" && s.hovered ? (s.hovered.object ? GLYPH[s.hovered.object.type] ?? "?" : FRAGMENT_GLYPH[s.hovered.fragment?.kind ?? "text"] ?? "?") : null,
    token: obj ? { title, glyph: GLYPH[tokenType] ?? "?", type: tokenType, ...(obj.favicon ? { favicon: obj.favicon } : {}), at, snapped, ...(capsule ? { pieces: capsule.fragments.length } : {}) } : null,
    capsule: capsule ? {
      pieces: capsule.fragments.map((f, i) => ({ kind: f.kind, text: f.text, candidateId: capsule.candidateIds[i]! })),
      status: capsule.composition.status,
      fields: Object.entries(capsule.composition.fields).map(([name, f]) => ({ name, value: String(f!.value), origin: f!.origin, ...(f!.note ? { note: f!.note } : {}) })),
      missing: capsule.composition.missing, conflicts: capsule.composition.conflicts, assumptions: capsule.composition.assumptions,
    } : null,
    completing: s.phase === "completing",
    completion: s.phase === "completing" && s.capsule && s.completingFor ? {
      missing: s.completingFor.asked.missing, conflicts: s.completingFor.asked.conflicts,
      answers: { ...s.capsule.answers } as Record<string, string | boolean>, choices: { ...s.capsule.choices } as Record<string, string>,
      ready: s.capsule.composition.status === "ready", assumptions: s.capsule.composition.assumptions,
    } : null,
    capsuleOutline: s.capsule && s.liftKeyDown && s.hovered?.fragment ? s.hovered.rect : null,
    destinationRect: s.destination?.rect ?? null,
    chips: s.chips.map((c) => ({ ...c, active: c.proposalId === s.activeChip, near: c.proposalId !== s.activeChip && c.proposalId === nearest })),
    pointer: s.pointer,
    cancelled: !obj && s.phase === "idle" && s.outcome?.kind === "cancelled",
    ghost: s.preview,
    note: s.blockedNote,
    hold: s.phase === "confirming" && s.pending ? { kind: s.pending.kind, progress: s.hold.progress, chipId: s.activeChip ?? "" } : null,
    toast: s.toast ? { ...s.toast, remainingMs: Math.max(0, s.toast.expiresAt - s.now) } : null,
    live: s.live,
  };
}
