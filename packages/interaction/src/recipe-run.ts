// Running a recipe: several operations from one composition, each to its own destination, reviewed together and approved
// once. They are independent writes to independent services, so there is no pretend transaction: each step has its own
// operation, its own receipt and its own outcome, and the run reports exactly that ("2 of 3 done"), never a blanket success.
// A step whose answer was lost is unknown and is never sent again by the run.
import { answerClump, checkConsent, chooseClump, plan, planRecipe, propose, rankProposals, recipeById, RECIPES, resolve, viewClump, type Consent, type Operation, type Receipt, type TargetKind, type Verification } from "@recast/core";
import type { ClumpEffect, ClumpEvent, ClumpResult, ClumpState } from "./clump-machine.js";

export type StepStatus = "ready" | "blocked" | "skipped" | "waiting" | "running" | "done" | "failed" | "unknown" | "undoing" | "undone";
export interface RunStep {
  id: string; label: string; targetKind: TargetKind; worded: boolean;
  /** The captured pieces this step uses, in words, so the review shows what goes where. */
  uses: string[]; note?: string;
  destinationId?: string; destinationLabel?: string; app?: string; standIn?: boolean;
  op?: Operation; include: boolean; status: StepStatus;
  reason?: string; receipt?: Receipt; message?: string; undoable?: boolean;
  /** The destination's own read-back once the step is done: "checking" until it answers. */
  verification?: Verification | "checking";
  /** The step this one waits for (its id), and that step's label for the review ("after: Add the event to your calendar"). */
  after?: string; afterLabel?: string;
  /** How many times the person asked to try a failed step again. */
  tries?: number;
}
export interface RecipeRun { recipeId: string; version: number; name: string; objectId: string; steps: RunStep[]; /** one of the person's saved workflows */ saved?: boolean;
  /** What the recipe says it cannot do, shown in the review before it runs. */
  limitations?: string[] }

export type RunEvent =
  | { type: "openRecipe"; recipeId: string; id?: string; now: number }
  | { type: "toggleStep"; stepId: string; now: number }
  | { type: "runRecipe"; consent: Consent; now: number }
  | { type: "undoStep"; stepId: string; now: number }
  /** Try a step again that failed (the destination said no) or was not run because the step it waits for had failed. */
  | { type: "retryStep"; stepId: string; now: number };

/** A recipe as the module offers it for an object: available when at least one of its steps can run here. */
export interface RecipeOffer { id: string; name: string; description: string; available: boolean; reason?: string; saved?: boolean }

const KIND_NAME: Partial<Record<TargetKind, string>> = { Calendar: "a calendar", Drafts: "a mail account", TaskList: "a task list", Docs: "documents", Issues: "an issue tracker" };

function steps(s: ClumpState, recipeId: string, objectId: string): RunStep[] | { error: string } {
  const r = recipeById(recipeId, s.workflows ?? []); if (!r) return { error: "no such recipe" };
  const c = s.objects[objectId]; if (!c) return { error: "no such object" };
  const ctx = { now: new Date(s.now).toISOString(), timezone: s.timezone };
  return planRecipe(r, c, ctx).map((p, i): RunStep => {
    // A saved workflow names its exact destination: only that one will do, never a look-alike of the same kind.
    const def = r.steps[i];
    const dep = def?.after ? r.steps.find((x) => x.id === def.after) : undefined;
    const base = { id: p.id, label: p.label, targetKind: p.targetKind, worded: p.worded, uses: p.uses, ...(p.note ? { note: p.note } : {}), ...(dep ? { after: dep.id, afterLabel: dep.label } : {}) };
    const d = def?.destination ? s.destinations.find((x) => x.contract.destination === def.destination) : s.destinations.find((x) => x.contract.targetKind === p.targetKind);
    const where = d ? { destinationId: d.id, destinationLabel: d.label, app: d.contract.app, ...(d.standIn ? { standIn: true } : {}) } : {};
    if (!d) return { ...base, include: false, status: "blocked", reason: def?.destination ? `${def.app ?? def.destination} is not connected here` : `${KIND_NAME[p.targetKind] ?? p.targetKind} is not connected here` };
    if (!p.candidate) return { ...base, ...where, include: false, status: "blocked", reason: p.reason ?? "something is missing" };
    const proposal = rankProposals(propose(resolve(p.candidate), d.contract)).find((x) => x.status === "ready");
    if (!proposal) return { ...base, ...where, include: false, status: "blocked", reason: `${d.label} cannot take this as it is` };
    return { ...base, ...where, op: plan(proposal, { now: () => new Date(s.now).toISOString() }), include: true, status: "ready" };
  });
}

