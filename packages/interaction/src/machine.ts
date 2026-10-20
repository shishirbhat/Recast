// The GRAB -> APPROACH -> PREVIEW -> PLACE state machine.
// Pure: (state, event) -> { state, effects }. No DOM, no timers, no I/O. Time arrives on events, so runs are deterministic.
// Consent rules and the hold duration come from @recast/core's trust model, not from this file.
import { compose, HOLD_MS, plan, preview, propose, RELATIONS, resolve } from "@recast/core";
import type { Consent, Preview, Proposal } from "@recast/core";
import { CHIP_H, MAGNET, center, chipRect, contains, distanceToRect } from "./geometry.js";
import type { Candidate, Capsule, Chip, Destination, Effect, Event, Point, Result, State } from "./types.js";

export const TOAST_MS = 6000;
export const UNDONE_MS = 3000;

export function initialState(now = 0, opts: { timezone?: string } = {}): State {
  return {
    capsule: null, timezone: opts.timezone ?? "UTC", completingFor: null,
    phase: "idle", mode: "pointer", now, pointer: { x: 0, y: 0 }, liftKeyDown: false, hitSeq: 0,
    hovered: null, carried: null, destination: null, proposals: [], chips: [], activeChip: null, preview: null, blockedNote: null,
    pending: null, hold: { startedAt: null, progress: 0 }, toast: null, candidates: [], destinations: [], focusIndex: 0,
    placements: [], live: "", outcome: null,
  };
}

const iso = (ms: number) => new Date(ms).toISOString();
const titleOf = (c: Candidate): string => c.object
  ? String(c.object.properties["name"] ?? c.object.properties["title"] ?? c.object.properties["address"] ?? c.object.type)
  : c.fragment?.text ?? "pieces";
/** A whole object, a time or a place can start a carry. A title only joins a capsule that already holds a time or place. */
const startsSomething = (c: Candidate | null): c is Candidate => !!c && (!!c.object || (!!c.fragment && c.fragment.kind !== "title"));
const kindOf = (c: Candidate): string => c.object?.type ?? (c.fragment ? `a ${c.fragment.kind}` : "item");

// ---------------------------------------------------------------- capsules (composition) ----------------------------------------------------------------

export const CAPSULE_ID = "capsule";
const capsuleTitle = (c: Capsule) => String(c.composition.fields.title?.value ?? c.fragments.map((f) => f.text).join(" + "));
function recompose(s: State, c: Pick<Capsule, "fragments" | "candidateIds" | "answers" | "choices">): Capsule {
  return { ...c, composition: compose(c.fragments, { now: iso(s.now), timezone: s.timezone, answers: c.answers, choose: c.choices }) };
}
/** The capsule as something carried: with an object once the composition is complete, without one until then. */
function capsuleCandidate(c: Capsule, rect = { x: 0, y: 0, w: 0, h: 0 }): Candidate {
  let object;
  if (c.composition.candidate) { try { object = resolve(c.composition.candidate); } catch { object = undefined; } }
  return { id: CAPSULE_ID, rect, ...(object ? { object } : {}) };
}
function addFragment(s: State, cand: Candidate): State {
  if (!cand.fragment) return s;
  const prev: Omit<Capsule, "composition"> = s.capsule ?? { fragments: [], candidateIds: [], answers: {}, choices: {} };
  if (prev.candidateIds.includes(cand.id)) return { ...s, live: `${cand.fragment.text} is already in the capsule.` };
  const capsule = recompose(s, { ...prev, fragments: [...prev.fragments, cand.fragment], candidateIds: [...prev.candidateIds, cand.id] });
  const carried = capsuleCandidate(capsule, cand.rect);
  let next: State = { ...s, capsule, carried, hovered: null };
  if (next.destination) { const d = next.destination; next = { ...next, destination: null }; next = enterDestination(next, d); next = settle(next, next.activeChip && next.chips.some((ch) => ch.proposalId === next.activeChip) ? next.activeChip : null); }
  const n = capsule.fragments.length;
  const needs = capsuleNeeds(capsule);
  return { ...next, live: `Added ${cand.fragment.kind} "${cand.fragment.text}". ${n} piece${n === 1 ? "" : "s"} in the capsule.${needs.length ? ` Still needs ${needs.join(", ")}.` : ` Ready: ${capsuleTitle(capsule)}.`}` };
}
const capsuleNeeds = (c: Capsule) => [...c.composition.missing.map((m) => m.field), ...c.composition.conflicts.map((x) => `a choice of ${x.field}`)];

