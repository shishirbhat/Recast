// The clump gesture: capture pieces, carry one onto another to press them into one object, carry that object to a
// destination, review, place. Pure and serialisable (plain JSON), so a browser extension can keep it in session storage and
// rebuild the carried object in whichever tab the person moves to. Hosts turn pointer, touch and keys into these events and
// perform the effects (commit, undo, reconcile) through the core's action lifecycle.
import {
  answerClump, canMerge, checkConsent, chooseClump, mergeClumps, newClump, plan, propose, rankProposals, removeIngredient, resolve, viewClump,
  type AnswerField, type CapabilityContract, type Clump, type ClumpType, type ClumpView, type Consent, type EventField, type Fragment, type Operation, type Receipt,
} from "@recast/core";

export type ClumpPhase =
  | "idle"             // objects rest on the desk; nothing in hand
  | "carrying"         // one object in hand
  | "approaching"      // in hand, over something that could receive it (an object or a destination slot)
  | "confirmingMerge"  // dropped on an object, but the merge would change what the object is: the person decides
  | "merging"          // the merge is decided and applied; the host is playing the fusion (settled by `settled`)
  | "inspecting"       // one object opened: its ingredients, sources, assumptions; edit, remove, answer
  | "previewing"       // dropped on a destination: what placing would do, what is still missing; nothing written yet
  | "executing"        // the destination is being written to; cannot be cancelled
  | "succeeded" | "failed" | "unknown";   // after executing; `unknown` is reconciled, never retried blindly

export interface DestinationSpec { id: string; label: string; contract: CapabilityContract; slots?: { id: string; label: string; start?: string }[] }
export type Target = { kind: "object"; id: string } | { kind: "destination"; id: string; slot?: string };

export interface Placement {
  objectId: string; destinationId: string; slot?: string;
  op?: Operation;             // once the object is complete and a route exists
  receipt?: Receipt; message?: string;
  undoable?: boolean;
}

export interface ClumpState {
  phase: ClumpPhase;
  objects: Record<string, Clump>;
  /** Objects on the desk, in stacking order (last is on top). The carried object is not in here. */
  desk: string[];
  carried: string | null;
  target: Target | null;
  /** What the target would do with the carried object, for the host to show while approaching. */
  verdict: { ok: boolean; becomes?: ClumpType; reason?: string; change?: { from: ClumpType; to: ClumpType } } | null;
  pendingMerge: { targetId: string; incomingId: string; becomes: ClumpType; reason: string } | null;
  merging: { id: string; incomingId: string; at: number } | null;
  inspecting: string | null;
  placement: Placement | null;
  destinations: DestinationSpec[];
  /** One short sentence about the last thing that happened, for a live region and a toast. */
  last: { kind: "captured" | "merged" | "put-down" | "refused" | "cancelled" | "removed" | "placed" | "failed" | "unknown" | "undone"; text: string; at: number } | null;
  now: number; timezone: string; seq: number;
}

export type ClumpEvent =
  | { type: "capture"; fragment: Fragment; carry?: boolean; now: number }
  | { type: "pickUp"; id: string; now: number }
  | { type: "approach"; target: Target | null; now: number }
  | { type: "drop"; now: number }
  | { type: "confirmMerge"; yes: boolean; now: number }
  | { type: "settled"; now: number }
  | { type: "inspect"; id: string | null; now: number }
  | { type: "remove"; objectId: string; ingredientId: string; now: number }
  | { type: "answer"; objectId: string; field: AnswerField; value: string | boolean; now: number }
  | { type: "choose"; objectId: string; field: EventField; ingredientId: string; now: number }
  | { type: "place"; consent: Consent; now: number }
  | { type: "committed"; receipt: Receipt; undoable: boolean; now: number }
  | { type: "commitFailed"; message: string; now: number }
  | { type: "outcomeUnknown"; message: string; now: number }
  | { type: "reconcile"; now: number }
  | { type: "reconciled"; found: boolean; receipt?: Receipt; now: number }
  | { type: "undo"; now: number }
  | { type: "undone"; now: number }
  | { type: "cancel"; now: number }
  | { type: "dismiss"; now: number }
  | { type: "discard"; id: string; now: number };

export type ClumpEffect =
  | { type: "commit"; op: Operation; consent: Consent; destinationId: string }
  | { type: "reconcile"; op: Operation; destinationId: string }
  | { type: "undo"; receipt: Receipt; destinationId: string };

export interface ClumpResult { state: ClumpState; effects: ClumpEffect[]; error?: string }