/** The recipes that fit this object's kind, each available or with the reason it is not. */
export function recipeOffers(s: ClumpState, objectId: string): RecipeOffer[] {
  const c = s.objects[objectId]; if (!c) return [];
  const type = viewClump(c, { now: new Date(s.now).toISOString(), timezone: s.timezone }).type;
  return [...RECIPES, ...(s.workflows ?? [])].filter((r) => r.needs === type).map((r) => {
    const tag = r.origin === "saved" ? { saved: true } : {};
    const st = steps(s, r.id, objectId);
    if ("error" in st) return { id: r.id, name: r.name, description: r.description, available: false, reason: st.error, ...tag };
    // Open when something in it can run, or can once it is finished in the review (a missing title or date, a disagreement).
    const usable = st.filter((x) => x.status === "ready" || (x.destinationId && (x.reason?.startsWith("the event is not complete") || x.reason?.startsWith("it is not complete"))));
    return { id: r.id, name: r.name, description: r.description, available: usable.length > 0, ...tag, ...(usable.length ? {} : { reason: st.map((x) => x.reason).filter(Boolean)[0] ?? "nothing in it can run here" }) };
  });
}

const RUN_PHASES = ["planning", "running", "ran"] as const;
const say = (s: ClumpState, kind: NonNullable<ClumpState["last"]>["kind"], text: string): ClumpState => ({ ...s, last: { kind, text, at: s.now } });
const withSteps = (s: ClumpState, run: RecipeRun, f: (x: RunStep) => RunStep): ClumpState => ({ ...s, run: { ...run, steps: run.steps.map(f) } });

/** Start the next waiting step, or finish the run. A step whose dependency did not succeed is not run, and says why. */
function next(s: ClumpState): ClumpResult {
  let run = s.run!;
  for (;;) {
    const w0 = run.steps.find((x) => x.status === "waiting"); if (!w0?.after) break;
    const dep = run.steps.find((x) => x.id === w0.after);
    if (dep?.status === "done") break;
    const why = !dep?.include ? `it waits for "${dep?.label ?? w0.after}", which was left out` : `"${dep.label}" did not succeed, so this was not run`;
    run = { ...run, steps: run.steps.map((x) => (x.id === w0.id ? { ...x, status: "skipped", message: why } : x)) };
    s = { ...s, run };
  }
  const w = run.steps.find((x) => x.status === "waiting");
  if (!w) {
    const ran = run.steps.filter((x) => x.include);
    const done = ran.filter((x) => x.status === "done" || x.status === "undone").length;
    const text = done === ran.length ? `${run.name}: all ${done} done` : `${run.name}: ${done} of ${ran.length} done`;
    return { state: say({ ...s, phase: "ran" }, done === ran.length ? "placed" : "failed", text), effects: [] };
  }
  const st = withSteps(s, run, (x) => (x.id === w.id ? { ...x, status: "running" } : x));
  const effect: ClumpEffect = { type: "commit", op: w.op!, consent: s.runConsent!, destinationId: w.destinationId! };
  return { state: st, effects: [effect] };
}

/**
 * The recipe part of the state machine. Returns null when the event is not about a recipe run (the rest of the machine
 * handles it). Results name their operation, so an answer for an earlier operation is ignored.
 */
