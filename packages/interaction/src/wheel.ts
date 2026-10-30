// The destination selector and the action module, as data. Pure: hosts (the clay page, the extension) render the result,
// so both show the same destinations for the same reasons.
//
// The selector lists only what the bridge registry knows (passed in, so this package does not depend on the bridges), in
// five fixed places. A destination is available only when the composition is the kind it takes AND a destination for it is
// connected here. Anything else stays visible, disabled, with the reason in words.
import { objectData, type CapabilityContract, type ClumpView, type Fragment } from "@recast/core";
import { aThing, ctxOf, unfit, viewOf, type ClumpState, type Placement } from "./clump-machine.js";
import { recipeOffers, type RecipeOffer, type RecipeRun } from "./recipe-run.js";
import { saveable, workflowDefinition } from "./workflows.js";

export type WheelKey = "calendar" | "mail" | "tasks" | "documents" | "more";
export const WHEEL_SLOTS: readonly { key: WheelKey; label: string; kinds: readonly string[] }[] = [
  { key: "calendar", label: "Calendar", kinds: ["Calendar"] },
  { key: "mail", label: "Mail", kinds: ["Drafts"] },
  { key: "tasks", label: "Tasks", kinds: ["Task", "TaskList", "Issues"] },
  { key: "documents", label: "Documents", kinds: ["Project", "Docs"] },
  { key: "more", label: "More", kinds: [] },   // everything else in the registry
];

export interface WheelOption { destination: string; app: string; effect: string; available: boolean; reason?: string; destinationId?: string; standIn?: boolean;
  /** What the destination itself declares it can do, in words: "Read back after placing · Undo", or "Opens only". */
  can: string }

/**
 * A destination's declared abilities, as the person needs them before choosing: whether Recast can check the result, and
 * whether it can take it back. From the contract only (D30), so it never promises more than the bridge declares.
 */
export function abilityLine(c: CapabilityContract): string {
  const a = c.abilities ?? [];
  if (c.reliability === "deep-link" || (a.includes("open") && !a.includes("create") && !a.includes("update"))) return "Opens it for you to finish there: Recast can’t check or undo it";
  return [a.includes("verify") ? "Read back after placing" : "Can’t be read back", a.includes("undo") ? "Undo" : "No Undo"].join(" · ");
}
export interface WheelEntry { key: WheelKey; label: string; available: boolean; reason?: string; destinationId?: string; standIn?: boolean; options: WheelOption[] }

export function wheelEntries(s: ClumpState, objectId: string, registry: readonly CapabilityContract[]): WheelEntry[] {
  const v = viewOf(s, objectId);
  const named = new Set(WHEEL_SLOTS.flatMap((w) => w.kinds));
  const option = (c: CapabilityContract): WheelOption => {
    const base = { destination: c.destination, app: c.app, effect: c.accepts[0]?.effect ?? "", can: abilityLine(c) };
    if (!v.placeableAs.includes(c.targetKind as never)) return { ...base, available: false, reason: unfit(c.app, c, v.type) };
    const live = s.destinations.find((d) => d.contract.destination === c.destination);
    if (!live) return { ...base, available: false, reason: `${c.app} is not connected here` };
    return { ...base, available: true, destinationId: live.id, ...(live.standIn ? { standIn: true } : {}) };
  };
  return WHEEL_SLOTS.map((slot) => {
    const options = registry.filter((c) => (slot.key === "more" ? !named.has(c.targetKind) : slot.kinds.includes(c.targetKind))).map(option);
    const first = options.find((o) => o.available);
    if (first) return { key: slot.key, label: slot.label, available: true, destinationId: first.destinationId!, ...(first.standIn ? { standIn: true } : {}), options };
    // Several apps would take it but none is connected: name them all ("Google Calendar or Outlook Calendar").
    // The person's own webhook is not an app anyone misses: it is offered when set up, never named as "not connected".
    const unconnected = [...new Set(options.filter((o) => o.reason?.endsWith(" is not connected here") && !o.destination.startsWith("webhook.")).map((o) => o.app))];
    const reason = slot.key === "more" ? `Nothing else Recast connects to takes ${aThing(v.type)}` : unconnected.length > 1 ? `${unconnected.slice(0, -1).join(", ")} or ${unconnected.at(-1)} is not connected here` : options[0]?.reason ?? `No ${slot.label.toLowerCase()} bridge yet`;
    return { key: slot.key, label: slot.label, available: false, reason, options };
  });
}

/** The first available destination, so opening the selector lands on something that works. */
export const firstAvailable = (entries: WheelEntry[]) => entries.find((e) => e.available)?.key ?? entries[0]!.key;

export interface ModuleObject { id: string; view: ClumpView; ingredients: { id: string; kind: Fragment["kind"]; text: string; from: string; confidence: number; /** when it was captured (ISO) */ at?: string }[];
  /** The object as structured data (recast.object/1, JSON), for "Copy as data". */
  data: string }