export function initialClumpState(o: { now: number; timezone: string; destinations?: DestinationSpec[] }): ClumpState {
  return { phase: "idle", objects: {}, desk: [], carried: null, target: null, verdict: null, pendingMerge: null, merging: null, inspecting: null, placement: null, destinations: o.destinations ?? [], last: null, now: o.now, timezone: o.timezone, seq: 0 };
}

/** Which events each phase accepts. Anything else is refused with a reason and changes nothing. */
const LEGAL: Record<ClumpPhase, ClumpEvent["type"][]> = {
  idle: ["capture", "pickUp", "inspect", "discard", "dismiss", "cancel", "answer", "choose"],
  carrying: ["approach", "drop", "cancel", "capture"],
  approaching: ["approach", "drop", "cancel"],
  confirmingMerge: ["confirmMerge", "cancel"],
  merging: ["settled"],
  inspecting: ["inspect", "remove", "answer", "choose", "pickUp", "cancel", "discard"],
  previewing: ["answer", "choose", "remove", "place", "cancel"],
  executing: ["committed", "commitFailed", "outcomeUnknown"],
  succeeded: ["undo", "undone", "dismiss", "capture", "pickUp", "cancel"],
  failed: ["dismiss", "cancel", "capture", "pickUp"],
  unknown: ["reconcile", "reconciled", "dismiss"],
};

export const ctxOf = (s: ClumpState) => ({ now: new Date(s.now).toISOString(), timezone: s.timezone });
export const viewOf = (s: ClumpState, id: string): ClumpView => viewClump(s.objects[id]!, ctxOf(s));
const say = (s: ClumpState, kind: NonNullable<ClumpState["last"]>["kind"], text: string): ClumpState => ({ ...s, last: { kind, text, at: s.now } });
const without = (desk: string[], id: string) => desk.filter((x) => x !== id);
const putDown = (s: ClumpState, id: string): ClumpState => ({ ...s, desk: [...without(s.desk, id), id] });
const rest = (s: ClumpState): ClumpState => ({ ...s, carried: null, target: null, verdict: null });

/** The relation a destination accepts for this object, and the operation that would run. Null when nothing fits yet. */
function route(s: ClumpState, objectId: string, destinationId: string, now: number): { op: Operation | null; reason?: string } {
  const d = s.destinations.find((x) => x.id === destinationId); if (!d) return { op: null, reason: "that destination is gone" };
  const v = viewOf(s, objectId);
  if (!v.placeableAs.includes(d.contract.targetKind as never)) return { op: null, reason: `${d.label} takes ${d.contract.targetKind === "Calendar" ? "events" : "messages"}; this is ${v.type === "Fragment" ? "a single piece" : `a ${v.type.toLowerCase()}`}` };
  if (!v.candidate) return { op: null };
  const p = rankProposals(propose(resolve(v.candidate), d.contract)).find((x) => x.status === "ready");
  if (!p) return { op: null, reason: `${d.label} cannot take this as it is` };
  return { op: plan(p, { now: () => new Date(now).toISOString() }) };
}

/** A slot fills the start when the object has none: dropping on "Fri 7 PM" is the person choosing that time. */
function applySlot(s: ClumpState, objectId: string, destinationId: string, slot?: string): ClumpState {
  const sl = s.destinations.find((d) => d.id === destinationId)?.slots?.find((x) => x.id === slot);
  if (!sl?.start) return s;
  const v = viewOf(s, objectId); if (v.type !== "Event" || v.event?.fields.start) return s;
  return { ...s, objects: { ...s.objects, [objectId]: answerClump(s.objects[objectId]!, "start", sl.start) } };
}

