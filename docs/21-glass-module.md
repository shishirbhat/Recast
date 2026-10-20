# 21. The Recast trigger and the glass action module

**Level reached:**
- **U:** state machine 14 tests, glass contrast 7, bridges 4 new.
- **H:** Chromium on the clay page, 18 tests including touch, keyboard, reduced motion, and axe in light and dark on every module state.
- **H, F:** the real MV3 extension in Chromium, 3 cross-tab tests.

Every placement goes to a local stand-in. Nothing reaches Google. Not **R**, not **P**, not native.

Screenshots (`docs/images/glass/`): off, the pill, the module (light), the selector (dark), the review on a phone, and the selector in the real extension.

## Acceptance journey, and where it is proven
> With Recast inactive, ordinary browsing behaves normally. I activate Recast, pick up Maya, merge her with a restaurant, and obtain one composed clay object. A compact frosted-glass module appears without taking over the screen. I scroll through Calendar, Mail, Tasks, and other supported destinations, choose one, inspect the preview, and complete the action through Recast's existing trust model.

Proven by `apps/harness/test/clay.test.ts` ("acceptance: …", "the trigger", "keyboard: …", "More lists …") and `apps/extension/test/clay.test.ts` ("the module's selector: …").

## What was reused
- **The clump model and state machine.** The machine is extended, not duplicated: one `reduceClump`, one JSON state.
- **The trust path:** `propose` → `plan` → `checkConsent` → `commit` → receipt, unknown outcome → reconcile, and undo only when reversible.
- **The clay renderer and its fusion animation:** unchanged. The module leaves a well, and the real blob is drawn in it.
- **The extension's cross-tab architecture:** the worker owns the state in `storage.session`, tabs render it, and effects run in the tab that owns the destination.
- **The bridge registry's contracts.** They now live as plain data in `packages/bridges/src/contracts.ts`, so the extension's page script can read them without any network code.

## Trigger
| Where | How | What it does |
|---|---|---|
| Extension | **Alt+Shift+R** (the existing `recast-clay` command), or the toolbar popup's "Clump things on this page" | In a tab Recast is not in yet, it brings Recast there (activeTab) and turns it on. In a tab it is already in, it turns Recast on, reopens the composition, or turns it off (`commandEvents`). |
| Clay page | The "Recast" button in the simulated browser bar, or Alt+Shift+R | The same `commandEvents` |

- **Off is the default.** With Recast off:
  - the machine refuses `capture` and `pickUp`;
  - pieces on the page are plain text (no highlight, ordinary selection, not focusable as Recast targets);
  - in the extension, Alt+press is ignored;
  - no module is shown.
- **Turning off:** Escape when nothing is open, the × on the pill, or the command when nothing is made yet. Off puts an object in hand back and closes an unwritten review. The composition is kept for the session.
- **Shortcut choice:** Alt+Shift+R was already this extension's command.
  - It is not one of Chrome's built-in shortcuts that I know of on Windows or Linux. I did not check ChromeOS or macOS.
  - On macOS, Option+Shift+R types "‰" in text fields, and an extension command captures it while Recast is installed.
  - People can rebind it at `chrome://extensions/shortcuts`.
  - The clay page matches on `e.code` (KeyR), so it works when Option changes the character.
- **Capture gesture in the extension:** Alt+press (with Recast on). Without Alt, the page keeps its own drag and selection even while Recast is on.

## Module lifecycle
One module, rendered from one pure model (`moduleModel(state, REGISTRY)` in `packages/interaction/src/wheel.ts`) by one component (`createGlass`, `packages/overlay/src/glass.ts`).

| State (machine phase) | Module |
|---|---|
| Off (`armed: false`) | hidden |
| On, idle | **pill** (about 40 px tall): "Drag one thing onto another", or "Meet Maya at Dakshin is ready" with **Open** when a composition was closed |
| Carrying, with a composition | the module stays open with the object in its well: "Drop it on the object to add it" |
| Carrying, no composition | pill: "Carrying Maya Rao" |
| `merging` | pill while the fusion plays |
| `composed`: a merge has settled | the composition in the well, 2–3 facts, **Choose where it goes ↵**, **Look inside** |
| `choosing` | the destination selector |
| `previewing` | the review: fields with their origin, what is still needed, assumptions, risk, a stand-in note |
| `executing` | "Adding to Calendar…", no buttons |
| `succeeded` | "Added to Calendar", only after the destination's receipt. Undo only if reversible |
| `unknown` | "No answer from Calendar"; **Check Calendar** reconciles, never resends |
| `failed` | the reason; Close |
| `inspecting` | the ingredients with their sources; Take out |
| `confirmingMerge` | Combine / Keep apart |

