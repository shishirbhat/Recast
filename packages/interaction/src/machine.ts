// The GRAB -> APPROACH -> PREVIEW -> PLACE state machine.
// Pure: (state, event) -> { state, effects }. No DOM, no timers, no I/O. Time arrives on events, so runs are deterministic.
// Consent rules and the hold duration come from @recast/core's trust model, not from this file.
import { HOLD_MS, plan, preview, propose } from "@recast/core";
import type { Consent, Proposal } from "@recast/core";
import { CHIP_H, MAGNET, center, chipRect, contains, distanceToRect } from "./geometry.js";
import type { Candidate, Chip, Destination, Effect, Event, Point, Result, State } from "./types.js";

export const TOAST_MS = 6000;
export const UNDONE_MS = 3000;

export function initialState(now = 0): State {
  return {
    phase: "idle", mode: "pointer", now, pointer: { x: 0, y: 0 }, liftKeyDown: false, hitSeq: 0,
    hovered: null, carried: null, destination: null, proposals: [], chips: [], activeChip: null, preview: null, blockedNote: null,
    pending: null, hold: { startedAt: null, progress: 0 }, toast: null, candidates: [], destinations: [], focusIndex: 0,
    placements: [], live: "", outcome: null,
  };
}

const iso = (ms: number) => new Date(ms).toISOString();
const titleOf = (c: Candidate) => String(c.object.properties["name"] ?? c.object.properties["title"] ?? c.object.properties["address"] ?? c.object.type);
const none = (state: State, effects: Effect[] = []): Result => ({ state, effects });

function clearCarry(s: State): State {
  return { ...s, hovered: null, carried: null, destination: null, proposals: [], chips: [], activeChip: null, preview: null, blockedNote: null, pending: null, hold: { startedAt: null, progress: 0 }, placements: [], focusIndex: 0 };
}
function cancel(s: State, reason: string): Result {
  return none({ ...clearCarry(s), phase: "idle", outcome: { kind: "cancelled", reason }, live: "Cancelled. Nothing changed." });
}

function chipsFor(carried: Candidate, dest: Destination): { proposals: Proposal[]; chips: Chip[] } {
  const proposals = propose(carried.object, dest.contract);
  const chips: Chip[] = proposals.map((p, i) => ({
    proposalId: p.id, destinationId: dest.id, label: p.relation, rect: chipRect(dest.rect, i), status: p.status,
    ...(p.blocked ? { reason: p.blocked.reason } : {}), tier: p.risk.tier, reliability: p.reliability, deliberate: p.risk.requiresDeliberateChoice,
  }));
  return { proposals, chips };
}

/** Which chip is active: directly over one, or within the magnet radius of the nearest (unless a deliberate choice is required). */
function snap(chips: Chip[], p: Point): string | null {
  let best: { id: string; d: number; over: boolean; deliberate: boolean } | null = null;
  for (const c of chips) {
    const d = distanceToRect(c.rect, p), over = contains(c.rect, p);
    if (!best || d < best.d) best = { id: c.proposalId, d, over, deliberate: c.deliberate };
  }
  if (!best) return null;
  return best.over || (!best.deliberate && best.d <= MAGNET) ? best.id : null;
}

/** Recompute phase, active chip, preview and announcements from the current destination and chips. */
function settle(s: State, active: string | null): State {
  const prev = s.activeChip;
  const proposal = s.proposals.find((p) => p.id === active) ?? null;
  const chip = s.chips.find((c) => c.proposalId === active) ?? null;
  let pv = null, note: string | null = null;
  if (proposal) { if (proposal.status === "ready") pv = preview(proposal); else note = chip?.reason ? `Can't: ${chip.reason}` : "Can't place this here"; }
  let live = s.live;
  if (active !== prev) {
    live = chip ? (proposal?.status === "ready" ? `${chip.label}. ${pv?.summary ?? ""}. Release to place.` : note ?? "") : s.destination ? `${s.destination.label}. Options: ${s.chips.map((c) => c.label).join(", ")}.` : live;
  }
  const phase = !s.destination || !s.chips.length ? "carrying" : active ? "previewing" : "approaching";
  return { ...s, phase, activeChip: active, preview: pv, blockedNote: note, live };
}

function enterDestination(s: State, dest: Destination | null): State {
  if (!s.carried) return s;
  if (!dest) return settle({ ...s, destination: null, proposals: [], chips: [] }, null);
  if (s.destination?.id === dest.id) return s;
  const { proposals, chips } = chipsFor(s.carried, dest);
  if (!chips.length) return settle({ ...s, destination: null, proposals: [], chips: [] }, null);   // supports nothing for this object: not a destination at all
  return { ...s, destination: dest, proposals, chips };
}

const doneText = (p: Proposal) =>
  p.effectFlags.includes("send") ? "Sent" : p.effectFlags.includes("delete") ? "Deleted" : p.effectFlags.includes("publish") ? "Published" : `Added as ${p.relation}`;

