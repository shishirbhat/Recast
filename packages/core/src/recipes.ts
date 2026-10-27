// Recipes: a composition turned into several related objects, each for its own destination. A recipe is a definition only:
// it never carries captured content, accounts or tokens, so it can be shared and versioned. Running one still goes through
// propose → plan → consent → commit for every step, with the destination's own contract and the person's own connections.
// Pure: what each step would place is derived from the composition, and anything Recast words itself is marked as such.
import { viewClump, type Clump, type ClumpType, type ClumpView } from "./clump.js";
import type { ComposeContext } from "./compose.js";
import type { Candidate, Evidence, FieldMeta, TargetKind } from "./types.js";
import { hash32 } from "./canonical.js";

export interface RecipeStepDef {
  id: string;
  /** What the step does, for the review ("Add the event to your calendar"). */
  label: string;
  /** The kind of destination it needs; the person's connected destination of that kind performs it. */
  targetKind: TargetKind;
  /** True when Recast words part of it (a suggested task title, a draft message): the review says so. */
  worded?: boolean;
  /** A saved workflow's step names the exact destination it was saved with (a contract's destination, e.g. "outlook-calendar.calendar"). */
  destination?: string;
  /** The app that destination belongs to, for the words on screen ("Outlook Calendar is not connected here"). */
  app?: string;
}
export interface Recipe {
  id: string; version: number; name: string; description: string;
  /** "saved": defined by the person (a personal workflow); absent: one of Recast's own recipes. */
  origin?: "saved";
  /** The composition it takes. */
  needs: ClumpType;
  steps: RecipeStepDef[];
  limitations: string[];
}

/** One step, derived for a composition: the object it would place, or why it cannot. */
export interface StepPlan { id: string; label: string; targetKind: TargetKind; worded: boolean; candidate: Candidate | null; reason?: string; uses: string[]; note?: string }

export const RECIPES: readonly Recipe[] = [
  {
    id: "plan-and-invite", version: 1, name: "Plan and invite",
    description: "The event in your calendar, and a draft asking the people in it whether the time works.",
    needs: "Event",
    steps: [
      { id: "event", label: "Add the event to your calendar", targetKind: "Calendar" },
      { id: "invite", label: "Draft a message to the people in it", targetKind: "Drafts", worded: true },
    ],
    limitations: ["The message is saved as a draft, never sent.", "A person without an email address on the page cannot be written to: that step waits for the address."],
  },
  {
    id: "plan-and-prepare", version: 1, name: "Plan and prepare",
    description: "The event in your calendar, and a task to prepare for it, due the same day.",
    needs: "Event",
    steps: [
      { id: "event", label: "Add the event to your calendar", targetKind: "Calendar" },
      { id: "prepare", label: "Add a task to prepare for it", targetKind: "TaskList", worded: true },
    ],
    limitations: ["The task is due on the event's day; Google Tasks keeps only the day."],
  },
];
export const recipeById = (id: string, saved: readonly Recipe[] = []) => RECIPES.find((r) => r.id === id) ?? saved.find((r) => r.id === id);

// ---- personal saved workflows --------------------------------------------------------------------------------------
// A saved workflow is a recipe the person defined: a name and steps (what kind of object it takes, which steps, which
// destination each goes to). It is a definition only, like every recipe: no captured words, no values, no accounts, no
// tokens. It runs through the same review, approval, commit, read-back and Undo as any recipe.
export const STEP_IDS = ["event", "invite", "prepare", "place"] as const;
const CLUMP_TYPES: readonly ClumpType[] = ["Fragment", "Event", "Message", "People", "Document", "Task", "Note", "Issue"];
const TARGET_KINDS: readonly string[] = ["Calendar", "Drafts", "Task", "Project", "TaskList", "Map", "Docs", "Issues"];
export const WORKFLOW_NAME_MAX = 60;

/**
 * Read a stored workflow definition. Anything that is not exactly a workflow (an unknown step, a destination Recast has no
 * bridge for, an extra field that could carry content) is refused with the reason: a stored file is never trusted.
 */
