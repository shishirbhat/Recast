# Personal saved workflows

A saved workflow is something you did once in Recast, kept under a name so you can do it again with new information. It is built on the recipe engine (D35): a saved workflow *is* a recipe that you defined. It runs through the same review, the same single approval, the same per-step receipts, read-back and Undo. Decision: D44.

## What you see
- **Saving.** "Save as workflow" sits under a review, under a recipe's plan, and on a receipt.
  - It is offered only when what is on screen can be repeated safely (see "What cannot be saved").
  - Pressing it asks for a name, inline. Nothing is saved until you press Save or Enter.
  - An empty name, a name over 60 characters, or a name already in use (yours or one of Recast's recipes) is refused with the reason, and the field stays open.
  - Once saved, the line says `Saved "<name>". Run it again from the module with new information.` Saving never places, approves or changes anything.
- **Running.** Your workflows appear under "Your workflows", below Recast's own recipes, when they fit the object in front of you (an event workflow for an event).
  - A workflow that cannot run here is shown disabled with the reason: "Google Calendar is not connected here", or "this workflow takes an event; this is a note".
  - Opening one shows the plan: each step, where it goes, what it will use from *this* object. Nothing is written.
  - Missing information (a title, a date) is asked in the same review. Conflicting information (two times from two pages) is shown with its sources, and you pick one. Until then the step is blocked with the reason, and Run is not offered for it.
  - Run asks for the same approval the step needs (confirm, or hold). Each step reports its own result, and destinations that can be read back are read back ("Read back from Google Calendar: 4 of 4 fields match", with a link). A lost answer is "No answer": it is never sent again.
- **Managing.** "Manage" opens the list of your workflows.
  - **Rename** edits the name in place (the same name rules).
  - **Delete** asks once more ("Nothing it already placed is changed").
  - A stored workflow that cannot be used is listed with the reason ("it was saved by a different version of Recast", "it goes to evernote.notes, which Recast cannot place in any more"). It can be deleted, never run.
- There is no separate dashboard, no sharing, no marketplace and no sync.

## What is kept
A workflow is a definition. Exactly these fields, and nothing else:

| Field | Example |
|---|---|
| `id` | `wf_` + a hash of the name, steps and save time |
| `version` | `1` |
| `name` | the name you typed |
| `description` | built from the kind and the apps only: `An event → Google Calendar` |
| `origin` | `saved` |
| `needs` | the kind of object it takes: `Event`, `Message`, `Note`… |
| `steps` | per step: `id` (`event`, `invite`, `prepare`, or `place`), a label from the recipe or the destination (never from content), the kind of place, whether Recast words part of it, the exact destination (`google-calendar.calendar`) and its app name |
| `limitations` | `[]` |

No captured words, people, email addresses, links, pages, times, object ids, accounts or tokens. A test saves a workflow from "Dinner with Maya at Dakshin, Friday 7:30 PM, maya@example.com" and checks that none of it is in what is stored.

**Where it is stored** (the same places each surface already keeps your settings):
- Browser extension: `chrome.storage.local`, key `workflows` (next to `confirmLevel`). Page content still lives only in session storage.
- Desktop app: `workflows.json` in the app's data folder, mode 0600. Only the overlay page may write it, and the list is capped at 50 entries.
- Try-it page: the page's `localStorage` (`recast.workflows`). If the browser refuses storage, the page says so, and the workflow lasts until the page is closed.

**Reading it back:** every entry is checked as it is read (`checkWorkflow`).
- An unknown field, an unknown step, a destination this build has no bridge for, another version, or a bad name is refused with the reason.
- A refused entry is kept as it was (a newer Recast may read it) until you delete it.

## How a step finds its destination
A recipe step picks the first connected destination of its kind. A saved step names its **exact** destination. If you saved "→ Google Calendar" and only Outlook is connected, the step is blocked ("Google Calendar is not connected here"). It never goes to a look-alike.

## What cannot be saved (Save is not offered)
- Changing one particular existing item (an open event's editor, a sheet row): it only means something for that item.
- A placement onto a chosen calendar slot: the slot belongs to that placement.
- Anything that is not open in a review, a recipe plan or a receipt.
- A run of a workflow you already saved (it already is one).

## Evidence
| Claim | Test | Level |
|---|---|---|
| save only on request; name rules; no content stored; exact fields; run steps saved with exact destinations | `packages/interaction/test/workflows.test.ts` | U |
| load and check: outdated, unknown destination, extra field, unknown step, not an object | same | U |
| rename, delete (unusable entries too), store effect carries unusable entries unchanged | same | U |
| a run on new information: no write in review, approval required, commit, read-back, stale read-back ignored, Undo | same | U |
| missing information finished in the review; conflicting information settled before it runs | same | U |
| not connected → blocked with the app's name, never a look-alike; another kind of object does not fit | same | U |
| cancel writes nothing; failure reported; lost answer unknown, never resent, and checked before placing again | same | U |
| cannot delete while it runs; settings still apply during a run | same | U |
| the whole flow in Chromium: save, reload, run on new pieces, read back, rename (refused duplicate), delete with confirmation | `apps/harness/test/clay.test.ts` ("a personal saved workflow") | H |
| unusable stored entries listed with reasons, deletable, never offered to run | same | H |
| extension: read from `chrome.storage.local` on a new session, checked; delete stored; nothing else in local storage | `apps/extension/test/clay.test.ts` | H |
| desktop: private file read and checked; runs against the Google stand-in with read-back; delete stored; file 0600; only the overlay may write it | `apps/desktop/test/app.test.ts` | F |

## Remaining limitations
- **No real provider run.** Every run above uses stand-ins (in-page destinations, or the fake Google in the desktop app). A saved workflow uses the same bridges as any placement, so REAL_TEST_PLAN sections A–M cover the writes. A real run of a saved workflow itself has not been made.
- **No parameters.** "Send it to whoever is in it" works because the invite step reads the people from the object. "Always invite Maya" cannot be saved, because that would mean keeping a person.
- **One workflow is one list of steps.** There are no conditions and no branching.
- **The extension keeps workflows per browser profile; the desktop per computer.** There is no sync between them, on purpose.
- **Re-running a saved workflow plans the destination's operation again** (`propose`, first ready route). If a destination ever offers two routes for the same kind of object, the first ready one is used, as in a recipe.