export function reduceRun(s: ClumpState, ev: ClumpEvent): ClumpResult | null {
  const inRun = (RUN_PHASES as readonly string[]).includes(s.phase);
  const ok = (state: ClumpState, effects: ClumpEffect[] = []): ClumpResult => ({ state, effects });
  const no = (error: string): ClumpResult => ({ state: s, effects: [], error });
  const e = { ...s, now: ev.now };
  if (ev.type === "openRecipe") {
    if (!["composed", "choosing", "inspecting", "idle"].includes(s.phase)) return no(`cannot open a recipe while ${s.phase}`);
    const id = ev.id ?? s.focus; if (!id || !s.desk.includes(id)) return no("there is no composition to run it on");
    const st = steps(e, ev.recipeId, id); if ("error" in st) return no(st.error);
    const r = recipeById(ev.recipeId, s.workflows ?? [])!;
    return ok({ ...e, phase: "planning", focus: id, inspecting: null, placement: null, run: { recipeId: r.id, version: r.version, name: r.name, objectId: id, steps: st, ...(r.origin === "saved" ? { saved: true } : {}), ...(r.limitations.length ? { limitations: r.limitations } : {}) } });
  }
  if (!inRun || !s.run) return null;
  // Settings are not steps: the rest of the machine applies them in any phase.
  if (ev.type === "setConfirm" || ev.type === "setTimezone") return null;
  const run = s.run;
  const stepOf = (opId: string) => run.steps.find((x) => x.op?.opId === opId && (x.status === "running" || x.status === "undoing"));
  switch (ev.type) {
    case "answer": case "choose": {
      // Finishing the event in the review (a title, a date): the steps are worked out again; steps the person left out stay out.
      if (s.phase !== "planning") return no("answers are given before it runs");
      if (ev.objectId !== run.objectId) return no("no such object");
      const c = s.objects[run.objectId]!;
      const updated = ev.type === "answer" ? answerClump(c, ev.field, ev.value) : chooseClump(c, ev.field, ev.ingredientId);
      const n = { ...e, objects: { ...e.objects, [run.objectId]: updated } };
      const st = steps(n, run.recipeId, run.objectId); if ("error" in st) return no(st.error);
      const out = new Set(run.steps.filter((x) => x.status === "ready" && !x.include).map((x) => x.id));
      return ok({ ...n, run: { ...run, steps: st.map((x) => (out.has(x.id) && x.status === "ready" ? { ...x, include: false } : x)) } });
    }
    case "toggleStep": {
      if (s.phase !== "planning") return no("the steps are chosen before it runs");
      const t = run.steps.find((x) => x.id === ev.stepId); if (!t) return no("no such step");
      if (t.status !== "ready") return no(t.reason ?? "this step cannot run");
      return ok(withSteps(e, run, (x) => (x.id === t.id ? { ...x, include: !x.include } : x)));
    }
    case "runRecipe": {
      if (s.phase !== "planning") return no("it is already running");
      const chosen = run.steps.filter((x) => x.include && x.status === "ready");
      if (!chosen.length) return no("choose at least one step");
      for (const x of chosen) { try { checkConsent(x.op!, ev.consent); } catch { return no(x.op!.risk.consent === "hold" ? "press and hold to run this one" : "confirm to run it"); } }
      const st = withSteps({ ...e, phase: "running", runConsent: ev.consent }, run, (x) => (x.include && x.status === "ready" ? { ...x, status: "waiting" } : x.status === "ready" ? { ...x, status: "skipped" } : x));
      return next(st);
    }
    case "committed": {
      const t = stepOf(ev.receipt.opId); if (!t || t.status !== "running") return { state: s, effects: [], error: "ignored: an answer for an earlier action", stale: true };
      const d = s.destinations.find((x) => x.id === t.destinationId);
      // A destination that can be read back is checked right away; the step says "checking" until it answers.
      const reads = !!d?.contract.abilities?.includes("verify");
      const r = next(withSteps(e, run, (x) => (x.id === t.id ? { ...x, status: "done", receipt: ev.receipt, undoable: ev.undoable && ev.receipt.reversible && d?.contract.reliability !== "deep-link", ...(reads ? { verification: "checking" as const } : {}) } : x)));
      return reads ? { ...r, effects: [{ type: "verify", op: t.op!, receipt: ev.receipt, destinationId: t.destinationId! }, ...r.effects] } : r;
    }
    case "verified": {
      const t = run.steps.find((x) => x.op?.opId === ev.opId && x.verification === "checking");
      if (!t) return { state: s, effects: [], error: "ignored: an answer for an earlier action", stale: true };
      return ok(withSteps(e, run, (x) => (x.id === t.id ? { ...x, verification: ev.verification } : x)));
    }
    case "commitFailed": case "outcomeUnknown": {
      const t = stepOf(ev.opId); if (!t || t.status !== "running") return { state: s, effects: [], error: "ignored: an answer for an earlier action", stale: true };
      // Unknown: never sent again by the run. The object remembers it, so placing it there again checks first.
      const unknown = ev.type === "outcomeUnknown";
      const st = withSteps(e, run, (x) => (x.id === t.id ? { ...x, status: unknown ? "unknown" : "failed", message: ev.message } : x));
      return next(unknown ? { ...st, uncertain: { ...(st.uncertain ?? {}), [run.objectId]: { destinationId: t.destinationId!, destination: t.op!.proposal.destination.destination, op: t.op!, message: ev.message } } } : st);
    }
    case "retryStep": {
      // Only what certainly did not happen is tried again: a step the destination refused, or one never sent because the
      // step it waits for had failed. An unknown outcome is never resent (it is checked first, from the object).
      if (s.phase !== "ran") return no("a step is tried again once the run has finished");
      const t = run.steps.find((x) => x.id === ev.stepId);
      if (!t || !t.include || !t.op || !(t.status === "failed" || (t.status === "skipped" && t.message))) return no(t?.status === "unknown" ? "Recast does not know whether that one worked: check the destination first, it is never sent twice" : "this step cannot be tried again");
      if (t.after && run.steps.find((x) => x.id === t.after)?.status !== "done") return no(`"${t.afterLabel ?? t.after}" has to succeed first`);
      if (!s.destinations.some((x) => x.id === t.destinationId)) return no(`${t.destinationLabel ?? "That destination"} is not open here`);
      // The same operation (the same id): a destination that did receive it after all recognises it, so it cannot be added twice.
      const st = withSteps({ ...e, phase: "running" }, run, (x) => (x.id === t.id ? { ...x, status: "waiting", message: undefined, tries: (x.tries ?? 0) + 1 } : x));
      return next(st);
    }
    case "undoStep": {
      if (s.phase !== "ran") return no("undo is offered once it has run");
      const t = run.steps.find((x) => x.id === ev.stepId);
      if (!t || t.status !== "done" || !t.undoable || !t.receipt) return no("this step cannot be undone");
      if (!s.destinations.some((x) => x.id === t.destinationId)) return no(`${t.destinationLabel ?? "That destination"} is not open here. Open it to undo`);
      return ok(withSteps(e, run, (x) => (x.id === t.id ? { ...x, status: "undoing" } : x)), [{ type: "undo", receipt: t.receipt, destinationId: t.destinationId! }]);
    }
    case "undone": {
      const t = stepOf(ev.opId); if (!t || t.status !== "undoing") return { state: s, effects: [], error: "ignored", stale: true };
      return ok(say(withSteps(e, run, (x) => (x.id === t.id ? { ...x, status: "undone", undoable: false } : x)), "undone", `Removed from ${t.destinationLabel}`));
    }
    case "undoFailed": {
      const t = stepOf(ev.opId); if (!t || t.status !== "undoing") return { state: s, effects: [], error: "ignored", stale: true };
      return ok(withSteps(e, run, (x) => (x.id === t.id ? { ...x, status: "done", message: `Could not undo: ${ev.message}` } : x)));
    }
    case "cancel": case "dismiss": {
      if (s.phase === "running") return no("Waiting for the steps to answer. Recast stays on until they do");
      if (s.phase === "planning") return ok(say({ ...e, phase: "composed", run: null }, "cancelled", "Not run; nothing was written"));
      if (run.steps.some((x) => x.status === "undoing")) return no("Waiting for the undo to be confirmed");
      // Everything chosen done: the object has its places and leaves the desk. Otherwise it stays, for what is left.
      const ran = run.steps.filter((x) => x.include);
      const all = ran.length > 0 && ran.every((x) => x.status === "done");
      const desk = all ? e.desk.filter((x) => x !== run.objectId) : e.desk;
      const objects = all ? Object.fromEntries(Object.entries(e.objects).filter(([k]) => k !== run.objectId)) : e.objects;
      return ok({ ...e, phase: "idle", run: null, runConsent: undefined, desk, objects, ...(all && e.focus === run.objectId ? { focus: null } : {}) });
    }
    case "arm": return ok(e);
    case "disarm": return s.phase === "planning" ? ok({ ...e, phase: "idle", run: null, armed: false }) : no("finish or close the recipe first");
    default: return no(`cannot ${ev.type} while ${s.phase}`);
  }
}
