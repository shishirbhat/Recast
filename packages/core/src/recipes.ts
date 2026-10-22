// Recipes: a composition turned into several related objects, each for its own destination. A recipe is a definition only:
// it never carries captured content, accounts or tokens, so it can be shared and versioned. Running one still goes through
// propose → plan → consent → commit for every step, with the destination's own contract and the person's own connections.
// Pure: what each step would place is derived from the composition, and anything Recast words itself is marked as such.
import { viewClump, type Clump, type ClumpType, type ClumpView } from "./clump.js";
import type { ComposeContext } from "./compose.js";
import type { Candidate, Evidence, FieldMeta, TargetKind } from "./types.js";

export interface RecipeStepDef {
  id: string;
  /** What the step does, for the review ("Add the event to your calendar"). */
  label: string;
  /** The kind of destination it needs; the person's connected destination of that kind performs it. */
  targetKind: TargetKind;
  /** True when Recast words part of it (a suggested task title, a draft message): the review says so. */
  worded?: boolean;
}
export interface Recipe {
  id: string; version: number; name: string; description: string;
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
export const recipeById = (id: string) => RECIPES.find((r) => r.id === id);

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
