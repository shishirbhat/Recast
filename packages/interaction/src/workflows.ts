// Personal saved workflows: a recipe the person defined by doing it once and naming it. Saving keeps the structure only
// (what kind of object, which steps, which destination each goes to); never the captured words, people, links, accounts
// or tokens. A saved workflow runs exactly like a recipe: the same review, the same single approval, each step's own
// receipt, read-back and Undo. Nothing is saved, renamed or deleted without the person asking for it; the host persists
// the list it is handed in a `storeWorkflows` effect, and reads it back with `setWorkflows`, which checks every entry.
import { checkWorkflow, placeStepLabel, RECIPES, viewClump, workflowFrom, WORKFLOW_NAME_MAX, type Recipe, type TargetKind } from "@recast/core";
import type { ClumpEvent, ClumpResult, ClumpState } from "./clump-machine.js";

export type WorkflowEvent =
  /** The stored list, as the host read it. `known` is every destination this build of Recast can place in. */
  | { type: "setWorkflows"; items: unknown[]; known: string[]; now: number }
  | { type: "saveWorkflow"; name: string; now: number }
  | { type: "renameWorkflow"; id: string; name: string; now: number }
  | { type: "deleteWorkflow"; id: string; now: number };

/** A stored entry that cannot be used (from another version, or for a destination Recast no longer has): shown, never run. */
export interface WorkflowIssue { id?: string; name?: string; reason: string }

/** Kinds of destination a saved workflow can name: a new thing in a place, never "change that one existing item". */
const SAVEABLE: readonly TargetKind[] = ["Calendar", "Drafts", "Task", "Project", "TaskList", "Map", "Docs", "Issues"];
const WF_TYPES = ["setWorkflows", "saveWorkflow", "renameWorkflow", "deleteWorkflow"];

/** Why what is on screen can or cannot be saved as a workflow. The Save button is only offered when it can. */
export function saveable(s: ClumpState): { ok: true; from: "run" | "placement" } | { ok: false; reason: string } {
  if (s.run && (s.phase === "planning" || s.phase === "ran")) {
    const usable = s.run.steps.filter((x) => x.include && x.destinationId);
    if (!usable.length) return { ok: false, reason: "choose at least one step that can run here" };
    if (usable.some((x) => !s.destinations.find((d) => d.id === x.destinationId)?.contract.destination)) return { ok: false, reason: "a step goes somewhere that cannot be named" };
    return { ok: true, from: "run" };
  }
  const p = s.placement;
  if (p && (s.phase === "previewing" || s.phase === "succeeded")) {
    const d = s.destinations.find((x) => x.id === p.destinationId);
    if (!d) return { ok: false, reason: "that destination is not open here" };
    // Changing one particular existing item (an open event editor, a sheet row) only means something for that item.
    if (!SAVEABLE.includes(d.contract.targetKind as TargetKind)) return { ok: false, reason: `this changes one particular item in ${d.contract.app}, which cannot be repeated with new information` };
    if (p.slot) return { ok: false, reason: "a chosen time slot belongs to this one placement" };
    return { ok: true, from: "placement" };
  }
  return { ok: false, reason: "open a review first" };
}

const norm = (n: string) => n.replace(/\s+/g, " ").trim();
function nameProblem(s: ClumpState, name: string, except?: string): string | null {
  const n = norm(name);
  if (!n) return "give it a name";
  if (n.length > WORKFLOW_NAME_MAX) return `keep the name under ${WORKFLOW_NAME_MAX} characters`;
  const taken = [...RECIPES.map((r) => r.name), ...(s.workflows ?? []).filter((w) => w.id !== except).map((w) => w.name)];
  if (taken.some((t) => t.toLowerCase() === n.toLowerCase())) return `there is already a workflow called "${n}"`;
  return null;
}

/** What the host stores: the usable workflows, plus the unusable entries it already had (left as they were, until deleted). */
const stored = (_s: ClumpState, workflows: Recipe[], kept: unknown[]) => [...workflows, ...kept];