/** What an incomplete capsule would become in a destination, with what is still needed. Never shows a guessed value. */
function pendingPreview(c: Capsule, effect: string, targetKind: Preview["ghost"]["targetKind"]): Preview {
  const rows = Object.entries(c.composition.fields).map(([k, f]) => ({ label: `Event.${k}`, value: `${String(f!.value)}${f!.origin === "extracted" ? "" : ` (${f!.origin})`}` }));
  for (const m of c.composition.missing) rows.push({ label: `Event.${m.field}`, value: "needed" });
  for (const x of c.composition.conflicts) rows.push({ label: `Event.${x.field}`, value: `pick one of ${x.options.map((o) => o.value).join(" / ")}` });
  return { summary: `${effect}: ${capsuleTitle(c)}`, ghost: { targetKind, effect, rows }, sideEffects: false };
}
const none = (state: State, effects: Effect[] = []): Result => ({ state, effects });

function clearCarry(s: State): State {
  return { ...s, hovered: null, carried: null, destination: null, proposals: [], chips: [], activeChip: null, preview: null, blockedNote: null, pending: null, hold: { startedAt: null, progress: 0 }, placements: [], focusIndex: 0, capsule: null, completingFor: null };
}
function cancel(s: State, reason: string): Result {
  return none({ ...clearCarry(s), phase: "idle", outcome: { kind: "cancelled", reason }, live: "Cancelled. Nothing changed." });
}

function chipsFor(carried: Candidate, dest: Destination, capsule: Capsule | null = null): { proposals: Proposal[]; chips: Chip[] } {
  if (carried.object) {
    const proposals = propose(carried.object, dest.contract);
    const chips: Chip[] = proposals.map((p, i) => ({
      proposalId: p.id, destinationId: dest.id, label: p.relation, rect: chipRect(dest.rect, i), status: p.status, relationId: p.relationId,
      ...(p.blocked ? { reason: p.blocked.reason } : {}), tier: p.risk.tier, reliability: p.reliability, deliberate: p.risk.requiresDeliberateChoice,
    }));
    return { proposals, chips };
  }
  if (!capsule) return { proposals: [], chips: [] };
  // An incomplete capsule: offer the destination's Event relations, marked with what is still needed.
  const needs = capsuleNeeds(capsule);
  const chips: Chip[] = dest.contract.accepts.flatMap((a, i) => {
    const rel = RELATIONS.find((r) => r.id === a.relationId && r.from === "Event");
    return rel ? [{ proposalId: `pending:${dest.id}:${a.relationId}`, destinationId: dest.id, label: rel.relation, rect: chipRect(dest.rect, i), status: "ready" as const, tier: rel.risk, reliability: dest.contract.reliability, deliberate: false, needs, relationId: a.relationId }] : [];
  });
  return { proposals: [], chips };
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
  let pv: Preview | null = null, note: string | null = null;
  if (proposal) { if (proposal.status === "ready") pv = preview(proposal); else note = chip?.reason ? `Can't: ${chip.reason}` : "Can't place this here"; }
  else if (chip?.needs && s.capsule && s.destination) {
    const accept = s.destination.contract.accepts.find((a) => a.relationId === chip.relationId)!;
    pv = pendingPreview(s.capsule, accept.effect, s.destination.contract.targetKind);
  }
  let live = s.live;
  if (active !== prev) {
    live = chip ? (chip.needs?.length ? `${chip.label}. ${pv?.summary ?? ""}. Still needs ${chip.needs.join(", ")}. Release to fill them in.` : proposal?.status === "ready" || chip.needs ? `${chip.label}. ${pv?.summary ?? ""}. Release to place.` : note ?? "") : s.destination ? `${s.destination.label}. Options: ${s.chips.map((c) => c.label).join(", ")}.` : live;
  }
  const phase = !s.destination || !s.chips.length ? "carrying" : active ? "previewing" : "approaching";
  return { ...s, phase, activeChip: active, preview: pv, blockedNote: note, live };
}

function enterDestination(s: State, dest: Destination | null): State {
  if (!s.carried) return s;
  if (!dest) return settle({ ...s, destination: null, proposals: [], chips: [] }, null);
  if (s.destination?.id === dest.id) return s;
  const { proposals, chips } = chipsFor(s.carried, dest, s.capsule);
  if (!chips.length) return settle({ ...s, destination: null, proposals: [], chips: [] }, null);   // supports nothing for this object: not a destination at all
  return { ...s, destination: dest, proposals, chips };
}

