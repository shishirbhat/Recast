# Mission status: the brief (`docs/mission.md`) against the repository

Audit of 2026-10-29, after D52 and the desktop redesign (D38, D39). Surfaces: **H** try-it page (`apps/harness`), **X** extension, **D** desktop overlay, **L** desktop library. All three draw from the same shared pieces (`packages/overlay` glass and clay, `packages/interaction` state), so a module change reaches every surface. Evidence levels as in `docs/ENGINEERING_STATUS.md`; only Google Calendar creation is at R. Updated as gaps close (the "Closed" column names the decision).

| # | Feature | State at audit | Main gaps found | Closed |
|---|---|---|---|---|
| 1 | Capture stack | Capsules, inspect, take a piece out, dedupe, sources, real selections, all surfaces | No **reorder** or **replace** of pieces; whole-object **remove** only on the desktop (Delete key); cancel keeps the composition, no explicit discard; library "Remove" keeps the text on disk | D54: ↑/↓, Replace, Discard on every surface; Remove deletes; Clear all |
| 2 | Typed objects | Event, Task, Issue, Note, Person, Place (incl. "Place?" guesses), Document (URL, files); per-field origin and confidence; validation before acting | No **PhoneNumber** or **CodeReference** piece; only event, message and due fields are correctable before acting | D56: phone and code pieces, error + code → bug report; any piece correctable by Replace (D54) |
| 3 | Action palette (the wheel) | Kind-aware places, unavailable ones explained, keyboard on H and X, saved workflows | No **Copy structured data** action; no desktop keyboard path | Desktop keyboard path: D53; Copy as data: D55 |
| 4 | Multi-destination | Recipes: independent steps, uses shown, blocked steps explained, honest partial success, no blind resend | Two two-step recipes only (nothing yields event + task + note + draft); no step dependencies; a failed step cannot be retried in the run | |
| 5 | Receipts | Read-back "N of N fields match", Open in …, unknown reconciled, Undo only when reversible, on all surfaces | Library entries have no link to the result; the success receipt names no sources | |
| 6 | Recipes | Review screen, per-step approval, saved workflows (D44) | **Limitations and version not shown**; no export/import of definitions; no field-to-field map | |
| 7 | Context | URL, title, selection, source app, per-field sources, resolutions in the review | No capture time or source id on a piece; library keeps no corrections; storage location not stated on H, X, D | |
| 8 | Capture inbox | Remove one; restart recovery on X and D; library lists grabs | ~~No clear all~~ (D54); library cannot show or resume unplaced blobs; incomplete items not listed | |
| 9 | Keyboard flow | H and X full keyboard path (D48); desktop shortcuts configurable | **Desktop overlay has no keyboard entry; hovering a blob takes focus from the app underneath and never returns it** | D53: hover takes nothing; keys shortcut; D48 keys on the overlay; keys handed back |
| 10 | Presets | Saved workflows keep exact destinations | No default calendar or task app (the "which one?" choice is asked every time), no configurable default duration | |
| 11 | Destinations | Google Calendar, Gmail drafts, Google Tasks, Docs, Outlook Calendar and mail, Microsoft To Do, Todoist, Notion, GitHub, Linear, webhook, Google Maps; Apple Maps on the Mac desktop; abilities declared (D30, D45) | Slack absent (needs the owner's decision); Apple Maps not in the extension; Sheets bridge offered nowhere; one stale status row | |
| 12 | Playground | Time, place, person, combine, review, stand-in result with Undo, stand-ins labelled per review | No page-wide **demo** banner; **no path to the real app**; no guided first run | |
| — | Design (`docs/prompts/ui-polish-from-reel.md`, `design/brand/`) | Tokens, hold-to-confirm, reduced motion, keyboard | Brand mark used nowhere (desktop icon, tray, library header); no "PREVIEW · NOT CREATED YET" line; no labelled token pill; dark shadows are pure black | |

## Definition of done (§17)
Met at F: composition of real captured objects; palette by type and capability; three or more workflows end to end with honest outcomes; Calendar and Mail working; inspectable sources; receipts from read-back; recipes and saved workflows; tests passing. **Partial:** the demonstration (no banner, no path to the app). Only Google Calendar creation has run against the real provider (R).

## Needs the owner (kept for the end)
Real-account runs (REAL_TEST_PLAN B, C, E–P), trying the desktop app on the Mac, Slack's send model, an Apple Developer ID, a public download page, GitHub Pages for the showcase, the deck's figures, outsider test sessions.
