// Clumps: objects a person makes by pressing pieces of information together. A clump has a stable id and keeps every
// ingredient as it was captured, so it can be inspected, pulled apart and recombined. What it *is* (an event, a message,
// a group of people) is recalculated from its ingredients by the rules below, never stored, so it can never drift.
// Pure: no I/O, no clock, no randomness of its own (ids and time come in). Composing never performs an action.
import { compose, type ComposeContext, type Composition, type Conflict, type EventField, type Fragment, type Missing, type Origin } from "./compose.js";
import type { Candidate, Evidence, FieldMeta } from "./types.js";

export type ClumpType = "Fragment" | "Event" | "Message" | "People" | "Document" | "Task";
export type MessageField = "to" | "snippet" | "subject";
export type AnswerField = EventField | MessageField | "due";

export interface Clump {
  id: string;
  /** In the order they joined. Never edited: a correction is an answer, so the source stays visible. */
  ingredients: Fragment[];
  /** What the person typed or accepted. Survives merges; the target's answers win over the incoming one's. */
  answers: Partial<Record<AnswerField, string | boolean>>;
  /** Conflict resolutions: field -> the ingredient to trust. */
  choices: Partial<Record<EventField, string>>;
}

export interface MessageView {
  status: "ready" | "incomplete";
  fields: Partial<Record<MessageField, { value: string | string[]; origin: Origin; fragments: string[] }>>;
  missing: { field: MessageField; reason: string; suggestions?: string[] }[];
}

/** A page or file as one object: its title (the page's, or what the person typed) and its address. */
export interface DocumentView {
  status: "ready" | "incomplete";
  fields: Partial<Record<"title" | "url", { value: string; origin: Origin; fragments: string[] }>>;
  missing: { field: "title"; reason: string }[];
}

/** A page with a date: a task, due that day. The title and link are the page's; the date is read from the time piece. */
export interface TaskView {
  status: "ready" | "incomplete";
  fields: Partial<Record<"title" | "url" | "due", { value: string; origin: Origin; fragments: string[] }>>;
  missing: { field: "title" | "due"; reason: string }[];
}

export interface ClumpView {
  type: ClumpType;
  /** The one name the capsule shows. `proposed` when it is Recast's suggestion, not something the person accepted or the page said. */
  label: string; proposed: boolean;
  /** A few short things to show on the capsule: names, the place, the time. */
  summary: string[];
  event?: Composition; message?: MessageView; document?: DocumentView; task?: TaskView;
  missing: { field: AnswerField; reason: string; suggestions?: string[] }[];
  conflicts: Conflict[];
  assumptions: string[];
  /** Where this kind of object can be placed. Empty when it cannot be placed as it is. */
  placeableAs: ("Calendar" | "Drafts" | "Task" | "Project" | "TaskList" | "Map")[];
  /** A complete object ready for the normal propose → plan → consent → commit path. Null until nothing is missing. */
  candidate: Candidate | null;
}

export type MergeCheck =
  | { ok: true; becomes: ClumpType; change?: { from: ClumpType; to: ClumpType } }
  | { ok: false; code: "same_object" | "incompatible"; reason: string };

export type MergeResult =
  | { ok: true; clump: Clump; becomes: ClumpType }
  | { ok: false; code: "same_object" | "incompatible" | "needs_confirmation"; reason: string; becomes?: ClumpType };

export const newClump = (id: string, f: Fragment): Clump => ({ id, ingredients: [f], answers: {}, choices: {} });

const has = (fs: Fragment[], k: Fragment["kind"]) => fs.some((f) => f.kind === k);
const nameOf = (f: Fragment) => (f.value?.name ?? f.text).replace(/\s+/g, " ").trim();