const doneText = (p: Proposal) =>
  p.effectFlags.includes("send") ? "Sent" : p.effectFlags.includes("delete") ? "Deleted" : p.effectFlags.includes("publish") ? "Published" : `Added as ${p.relation}`;

/** Release / Enter on the active chip: decide by the trust model what consent is needed. */
function place(s: State): Result {
  const pending = s.chips.find((c) => c.proposalId === s.activeChip && c.needs);
  if (pending && s.capsule && s.destination) {
    const needs = capsuleNeeds(s.capsule);
    // The questions are fixed when the card opens, so a field does not vanish while the person is typing into it.
    return none({ ...s, phase: "completing", completingFor: { destinationId: s.destination.id, relationId: pending.relationId!, asked: { missing: s.capsule.composition.missing, conflicts: s.capsule.composition.conflicts } },
      live: `Before it can be placed: ${needs.join(", ")}. Fill ${needs.length === 1 ? "it" : "them"} in, then press Enter. Escape cancels.` });
  }
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

/** The person filled in what was missing: compose again; if complete, continue to the normal consent and place path. */
function submitCompletion(s: State): Result {
  if (s.phase !== "completing" || !s.capsule || !s.completingFor) return none(s);
  const dest = s.destination ?? s.destinations.find((d) => d.id === s.completingFor!.destinationId) ?? null;
  const needs = capsuleNeeds(s.capsule);
  if (needs.length || !dest) return none({ ...s, live: `Still needed: ${needs.join(", ")}.` });
  const carried = capsuleCandidate(s.capsule, s.carried?.rect);
  if (!carried.object) return none({ ...s, live: "This can't become a valid event yet. Check the values." });
  const { proposals, chips } = chipsFor(carried, dest);
  const target = proposals.find((p) => p.relationId === s.completingFor!.relationId);
  const next: State = { ...s, carried, destination: dest, proposals, chips, completingFor: null, phase: "previewing" };
  if (!target) return none({ ...settle(next, null), live: `${dest.label} can't take this as it is.` });
  return place(settle(next, target.id));
}

function commit(s: State, consent: Consent): Result {
  if (!s.pending) return none(s);
  return none({ ...s, phase: "committing", live: "Placing…" }, [{ type: "commit", op: s.pending.op, consent }]);
}

function keyboardPlacements(s: State): State["placements"] {
  if (!s.carried) return [];
  return s.destinations.flatMap((d) => chipsFor(s.carried!, d, s.capsule).chips.map((c) => ({ destination: d, proposalId: c.proposalId, label: c.label })));
}

function focusPlacement(s: State, i: number): State {
  const pl = s.placements[i];
  if (!pl || !s.carried) return s;
  const { proposals, chips } = chipsFor(s.carried, pl.destination, s.capsule);
  return settle({ ...s, focusIndex: i, destination: pl.destination, proposals, chips }, pl.proposalId);
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
        if ((s.capsule || s.carried?.fragment) && s.mode === "pointer" && (s.phase === "carrying" || s.phase === "approaching" || s.phase === "previewing")) {
          const seq = s.hitSeq + 1;
          return none({ ...s, liftKeyDown: true, hitSeq: seq }, [{ type: "hitTest", seq, p: s.pointer }]);
        }
        return none({ ...s, liftKeyDown: true });
      }
      s = { ...s, liftKeyDown: false, ...(s.capsule && s.phase !== "lifting" ? { hovered: null } : {}) };
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
        return none({ ...s, focusIndex: 0, hovered: first, live: first ? `${titleOf(first)}, ${kindOf(first)}. ${first.object ? "Enter to lift." : "Space to add it to a capsule."}` : "Nothing here can be lifted." });
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
        const offer = startsSomething(e.candidate) ? e.candidate : null;
        const changed = offer?.id !== s.hovered?.id;
        return none({ ...s, hovered: offer, live: changed && offer ? `${titleOf(offer)}, ${kindOf(offer)}. Click to lift.` : s.live });
      }
      if (s.mode === "pointer" && (s.phase === "carrying" || s.phase === "approaching" || s.phase === "previewing")) {
        if ((s.capsule || s.carried?.fragment) && s.liftKeyDown) {
          const taken = s.capsule?.candidateIds ?? [s.carried!.id];
          const piece = e.candidate?.fragment && !taken.includes(e.candidate.id) ? e.candidate : null;
          s = { ...s, hovered: piece, ...(piece && piece.id !== prior.hovered?.id ? { live: `${piece.fragment!.text}. Click to add it to the capsule.` } : {}) };
        }
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
        if (!s.hovered.object && s.hovered.fragment) {
          const next = addFragment({ ...s, phase: "carrying", hitSeq: seq }, s.hovered);
          return none({ ...next, live: `${next.live} Keep the lift key down and click more pieces, or move it to a destination.` }, [{ type: "hitTest", seq, p: e.p }]);
        }
        return none({ ...s, phase: "carrying", carried: s.hovered, hovered: null, hitSeq: seq, live: `Carrying ${titleOf(s.hovered)}. Move it onto a destination.` }, [{ type: "hitTest", seq, p: e.p }]);
      }
      if ((s.capsule || s.carried?.fragment) && s.liftKeyDown && s.hovered?.fragment && (s.phase === "carrying" || s.phase === "approaching" || s.phase === "previewing")) {
        // Carrying a whole object that is also a piece (an address, say): it becomes the capsule's first piece.
        const started = s.capsule ? s : addFragment(s, s.carried!);
        return none(addFragment(started, s.hovered));
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
      if (s.phase === "carrying" || s.phase === "approaching" || s.phase === "previewing") {
        if (s.activeChip) return place(s);
        if (s.capsule) return none({ ...s, live: `Holding ${s.capsule.fragments.length} piece${s.capsule.fragments.length === 1 ? "" : "s"}. Add more with the lift key, move to a destination and click a choice, or press Escape.` });
        return cancel(s, "dropped-nowhere");
      }
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
          return none({ ...s, focusIndex: i, hovered: c, live: `${titleOf(c)}, ${kindOf(c)}. ${c.object ? "Enter to lift." : "Space to add it to a capsule."}` });
        }
        if (e.key === " " && s.hovered?.fragment && !s.capsule && !startsSomething(s.hovered)) {
          return none({ ...s, live: "A title joins a capsule once it holds a time or a place." });
        }
        if (e.key === " " && s.hovered?.fragment) {
          const next = addFragment(s, s.hovered);
          return none({ ...next, phase: "lifting", carried: null, hovered: s.hovered, live: `${next.live} Space adds another piece, Enter when done.` });
        }
        if (e.key === "Enter" && s.capsule) {
          const carried = capsuleCandidate(s.capsule);
          const next = { ...s, carried, hovered: null, phase: "carrying" as const };
          const placements = keyboardPlacements(next);
          if (!placements.length) return none({ ...next, live: `Nothing here accepts ${capsuleTitle(s.capsule)}. Escape to cancel.` });
          return none(focusPlacement({ ...next, placements }, 0));
        }
        if (e.key === "Enter" && s.hovered?.object) {
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
      if (s.phase === "completing" && e.key === "Enter" && e.down) return submitCompletion(s);
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

    case "answer":
    case "choose": {
      if (!s.capsule) return none(s);
      const answers = e.type === "answer" ? { ...s.capsule.answers, [e.field]: e.value } : s.capsule.answers;
      const choices = e.type === "choose" ? { ...s.capsule.choices, [e.field]: e.fragmentId } : s.capsule.choices;
      const capsule = recompose(s, { ...s.capsule, answers, choices });
      const needs = capsuleNeeds(capsule);
      return none({ ...s, capsule, live: needs.length ? `Still needed: ${needs.join(", ")}.` : "Complete. Press Enter to continue." });
    }
    case "submitCompletion":
      return submitCompletion(s);

    case "undoRequest":
      return s.toast?.kind === "placed" && s.toast.receipt ? none(s, [{ type: "undo", receipt: s.toast.receipt }]) : none(s);
    case "undone":
      return none({ ...s, outcome: { kind: "undone", label: s.toast?.text ?? "" }, toast: { kind: "undone", text: "Undone", startedAt: e.now, expiresAt: e.now + UNDONE_MS }, live: "Undone." });
    case "undoFailed":
      return none({ ...s, toast: { kind: "error", text: `Couldn't undo: ${e.message}`, startedAt: e.now, expiresAt: e.now + TOAST_MS }, live: `Couldn't undo. ${e.message}` });
  }
}

export { center };