export function checkWorkflow(x: unknown, destinations: readonly string[]): { ok: true; recipe: Recipe } | { ok: false; reason: string; id?: string; name?: string } {
  const o = x && typeof x === "object" ? (x as Record<string, unknown>) : null;
  const id = typeof o?.id === "string" ? o.id : undefined; const name = typeof o?.name === "string" ? o.name : undefined;
  const no = (reason: string) => ({ ok: false as const, reason, ...(id ? { id } : {}), ...(name ? { name } : {}) });
  if (!o) return no("not a workflow");
  const extra = Object.keys(o).filter((k) => !["id", "version", "name", "description", "origin", "needs", "steps", "limitations"].includes(k));
  if (extra.length) return no(`unexpected ${extra.join(", ")}`);
  if (!id || !/^wf_[a-z0-9]{1,40}$/.test(id)) return no("its id is not valid");
  if (o.version !== 1) return no("it was saved by a different version of Recast");
  if (!name || !name.trim() || name.length > WORKFLOW_NAME_MAX) return no("its name is missing or too long");
  if (o.origin !== "saved") return no("it is not a saved workflow");
  if (!CLUMP_TYPES.includes(o.needs as ClumpType)) return no("the kind of object it takes is not known");
  if (!Array.isArray(o.steps) || !o.steps.length || o.steps.length > 5) return no("it has no steps, or too many");
  const steps: RecipeStepDef[] = [];
  for (const st of o.steps as unknown[]) {
    const t = st && typeof st === "object" ? (st as Record<string, unknown>) : {};
    if (Object.keys(t).some((k) => !["id", "label", "targetKind", "worded", "destination", "app"].includes(k))) return no("a step has unexpected fields");
    if (!STEP_IDS.includes(t.id as never)) return no(`a step (${String(t.id)}) is not one Recast can run`);
    if (typeof t.label !== "string" || t.label.length > 120 || !TARGET_KINDS.includes(String(t.targetKind))) return no("a step is not valid");
    if (t.destination !== undefined && (typeof t.destination !== "string" || !destinations.includes(t.destination))) return no(`it goes to ${String(t.destination)}, which Recast cannot place in any more`);
    if (t.app !== undefined && (typeof t.app !== "string" || t.app.length > 40)) return no("a step is not valid");
    steps.push({ id: t.id as string, label: t.label, targetKind: t.targetKind as TargetKind, ...(t.worded ? { worded: true } : {}), ...(t.destination ? { destination: t.destination as string } : {}), ...(t.app ? { app: t.app as string } : {}) });
  }
  if (typeof o.description !== "string" || o.description.length > 300) return no("its description is not valid");
  return { ok: true, recipe: { id, version: 1, name: name.trim(), description: o.description, origin: "saved", needs: o.needs as ClumpType, steps, limitations: [] } };
}

/** The workflow's own words for what it does, from its steps and their destinations (never from captured content). */
const describe = (needs: ClumpType, steps: RecipeStepDef[], apps: Record<string, string>) =>
  `${({ Event: "An event", Message: "A message", Document: "A page", Task: "A task", Note: "A note", Issue: "An issue", Fragment: "A piece", People: "People" } as Record<ClumpType, string>)[needs]} → ${steps.map((x) => apps[x.destination ?? ""] ?? x.targetKind).join(", then ")}`;

/**
 * A workflow from what the person just did: the kind of object, the steps they ran (or reviewed), each with the exact
 * destination it went to. Only structure is kept: no step label comes from content, and nothing captured is copied.
 */
export function workflowFrom(o: { name: string; needs: ClumpType; steps: { id: string; label: string; targetKind: TargetKind; worded?: boolean; destination: string; app: string }[]; now: string }): Recipe {
  const name = o.name.replace(/\s+/g, " ").trim().slice(0, WORKFLOW_NAME_MAX);
  const steps: RecipeStepDef[] = o.steps.map((x) => ({ id: x.id, label: x.label, targetKind: x.targetKind, ...(x.worded ? { worded: true } : {}), destination: x.destination, app: x.app }));
  const apps = Object.fromEntries(o.steps.map((x) => [x.destination, x.app]));
  return { id: `wf_${hash32(`${name}|${JSON.stringify(steps)}|${o.now}`)}`, version: 1, name, description: describe(o.needs, steps, apps), origin: "saved", needs: o.needs, steps, limitations: [] };
}
/** The label a single-placement workflow's step carries: the destination's effect, not the content. */
export const placeStepLabel = (effect: string, app: string) => `${effect} in ${app}`.slice(0, 120);