export type ModuleModel =
  | { mode: "off" }
  /** Recast is on and nothing needs choosing: a small pill. `reopen` names a composition the command would bring back. */
  | { mode: "pill"; text: string; reopen?: string; carrying?: string }
  | { mode: "composed" | "choosing" | "inspecting" | "confirm" | "preview" | "executing" | "undoing" | "succeeded" | "failed" | "unknown" | "plan" | "running" | "ran";
      object: ModuleObject; entries: WheelEntry[]; choice: WheelKey;
      /** Recipes for this kind of object (composed), or the run being reviewed, running or reported. */
      recipes?: RecipeOffer[]; run?: RecipeRun;
      placement?: Placement; destination?: { key: WheelKey; label: string; app: string; effect: string; standIn: boolean; opensOnly?: boolean; verifies?: boolean };
      confirm?: string; text?: string;
      /** Whether what is on screen can be saved as a personal workflow; Save is offered only when it can. */
      save?: { ok: boolean; reason?: string; done?: string };
      /** The person's saved workflows (composed), with the ones that cannot be used and why: for rename and delete. */
      mine?: { id: string; name: string; description: string; reason?: string; /** the definition to share (JSON), for usable ones */ definition?: string }[] };

/** What the action module shows for this state. One model, one module: there is never a second panel. */
export function moduleModel(s: ClumpState, registry: readonly CapabilityContract[]): ModuleModel {
  if (!s.armed && s.phase === "idle") return { mode: "off" };
  const obj = (id: string): ModuleObject => ({ id, view: viewOf(s, id), ingredients: s.objects[id]!.ingredients.map((f) => ({ id: f.id, kind: f.kind, text: f.text, from: f.source?.title ?? f.source?.url ?? f.source?.app ?? "", confidence: f.confidence, ...(f.capturedAt ? { at: f.capturedAt } : {}) })),
    data: JSON.stringify(objectData(s.objects[id]!, ctxOf(s)), null, 2) });
  const around = (id: string) => { const entries = wheelEntries(s, id, registry); return { object: obj(id), entries, choice: (entries.some((e) => e.key === s.choice) ? s.choice : firstAvailable(entries)) as WheelKey }; };
  const place = () => {
    const p = s.placement!; const d = s.destinations.find((x) => x.id === p.destinationId);
    return { ...around(p.objectId), placement: p, ...(d ? { destination: { key: WHEEL_SLOTS.find((w) => w.kinds.includes(d.contract.targetKind))?.key ?? "more", label: d.label, app: d.contract.app, effect: p.op?.proposal.effect ?? d.contract.accepts[0]?.effect ?? "", standIn: !!d.standIn, verifies: !!d.contract.abilities?.includes("verify"), ...(d.contract.reliability === "deep-link" ? { opensOnly: true } : {}) } } : {}), ...(s.last ? { text: s.last.text } : {}) };
  };
  const sv = () => { const r = saveable(s); const done = s.last?.kind === "saved" ? { done: s.last.text } : {}; return { save: r.ok ? { ok: true, ...done } : { ok: false, reason: r.reason } }; };
  const mine = () => {
    const list = [...(s.workflows ?? []).map((w) => ({ id: w.id, name: w.name, description: w.description, definition: workflowDefinition(w) })),
      ...(s.workflowIssues ?? []).map((x, i) => ({ id: x.id ?? `#${i}`, name: x.name ?? "A saved workflow", description: "", reason: x.reason }))];
    return list.length ? { mine: list } : {};
  };
  switch (s.phase) {
    case "composed": return { mode: "composed", ...around(s.focus!), recipes: recipeOffers(s, s.focus!), ...mine() };
    case "planning": return { mode: "plan", ...around(s.run!.objectId), run: s.run!, ...(s.run!.saved ? {} : sv()) };
    case "running": return { mode: "running", ...around(s.run!.objectId), run: s.run! };
    case "ran": return { mode: "ran", ...around(s.run!.objectId), run: s.run!, ...(s.last ? { text: s.last.text } : {}), ...(s.run!.saved ? {} : sv()) };
    case "choosing": return { mode: "choosing", ...around(s.focus!) };
    case "inspecting": return { mode: "inspecting", ...around(s.inspecting!) };
    case "confirmingMerge": return { mode: "confirm", ...around(s.pendingMerge!.targetId), confirm: `Pressing these together ${s.pendingMerge!.reason}.` };
    case "previewing": return { mode: "preview", ...place(), ...sv() };
    case "executing": return { mode: "executing", ...place() };
    case "undoing": return { mode: "undoing", ...place() };
    case "succeeded": return { mode: "succeeded", ...place(), ...sv() };
    case "failed": return { mode: "failed", ...place() };
    case "unknown": return { mode: "unknown", ...place() };
    default: {
      // Carrying a piece while a composition exists: the module stays open around it, so it can be dropped in.
      if (s.carried && s.focus && s.carried !== s.focus && s.objects[s.focus] && s.desk.includes(s.focus) && (s.phase === "carrying" || s.phase === "approaching")) {
        return { mode: "composed", ...around(s.focus), text: "Drop it on the object to add it, or anywhere else to put it down" };
      }
      const reopen = s.focus && s.objects[s.focus] && s.desk.includes(s.focus) ? viewOf(s, s.focus).label : undefined;
      const carrying = s.carried ? viewOf(s, s.carried).label : undefined;
      const text = carrying ? `Carrying ${carrying}` : s.phase === "merging" ? "Pressing together…" : reopen ? `${reopen} is ready` : "Drag one thing onto another";
      return { mode: "pill", text, ...(reopen ? { reopen } : {}), ...(carrying ? { carrying } : {}) };
    }
  }
}

/** One line for an object whose last placement has an unknown outcome, so it never looks like an untouched object. */
export function doubtNote(s: ClumpState, id: string): string | undefined {
  const u = (s.uncertain ?? {})[id]; if (!u) return undefined;
  const where = s.destinations.find((d) => d.contract.destination === u.destination)?.label ?? u.op.proposal.destination.app;
  return `Not sure it reached ${where}: check before placing again`;
}