export function reduceClump(state: ClumpState, ev: ClumpEvent): ClumpResult {
  const s0: ClumpState = { ...state, now: ev.now };
  if (!LEGAL[s0.phase].includes(ev.type)) return { state, effects: [], error: `cannot ${ev.type} while ${s0.phase}` };
  const ok = (state: ClumpState, effects: ClumpEffect[] = []): ClumpResult => ({ state, effects });
  const refuse = (error: string): ClumpResult => ({ state, effects: [], error });
  const s = s0;

  switch (ev.type) {
    case "capture": {
      const id = `obj-${s.seq + 1}`;
      let n: ClumpState = { ...s, seq: s.seq + 1, objects: { ...s.objects, [id]: newClump(id, ev.fragment) } };
      // Capturing while carrying puts the new piece down beside you; it never silently merges.
      if (ev.carry && (s.phase === "idle" || s.phase === "succeeded" || s.phase === "failed")) n = { ...n, phase: "carrying", carried: id, placement: null };
      else n = putDown(n, id);
      return ok(say(n, "captured", `Picked up ${viewOf(n, id).label}`));
    }
    case "pickUp": {
      if (!s.objects[ev.id] || !s.desk.includes(ev.id)) return refuse("no such object on the desk");
      return ok({ ...s, phase: "carrying", carried: ev.id, desk: without(s.desk, ev.id), inspecting: null, placement: null, target: null, verdict: null });
    }
    case "approach": {
      const t = ev.target; const carried = s.carried!;
      if (!t) return ok({ ...s, phase: "carrying", target: null, verdict: null });
      if (t.kind === "object") {
        if (!s.objects[t.id] || t.id === carried) return ok({ ...s, phase: "carrying", target: null, verdict: null });
        const c = canMerge(s.objects[t.id]!, s.objects[carried]!);
        return ok({ ...s, phase: "approaching", target: t, verdict: c.ok ? { ok: true, becomes: c.becomes, ...(c.change ? { change: c.change } : {}) } : { ok: false, reason: c.reason } });
      }
      const d = s.destinations.find((x) => x.id === t.id); if (!d) return ok({ ...s, phase: "carrying", target: null, verdict: null });
      const v = viewOf(s, carried); const fits = v.placeableAs.includes(d.contract.targetKind as never);
      return ok({ ...s, phase: "approaching", target: t, verdict: fits ? { ok: true } : { ok: false, reason: route(s, carried, d.id, s.now).reason ?? "does not fit here" } });
    }
    case "drop": {
      const carried = s.carried!; const t = s.target;
      if (!t) return ok(say({ ...rest(putDown(s, carried)), phase: "idle" }, "put-down", `Put down ${viewOf(s, carried).label}`));
      if (t.kind === "object") {
        const r = mergeClumps(s.objects[t.id]!, s.objects[carried]!);
        if (r.ok) return ok(say({ ...rest(s), phase: "merging", objects: { ...omit(s.objects, carried), [t.id]: r.clump }, merging: { id: t.id, incomingId: carried, at: s.now } }, "merged", `Now one object: ${viewClump(r.clump, ctxOf(s)).label}`));
        if (r.code === "needs_confirmation") return ok({ ...s, phase: "confirmingMerge", pendingMerge: { targetId: t.id, incomingId: carried, becomes: r.becomes!, reason: r.reason } });
        // Refused: nothing merges, and the carried object goes back on the desk, whole.
        return ok(say({ ...rest(putDown(s, carried)), phase: "idle" }, "refused", `Kept apart: ${r.reason}`));
      }
      const withSlot = applySlot(s, carried, t.id, t.slot);
      const r = route(withSlot, carried, t.id, s.now);
      if (!r.op && r.reason) return ok(say({ ...rest(putDown(s, carried)), phase: "idle" }, "refused", `Not placed: ${r.reason}`));
      // Dropping on a destination is never execution: it opens a preview. The object stays on the desk while you review it.
      return ok({ ...rest(putDown(withSlot, carried)), phase: "previewing", placement: { objectId: carried, destinationId: t.id, ...(t.slot ? { slot: t.slot } : {}), ...(r.op ? { op: r.op } : {}) } });
    }
    case "confirmMerge": {
      const p = s.pendingMerge!;
      if (!ev.yes) return ok(say({ ...rest(putDown(s, p.incomingId)), phase: "idle", pendingMerge: null }, "cancelled", "Kept apart"));
      const r = mergeClumps(s.objects[p.targetId]!, s.objects[p.incomingId]!, { confirmChange: true });
      if (!r.ok) return ok(say({ ...rest(putDown(s, p.incomingId)), phase: "idle", pendingMerge: null }, "refused", `Kept apart: ${r.reason}`));
      return ok(say({ ...rest(s), phase: "merging", pendingMerge: null, objects: { ...omit(s.objects, p.incomingId), [p.targetId]: r.clump }, merging: { id: p.targetId, incomingId: p.incomingId, at: s.now } }, "merged", `Now one object: ${viewClump(r.clump, ctxOf(s)).label}`));
    }
    case "settled": return ok({ ...s, phase: "idle", merging: null });
    case "inspect": {
      if (ev.id === null) return ok({ ...s, phase: "idle", inspecting: null });
      if (!s.objects[ev.id]) return refuse("no such object");
      return ok({ ...s, phase: "inspecting", inspecting: ev.id });
    }
    case "remove": {
      const c = s.objects[ev.objectId]; if (!c || !c.ingredients.some((f) => f.id === ev.ingredientId)) return refuse("no such ingredient");
      if (c.ingredients.length === 1) return refuse("a single piece has nothing to take out");
      const releasedId = `obj-${s.seq + 1}`; const { rest: left, released } = removeIngredient(c, ev.ingredientId, releasedId);
      let n: ClumpState = { ...s, seq: s.seq + 1, objects: { ...s.objects, [releasedId]: released, ...(left ? { [ev.objectId]: left } : {}) } };
      n = putDown(n, releasedId);
      if (n.placement?.objectId === ev.objectId) n = repreview(n);
      return ok(say(n, "removed", `Took ${viewOf(n, releasedId).label} out; it is on its own again`));
    }
    case "answer": case "choose": {
      const c = s.objects[ev.objectId]; if (!c) return refuse("no such object");
      const next = ev.type === "answer" ? answerClump(c, ev.field, ev.value) : chooseClump(c, ev.field, ev.ingredientId);
      let n: ClumpState = { ...s, objects: { ...s.objects, [ev.objectId]: next } };
      if (n.placement?.objectId === ev.objectId) n = repreview(n);
      return ok(n);
    }
    case "place": {
      const p = s.placement!; if (!p.op) return refuse("this is not complete yet: answer what is missing first");
      // The trust model decides, not the gesture: the core's own consent check, the same one commit() runs again.
      try { checkConsent(p.op, ev.consent); } catch { return refuse(p.op.risk.consent === "hold" ? "press and hold to confirm this one" : "confirm this one first"); }
      return ok({ ...s, phase: "executing" }, [{ type: "commit", op: p.op, consent: ev.consent, destinationId: p.destinationId }]);
    }
    case "committed": return ok(say({ ...s, phase: "succeeded", placement: { ...s.placement!, receipt: ev.receipt, undoable: ev.undoable } }, "placed", `Placed in ${destLabel(s)}`));
    case "commitFailed": return ok(say({ ...s, phase: "failed", placement: { ...s.placement!, message: ev.message } }, "failed", `Not placed: ${ev.message}`));
    case "outcomeUnknown": return ok(say({ ...s, phase: "unknown", placement: { ...s.placement!, message: ev.message } }, "unknown", `${destLabel(s)} did not answer. It may or may not have been added; check before trying again.`));
    case "reconcile": return ok(s, [{ type: "reconcile", op: s.placement!.op!, destinationId: s.placement!.destinationId }]);
    case "reconciled": return ev.found
      ? ok(say({ ...s, phase: "succeeded", placement: { ...s.placement!, ...(ev.receipt ? { receipt: ev.receipt } : {}), undoable: !!ev.receipt } }, "placed", `Checked: it is in ${destLabel(s)}`))
      : ok(say({ ...s, phase: "failed", placement: { ...s.placement!, message: "not found at the destination" } }, "failed", `Checked: it was not added to ${destLabel(s)}. It is safe to place again.`));
    case "undo": {
      const p = s.placement!; if (!p.receipt || !p.undoable) return refuse("this placement cannot be undone");
      return ok(s, [{ type: "undo", receipt: p.receipt, destinationId: p.destinationId }]);
    }
    case "undone": return ok(say({ ...s, phase: "idle", placement: null }, "undone", `Removed from ${destLabel(s)}`));
    case "cancel": {
      if (s.phase === "carrying" || s.phase === "approaching") return ok(say({ ...rest(putDown(s, s.carried!)), phase: "idle" }, "cancelled", "Put back; nothing changed"));
      if (s.phase === "confirmingMerge") return ok(say({ ...rest(putDown(s, s.pendingMerge!.incomingId)), phase: "idle", pendingMerge: null }, "cancelled", "Kept apart"));
      if (s.phase === "previewing") return ok(say({ ...s, phase: "idle", placement: null }, "cancelled", "Not placed; nothing was written"));
      return ok({ ...s, phase: "idle", inspecting: null, placement: s.phase === "succeeded" ? null : s.placement });
    }
    case "dismiss": return ok({ ...s, phase: "idle", placement: null });
    case "discard": {
      if (!s.desk.includes(ev.id)) return refuse("no such object on the desk");
      return ok({ ...s, phase: "idle", inspecting: null, desk: without(s.desk, ev.id), objects: omit(s.objects, ev.id) });
    }
  }
}

function repreview(s: ClumpState): ClumpState {
  const p = s.placement!; if (!s.objects[p.objectId]) return { ...s, phase: "idle", placement: null };
  const r = route(s, p.objectId, p.destinationId, s.now);
  const { op: _old, ...rest } = p;
  return { ...s, placement: { ...rest, ...(r.op ? { op: r.op } : {}) } };
}
const destLabel = (s: ClumpState) => s.destinations.find((d) => d.id === s.placement?.destinationId)?.label ?? "the destination";
const omit = <T>(o: Record<string, T>, k: string) => { const { [k]: _gone, ...r } = o; return r; };
