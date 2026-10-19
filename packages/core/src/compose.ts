// Composition: combine fragments the person picked up (a time, a place, a title) into one candidate object.
// Pure, like the rest of the core: the clock and time zone come in through `context`.
// Rules: never invent a value; say where every value came from; show conflicts instead of choosing; make defaults visible.
import type { Candidate, Evidence, FieldMeta } from "./types.js";

export type Origin = "extracted" | "inferred" | "default" | "user";
export type FragmentKind = "time" | "place" | "title" | "text";

/** One piece the person captured. `text` is exactly what was on screen; `value` is optional structure from extraction. */
export interface Fragment {
  id: string;
  kind: FragmentKind;
  text: string;
  value?: { name?: string; address?: string };
  confidence: number;
  evidence: Evidence[];
  source?: { app: string; url?: string; title?: string };
}

export type EventField = "title" | "start" | "end" | "allDay" | "timezone" | "location";

export interface ComposeContext {
  /** ISO instant used to read relative dates ("Friday", "tomorrow"). */
  now: string;
  /** The person's IANA time zone, used when the source names none. */
  timezone: string;
  /** Values the person typed or picked. They win, and are marked `user`. */
  answers?: Partial<Record<EventField, string | boolean>>;
  /** Resolve a conflict by picking the fragment to trust for that field. */
  choose?: Partial<Record<EventField, string>>;
  /** Shown as a visible default, never silently. Minutes. */
  defaultDurationMin?: number;
  app?: string;
}

export interface ComposedField {
  value: string | boolean;
  origin: Origin;
  fragments: string[];
  original?: string;
  confidence: number;
  note?: string;
}
export interface Missing { field: EventField; reason: string; suggestions?: string[] }
export interface Conflict { field: EventField; options: { value: string; fragmentId: string; original: string }[] }
export interface Composition {
  type: "Event";
  status: "ready" | "incomplete";
  fields: Partial<Record<EventField, ComposedField>>;
  missing: Missing[];
  conflicts: Conflict[];
  /** Everything Recast assumed (inferred or default), in words, for the preview. */
  assumptions: string[];
  fragments: Fragment[];
  /** Only when nothing is missing and nothing conflicts. Still needs validation, destination checks and permission before it can execute. */
  candidate: Candidate | null;
}

// ---------------------------------------------------------------- reading times ----------------------------------------------------------------

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
/** Abbreviations that are unambiguous enough to use. "IST" is read as India; the reading is shown in assumptions. */
const ZONES: Record<string, string> = { ist: "Asia/Kolkata", utc: "UTC", gmt: "UTC", z: "UTC", pst: "America/Los_Angeles", pdt: "America/Los_Angeles", est: "America/New_York", edt: "America/New_York", cst: "America/Chicago", cdt: "America/Chicago", cet: "Europe/Paris", cest: "Europe/Paris", bst: "Europe/London", jst: "Asia/Tokyo", sgt: "Asia/Singapore", aest: "Australia/Sydney" };
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const validDate = (y: number, m: number, d: number) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };

