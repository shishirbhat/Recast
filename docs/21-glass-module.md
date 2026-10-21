# 21. The Recast trigger and the glass instrument

**Level reached:**
- **U:** state machine 14 tests, the Control-twice detector 6, glass contrast 7, bridges 4 new.
- **H:** Chromium on the clay page, 21 tests: mouse wheel, trackpad-style scrolling, touch, keyboard, Control twice, reduced motion, reduced transparency, and axe in light and dark on every state.
- **H, F:** the real MV3 extension in Chromium, 3 cross-tab tests (Control twice included).

Every placement goes to a local stand-in. Nothing reaches Google. Not **R**, not **P**, not native.

Screenshots (`docs/images/glass/`): the pill, the resting capsule, the wheel (light, dark, phone), the review, and the receipt (dark).

**What the screenshots are:** the try-it page in a desktop-sized browser. The tabs, the address bar, the pages and the "Your objects" bar are a simulated browser that serves as the demo's backdrop. Recast itself is only the glass instrument and the clay object floating over it. There is no native desktop app.

## Acceptance journey, and where it is proven
> With Recast inactive, ordinary browsing behaves normally. I activate Recast, pick up Maya, merge her with a restaurant, and obtain one composed clay object. A compact frosted-glass module appears without taking over the screen. I scroll through Calendar, Mail, Tasks, and other supported destinations, choose one, inspect the preview, and complete the action through Recast's existing trust model.

Proven by `apps/harness/test/clay.test.ts` ("acceptance: …", "the trigger", "keyboard: …", "More lists …") and `apps/extension/test/clay.test.ts` ("the module's selector: …").

## What was reused
- **The clump model and state machine.** The machine is extended, not duplicated: one `reduceClump`, one JSON state.
- **The trust path:** `propose` → `plan` → `checkConsent` → `commit` → receipt, unknown outcome → reconcile, and undo only when reversible.
- **The clay renderer and its fusion animation:** unchanged. The module leaves a well, and the real blob is drawn in it.
- **The extension's cross-tab architecture:** the worker owns the state in `storage.session`, tabs render it, and effects run in the tab that owns the destination.
- **The bridge registry's contracts.** They now live as plain data in `packages/bridges/src/contracts.ts`, so the extension's page script can read them without any network code.

## Trigger: Control twice turns it on, Control once turns it off
| Where | How | What it does |
|---|---|---|
| Clay page | **Control twice** (Control on a Mac, Ctrl on Windows and Linux) to turn on; **Control once** to turn off. Or the "Recast" button in the simulated browser bar | on (reopening a kept composition); off. The button follows `commandEvents` (on, reopen, or off) |
| Extension, in a tab Recast is in | **Control twice** on, **Control once** off | the same |
| Extension, a tab Recast is not in yet | the toolbar popup's "Clump things on this page", or Alt+Shift+R (the `recast-clay` command) | brings Recast into the tab (activeTab) and turns it on |

- **What counts** (`createControlTrigger` in `packages/interaction/src/double-tap.ts`, 10 unit tests):
  - A tap is Control pressed and released on its own, under 300 ms. "Twice" is two taps within 400 ms.
  - While Recast is on, one tap turns it off, at once. The detector then starts afresh, so the second press of a habitual double tap does not turn it straight back on.
  - These never count: Control used in a shortcut (Ctrl+C), Ctrl+click, a held Control (auto-repeat or a long press), leaving the window, or Shift, Alt or ⌘ pressed twice.
- **Why the extension still has a first-time shortcut:** a browser extension cannot listen for keys on a page it was not invited into without access to every site. Recast deliberately doesn't ask for that. Once it is in a tab, Control twice works there.
- **Known overlaps, stated rather than tested:**
  - macOS lets people set Dictation to "Press Control key twice". Anyone who has chosen that will start both.
  - Screen readers stop speaking when Control is pressed. The trigger still works, and the button is there as an alternative.
- **Off is the default.** With Recast off:
  - the machine refuses `capture` and `pickUp`;
  - pieces on the page are plain text (no highlight, ordinary selection, not focusable as Recast targets);
  - in the extension, Alt+press is ignored;
  - no module is shown.
