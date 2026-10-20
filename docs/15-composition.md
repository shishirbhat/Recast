# 15. Composition: combining pieces into one object

**Level reached:** U (core 17 composition tests, engine 12 capsule tests, extract-web 4 piece tests) and H (Chromium harness: 7 tests on `apps/harness/src/compose.html`, including axe in light and dark). Not on Windows, not against a real calendar, not with people.

## What it does
Point at a visible time and lift it into a capsule. With the lift key held, click a place and a title to add them. Carry the capsule to a calendar and preview the event it would create. If something is missing or conflicting, a small card asks only for that. The event is then placed through the normal consent path and can be undone.

Screenshots: `docs/images/composition/` (collecting, preview with a missing title, completion card, placed).

## Pieces of the model
- `@recast/core` `compose(fragments, context)` (`packages/core/src/compose.ts`) returns:
  - field values, each with an **origin**: `extracted` (read from what the person picked), `inferred` (for example "Friday" → 2026-10-23), `default` (time zone, a 60-minute duration) or `user` (typed or chosen);
  - the original text, the contributing pieces, and a confidence;
  - `missing` fields with reasons and suggestions that are **never filled in automatically**;
  - `conflicts` (two different dates or places, never silently chosen);
  - `assumptions` in words;
  - a `Candidate` only when nothing is missing or conflicting. A candidate is still not an executable action: validation, destination compatibility, consent and permission come after.
- The time reader (`readTime`) handles:
  - ISO and written dates; dd/mm versus mm/dd, which is ambiguous when both parts are 12 or less, so the person is asked;
  - times, ranges, ranges that cross midnight, and noon;
  - named zones and offsets;
  - today, tomorrow and weekdays, read against the person's own date in their own time zone.

  Impossible dates read as nothing.
- Origins travel inside the object: `Evidence.origin`, `Evidence.source` (which page or app the piece came from) and `Evidence.original` were added to the schema (additive). `capture.method: "composition"` marks composed objects.
- New relation `event-calendar-entry` (Event → Calendar, low risk, reversible, requires title and start) and a `Calendar` target kind, so a composed event has somewhere to go.

## The gesture (engine, `packages/interaction`)
- A time or a place can start a capsule; a title can only join one. On a contacts page, an unsure heading must not become liftable as a "title".
- Releasing over nothing keeps the capsule. A single object released over nothing is still cancelled.
- A destination that accepts Events offers its chip while the capsule is incomplete, marked with what it needs. Its preview lists every value with its origin and shows missing values as "needed".
- Placing an incomplete capsule opens **completing**. The questions are fixed when it opens, so a field doesn't vanish while being typed into. Enter continues, Escape cancels, and nothing is written until it is complete. Then the normal consent path applies.
- Carrying a whole object that is also a piece (an address) and adding a time turns the carry into a capsule.
- Keyboard: Space adds the focused piece, Enter finishes, Tab chooses a destination, Enter places.

## Pieces from the screen (`packages/extract-web` `classifyPiece`)
Read from the element the person points at (and one parent), never the whole page:
- a time if the core's time reader finds one;
- a place if it has an address, or a confident name outside a heading;
- a short heading as a title.

The harness keeps a whole-object reading alongside a piece only if it covers the pointed-at element. Found by testing: a time in a chat message had been read as an "event" titled after the page heading.

## Confidence and consent (decision D17)
Once the person has picked a piece, the classifier's guess about *which element* no longer applies. A verbatim value or an explicit date is read at 0.9, which places on release for a low-risk, reversible entry after the preview: no redundant confirmation. An inference stays at 0.6, so placing an event dated from "Friday" asks for a confirmation. User answers are 1.0.

## Not done
- Duplicate placement, calendar choice and invitations belong to the real Calendar bridge (task P3). The harness calendar is an in-page list.
- Durations other than the default come only from a captured range or a typed end. There is no "for 2 hours" reading yet.
- Pieces are offered only where the host enumerates them for the keyboard (`data-scan` on the harness page). The browser extension does not include the overlay yet.
- Visual design is the interim system. The card and the capsule are functional, not final (`docs/design-direction.md`).