/** The calendar date of an instant in a time zone. */
function localDate(iso: string, tz: string): { y: number; m: number; d: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", weekday: "long" }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { y: Number(get("year")), m: Number(get("month")), d: Number(get("day")), weekday: WEEKDAYS.indexOf(get("weekday").toLowerCase()) };
}
const addDays = (y: number, m: number, d: number, n: number) => { const t = new Date(Date.UTC(y, m - 1, d + n)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };

export interface TimeReading {
  date?: string;            // YYYY-MM-DD
  dateOrigin?: "extracted" | "inferred";
  dateNote?: string;
  /** dd/mm versus mm/dd with both parts at most 12: two readings, the person must pick. */
  ambiguousDates?: string[];
  start?: string;           // HH:MM
  end?: string;             // HH:MM
  zone?: string;            // IANA
  zoneText?: string;
}

/** Reads dates, times, ranges, zones and relative days from one piece of text. Returns null when nothing time-like is present. */
export function readTime(text: string, ctx: Pick<ComposeContext, "now" | "timezone">): TimeReading | null {
  let s = ` ${text.toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ")} `;
  const r: TimeReading = {};
  let m: RegExpExecArray | null;
  /** Once a part is read, blank it out so its digits are not read again as something else. */
  const consume = (match: RegExpExecArray) => { s = s.slice(0, match.index) + " ".repeat(match[0].length) + s.slice(match.index + match[0].length); };

  // Zones first, so "+05:30" is never read as a time. An offset must not follow a digit ("22:00-01:00" is a range).
  if ((m = /\b(ist|utc|gmt|pst|pdt|est|edt|cst|cdt|cet|cest|bst|jst|sgt|aest)(?:([+-])(\d{2}):?(\d{2}))?\b/.exec(s))) {
    if (m[2]) { r.zone = `${m[2]}${m[3]}:${m[4]}`; r.zoneText = `${m[1]!.toUpperCase()}${r.zone}`; }
    else { r.zone = ZONES[m[1]!]; r.zoneText = m[1]!.toUpperCase(); }
    consume(m);
  } else if ((m = /(?<![\d:])([+-])(\d{2}):(\d{2})\b/.exec(s))) { r.zone = `${m[1]}${m[2]}:${m[3]}`; r.zoneText = r.zone; consume(m); }

  if ((m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s)) && validDate(+m[1]!, +m[2]!, +m[3]!)) { r.date = ymd(+m[1]!, +m[2]!, +m[3]!); r.dateOrigin = "extracted"; consume(m); }
  else if ((m = /\b(\d{1,2})(?:st|nd|rd|th)? (jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?,? (\d{4})\b/.exec(s)) && validDate(+m[3]!, MONTHS[m[2]!]!, +m[1]!)) { r.date = ymd(+m[3]!, MONTHS[m[2]!]!, +m[1]!); r.dateOrigin = "extracted"; consume(m); }
  else if ((m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})\b/.exec(s)) && validDate(+m[3]!, MONTHS[m[1]!]!, +m[2]!)) { r.date = ymd(+m[3]!, MONTHS[m[1]!]!, +m[2]!); r.dateOrigin = "extracted"; consume(m); }
  else if ((m = /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/.exec(s))) {
    const a = +m[1]!, b = +m[2]!, y = +m[3]!;
    const dm = validDate(y, b, a) ? ymd(y, b, a) : null, md = validDate(y, a, b) ? ymd(y, a, b) : null;
    if (dm && md && dm !== md) r.ambiguousDates = [dm, md];
    else if (dm ?? md) { r.date = (dm ?? md)!; r.dateOrigin = "extracted"; }
    consume(m);
  } else if (/\b\d{4}-\d{2}-\d{2}\b/.test(s)) {
    return null;   // looks like a date but is not a real one (2026-02-30): read nothing rather than guess
  } else {
    const today = localDate(ctx.now, ctx.timezone);
    let rel: { y: number; m: number; d: number } | null = null; let word = "";
    if ((m = /\b(today|tonight)\b/.exec(s))) { rel = today; word = m[1]!; consume(m); }
    else if ((m = /\btomorrow\b/.exec(s))) { rel = addDays(today.y, today.m, today.d, 1); word = "tomorrow"; consume(m); }
    else if ((m = /\b(next |this )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(s))) {
      const want = WEEKDAYS.indexOf(m[2]!); let delta = (want - today.weekday + 7) % 7;
      if (m[1] === "next " && delta === 0) delta = 7;   // otherwise "next Friday" is the coming Friday; the reading is shown so the person can correct it
      rel = addDays(today.y, today.m, today.d, delta); word = `${m[1] ?? ""}${m[2]!}`.trim(); consume(m);
    }
    if (rel) { r.date = ymd(rel.y, rel.m, rel.d); r.dateOrigin = "inferred"; r.dateNote = `"${word}" read as ${r.date}`; }
  }

  const clock = (h: number, min: number, ap?: string) => {
    if (ap) { if (h < 1 || h > 12) return null; if (ap.startsWith("p") && h !== 12) h += 12; if (ap.startsWith("a") && h === 12) h = 0; }
    return h <= 23 && min <= 59 ? `${pad(h)}:${pad(min)}` : null;
  };
  // Ranges first ("7-9 pm", "19:00-21:00", "7:30 pm to 9"). Every candidate is tried, not only the first.
  const range = /\b(\d{1,2})(?::(\d{2}))? ?(am|pm|a\.m\.|p\.m\.)? ?(?:-|to|until) ?(\d{1,2})(?::(\d{2}))? ?(am|pm|a\.m\.|p\.m\.)?(?![\d/.-])/g;
  while ((m = range.exec(s))) {
    if (!(m[2] || m[3] || m[5] || m[6])) continue;
    const ap2 = m[6]?.[0], ap1 = m[3]?.[0] ?? ap2;
    const a = clock(+m[1]!, +(m[2] ?? 0), ap1), b = clock(+m[4]!, +(m[5] ?? 0), ap2);
    if (a && b) { r.start = a; r.end = b; break; }
  }
  if (!r.start && (m = /\b(\d{1,2}):(\d{2}) ?(am|pm|a\.m\.|p\.m\.)?/.exec(s))) { const t = clock(+m[1]!, +m[2]!, m[3]?.[0]); if (t) r.start = t; }
  if (!r.start && (m = /\b(\d{1,2}) ?(am|pm|a\.m\.|p\.m\.)/.exec(s))) { const t = clock(+m[1]!, 0, m[2]![0]); if (t) r.start = t; }
  if (!r.start && /\bnoon\b/.test(s)) r.start = "12:00";

  if (!(r.date || r.start || r.ambiguousDates)) return null;
  if (r.zone && !r.start && !r.date) return null;
  return r;
}