- **Turning off:** Control once, Escape when nothing is open, or the × on the pill. Turning off is refused while a write is in progress or its outcome is unknown. Off puts an object in hand back and closes an unwritten review. The composition is kept for the session.
- **Capture gesture in the extension:** Alt+press (with Recast on). Without Alt, the page keeps its own drag and selection.

## Module lifecycle
One module, rendered from one pure model (`moduleModel(state, REGISTRY)` in `packages/interaction/src/wheel.ts`) by one component (`createGlass`, `packages/overlay/src/glass.ts`).

| State (machine phase) | Module |
|---|---|
| Off (`armed: false`) | hidden |
| On, idle | **pill** (about 40 px tall): "Drag one thing onto another", or "Meet Maya at Dakshin is ready" with **Open** when a composition was closed |
| Carrying, with a composition | the module stays open with the object in its well: "Drop it on the object to add it" |
| Carrying, no composition | pill: "Carrying Maya Rao" |
| `merging` | pill while the fusion plays |
| `composed`: a merge has settled | the **resting capsule**: the object in its well, "Ready to place", one glass button **Choose where it goes ›**, and a small Look inside |
| `choosing` | the capsule opens: the object on the left (drawn compact), facts under it, the **wheel** on the right sharing its centre line |
| `previewing` | the wheel contracts into the review: the destination's icon, fields with their origin, what is still needed, assumptions, risk, a stand-in note, **Confirm: Add to calendar** and **Cancel** |
| `executing` | "Adding to Calendar…", no buttons |
| `succeeded` | the receipt: the destination's icon with an ember check, "Added to Calendar", only after the destination's receipt. Undo only if reversible. **Once the receipt is closed (Done, Escape, turning off, picking up something new) the placed object leaves "Your objects"**; an undone placement keeps its object |
| `unknown` | "No answer from Calendar"; **Check Calendar** reconciles, never resends |
| `failed` | the reason; Close |
| `inspecting` | the ingredients with their sources and how sure Recast is of each ("sure 90%"); Take out |
| `confirmingMerge` | Combine / Keep apart |

- **Escape steps back one level at a time.** Review → selector → module → pill → off. It does nothing while writing or while an outcome is unknown, and Recast cannot be turned off then.
- **The × (Close)** goes back to the pill without turning Recast off.
- **The command never makes a second module.** Tests count one `.rg`, and one `recast-clay` host per tab.
- **The module appears only after a merge settles.** It is never a permanent dashboard.

### Size and position
- **Pill:** width fits its content.
- **Capsule** 360 px, **wheel** 470 px, **review** 390 px, **receipt** 340 px wide, each `min(…, 100vw − 32px)`.
- **Height grows only as needed:**
  - capsule about 190 px;
  - wheel about 370 px;
  - receipt about 190 px;
  - review up to the viewport less 24 px, scrolling inside.
- **Desktop:** bottom-centre, floating above the clay page's desk when there is room.
- **Phone (≤ 520 px):** 16 px from each edge; in the wheel state the object sits above the wheel.
- **Extension:** the shelf of loose pieces sits bottom-right; on windows narrower than 900 px it moves to the top-right, so it doesn't overlap the module.
- **Tested:** 1200×800 and 390×844 on the clay page (no horizontal scroll; the module stays inside the screen), and 1280×800 and 760×760 in the extension (screenshots).

### Material
- **Optical glass:**
  - a warm ivory tint (78%), or warm charcoal in dark, slightly lighter at the top where light falls;
  - backdrop blur 22 px with saturation 180% and a touch of brightness;
  - a hairline rim, bright along the top edge and fading round the sides;
  - two shadows, contact and ambient.