- **Escape steps back one level at a time.** Review → selector → module → pill → off. It does nothing while writing or while an outcome is unknown, and Recast cannot be turned off then.
- **The × (Close)** goes back to the pill without turning Recast off.
- **The command never makes a second module.** Tests count one `.rg`, and one `recast-clay` host per tab.
- **The module appears only after a merge settles.** It is never a permanent dashboard.

### Size and position
- **Pill:** width fits its content.
- **Module:** `min(340px, 100vw − 32px)` wide.
- **Height grows only as needed:**
  - module about 235 px;
  - selector about 400 px;
  - review up to the viewport less 24 px, scrolling inside.
- **Desktop:** bottom-centre, floating above the clay page's desk when there is room.
- **Phone (≤ 480 px):** 16 px from each edge.
- **Extension:** the shelf of loose pieces sits bottom-right; on windows narrower than 900 px it moves to the top-right, so it doesn't overlap the module.
- **Tested:** 1200×800 and 390×844 on the clay page (no horizontal scroll; the module stays inside the screen), and 1280×800 and 760×760 in the extension (screenshots).

### Material
- **Glass:** translucent tint (80%), backdrop blur 28 px with saturation 170%, a hairline border, a top edge highlight, and two soft shadows.
- **Fallbacks:** solid colour without `backdrop-filter`, with `prefers-reduced-transparency`, and with `prefers-contrast: more`.
- **Contrast:** checked in a unit test over glass composited on pure black and on pure white, and on the solid fallback. Ink and secondary text are at least 4.5:1 in both schemes. axe finds no serious or critical violations on the pill, module, selector, review and inspection, in light and dark.
- **Motion:**
  - the outline is revealed from the old shape to the new (clip-path, 200 ms), so layout and the well are final at once;
  - activation fades in 160 ms;
  - the selector glides 180 ms;
  - the receipt check draws 260 ms.
  - With reduced motion, none of these run and everything still works.
  - The fusion is unchanged.

## The destination selector
- **A short vertical drum.** The chosen place sits in a raised capsule in the middle, with one neighbour visible above and below.
- **Not colour alone:** the chosen row is larger and bold and shows ↵; unavailable rows are struck through and say "Unavailable", with the reason under the drum.
- **Mouse:**
  - the scroll wheel moves one row per notch (trackpad deltas are accumulated);
  - clicking a row selects it; clicking the selected row opens it.
- **Touch:** a vertical swipe of 36 px moves one row.
- **Keyboard:**
  - ↑/↓ (and ←/→), Home/End;
  - Enter or Space opens;
  - Escape goes back.
  - Focus moves into the selector when it opens.
- **Selecting writes nothing.** Opening an unavailable row only nudges its reason.
- **Opening is not execution.** It leads to the review, and `pickDestination` with an unfit destination is refused, so the selector stays open.

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
- **Tasks and Documents:** in the registry, but they take documents, and no composition is a document today. So they are always unavailable, with that reason.
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
| Worker restart | state reloads from `storage.session` (a restart is not forced in the test) | extension |
| Extension reload | `storage.session` is cleared: objects are lost, as before. Not upgraded to persistent storage. | — |

## Platform limits, and the smallest next step
- **Desktop-wide is not supported.** This is a browser extension: the module floats over web pages only in tabs where Recast was invoked, and the shortcut is a Chrome extension command (Chrome must be focused).
  - Next step: the Windows shell (`docs/09-windows-spike-kit.md`, task #23), drawing the same `moduleModel` in a layered window. The model and the glass component are already framework-free.
- **Per-tab activation is kept.** It is activeTab, with no host permissions.
- **No pointer continuity across real tabs.** The object waits in the next tab's shelf.
- **Tasks and Documents never have a fitting object today.**
  - Next step: a document fragment (a page or a file, captured from the page's own metadata) so Google Tasks and Notion can be offered.
- **Stand-ins only.**
  - Next step: OAuth apps (#22), then a real `HttpBridge` destination in the extension's worker, which needs host permissions for the Google APIs and its own review.
- **Selector keys in the extension** work once focus is in the module. The command focuses it (via a `focus` message). The full page-level keyboard path (Tab between pieces) remains a clay-page feature.

## Commands and results
```
pnpm --filter @recast/bridges test        # 36 (4 new: Gmail message draft, registry)
pnpm --filter @recast/interaction test    # 69 (14 new: trigger, module, selector, Escape)
pnpm --filter @recast/overlay test        # 11 (7 new: glass contrast and fallbacks)
pnpm --filter @recast/harness test        # 44 (clay page 18: 13 updated, 5 new)
pnpm --filter @recast/extension test      # 22 (cross-tab 3, manifest audit 12, e2e 7)
```
