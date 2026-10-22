# 20. Clay: pressing pieces into one object, carrying it across tabs, placing it

**Level reached:** U (core 11 clump tests, state machine 11), H (Chromium: harness clay page 13 tests including touch, keyboard and reduced motion; the real MV3 extension in Chromium 2 cross-tab tests), F (every placement goes to an in-page stand-in calendar or mail-drafts list). **Not R** (no real calendar), **not P** (no person has used it), **not native** (no Windows shell).

Try it: the harness page `apps/harness/dist/clay.html` (`pnpm --filter @recast/harness build`), or the published artifact built from the same source (`apps/harness/dist/clay-artifact.html`). Screenshots: `docs/images/clay/` (approach, fusing, one object, each in light and dark; a phone frame).

## The acceptance journey and where it is proven
> Pick up "Maya Rao" from one browser tab, switch to a restaurant's page, press Maya into the restaurant's name, watch the two blobs fuse into one object, add a time, carry the result to the calendar, inspect the event, and place it safely through Recast's existing trust model.

| Step | Harness page (simulated tabs) | Real extension (real Chromium tabs) |
|---|---|---|
| Pick up Maya in one tab | mouse, keyboard (Space), touch (press and hold 320 ms) | Alt + press on the name in `profile.html` |
| Switch tabs while carrying | hover a tab for 450 ms (spring-loaded), or arrow keys | a real second tab; the object appears "In hand" in its tray |
| Press into the restaurant | drop on "Dakshin" | drag from the tray onto "Dakshin" in `restaurant.html` |
| Fusion animation | yes (goo filter, springs; reduced motion: a pulse) | yes, same renderer |
| Close the source tab | n/a | nothing is lost: the object never belonged to a tab |
| Add a time | drop the time on the object | Alt-drag the time on the page onto the object in the tray |
| Carry to calendar, inspect | slot opens a review: every field with its origin | the calendar tab's slot opens the review in that tab |
| Place through the trust model | `propose` → `plan` → consent → `commit` with receipt; undo | same; the commit runs in the calendar tab, undo removes the entry |

Tests: `apps/harness/test/clay.test.ts` ("pick up, switch tabs while carrying, press in, add the time, carry to a slot, review and place" and 12 others) and `apps/extension/test/clay.test.ts`.

## Audit: what existed and what was reused
- **Reused unchanged:** the trust model (`propose`, `plan`, `assessRisk`, `checkConsent`, `commit`, `undo`, `InMemoryEventLog`, `OutcomeUnknownError` and reconciliation in `packages/core`); `readTime`; `classifyElement` and `classifyPiece` (`packages/extract-web`); capability contracts; the design tokens.
- **Extended:** `compose` (person and thing fragments, a description such as "With Maya Rao", a suggested title "Meet Maya at Dakshin"); the grammar (a `Drafts` target and the `message-draft-entry` relation, low risk and reversible). Regenerated with `pnpm gen`.
- **New:** clumps (`packages/core/src/clump.ts`), the clump state machine (`packages/interaction/src/clump-machine.ts`), the clay renderer (`packages/overlay/src/clay.ts`), the harness page (`apps/harness/src/clay.*`), and the extension's worker and clay layer (`apps/extension/src/{background,clay-content,clay-messages}.ts`).
- **Not replaced:** the earlier single-object machine and the capsule (`docs/08`, `docs/15`) still work and are still tested. Clay sits beside them; it does not yet replace the capsule.

## The model: a clump
A clump has a stable id, an ordered list of ingredients (fragments, each with its source and evidence), the person's answers and the person's choices. Everything else is computed by `viewClump`:
- its **type**, recalculated by rules: Fragment, Event, Message or People. Maya + a restaurant is a plan to meet with no time yet; adding a time makes it a proposed Event; Maya + a sentence is a Message.
- `missing` fields with reasons (never filled in silently), `conflicts` (two times stay two until the person chooses), `assumptions` in words, and `placeableAs`.
- a `candidate` only when nothing is missing or in conflict. A candidate still goes through `propose`, consent and `commit`. Composing never executes anything.

Rules (`canMerge`, `mergeClumps`):
- merging is recursive (a clump can be pressed into a clump) and keeps the target's id and ingredient order;
- a change of kind that changes meaning (a Message gaining a time becomes an Event) needs the person to confirm;
- incompatible results are refused with a reason, and both objects stay whole (a gift card into a plan; two bare sentences; an object into itself);
- `removeIngredient` gives the ingredient back as its own object and recalculates the rest. A choice about a removed ingredient goes with it.

## The state machine
`reduceClump(state, event) → { state, effects, error? }` is pure, and its state is plain JSON (which is how it crosses tabs).

| Phase | Legal events |
|---|---|
| idle | capture, pickUp, inspect, discard, dismiss, cancel, answer, choose |
| carrying | approach, drop, cancel, capture |
| approaching | approach, drop, cancel |
| confirmingMerge | confirmMerge, cancel |
| merging | settled |
| inspecting | inspect, remove, answer, choose, pickUp, cancel, discard |
| previewing | answer, choose, remove, place, cancel |
| executing | committed, commitFailed, outcomeUnknown |
| succeeded | undo, undone, dismiss, capture, pickUp, cancel |
| failed | dismiss, cancel, capture, pickUp |
| unknown | reconcile, reconciled, dismiss |