- **A specular highlight** drifts toward the pointer over the surface. It is static with reduced motion and absent with reduced transparency.
- **Glass is used for the instrument only.** The clay object stays opaque and tactile (a soft top highlight and inner shade), distinct from the glass around it.
- **Type and accent:** Instrument Serif for page display moments, Inter for the interface, JetBrains Mono for numbers. Ember orange marks the lens rim, the primary action's ring, the receipt check and focus, and never long text.
- **Fallbacks:** solid colour without `backdrop-filter`, with `prefers-reduced-transparency` (tested in Chromium: no blur, no gradient, solid ivory), and with `prefers-contrast: more`.
- **Contrast:** checked in a unit test over glass composited on pure black and on pure white, and on the solid fallback. Ink and secondary text are at least 4.5:1 in both schemes. axe finds no serious or critical violations on the pill, capsule, wheel, review and inspection, in light and dark.
- **Motion:**
  - the outline is revealed from the old shape to the new (clip-path, 220 ms), so layout and the well are final at once;
  - activation rises and scales in over 180 ms;
  - the wheel settles with a critically damped ease (about 150 ms, no overshoot, no spin);
  - each settle gives one "tick" (the lens rim brightens and the chosen icon firms, 160 ms);
  - the receipt makes one small scale (260 ms) and draws its check.
  - Nothing moves perpetually. With reduced motion none of this runs and everything works.

## The destination wheel
- **A short cylinder, turning behind a fixed glass lens.** Rows sit on the cylinder 24° apart. The chosen one faces you inside the lens, which has an ember rim on its leading edge. Its neighbours tilt away with perspective, shrinking and fading, so the wheel reads as a physical drum. It was chosen over a radial dial because it stays usable at phone width.
- **Not colour alone:** the chosen row is bold, its icon inverts with an ember ring, and it shows ↵. Unavailable rows are struck through and say "Unavailable", with the reason under the wheel.
- **Mouse wheel:** one row per notch.
- **Trackpad:** the cylinder follows the fingers (with a little resistance at the ends), then snaps to the nearest row. No free-spinning momentum.
- **Click:** a neighbour turns the wheel to it; clicking the chosen row opens it.
- **Touch:** drag the cylinder; it snaps when you let go.
- **Keyboard:**
  - ↑/↓ (and ←/→), Home/End;
  - Enter or Space opens;
  - Escape goes back.
  - Focus moves into the wheel when it opens.
- **Selecting writes nothing.** Opening an unavailable row only nudges its reason.
- **Opening is not execution.** It leads to the review, and `pickDestination` with an unfit destination is refused, so the wheel stays open.
- **Focus never lands on Cancel first.** When the review opens, focus goes to what is still needed, else to Confirm. This was a real bug found by the keyboard test: a stray Enter could throw away a review.

### What is listed, and when it is available
The entries come from `REGISTRY` (`packages/bridges/src/contracts.ts`), in five places:

| Place | Registry contract | Takes |
|---|---|---|
| Calendar | Google Calendar `google-calendar.calendar` (event-calendar-entry) | events |
| Mail | Gmail `gmail.drafts` (message-draft-entry) **new spec** | messages (a person and what to say) |
| Tasks | Google Tasks `google-tasks.list` (document-task-reference) | documents |
| Documents | Notion `notion.database` (document-project-source) | documents |
| More | the rest: Google Calendar event editor (attendee, location), Gmail draft to a person, Google Sheets (products) | people or places; people; products |