/** The rules. Kept here, in the domain layer, so every surface (page, extension, desktop) behaves the same. */
export function typeOf(fs: Fragment[]): ClumpType | { incompatible: string } {
  if (fs.length === 1 && fs[0]!.kind === "page") return "Document";
  if (fs.length <= 1) return "Fragment";
  const pages = fs.filter((f) => f.kind === "page");
  // A page and a date: a task due that day. Anything else with a page is refused, with what would work.
  if (pages.length === 1 && fs.every((f) => f.kind === "page" || f.kind === "time")) return "Task";
  if (pages.length) return { incompatible: pages.length > 1 ? "two pages do not make one object; place each on its own" : `${nameOf(pages[0]!)} is a whole page: add a date to make it a task due that day, or place it on its own` };
  const things = fs.filter((f) => f.kind === "thing");
  if (things.length) return { incompatible: `${nameOf(things[0]!)} can be carried and placed on its own, but it cannot be combined with other pieces yet` };
  if (has(fs, "time") || has(fs, "place") || has(fs, "title")) return "Event";
  const people = fs.filter((f) => f.kind === "person").length, texts = fs.filter((f) => f.kind === "text").length;
  if (people && texts === 0) return "People";
  if (people && texts) return "Message";
  return { incompatible: "two pieces of text do not make an object yet; add a person to write a message, or a time or place to plan an event" };
}

export function canMerge(target: Clump, incoming: Clump): MergeCheck {
  if (target.id === incoming.id) return { ok: false, code: "same_object", reason: "that is the same object" };
  const before = typeOf(target.ingredients);
  const after = typeOf(union(target.ingredients, incoming.ingredients));
  if (typeof after !== "string") return { ok: false, code: "incompatible", reason: after.incompatible };
  // A message that gains a time or place turns into an event. That changes what placing it does, so the person confirms it.
  const changes = typeof before === "string" && before !== "Fragment" && before !== "People" && before !== after;
  return { ok: true, becomes: after, ...(changes ? { change: { from: before, to: after } } : {}) };
}

const union = (a: Fragment[], b: Fragment[]) => { const ids = new Set(a.map((f) => f.id)); return [...a, ...b.filter((f) => !ids.has(f.id))]; };

/** Press `incoming` into `target`. The result keeps the target's id: it is the object that was already there, grown. */
export function mergeClumps(target: Clump, incoming: Clump, opts: { confirmChange?: boolean } = {}): MergeResult {
  const check = canMerge(target, incoming);
  if (!check.ok) return check;
  if (check.change && !opts.confirmChange) return { ok: false, code: "needs_confirmation", reason: `this turns the ${check.change.from.toLowerCase()} into ${/^[aeiou]/i.test(check.change.to) ? "an" : "a"} ${check.change.to.toLowerCase()}`, becomes: check.becomes };
  return {
    ok: true, becomes: check.becomes,
    clump: { id: target.id, ingredients: union(target.ingredients, incoming.ingredients), answers: { ...incoming.answers, ...target.answers }, choices: { ...incoming.choices, ...target.choices } },
  };
}

/** Take one ingredient back out. Nothing is lost: the ingredient comes back as its own object, and the rest is recalculated. */
export function removeIngredient(c: Clump, ingredientId: string, releasedId: string): { rest: Clump | null; released: Clump } {
  const f = c.ingredients.find((x) => x.id === ingredientId);
  if (!f) throw new Error(`no ingredient ${ingredientId} in ${c.id}`);
  const left = c.ingredients.filter((x) => x.id !== ingredientId);
  const choices = Object.fromEntries(Object.entries(c.choices).filter(([, v]) => v !== ingredientId));
  return { rest: left.length ? { ...c, ingredients: left, choices } : null, released: newClump(releasedId, f) };
}