// ---------------------------------------------------------------- composing ----------------------------------------------------------------

const REQUIRED: EventField[] = ["title", "start"];
/**
 * Confidence of a composed value. The person picked each piece themselves, so the classifier's guess about *which* element
 * matters no longer applies; what remains is how certain the reading of that text is. A verbatim value or an explicit date
 * is read with high confidence. An inference ("Friday" → a date) stays below the trust model's 0.75, so placing it asks for
 * a confirmation. A default is policy, shown in the preview and the assumptions.
 */
export const COMPOSED_CONFIDENCE = { extracted: 0.9, inferred: 0.6, default: 0.9, user: 1 } as const;

/** Combine fragments into an Event candidate. Deterministic for the same inputs and context. */
export function compose(fragments: Fragment[], ctx: ComposeContext): Composition {
  const fields: Composition["fields"] = {};
  const missing: Missing[] = []; const conflicts: Conflict[] = []; const assumptions: string[] = [];
  const answers = ctx.answers ?? {}; const choose = ctx.choose ?? {};

  // Sort fragments into what they can say.
  const times: { f: Fragment; r: TimeReading }[] = []; const places: Fragment[] = []; const titles: Fragment[] = [];
  for (const f of fragments) {
    if (f.kind === "place") { places.push(f); continue; }
    if (f.kind === "title") { titles.push(f); continue; }
    const r = readTime(f.text, ctx);
    if (r) times.push({ f, r });
    else if (f.kind === "text") titles.push(f);
    else missing.push({ field: "start", reason: `"${f.text}" was captured as a time but no date or time could be read from it` });
  }

  const set = (field: EventField, v: ComposedField) => { fields[field] = v; };
  const userField = (field: EventField) => {
    const a = answers[field]; if (a === undefined || a === "") return false;
    set(field, { value: a, origin: "user", fragments: [], confidence: 1 }); return true;
  };
  /** Distinct values from several fragments: one value merges, several are a conflict unless the person chose. */
  const pick = <T extends string>(field: EventField, opts: { value: T; f: Fragment; original: string }[]): { value: T; ids: string[]; original: string; conf: number } | null => {
    const distinct = [...new Map(opts.map((o) => [o.value.toLowerCase(), o])).values()];
    if (!distinct.length) return null;
    const chosen = choose[field] ? opts.find((o) => o.f.id === choose[field]) : undefined;
    if (distinct.length > 1 && !chosen) { conflicts.push({ field, options: distinct.map((o) => ({ value: o.value, fragmentId: o.f.id, original: o.original })) }); return null; }
    const o = chosen ?? distinct[0]!;
    const same = opts.filter((x) => x.value.toLowerCase() === o.value.toLowerCase());
    return { value: o.value, ids: same.map((x) => x.f.id), original: o.original, conf: COMPOSED_CONFIDENCE.extracted };
  };

  // Title
  if (!userField("title")) {
    const t = pick("title", titles.map((f) => ({ value: f.text.replace(/\s+/g, " ").trim(), f, original: f.text })).filter((o) => o.value));
    if (t) set("title", { value: t.value, origin: "extracted", fragments: t.ids, original: t.original, confidence: t.conf });
    else if (!conflicts.some((c) => c.field === "title")) {
      const place = places[0]?.value?.name ?? places[0]?.text;
      missing.push({ field: "title", reason: "nothing captured reads as a title", ...(place ? { suggestions: [`Meet at ${place}`] } : {}) });
    }
  }

  // Location
  if (!userField("location")) {
    const l = pick("location", places.map((f) => {
      const v = f.value?.name && f.value?.address ? `${f.value.name}, ${f.value.address}` : f.value?.name ?? f.value?.address ?? f.text;
      return { value: v.replace(/\s+/g, " ").trim(), f, original: f.text };
    }));
    if (l) set("location", { value: l.value, origin: "extracted", fragments: l.ids, original: l.original, confidence: l.conf });
  }

  // Date and time: a date-only fragment and a time-only fragment combine; two different dates, or two different times, conflict.
  const ambiguous = times.find((t) => t.r.ambiguousDates);
  const dates = times.filter((t) => t.r.date).map((t) => ({ value: t.r.date!, f: t.f, original: t.f.text, r: t.r }));
  const starts = times.filter((t) => t.r.start).map((t) => ({ value: t.r.start!, f: t.f, original: t.f.text, r: t.r }));
  const zones = times.filter((t) => t.r.zone).map((t) => ({ value: t.r.zone!, f: t.f, original: t.r.zoneText!, r: t.r }));
  const userStart = userField("start");
  if (!userStart) {
    if (ambiguous && !dates.length) missing.push({ field: "start", reason: `"${ambiguous.f.text}" could be ${ambiguous.r.ambiguousDates!.join(" or ")}`, suggestions: ambiguous.r.ambiguousDates! });
    const d = pick("start", dates); const t = starts.length ? pick("start", starts) : null;
    if (d) {
      const dr = dates.find((x) => x.f.id === d.ids[0])!.r;
      const inferred = dr.dateOrigin === "inferred";
      if (inferred && dr.dateNote) assumptions.push(dr.dateNote);
      if (t) {
        set("start", { value: `${d.value}T${t.value}`, origin: inferred ? "inferred" : "extracted", fragments: [...new Set([...d.ids, ...t.ids])], original: [...new Set([d.original, t.original])].join(" + "), confidence: inferred ? COMPOSED_CONFIDENCE.inferred : COMPOSED_CONFIDENCE.extracted, ...(inferred ? { note: dr.dateNote! } : {}) });
        const endReading = starts.find((x) => x.f.id === t.ids[0])!.r;
        if (endReading.end && !answers.end) {
          const crossesMidnight = endReading.end <= endReading.start!;
          const endDate = crossesMidnight ? (() => { const [y, m, dd] = d.value.split("-").map(Number) as [number, number, number]; const n = addDays(y, m, dd, 1); return ymd(n.y, n.m, n.d); })() : d.value;
          set("end", { value: `${endDate}T${endReading.end}`, origin: "extracted", fragments: t.ids, original: t.original, confidence: t.conf });
        }
      } else if (!conflicts.some((c) => c.field === "start")) {
        set("start", { value: d.value, origin: inferred ? "inferred" : "extracted", fragments: d.ids, original: d.original, confidence: inferred ? COMPOSED_CONFIDENCE.inferred : COMPOSED_CONFIDENCE.extracted, ...(inferred ? { note: dr.dateNote! } : {}) });
        if (answers.allDay === undefined) { set("allDay", { value: true, origin: "inferred", fragments: d.ids, confidence: COMPOSED_CONFIDENCE.inferred, note: "no time was captured, so this is an all-day event" }); assumptions.push("All day, because no time was captured"); }
      }
    } else if (conflicts.some((c) => c.field === "start")) {
      // two different dates: the conflict says it all; do not also report the date as missing
    } else if (t && !ambiguous) missing.push({ field: "start", reason: `a time (${t.value}) was captured but no date` });
    else if (!ambiguous && !conflicts.some((c) => c.field === "start") && !missing.some((x) => x.field === "start")) missing.push({ field: "start", reason: "no date or time was captured" });
  }
  userField("allDay");

  // Time zone: from the source if it names one, otherwise the person's own, shown as a default.
  if (!userField("timezone")) {
    const z = pick("timezone", zones);
    if (z) {
      set("timezone", { value: z.value, origin: "extracted", fragments: z.ids, original: z.original, confidence: z.conf });
      if (/^[A-Z]{2,4}$/.test(z.original)) assumptions.push(`"${z.original}" read as ${z.value}`);
    } else if (!conflicts.some((c) => c.field === "timezone") && fields.start && fields.allDay?.value !== true) {
      set("timezone", { value: ctx.timezone, origin: "default", fragments: [], confidence: COMPOSED_CONFIDENCE.default, note: "your time zone; the source named none" });
      assumptions.push(`Time zone ${ctx.timezone} (yours; the source named none)`);
    }
  }

  // End: from the source, else a visible default duration.
  if (!userField("end") && !fields.end && fields.start && fields.allDay?.value !== true && typeof fields.start.value === "string" && fields.start.value.includes("T")) {
    const mins = ctx.defaultDurationMin ?? 60;
    const [date, hm] = fields.start.value.split("T") as [string, string];
    const [y, mo, d] = date.split("-").map(Number) as [number, number, number]; const [h, mi] = hm.split(":").map(Number) as [number, number];
    const t = new Date(Date.UTC(y, mo - 1, d, h, mi + mins));
    set("end", { value: `${ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`, origin: "default", fragments: [], confidence: COMPOSED_CONFIDENCE.default, note: `${mins} minutes, a default` });
    assumptions.push(`Ends after ${mins} minutes (a default; change it if needed)`);
  }

  // Validate what the person typed, without guessing a fix.
  const iso = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;
  for (const f of ["start", "end"] as const) if (fields[f]?.origin === "user" && !iso.test(String(fields[f]!.value))) { delete fields[f]; missing.push({ field: f, reason: `use the form 2026-11-14 or 2026-11-14T19:30` }); }
  if (fields.start && fields.end && String(fields.end.value) < String(fields.start.value)) { missing.push({ field: "end", reason: "the end is before the start" }); delete fields.end; }

  for (const f of REQUIRED) if (!fields[f] && !missing.some((x) => x.field === f) && !conflicts.some((c) => c.field === f)) missing.push({ field: f, reason: "required" });
  const status = missing.length || conflicts.length ? "incomplete" : "ready";
  return { type: "Event", status, fields, missing, conflicts, assumptions, fragments, candidate: status === "ready" ? toCandidate(fields, fragments, ctx) : null };
}