- Any other event is refused with `cannot <event> while <phase>` and changes nothing (tested).
- **Escape** (`cancel`) puts a carried object back on the desk, closes a merge question, and abandons a preview without writing.
- **No false success:** `succeeded` is reached only on a receipt from the destination. A destination that does not answer leads to `unknown`; the person can ask the destination (`reconcile`), which never retries. "Not found" means `failed` and safe to place again.
- **Undo** is offered only when the receipt says the action is reversible.
- Effects (`commit`, `reconcile`, `undo`) name a `destinationId`, so the code that owns that destination performs them.

## The fusion animation
`createClay(host, { reducedMotion })` draws every object as one SVG blob inside a single group with a goo filter (Gaussian blur, standard deviation 9, then an alpha threshold). Two blobs that come close visibly join. Labels are HTML above the SVG, so they stay sharp and focusable.
- Motion: springs (k 300, c 24, m 0.8). While approaching, the target leans toward the carried object (up to 14 px). On drop, `fuse()` runs contact, fusion and settle.
- Reduced motion: no travel and no lean. The merge happens at once, with a short pulse.
- The state machine decides; the renderer only shows. A refused merge never animates as a merge.

## How cross-tab works in the extension
1. **Activation.** The person invokes Recast in a tab (Alt+Shift+R, or the toolbar). That grants `activeTab` for that tab only, and the worker injects `clay-content.js` into it. No host permissions, and no content script runs on any page by itself.
2. **One state, in the worker.** `background.ts` keeps the clump state in `chrome.storage.session`. It is held in the browser's memory, never written to disk, and gone when the browser closes. Every event loads it, applies `reduceClump`, saves it and sends it to every activated tab. Events go through a queue one at a time, so two tabs cannot interleave a merge. The worker keeps nothing in memory between events, so a stopped and restarted worker carries on.
3. **Each tab rebuilds what is in hand.** A tab that did not start the carry shows the carried object in its tray ("In hand: Maya Rao. Drag it onto something on this page."). From there it can be dragged onto anything on that page.
4. **Destinations belong to tabs.** A page declares destinations with `data-recast-dest` / `data-recast-kind` / `data-recast-label`, slots with `data-recast-slot` and `data-start`, and its list with `data-recast-list`. The worker prefixes their ids with the tab id. A `commit`, `undo` or `reconcile` effect is sent only to that tab, because only that page can write to itself.
5. **Lifecycle.** A tab that closes or reloads takes its destinations with it. A review open in that tab is cancelled, and the objects stay on the desk. Closing the tab an ingredient came from loses nothing.

Permissions: `activeTab`, `scripting`, `storage` (used for session storage only). These are checked by `apps/extension/test/manifest-audit.test.ts`, which also checks that the worker and the clay layer contain no network calls, no eval and no other storage.

## What is real and what is approximated
| Real | Approximated or stand-in |
|---|---|
| The clump model, the rules and the state machine (pure, tested) | The calendar and the mail drafts are in-page stand-ins. No Google Calendar, Gmail or any provider is called |
| Real tabs, a real MV3 service worker, `storage.session`, `activeTab` injection (extension tests) | The harness simulates tabs inside one page; spring-loaded tab switching exists only there |
| The trust path: proposal, consent, receipt, unknown outcome, reconcile, undo | Since `docs/22-reliability.md`, an extension test stops the worker for real (DevTools `Target.closeTarget`) and checks that a fresh worker carries on from `storage.session` |
| Pointer, keyboard and touch input in the harness, tested in Chromium (touch via CDP) | No person has tried it (**P** not reached); on a phone it is the harness page, not an extension |
| The goo-filter fusion and the reduced-motion path | "Clay-like" is a filter and springs, not a physical simulation |

## Limits, stated plainly
- **No pointer continuity across real tabs.** A browser does not deliver a drag from one tab to another. In the extension the object waits in the tray of the next tab, and the person drags it from there. Carrying "in the hand" across tabs exists only on the harness page.
- **Per-tab activation.** Recast has to be invoked in each tab (the `activeTab` model). That is deliberate; broad host access was not requested.
- **Session only.** Objects are lost when the browser closes or the extension is reloaded.
- **Keyboard in the extension:** Escape, and the glass module's own keys once focus is in it (`docs/21-glass-module.md`). The full page-level keyboard path (Space to lift, Tab to targets, Enter to drop, arrow keys between tabs) exists on the harness page.
- **Since `docs/21-glass-module.md`:** Recast is off until invoked, and the review opens in the glass action module instead of a sheet.
- **Recognition** is the element classifier's: a name, an address block, a time or a heading. Anything else needs a selection. Maya's e-mail address is not read from the fixture profile, so a message to her asks for one.
- **Not on Windows.** The native shell does not exist (task #23).
- Release state: under `consumer.compose` (`internal`).

## Commands
```
pnpm --filter @recast/core test          # clumps (and the rest of core)
pnpm --filter @recast/interaction test   # clump machine
pnpm --filter @recast/harness test       # clay page in Chromium (13)
pnpm --filter @recast/extension test     # manifest audit, popup, cross-tab carry in Chromium (2)
```