An entry is available only when both hold:
1. the composition is the kind the contract takes (its relation's `from`, from the grammar);
2. a destination performing that contract is connected here.

Otherwise it stays visible, disabled, with the reason, for example "Gmail takes messages; this is an event" or "Google Calendar is not connected here".

## Which destinations are genuinely available
- **Calendar:** for events. On the clay page, an in-page stand-in calendar. In the extension, any open page that declares `data-recast-kind="calendar"` (the test fixture `calendar.html`) and has Recast in it.
- **Mail:** for messages. The same arrangement with `data-recast-kind="drafts"`.
- **Tasks:** for documents. A page taken whole (**This page** in the extension's pill) is a document. In the extension, Tasks is the real Google Tasks through the local program (`apps/calendar-link`) when the Tasks permission was granted, or a page that declares `data-recast-kind="tasks"` as a stand-in.
- **Documents:** for documents too (Notion). No Notion bridge is connected anywhere, so it says "Notion is not connected here".
- **More:** Sheets, the event editor and Gmail-to-person are listed with reasons. None of them takes an event or a message.
- **No destination is backed by a real provider.**
  - Every available one is a stand-in that performs the registry contract locally and says so ("stand-in" under the name, and a note in the review).
  - The Google and Notion bridges themselves are tested only against fakes (`packages/bridges`, **F**) and need OAuth apps (#22).

## Choosing a destination in another tab (extension)
Choosing Calendar in the restaurant tab, when the calendar page is in another tab, brings that tab and its window to the front. The review and the write then happen where the person can see them (D22).

The worker's only tab or window change is `tabs.update({active: true})` and `windows.update({focused: true})`. This is audited, and neither call needs a permission.

## Reliability and recovery
| Case | Behaviour | Test |
|---|---|---|
| Escape at each level | one step back; never a write | machine "Escape, one step at a time"; clay page "keyboard …" |
| Closing the module | composition kept; the command or **Open** reopens it | machine, clay page, extension |
| Invoking again | reopens, or nothing if already open; one module | all three |
| Switching tabs | the state is in the worker; every tab renders the same module | extension |
| Unsupported composition | entry unavailable with its reason; the pick is refused | machine, clay page |
| Destination missing or disconnected | "… is not connected here"; a closed tab cancels its open review | machine, extension |
| Failed or unknown outcome | unchanged lifecycle (reconcile, never resend) in the module | clay page "calendar does not answer" |
| Worker restart | a fresh worker reloads from `storage.session`; the restart is forced in a test (`docs/22-reliability.md`) | extension |
| Extension reload | `storage.session` is cleared: objects are lost, as before. Not upgraded to persistent storage. | — |

## Platform limits, and the smallest next step
- **Desktop-wide is not supported.** This is a browser extension: the module floats over web pages only in tabs where Recast was invoked, and the shortcut is a Chrome extension command (Chrome must be focused).
  - Next step: the Windows shell (`docs/09-windows-spike-kit.md`, task #23), drawing the same `moduleModel` in a layered window. The model and the glass component are already framework-free.
- **Per-tab activation is kept.** It is activeTab, with no host permissions.
- **No pointer continuity across real tabs.** The object waits in the next tab's shelf.
- **A document is a whole page, on its own.** **This page** takes the page's title (og:title, else `<title>`) and its address (the canonical link when it is on the same site, so tracking parameters are not saved). It cannot be pressed into other pieces yet; that is refused with the reason.
  - Not yet: files (PDFs), and "this page + a date" as a task with a due date.
  - Notion still has no connected bridge.
- **Stand-ins only.**
  - Next step: OAuth apps (#22), then a real `HttpBridge` destination in the extension's worker, which needs host permissions for the Google APIs and its own review.
- **Selector keys in the extension** work once focus is in the module. The command focuses it (via a `focus` message). The full page-level keyboard path (Tab between pieces) remains a clay-page feature.

## Reliability
The trigger's timing rules, the full transition table, the lifecycle invariants and the recovery behaviour (a lost answer, a failed undo, a closed tab, a worker restart) are in `docs/22-reliability.md`.

## Photographs
No reference photos are in the repository; there are only screenshots. The restaurant page therefore has a **photo slot** (`[data-photo-slot]`).
- It holds an SVG illustration of the storefront, labelled as an illustration, with one hotspot over the sign.
- With Recast on, the sign is a piece you can pick up. Its provenance says "Photo of the storefront · Dakshin" (tested).
- A real photo replaces the illustration without code changes, because the hotspot is placed in percentages.
- Reading text out of a real photo is not implemented: the hotspot is declared by the page.

## Commands and results
```
pnpm --filter @recast/bridges test        # 36 (4 new: Gmail message draft, registry)
pnpm --filter @recast/interaction test    # 75 (trigger, module, selector, Escape, Control twice)
pnpm --filter @recast/overlay test        # 11 (glass contrast and fallbacks)
pnpm --filter @recast/harness test        # 47 (clay page 21)
pnpm --filter @recast/extension test      # 22 (cross-tab 3 incl. Control twice, manifest audit 12, e2e 7)
```