/** Record what the person typed or accepted (a title, a date, an email). Empty clears it. */
export function answer(c: Clump, field: AnswerField, value: string | boolean): Clump {
  const answers = { ...c.answers }; if (value === "") delete answers[field]; else answers[field] = value;
  return { ...c, answers };
}
export const choose = (c: Clump, field: EventField, ingredientId: string): Clump => ({ ...c, choices: { ...c.choices, [field]: ingredientId } });

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Fixed format, not the runtime's locale: the same object reads the same everywhere it is shown. */
const shortTime = (iso: string) => {
  const [d, t] = iso.split("T") as [string, string | undefined];
  const day = new Date(`${d}T00:00:00Z`); const date = `${DAYS[day.getUTCDay()]}, ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]}`;
  if (!t) return date;
  const [h, m] = t.split(":").map(Number) as [number, number];
  return `${date}, ${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

export function viewClump(c: Clump, ctx: ComposeContext): ClumpView {
  const t = typeOf(c.ingredients); const fs = c.ingredients;
  const people = fs.filter((f) => f.kind === "person").map(nameOf);
  const base = { conflicts: [] as Conflict[], assumptions: [] as string[], placeableAs: [] as ClumpView["placeableAs"], candidate: null };
  if (t === "Fragment") {
    const f = fs[0]!;
    // A place on its own can already go somewhere: a map app, with directions to it. Other single pieces need company.
    if (f.kind === "place") return { ...base, type: "Fragment", label: nameOf(f), proposed: false, summary: [kindLabel(f.kind)], missing: [], placeableAs: ["Map"], candidate: locationCandidate(f, ctx) };
    return { ...base, type: "Fragment", label: nameOf(f), proposed: false, summary: [kindLabel(f.kind)], missing: [] };
  }
  if (typeof t !== "string") return { ...base, type: "Fragment", label: fs.map(nameOf).join(" + "), proposed: false, summary: [], missing: [{ field: "title", reason: t.incompatible }] };
  if (t === "Document") {
    const d = documentView(c);
    return { ...base, type: "Document", label: d.fields.title?.value ?? nameOf(fs[0]!), proposed: false, summary: ["Page", ...(d.fields.url ? [hostOf(d.fields.url.value)] : [])], document: d, missing: d.missing, placeableAs: ["Task", "Project"], candidate: d.status === "ready" ? documentCandidate(c, d, ctx) : null };
  }
  if (t === "Task") {
    const k = taskView(c, ctx);
    const due = k.fields.due?.value;
    const conflicts = compose(fs.filter((f) => f.kind === "time"), { ...ctx, choose: c.choices }).conflicts.filter((x) => x.field === "start");
    return { ...base, type: "Task", label: k.fields.title?.value ?? nameOf(fs.find((f) => f.kind === "page")!), proposed: false, summary: ["Task", ...(due ? [`due ${shortTime(due)}`] : [])], task: k, missing: k.missing, conflicts,
      assumptions: k.timeDropped ? [`A task is due on a day: the time (${k.timeDropped}) is not kept`] : [], placeableAs: ["TaskList"], candidate: k.status === "ready" ? taskCandidate(c, k, ctx) : null };
  }
  if (t === "People") return { ...base, type: "People", label: people.join(" + "), proposed: false, summary: [`${people.length} people`], missing: [{ field: "title", reason: "add a time or place to plan something, or a sentence to write to them" }] };
  if (t === "Message") {
    const m = message(c);
    const first = people[0]!.split(" ")[0];
    return { ...base, type: "Message", label: `Message ${first}`, proposed: true, summary: [people.join(", "), "message"], message: m, missing: m.missing, placeableAs: ["Drafts"], candidate: m.status === "ready" ? messageCandidate(c, m, ctx) : null };
  }
  const event = compose(fs, { ...ctx, answers: c.answers as ComposeContext["answers"], choose: c.choices });
  const title = event.fields.title?.value;
  const suggestion = event.missing.find((m) => m.field === "title")?.suggestions?.[0];
  const label = typeof title === "string" ? title : suggestion ?? "New event";
  const place = event.fields.location?.value; const start = event.fields.start?.value;
  const summary = [...people, ...(typeof place === "string" ? [place.split(",")[0]!] : []), ...(typeof start === "string" ? [shortTime(start)] : [])];
  return { ...base, type: "Event", label, proposed: typeof title !== "string", summary, event, missing: event.missing, conflicts: event.conflicts, assumptions: event.assumptions, placeableAs: ["Calendar"], candidate: event.candidate };
}

function kindLabel(k: Fragment["kind"]) { return ({ person: "Person", place: "Place", time: "Time", title: "Title", text: "Text", thing: "Thing", page: "Page" } as const)[k]; }

const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url.slice(0, 40); } };

function documentView(c: Clump): DocumentView {
  const f = c.ingredients[0]!; const fields: DocumentView["fields"] = {};
  const typed = c.answers.title;
  const found = (f.value?.name ?? f.text).replace(/\s+/g, " ").trim();
  if (typeof typed === "string" && typed.trim()) fields.title = { value: typed.trim(), origin: "user", fragments: [] };
  else if (found) fields.title = { value: found, origin: "extracted", fragments: [f.id] };
  const url = f.value?.url ?? f.source?.url;
  if (url) fields.url = { value: url, origin: "extracted", fragments: [f.id] };
  const missing: DocumentView["missing"] = fields.title ? [] : [{ field: "title", reason: "the page has no title; type one" }];
  return { status: missing.length ? "incomplete" : "ready", fields, missing };
}

function taskView(c: Clump, ctx: ComposeContext): TaskView & { timeDropped?: string } {
  const page = c.ingredients.find((f) => f.kind === "page")!;
  const d = documentView({ ...c, ingredients: [page] });
  const fields: TaskView["fields"] = { ...d.fields }; const missing: TaskView["missing"] = [...d.missing];
  // The date comes from the time pieces, read exactly as an event's start is (relative days, the person's time zone).
  const typed = c.answers.due;
  const read = compose(c.ingredients.filter((f) => f.kind === "time"), { ...ctx, answers: typeof typed === "string" && typed ? { start: typed } : {}, choose: c.choices });
  const start = read.fields.start; let timeDropped: string | undefined;
  if (start && typeof start.value === "string") {
    fields.due = { value: start.value.slice(0, 10), origin: start.origin, fragments: start.fragments };
    if (start.value.length > 10) timeDropped = shortTime(start.value).split(", ").pop();
  } else if (!read.conflicts.some((x) => x.field === "start")) missing.push({ field: "due", reason: read.missing.find((m) => m.field === "start")?.reason ?? "no date could be read; type one" });
  return { status: missing.length || read.conflicts.length ? "incomplete" : "ready", fields, missing, ...(timeDropped ? { timeDropped } : {}) };
}

function taskCandidate(c: Clump, k: TaskView, ctx: ComposeContext): Candidate {
  const doc = documentCandidate({ ...c, ingredients: c.ingredients.filter((f) => f.kind === "page") }, { status: "ready", fields: { ...(k.fields.title ? { title: k.fields.title } : {}), ...(k.fields.url ? { url: k.fields.url } : {}) }, missing: [] }, ctx);
  const properties: Record<string, unknown> = { ...doc.properties }; const meta: Record<string, FieldMeta> = { ...doc.fields };
  const due = k.fields.due;
  if (due) {
    properties["due"] = due.value;
    const byId = new Map(c.ingredients.map((f) => [f.id, f]));
    const ev: Evidence[] = due.origin === "user" ? [{ locator: { kind: "user", value: "user:due" }, origin: "user" }] : due.fragments.flatMap((id) => byId.get(id)!.evidence.map((e): Evidence => ({ ...e, origin: due.origin, ...(byId.get(id)!.source ? { source: byId.get(id)!.source! } : {}) })));
    meta["due"] = { confidence: due.origin === "user" ? 1 : Math.min(...due.fragments.map((id) => byId.get(id)!.confidence)), evidence: ev };
  }
  return { ...doc, type: "Task", properties, fields: meta };
}

function documentCandidate(c: Clump, d: DocumentView, ctx: ComposeContext): Candidate {
  const f = c.ingredients[0]!;
  const properties: Record<string, unknown> = {}; const meta: Record<string, FieldMeta> = {};
  for (const [name, v] of Object.entries(d.fields)) {
    properties[name] = v!.value;
    const ev: Evidence[] = v!.origin === "user" ? [{ locator: { kind: "user", value: `user:${name}` }, origin: "user" }] : f.evidence.map((e): Evidence => ({ ...e, origin: v!.origin, ...(f.source ? { source: f.source } : {}) }));
    meta[name] = { confidence: v!.origin === "user" ? 1 : f.confidence, evidence: ev.length ? ev : [{ locator: { kind: "user", value: `user:${name}` }, origin: v!.origin }] };
  }
  return { type: "Document", properties, fields: meta, provenance: { source: { app: ctx.app ?? f.source?.app ?? "recast", ...(f.source?.url ? { url: f.source.url } : {}) }, capture: { method: "composition", adapter: "clump", at: new Date(ctx.now).toISOString().replace(/\.\d{3}Z$/, "Z") } } };
}

/** A captured place as a Location: the name and address the page gave (or its text as the name), with their evidence. */
function locationCandidate(f: Fragment, ctx: ComposeContext): Candidate {
  const clean = (v: string | undefined) => v?.replace(/\s+/g, " ").trim() || undefined;
  const name = clean(f.value?.name) ?? clean(f.value?.address ? undefined : f.text), address = clean(f.value?.address);
  const properties: Record<string, unknown> = {}; const meta: Record<string, FieldMeta> = {};
  const ev: Evidence[] = f.evidence.map((e): Evidence => ({ ...e, origin: "extracted", ...(f.source ? { source: f.source } : {}) }));
  for (const [k, v] of [["name", name], ["address", address]] as const) if (v) { properties[k] = v; meta[k] = { confidence: f.confidence, evidence: ev.length ? ev : [{ locator: { kind: "composition", value: `extracted:${k}` }, origin: "extracted" }] }; }
  return { type: "Location", properties, fields: meta, provenance: { source: { app: ctx.app ?? f.source?.app ?? "recast", ...(f.source?.url ? { url: f.source.url } : {}) }, capture: { method: "composition", adapter: "clump", at: new Date(ctx.now).toISOString().replace(/\.\d{3}Z$/, "Z") } } };
}

function message(c: Clump): MessageView {
  const fs = c.ingredients; const people = fs.filter((f) => f.kind === "person"); const texts = fs.filter((f) => f.kind === "text");
  const fields: MessageView["fields"] = {}; const missing: MessageView["missing"] = [];
  const typedTo = c.answers.to;
  if (typeof typedTo === "string" && typedTo) fields.to = { value: typedTo.split(/[,;\s]+/).filter(Boolean), origin: "user", fragments: [] };
  else {
    const emails = people.map((p) => p.value?.email).filter((e): e is string => !!e);
    if (emails.length === people.length) fields.to = { value: emails, origin: "extracted", fragments: people.map((p) => p.id) };
    else missing.push({ field: "to", reason: `${people.filter((p) => !p.value?.email).map(nameOf).join(", ")} has no email address on the page; type it` });
  }
  const typedBody = c.answers.snippet;
  fields.snippet = typeof typedBody === "string" && typedBody ? { value: typedBody, origin: "user", fragments: [] } : { value: texts.map((t) => t.text.replace(/\s+/g, " ").trim()).join("\n"), origin: "extracted", fragments: texts.map((t) => t.id) };
  if (typeof c.answers.subject === "string" && c.answers.subject) fields.subject = { value: c.answers.subject, origin: "user", fragments: [] };
  if (fields.to && (fields.to.value as string[]).some((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) { missing.push({ field: "to", reason: "that does not look like an email address" }); delete fields.to; }
  return { status: missing.length ? "incomplete" : "ready", fields, missing };
}

function messageCandidate(c: Clump, m: MessageView, ctx: ComposeContext): Candidate {
  const byId = new Map(c.ingredients.map((f) => [f.id, f]));
  const properties: Record<string, unknown> = {}; const meta: Record<string, FieldMeta> = {};
  for (const [name, f] of Object.entries(m.fields)) {
    properties[name] = f!.value;
    const ev: Evidence[] = f!.fragments.flatMap((id) => byId.get(id)!.evidence.map((e): Evidence => ({ ...e, origin: f!.origin, ...(byId.get(id)!.source ? { source: byId.get(id)!.source! } : {}) })));
    if (!ev.length) ev.push({ locator: { kind: "user", value: `user:${name}` }, origin: f!.origin });
    meta[name] = { confidence: f!.origin === "user" ? 1 : 0.9, evidence: ev };
  }
  const first = c.ingredients.find((f) => f.source)?.source;
  return { type: "Message", properties, fields: meta, provenance: { source: { app: ctx.app ?? first?.app ?? "recast", ...(first?.url ? { url: first.url } : {}) }, capture: { method: "composition", adapter: "clump", at: new Date(ctx.now).toISOString().replace(/\.\d{3}Z$/, "Z") } } };
}

export type { Missing };