/** Field values with evidence that says where each came from: the fragments' own evidence for extracted values, a composition locator otherwise. */
function toCandidate(fields: Composition["fields"], fragments: Fragment[], ctx: ComposeContext): Candidate {
  const byId = new Map(fragments.map((f) => [f.id, f]));
  const properties: Record<string, unknown> = {}; const meta: Record<string, FieldMeta> = {};
  for (const [name, f] of Object.entries(fields) as [EventField, ComposedField][]) {
    properties[name] = f.value;
    const ev: Evidence[] = f.fragments.flatMap((id) => byId.get(id)!.evidence.map((e): Evidence => ({
      ...e, origin: f.origin === "user" ? "user" : f.origin, ...(byId.get(id)!.source ? { source: byId.get(id)!.source! } : {}), ...(f.original ? { original: f.original.slice(0, 500) } : {}),
    })));
    if (!ev.length) ev.push({ locator: { kind: f.origin === "user" ? "user" : "composition", value: `${f.origin}:${name}` }, origin: f.origin, ...(f.note ? { excerpt: f.note.slice(0, 500) } : {}) });
    meta[name] = { confidence: f.confidence, evidence: ev };
  }
  const first = fragments.find((f) => f.source)?.source;
  return { type: "Event", properties, fields: meta, provenance: { source: { app: ctx.app ?? first?.app ?? "recast", ...(first?.url ? { url: first.url } : {}) }, capture: { method: "composition", adapter: "compose", at: new Date(ctx.now).toISOString().replace(/\.\d{3}Z$/, "Z") } } };
}
