# 22. Reliability: the trigger, the object lifecycle, and recovery

**Scope:** the Control trigger, the clump state machine (`packages/interaction/src/{double-tap,clump-machine}.ts`), its two hosts (the clay page `apps/harness/src/clay.ts` and the extension `apps/extension/src/{background,clay-content}.ts`), and the glass module's states for them.

**Not in scope, and not claimed:** real providers, a native desktop app, people.

## Starting state (audited 2026-10-20)
- **Code:**
  - Branch `claude/clever-heisenberg-s3taqj`, clean, level with origin at `c7a6d79`.
  - GitHub CI on `c7a6d79`: **success** (full typecheck and test suite).
- **The local full run at the start is not usable as a baseline:** it overlapped with the first edits to the state machine.
  - The extension package was re-run on the untouched commit with a fresh build: 22 of 22.
  - CI is the clean baseline.

## Failure modes found
| # | Where | What could happen | Evidence |
|---|---|---|---|
| 1 | machine | Undo stayed in `succeeded`: a second click sent a second reversal; Done during it retired the object, and the late "undone" was refused, so nobody was told the entry was removed | reading the reducer; now `lifecycle.test.ts` "Undo is one step" |
| 2 | both hosts | A failed undo threw inside `perform()` with no catch: no message, Undo still offered | reading; now the clay page "a refused undo says so…" |
| 3 | machine | Effect results carried no operation id: a late answer could be taken for the current operation | reading; now "an answer for another operation is ignored" |
| 4 | extension | The destination tab closing during a write left the state in `executing` forever (nothing legal but an answer that could never come; Recast could not even be turned off) | reading `forget()`; now the extension "…a destination tab closing mid-write…" |
| 5 | machine and hosts | "Check" with the destination gone sent a reconcile to nowhere and waited forever | reading; now refused with "…is not open here" |
| 6 | machine | Closing an unknown-outcome card, then placing again, sent a second blind write | reading; now "Check later" plus the forced check |
| 7 | machine | **Found by the new browser test:** that doubt was keyed by the per-tab destination id, so a calendar reopened in a new tab was treated as new and could be written twice | extension test step 3 failed before the fix |
| 8 | trigger | A missed keyup (released in another window) kept the old press start, so the next clean double press did nothing | `double-tap.test.ts` "a keyup that never arrived…" failed before the fix |
| 9 | UI | Refusals showed raw machine text ("cannot capture while executing") | reading; now each busy phase says why in words |
| 10 | UI | An object with an unknown outcome looked like any other on the desk | clay page "the answer is lost…" asserts its label now |
| 11 | UI | The "No answer" card had no way to close it; with the destination gone, Check could never succeed | "Check later" added |

## Trigger rules (deterministic)
| Rule | Value |
|---|---|
| A tap | Control pressed and released alone, held ≤ 300 ms (300 counts, 301 does not) |
| Twice | the second release ≤ 400 ms after the first release (400 counts, 401 does not) |
| Off → on | twice |
| On → off | one tap, at once. The detector then resets, so a habitual second press does not turn it back on |
| Never a tap | Control with any other key (Ctrl+C, Ctrl+V, AltGr, which Windows sends as Control+Alt), Ctrl+click, auto-repeat, a press held over 300 ms, a keyup with no keydown |
| Never stuck | window blur and tab switch (`visibilitychange`) forget a half-press; a fresh keydown restarts the press even if the last keyup was lost |
| While busy | a press while writing, undoing, unsure of an outcome, or fusing is **discarded**, not deferred. Recast stays on and says why ("Waiting for Calendar to answer. Recast stays on until it does"). Deferral was rejected because a delayed "off" arriving later surprises more than a refusal now |

Platform notes:
- Timing tests run on recorded event sequences, and Chromium runs these key events through the real page in both hosts. Real macOS and Windows keyboards have not been checked by a person.
- The macOS Dictation option "Press Control twice", for those who chose it, and screen readers going quiet on Control, are listed in `docs/21-glass-module.md`.

## Lifecycle: phases and transitions
`reduceClump` is the only place state changes. Every result of an effect names its operation (`opId`; `committed` carries it in its receipt). An answer for any other operation is ignored as stale and never shown.