const at = (ctx: Pick<ComposeContext, "now">) => new Date(ctx.now).toISOString().replace(/\.\d{3}Z$/, "Z");
const composed = (field: string, why: string): FieldMeta => ({ confidence: 1, evidence: [{ locator: { kind: "composition", value: `recipe:${field}` }, origin: "inferred", excerpt: why.slice(0, 500) } as Evidence] });
const nameOf = (s: string) => s.replace(/\s+/g, " ").trim();
const day = (iso: string) => iso.slice(0, 10);
const when = (iso: string) => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  const date = d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  if (iso.length <= 10) return date;
  const [h, m] = iso.slice(11, 16).split(":").map(Number) as [number, number];
  return `${date} at ${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

/**
 * What each step of a recipe would place for this composition. Nothing missing is invented: a step that lacks something
 * (an email address, the event itself) says what, and is left out unless the person supplies it.
 */
export function planRecipe(recipe: Recipe, c: Clump, ctx: ComposeContext): StepPlan[] {
  const v: ClumpView = viewClump(c, ctx);
  const ev = v.event;
  const title = typeof ev?.fields.title?.value === "string" ? ev.fields.title.value : undefined;
  const start = typeof ev?.fields.start?.value === "string" ? ev.fields.start.value : undefined;
  const place = typeof ev?.fields.location?.value === "string" ? ev.fields.location.value.split(",")[0]! : undefined;
  const source = c.ingredients.find((f) => f.source)?.source;
  const provenance = { source: { app: ctx.app ?? source?.app ?? "recast", ...(source?.url ? { url: source.url } : {}) }, capture: { method: "composition" as const, adapter: `recipe:${recipe.id}@${recipe.version}`, at: at(ctx) } };
  const eventUses = v.summary;
  const needEvent = v.type !== "Event" ? "this is not an event" : !v.candidate ? `the event is not complete: ${v.missing.map((m) => m.field === "start" ? "a date" : m.field).join(", ") || "something is missing"}` : undefined;

  return recipe.steps.map((s): StepPlan => {
    const base = { id: s.id, label: s.label, targetKind: s.targetKind, worded: !!s.worded };
    // A saved single placement: the composition itself, as it is, to its one destination (nothing worded by Recast).
    if (s.id === "place") {
      if (v.type !== recipe.needs) return { ...base, candidate: null, reason: `this workflow takes ${recipe.needs === "Event" || recipe.needs === "Issue" ? `an ${recipe.needs.toLowerCase()}` : recipe.needs === "Fragment" ? "a single piece" : `a ${recipe.needs.toLowerCase()}`}; this is ${v.type === "Fragment" ? "a single piece" : v.type === "Event" || v.type === "Issue" ? `an ${v.type.toLowerCase()}` : `a ${v.type.toLowerCase()}`}`, uses: [] };
      if (!v.placeableAs.includes(s.targetKind as never)) return { ...base, candidate: null, reason: "this cannot go there", uses: [] };
      if (!v.candidate) return { ...base, candidate: null, reason: `${v.type === "Event" ? "the event" : "it"} is not complete: ${v.missing.map((m) => m.field === "start" ? "a date" : m.field).join(", ") || (v.conflicts.length ? "the pieces disagree" : "something is missing")}`, uses: v.summary };
      return { ...base, candidate: v.candidate, uses: v.summary };
    }
    if (s.id === "event") return { ...base, candidate: needEvent ? null : v.candidate, ...(needEvent ? { reason: needEvent } : {}), uses: eventUses };
    if (needEvent) return { ...base, candidate: null, reason: needEvent, uses: [] };
    if (s.id === "invite") {
      const people = c.ingredients.filter((f) => f.kind === "person");
      if (!people.length) return { ...base, candidate: null, reason: "there is nobody in it to write to", uses: [] };
      const noEmail = people.filter((p) => !p.value?.email).map((p) => nameOf(p.value?.name ?? p.text));
      if (noEmail.length) return { ...base, candidate: null, reason: `${noEmail.join(", ")} has no email address on the page`, uses: people.map((p) => nameOf(p.value?.name ?? p.text)) };
      const first = nameOf(people[0]!.value?.name ?? people[0]!.text).split(" ")[0];
      // The place only when the title does not already name it ("Meet Maya at Dakshin" needs no second "at Dakshin").
      const at = place && !title!.toLowerCase().includes(place.toLowerCase()) ? `at ${place} ` : "";
      const snippet = `Hi ${people.length === 1 ? first : "all"}, are you free for ${title} ${at}on ${when(start!)}?`;
      const to = people.map((p) => p.value!.email!);
      const byId = new Map(c.ingredients.map((f) => [f.id, f]));
      const toEv = people.flatMap((p) => byId.get(p.id)!.evidence.map((e): Evidence => ({ ...e, origin: "extracted", ...(p.source ? { source: p.source } : {}) })));
      return { ...base, uses: [...people.map((p) => nameOf(p.value?.name ?? p.text)), "the event"], note: "Recast's wording; edit it in your drafts",
        candidate: { type: "Message", properties: { to, snippet }, fields: { to: { confidence: Math.min(...people.map((p) => p.confidence)), evidence: toEv }, snippet: composed("snippet", "worded by the recipe from the event") }, provenance } };
    }
    // prepare
    const props: Record<string, unknown> = { title: `Prepare: ${title}`, due: day(start!) };
    const fields: Record<string, FieldMeta> = { title: composed("title", "worded by the recipe from the event title"), due: composed("due", "the event's day") };
    if (source?.url) { props["url"] = source.url; fields["url"] = { confidence: 0.9, evidence: [{ locator: { kind: "composition", value: "recipe:url" }, origin: "extracted", source } as Evidence] }; }
    return { ...base, uses: [title!, when(start!)], note: "Recast's wording", candidate: { type: "Task", properties: props, fields, provenance } };
  });
}