/** Release / Enter on the active chip: decide by the trust model what consent is needed. */
function place(s: State): Result {
  const proposal = s.proposals.find((p) => p.id === s.activeChip);
  if (!proposal) return cancel(s, "dropped-nowhere");
  if (proposal.status === "blocked") return cancel({ ...s, live: "" }, `blocked: ${proposal.blocked?.reason ?? "cannot place"}`);
  const op = plan(proposal, { now: () => iso(s.now) });
  const consent = op.risk.consent;
  if (consent === "release") return none({ ...s, phase: "committing", pending: { op, kind: "confirm" }, live: "Placing…" }, [{ type: "commit", op, consent: { kind: "release" } }]);
  const kind = consent === "hold" ? "hold" : "confirm";
  return none({ ...s, phase: "confirming", pending: { op, kind }, hold: { startedAt: null, progress: 0 },
    live: kind === "hold" ? `${proposal.effect} needs confirmation. Press and hold for one second.` : `${proposal.effect}. Confirm to place.` });
}

function commit(s: State, consent: Consent): Result {
  if (!s.pending) return none(s);
  return none({ ...s, phase: "committing", live: "Placing…" }, [{ type: "commit", op: s.pending.op, consent }]);
}

function keyboardPlacements(s: State): { destination: Destination; proposal: Proposal }[] {
  if (!s.carried) return [];
  return s.destinations.flatMap((d) => propose(s.carried!.object, d.contract).map((proposal) => ({ destination: d, proposal })));
}

function focusPlacement(s: State, i: number): State {
  const pl = s.placements[i];
  if (!pl || !s.carried) return s;
  const { proposals, chips } = chipsFor(s.carried, pl.destination);
  return settle({ ...s, focusIndex: i, destination: pl.destination, proposals, chips }, pl.proposal.id);
}