| From | Event | To | Notes |
|---|---|---|---|
| off (idle, `armed:false`) | Control twice / button | idle (on), or `composed` if a composition is kept | capture and pick-up are refused while off |
| idle (on) | capture / pick-up / drop on object | carrying → approaching → `merging` → `composed` | the module opens only after a merge settles |
| `composed` | Choose where it goes | `choosing` | selecting a row writes nothing |
| `choosing` | Open (fits, connected) | `previewing` | an unfit pick is refused, and the wheel stays open |
| `choosing` | Open (unknown outcome for this object at this destination) | `unknown` (the earlier operation) | **no second write** |
| `previewing` | Confirm (consent checked by the core) | `executing` + commit effect | |
| `executing` | committed (this opId) | `succeeded` | only on the destination's receipt |
| `executing` | commitFailed (this opId) | `failed` | nothing was written; the object stays |
| `executing` | outcomeUnknown (this opId), or the destination's tab closed | `unknown` | |
| `executing` | anything else | refused, with the reason | Escape, Control, Done, new pick-ups |
| `unknown` | Check (destination open) | (reconcile effect) → `succeeded` if found, `failed` if not ("safe to place again") | never resends |
| `unknown` | Check (destination not open) | refused: "… is not open here. Open it, then check" | |
| `unknown` | Check later | idle; the doubt is remembered by object **and destination contract** | the desk marks the object "Not sure it reached …" |
| `succeeded` | Undo (reversible, destination open) | `undoing` + undo effect | |
| `succeeded` | Done, Escape, off, a new pick-up | idle (or carrying); **the placed object retires** | only that object, and only from `succeeded` |
| `succeeded` | picking the placed object itself up | carrying it | the person chose to keep it |
| `undoing` | undone (this opId) | idle; the object stays | |
| `undoing` | undoFailed (this opId), or the destination's tab closed | `succeeded` with "Could not undo: …. It is still in …" | Undo can be tried again |
| `undoing` | anything else | refused, with the reason | no second Undo, no Done, no Escape, no off |
| any armed phase except `executing`, `undoing`, `unknown`, `merging` | Control once / Escape at idle / × | off | a review closes unwritten; the composition is kept |

## Invariants and where they are tested
| # | Invariant | Tests |
|---|---|---|
| 1 | Not retired before a confirmed placement | lifecycle "failure before anything was created…"; module "a placed object leaves the desk" |
| 2 | Kept for Undo while the receipt is open | module "it stays while the receipt shows…"; clay page "once placed and the receipt is closed…" |
| 3 | Closing the receipt retires only that object | lifecycle "turning Recast off with the receipt open…" |
| 4 | A new pick-up is never retired or changed by an old receipt closing | lifecycle "picking up a new piece while the receipt shows…"; "ids are never reused" |
| 5 | Undo restores only after a confirmed reversal | lifecycle "Undo"; clay page "Undo is one step…" |
| 6 | A failed undo is never reported as done | lifecycle "a failed undo…"; clay page (refused delete) |
| 7 | Unknown is neither success nor failure | lifecycle "an unknown outcome is never a blind retry"; clay page "the answer is lost…"; extension step 2 |
| 8 | No duplicate writes on retry | the forced check (lifecycle, clay page, extension step 3). Operation ids are content-derived, so the stand-ins and the Google Calendar bridge treat a repeat as the same write. Gmail drafts have no provider key: there the forced check is the only guard |
| 9 | Off keeps the composition | lifecycle "turning off with an unplaced composition keeps it…"; extension |
| 10 | Restarts and reloads neither resurrect nor drop | extension step 1 (a real worker stop) and step 4 (a reload after retirement); "the doubt survives being stored as JSON" |

## Recovery cases
| Case | Behaviour | Evidence |
|---|---|---|
| Written, but the answer is lost | `unknown`; Check finds it → `succeeded`, one entry | clay page (silent stand-in) |
| Refused before writing | `failed`, with the provider's reason; nothing written; the object stays | clay page (refuse) |
| Created, confirmation lost, card closed | doubt remembered; choosing again → Check, not a write | clay page, extension |
| Closing the receipt while a write is pending | impossible: there is no receipt until the answer; Escape, Control and Done are refused with the reason | clay page (gated stand-in) |
| Worker stopped | a fresh worker reloads from `storage.session`; nothing lost; commands work | extension step 1 (stopped with DevTools `Target.closeTarget`, checked by an in-memory marker) |
| Destination tab closes mid-write | `unknown`, "Calendar closed before it answered"; Check is refused until a calendar is open; then it asks that calendar | extension step 2 |
| Tab reload | the layer goes (activeTab); invoking again restores it with the session state; a retired object stays retired | extension step 4 |
| Destination disconnected | the wheel says "… is not connected here"; Check and Undo are refused with "… is not open here" | lifecycle, extension |
| A command repeated after a delay | the same command logic (`commandEvents`); no second module | earlier tests, unchanged |
| A stale callback | ignored (`stale`), not shown | lifecycle "every answer names its operation" |

## Evidence levels for this work
| Level | What |
|---|---|
| Unit | trigger (14 tests), state machine and lifecycle (interaction 107 tests in all) |
| Real browser, simulated tabs, in-page stand-in | the clay page in Chromium: 26 tests, including the 4 recovery cases above (`apps/harness/test/clay.test.ts`) |
| Real browser, real tabs and extension worker, stand-in destination pages | the MV3 extension in Chromium: 4 cross-tab tests, including a real worker stop, a tab closing mid-write and a reload (`apps/extension/test/clay.test.ts`) |
| Real provider | **none**. No Google or Notion account is connected (#22) |
| Real people | **none** (#24) |