export function reduceWorkflows(s: ClumpState, ev: ClumpEvent): ClumpResult | null {
  if (!WF_TYPES.includes(ev.type)) return null;
  const e = ev as WorkflowEvent;
  const no = (error: string): ClumpResult => ({ state: s, effects: [], error });
  const list = s.workflows ?? [];
  const kept = s.workflowKept ?? [];
  const say = (n: ClumpState, text: string): ClumpState => ({ ...n, last: { kind: "saved", text, at: ev.now } });
  switch (e.type) {
    case "setWorkflows": {
      const workflows: Recipe[] = []; const issues: WorkflowIssue[] = []; const bad: unknown[] = [];
      for (const x of e.items.slice(0, 50)) {
        const r = checkWorkflow(x, e.known);
        if (r.ok && !workflows.some((w) => w.id === r.recipe.id)) workflows.push(r.recipe);
        else if (!r.ok) { issues.push({ ...(r.id ? { id: r.id } : {}), ...(r.name ? { name: r.name.slice(0, WORKFLOW_NAME_MAX) } : {}), reason: r.reason }); bad.push(x); }
      }
      return { state: { ...s, now: ev.now, workflows, workflowIssues: issues, workflowKept: bad }, effects: [] };
    }
    case "saveWorkflow": {
      const can = saveable(s); if (!can.ok) return no(`Cannot save this as a workflow: ${can.reason}`);
      const problem = nameProblem(s, e.name); if (problem) return no(problem);
      const now = new Date(ev.now).toISOString();
      let wf: Recipe;
      if (can.from === "run") {
        const run = s.run!;
        const base = [...RECIPES, ...list].find((r) => r.id === run.recipeId);
        wf = workflowFrom({ name: e.name, needs: base!.needs, now, steps: run.steps.filter((x) => x.include && x.destinationId).map((x) => {
          const d = s.destinations.find((y) => y.id === x.destinationId)!;
          return { id: x.id, label: x.label, targetKind: x.targetKind, worded: x.worded, destination: d.contract.destination, app: d.contract.app };
        }) });
      } else {
        const p = s.placement!; const d = s.destinations.find((x) => x.id === p.destinationId)!;
        const type = viewClump(s.objects[p.objectId] ?? (s.objects[s.focus ?? ""])!, { now, timezone: s.timezone }).type;
        wf = workflowFrom({ name: e.name, needs: type, now, steps: [{ id: "place", label: placeStepLabel("Place it", d.contract.app), targetKind: d.contract.targetKind as TargetKind, destination: d.contract.destination, app: d.contract.app }] });
      }
      const workflows = [...list, wf];
      return { state: say({ ...s, now: ev.now, workflows }, `Saved "${wf.name}". Run it again from the module with new information`), effects: [{ type: "storeWorkflows", items: stored(s, workflows, kept) }] };
    }
    case "renameWorkflow": {
      const w = list.find((x) => x.id === e.id); if (!w) return no("no such workflow");
      const problem = nameProblem(s, e.name, w.id); if (problem) return no(problem);
      const workflows = list.map((x) => (x.id === w.id ? { ...x, name: norm(e.name) } : x));
      // A run of this workflow on screen keeps the name it was opened with.
      return { state: say({ ...s, now: ev.now, workflows }, `Renamed to "${norm(e.name)}"`), effects: [{ type: "storeWorkflows", items: stored(s, workflows, kept) }] };
    }
    case "deleteWorkflow": {
      if (s.run?.recipeId === e.id && s.phase === "running") return no("it is running: wait for its steps to answer");
      const w = list.find((x) => x.id === e.id);
      // An unusable entry with no id of its own is named by its place in the list ("#2").
      const badAt = e.id.startsWith("#") ? (Number(e.id.slice(1)) < (s.workflowIssues ?? []).length ? Number(e.id.slice(1)) : -1) : (s.workflowIssues ?? []).findIndex((x) => x.id === e.id);
      if (!w && badAt < 0) return no("no such workflow");
      const workflows = list.filter((x) => x.id !== e.id);
      const issues = (s.workflowIssues ?? []).filter((_, i) => i !== badAt);
      const keptNow = kept.filter((_, i) => i !== badAt);
      return { state: say({ ...s, now: ev.now, workflows, workflowIssues: issues, workflowKept: keptNow }, `Deleted "${w?.name ?? (s.workflowIssues ?? [])[badAt]?.name ?? "the workflow"}". Nothing already placed was changed`), effects: [{ type: "storeWorkflows", items: stored(s, workflows, keptNow) }] };
    }
  }
}
