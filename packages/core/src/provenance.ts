// Where every value in a composition came from, in one record: the field, its value, how Recast got it (from a source,
// inferred, a default, typed by the person), which sources say so, and what the person overruled to get it. This is the
// history a placement keeps, so "why does the event say 4 PM?" always has an answer.
import type { Composition, ConflictOption, EventField, Origin, Source } from "./compose.js";
import type { Verification } from "./types.js";

export interface FieldProvenance {
  field: EventField; value: string | boolean; origin: Origin;
  /** The sources that gave this value (more than one when they agreed). Empty for defaults and typed answers. */
  sources: Source[];
  /** What the person chose this over, when sources disagreed. */
  overruled: ConflictOption[];
}
export interface ProvenanceRecord { fields: FieldProvenance[]; sources: Source[]; verification?: Verification }

const key = (s: Source) => `${s.app}\n${s.url ?? ""}\n${s.title ?? ""}`;

export function provenanceOf(c: Composition): ProvenanceRecord {
  const byId = new Map(c.fragments.map((f) => [f.id, f]));
  const fields = (Object.entries(c.fields) as [EventField, NonNullable<Composition["fields"][EventField]>][]).map(([field, f]): FieldProvenance => {
    const sources = [...new Map(f.fragments.map((id) => byId.get(id)?.source).filter((s): s is Source => !!s).map((s) => [key(s), s])).values()];
    return { field, value: f.value, origin: f.origin, sources, overruled: c.resolutions.find((r) => r.field === field)?.overruled ?? [] };
  });
  const sources = [...new Map(c.fragments.map((f) => f.source).filter((s): s is Source => !!s).map((s) => [key(s), s])).values()];
  return { fields, sources };
}

/** A source in a few words, for a review line: its title, else its app. */
export const sourceName = (s?: Source) => (s ? (s.title ?? s.app) : "you");