export function reduce(prior: State, e: Event): Result {
  let s: State = { ...prior, now: e.now };
  switch (e.type) {
    case "liftKey": {
      if (e.down) {
        if (s.phase === "idle") {
          const seq = s.hitSeq + 1;
          return none({ ...s, liftKeyDown: true, phase: "lifting", mode: "pointer", hitSeq: seq, outcome: null, live: "Lift mode. Hover an item, then click to lift it." }, [{ type: "hitTest", seq, p: s.pointer }]);
        }
        return none({ ...s, liftKeyDown: true });
      }
      s = { ...s, liftKeyDown: false };
      return s.phase === "lifting" && s.mode === "pointer" ? none({ ...clearCarry(s), phase: "idle", live: "" }) : none(s);
    }

    case "keyboardLift": {
      if (s.phase === "lifting" && s.mode === "keyboard") return cancel(s, "keyboard-toggle");
      if (s.phase !== "idle") return none(s);
      return none({ ...s, phase: "lifting", mode: "keyboard", outcome: null, live: "Keyboard lift. Tab to choose an item, Enter to lift, Escape to cancel." }, [{ type: "enumerate" }]);
    }

    case "enumerated": {
      s = { ...s, candidates: e.candidates, destinations: e.destinations };
      if (s.phase === "lifting" && s.mode === "keyboard") {
        const first = e.candidates[0] ?? null;
        return none({ ...s, focusIndex: 0, hovered: first, live: first ? `${titleOf(first)}, ${first.object.type}. Enter to lift.` : "Nothing here can be lifted." });
      }
      return none(s);
    }

    case "pointerMove": {
      s = { ...s, pointer: e.p };
      if (s.mode !== "pointer") return none(s);
      if (s.phase === "lifting" || s.phase === "carrying" || s.phase === "approaching" || s.phase === "previewing") {
        const seq = s.hitSeq + 1;
        s = { ...s, hitSeq: seq };
        if (s.destination) s = settle(s, snap(s.chips, e.p));
        return none(s, [{ type: "hitTest", seq, p: e.p }]);
      }
      return none(s);
    }

    case "hitResult": {
      if (e.seq !== s.hitSeq) return none(s);   // stale answer to an older question
      if (s.phase === "lifting" && s.mode === "pointer") {
        const changed = e.candidate?.id !== s.hovered?.id;
        return none({ ...s, hovered: e.candidate, live: changed && e.candidate ? `${titleOf(e.candidate)}, ${e.candidate.object.type}. Click to lift.` : s.live });
      }
      if (s.mode === "pointer" && (s.phase === "carrying" || s.phase === "approaching" || s.phase === "previewing")) {
        const entered = enterDestination(s, e.destination);
        const announce = entered.destination && entered.destination.id !== s.destination?.id ? `${entered.destination.label}. Options: ${entered.chips.map((c) => c.label).join(", ")}.` : undefined;
        const out = settle(entered, entered.destination ? snap(entered.chips, s.pointer) : null);
        return none(announce ? { ...out, live: announce } : out);
      }
      return none(s);
    }

    case "pointerDown": {
      s = { ...s, pointer: e.p };
      if (s.mode !== "pointer") return none(s);
      if (s.phase === "lifting" && s.hovered) {
        const seq = s.hitSeq + 1;
        return none({ ...s, phase: "carrying", carried: s.hovered, hovered: null, hitSeq: seq, live: `Carrying ${titleOf(s.hovered)}. Move it onto a destination.` }, [{ type: "hitTest", seq, p: e.p }]);
      }
      if (s.phase === "confirming" && s.pending) {
        const onChip = s.chips.find((c) => c.proposalId === s.activeChip && contains(c.rect, e.p));
        if (!onChip) return none(s);
        if (s.pending.kind === "confirm") return commit(s, { kind: "confirm" });
        if (s.hold.startedAt === null) return none({ ...s, hold: { startedAt: e.now, progress: 0 } });
      }
      return none(s);
    }

    case "pointerUp": {
      s = { ...s, pointer: e.p };
      if (s.mode !== "pointer") return none(s);
      if (s.phase === "carrying" || s.phase === "approaching" || s.phase === "previewing") return s.activeChip ? place(s) : cancel(s, "dropped-nowhere");
      if (s.phase === "confirming" && s.hold.startedAt !== null) return none({ ...s, hold: { startedAt: null, progress: 0 }, live: "Hold a little longer to confirm." });
      return none(s);
    }

    case "key": {
      // A commit already sent to a destination cannot be taken back by Escape; the user has Undo for that.
      if (e.key === "Escape" && e.down) return s.phase === "idle" || s.phase === "committing" ? none(s) : cancel(s, "escape");
      if (s.phase === "lifting" && s.mode === "keyboard" && e.down) {
        if (e.key === "Tab" && s.candidates.length) {
          const i = (s.focusIndex + (e.shift ? -1 : 1) + s.candidates.length) % s.candidates.length;
          const c = s.candidates[i]!;
          return none({ ...s, focusIndex: i, hovered: c, live: `${titleOf(c)}, ${c.object.type}. Enter to lift.` });
        }
        if (e.key === "Enter" && s.hovered) {
          const carried = s.hovered;
          const next = { ...s, carried, hovered: null, phase: "carrying" as const };
          const placements = keyboardPlacements(next);
          if (!placements.length) return none({ ...next, live: `Nothing here accepts ${titleOf(carried)}. Escape to cancel.` });
          return none(focusPlacement({ ...next, placements }, 0));
        }
        return none(s);
      }
      if (s.mode === "keyboard" && (s.phase === "carrying" || s.phase === "approaching" || s.phase === "previewing") && e.down) {
        if (e.key === "Tab" && s.placements.length) return none(focusPlacement(s, (s.focusIndex + (e.shift ? -1 : 1) + s.placements.length) % s.placements.length));
        if (e.key === "Enter") return s.activeChip ? place(s) : none(s);
        return none(s);
      }
      if (s.phase === "confirming" && s.pending && e.key === "Enter") {
        if (s.pending.kind === "confirm") return e.down ? commit(s, { kind: "confirm" }) : none(s);
        if (e.down && s.hold.startedAt === null) return none({ ...s, hold: { startedAt: e.now, progress: 0 } });
        if (!e.down && s.hold.startedAt !== null) return none({ ...s, hold: { startedAt: null, progress: 0 }, live: "Hold a little longer to confirm." });
      }
      return none(s);
    }

    case "tick": {
      if (s.toast && s.now >= s.toast.expiresAt) s = { ...s, toast: null };
      if (s.phase === "confirming" && s.pending?.kind === "hold" && s.hold.startedAt !== null) {
        const held = s.now - s.hold.startedAt, progress = Math.min(1, held / HOLD_MS);
        if (progress >= 1) return commit({ ...s, hold: { startedAt: s.hold.startedAt, progress: 1 } }, { kind: "hold", heldMs: held });
        return none({ ...s, hold: { startedAt: s.hold.startedAt, progress } });
      }
      return none(s);
    }

    case "committed": {
      if (!s.pending) return none(s);
      const text = doneText(s.pending.op.proposal);
      return none({ ...clearCarry(s), phase: "idle", outcome: null, toast: { kind: "placed", text, receipt: e.receipt, startedAt: e.now, expiresAt: e.now + TOAST_MS }, live: `${text}. Undo is available for ${TOAST_MS / 1000} seconds.` });
    }
    case "commitFailed":
      return none({ ...clearCarry(s), phase: "idle", outcome: { kind: "failed", message: e.message }, toast: { kind: "error", text: `Couldn't place it: ${e.message}. Nothing changed.`, startedAt: e.now, expiresAt: e.now + TOAST_MS }, live: `Couldn't place it. ${e.message}. Nothing changed.` });

    case "undoRequest":
      return s.toast?.kind === "placed" && s.toast.receipt ? none(s, [{ type: "undo", receipt: s.toast.receipt }]) : none(s);
    case "undone":
      return none({ ...s, outcome: { kind: "undone", label: s.toast?.text ?? "" }, toast: { kind: "undone", text: "Undone", startedAt: e.now, expiresAt: e.now + UNDONE_MS }, live: "Undone." });
    case "undoFailed":
      return none({ ...s, toast: { kind: "error", text: `Couldn't undo: ${e.message}`, startedAt: e.now, expiresAt: e.now + TOAST_MS }, live: `Couldn't undo. ${e.message}` });
  }
}

export { center };
