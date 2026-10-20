# 16 · Interface simplification audit

Audit of the running IDE before the simplification pass. It covers the default demo project (three tasks, one superseded contract) at 1440, 1100 and 820 px wide, and the tasks, agents, problems, source control and people views. Screenshots were taken with `node scripts/shots.ts <dir> before`.

## What made it feel cramped and noisy

| # | Finding | Evidence | Effect |
|---|---|---|---|
| 1 | **The agent side bar was open by default and mostly empty.** It took 380 px, with about 450 px of empty space above the composer. | 1440 and 1100 screenshots | At 1100 px the code had about 420 px and lines were clipped. The empty panel competed with the editor for attention. |
| 2 | **Tasks lived in two places.** There was the Relay view in the left bar *and* the Tasks tab on the right, each with its own grouping ("Needs a person / In progress" vs "Needs a person / Moving / Settled"). | tasks screenshot | Two lists of the same thing, with two vocabularies. |
| 3 | **Agent activity lived in three places.** It appeared in the agent thread (every tool call), the task detail (every tool call) and the bottom panel's Agents tab (every tool call). | agents screenshot | Raw tool logs were the default view everywhere. |
| 4 | **Labels shouted.** Headings and tabs were 10.5 px uppercase tracked monospace: EXPLORER, OPEN EDITORS, NEEDS A PERSON, AGENT/TASKS/CONTRACTS/RECORDS, TERMINAL/PROBLEMS/…, and state pills like WORKING/READY. | every screenshot | Every heading had the same loud voice, so there was no hierarchy, and small caps are tiring to read. |
| 5 | **The accent colour was used for ordinary things.** The selected file had an orange fill plus an orange outline. "Working" was an orange pulsing pill. The status bar had a solid orange RELAY block. Activity-bar badges were orange. | every screenshot | Background activity looked as urgent as a blocker, and pulsing dots drew the eye while typing. |
| 6 | **The real blocker was invisible.** T-api is still built on user-api v1 after v2 was accepted, so it can't be integrated. The only signal was an anonymous "2" in the status bar. | 1440 file screenshot | Nothing answered "is anything blocking me?" or "what should I do next?" |
| 7 | **Nothing said what you were working on.** The editor showed a file, but not the task that file belongs to or its state. | file screenshots | Context had to be reassembled from the task list. |
| 8 | **Controls were duplicated.** Settings and account sat in both the title bar and the activity bar. An "Open Editors" tree section duplicated the tab strip. | file screenshots | More chrome, same actions. |
| 9 | **The empty editor was decorative.** It had a dot-grid background, corner registration ticks, and a framed card with an uppercase tagline. | empty screenshot | Decoration in the primary workspace. |
| 10 | **The status bar was crowded.** Of nine items, several were constant (UTF-8 always). The live indicator pulsed forever. | file screenshots | Low-priority metadata looked like status. |
| 11 | **The review layout put the decision last.** In task detail, approve/check buttons came after the evidence ladder, scope, contracts and the full run log. Nothing said what approving would *do*. | task detail | The reviewer had to scroll past evidence to reach the decision, and its consequence was implicit. |
| 12 | **Typefaces were tiring.** Geist Mono at 13 px for code, and Geist Mono uppercase for labels. | all | The user reported it as hard on the eyes. |

## What already worked and is kept

These are kept as they are:

- **Core editing and collaboration:** the editor (CodeMirror 6 with Yjs, presence, follow mode), search, source control and diff review, the terminal, and the test runner.
- **Coordination and evidence:** the command palette, the change record (the claim/verified/approved ladder), integration checks, people and contributions, and records.
- **Layout mechanics:** the sizing logic (panes collapse instead of crushing the editor), all keyboard commands, and everything the E2E suites cover.

## Changes (implemented in the same pass)

1. **Editor first.**
   - The Relay side bar starts closed. It opens when asked: Ctrl+Alt+B, Ctrl+I, the Relay activity, the attention list, or a task link.
   - The minimum editor width rises to 480 px (640 px on wide windows) before side bars give way.
2. **One home per thing.**
   - Tasks, agents, contracts and records live in the Relay side bar. The Relay activity opens it, and the duplicate left-bar task list is removed.
   - The bottom panel's Agents tab is removed. A compact agent overview at the top of the Agent tab shows each agent's state, and the full log stays one click away inside the task.
   - "Open Editors" and the duplicate title-bar settings and account buttons are removed.
3. **"What am I working on?"** The row above the code names the task that owns the open file, with its state, and links to it.
4. **"Is anything blocking me / what next?"** A single *Needs you* control in the title bar.
   - It lists only items that need a person: review requests, blocked or failed tasks, tasks built on a superseded contract, proposals waiting for an owner, outside-edit conflicts, and failing tests.
   - Each item gives its cause and one next action.
   - It is quiet ("All clear") when there is nothing.
   - A new item of that kind also raises one dismissible notification. Routine activity never does.
5. **Review answers its questions first.** Task detail opens with a decision summary:
   - what changed (files, with diffs);
   - which checks ran and their real results (a check that hasn't run says "not run");
   - open dependencies or conflicts;
   - whether approval is needed;
   - exactly what approving will do.
   - The evidence ladder and the raw agent log follow, with the log collapsed.
6. **Calm visual system.**
   - **Type:** sentence-case labels in the UI face, with no uppercase tracking. Figtree for the interface and IBM Plex Mono for code, both selectable in Settings → Typefaces. The default code size is 14 px with 1.65 line height.
   - **Colour:** ordinary states (ready, working, approved) are plain text with a dot; only states needing a person get a tint. The selected file is a neutral highlight. The status bar is neutral, and nothing pulses.
   - **Surfaces:** text and code contrast is slightly softer in both themes, with no glare-white editor.
7. **Notifications.**
   - Toasts can be dismissed, and at most three show at once.
   - Errors stay until dismissed and keep their full message in the notification list.
   - The list is capped at 50 entries.

## Found while validating, and fixed

The workflow run and its screenshots turned up problems the earlier tests didn't catch:

- **Outside-edit conflicts could not be resolved anywhere in the IDE.** They were recorded, and after this pass also listed under *Needs you*, but nothing could clear them.
  - Added `GET /api/conflicts/:id` and `POST /api/conflicts/:id/resolve`, plus a conflict tab that shows the outside version beside the shared copy with **Keep shared copy** / **Use outside version**.
  - Either way both versions stay recorded. Only editors and owners can decide, and a conflict is decided once.
  - Covered by `test/conflicts.test.ts` and workflow 7.
- **The review contradicted itself.** Its Tests line said "Passed on the current files" while evidence-staleness notes sat in red under *Depends on*.
  - The agent's check ran on its own copy, and the person kept editing the shared files meanwhile.
  - The summary now says "Passed. 1 passed on this exact workspace. The shared files changed since; see Re-check." Evidence staleness sits in its own *Re-check* row, in warning colour. *Depends on* holds only contracts and partner tasks.
- **A failed agent run was only visible in its log.** The task itself reads "Ready" after a failed run. The summary now leads with *Last run: Failed: <error>* and the next reasonable action, and the log opens by itself.
- **The editor gutter was transparent**, so horizontally scrolled code showed through the line numbers. The gutter is now opaque in the editor and in diffs.
- **Notices outlived their situation.** A notice now disappears once its item leaves *Needs you* (approved, resolved, rerun).
- **"Not safe to integrate yet" showed under an already-integrated task.** It is now hidden once the change is in the shared project.
- **Agent-log timestamps wrapped onto two lines** in 12-hour locales. They are now 24-hour.
- **Keyboard:** opening *Needs you* with Ctrl+Shift+A now moves focus to its first action, and Escape returns focus to where it was (the editor).

- **Keys typed right after Ctrl+Shift+P could land in the code.** The palette took focus one animation frame late, so a fast "Ctrl+Shift+P, S…" inserted a stray character into the open file. Workflow 10 caught it intermittently, with the caret off by one column. The palette now takes focus synchronously as it opens. A regression test types immediately after the shortcut five times and checks the file is unchanged.
- **An intermittent unit test.** About one run in three, `agents.test.ts`'s recovery test failed. It assumed a rerun's snapshot always differs from its partner's. When the shared files haven't changed, the snapshot commit is identical within the same second, so the test failed depending on the clock. The product was correct: identical state means nothing to rebase. The test now changes the shared state before the rerun, as its scenario describes, and passed 8 of 8 runs.

## Validation

`test/e2e/workflows.e2e.test.ts` runs the brief's ten workflows in Chromium against a real server.

- **What is real:** edits are real keystrokes, and outside edits are real file writes, reconciled through the same function the watcher calls.
- **What is simulated:** agents are the SIMULATED agent (`test/fixtures/simulated-agent`, with new `RELAY_SIM_DELAY_MS` and `RELAY_SIM_FAIL` modes). They exercise Relay's orchestration and the interface, not a model.
- **Screenshots:** `RELAY_SHOTS=<dir>` saves one at each key moment.

| # | Workflow | What is checked |
|---|---|---|
| 1 | Open the project, navigate files | Quick open, explorer, next/previous editor by keyboard |
| 2 | Edit for a while | 40 lines typed key by key. All reach the shared document intact, with no page errors. Markdown list continuation behaves like other editors. |
| 3 | Open and close panels | Six panel toggles; the caret is unchanged afterwards |
| 4 | Agents running while editing | Two agents (one started from the task's button) run while the person types. The overview shows both as Working. The only notice is the confirmation of the person's own click, and focus never leaves the editor. Completion raises exactly one notice per agent: one review, one failure. |
| 5 | Investigate a failure | From the failure notice, the task opens with *Last run: Failed* first and the log open, showing the error and the tool call |
| 6 | Review changes and test evidence | The changed file links to the diff. The tests line is honest about staleness, *Re-check* lists what changed, and *If approved* states the consequence. Approve & apply updates the shared copy. |
| 7 | Resolve an integration conflict | Overlapping outside edit → notice → *Needs you* → Resolve → compare → use outside version. Both versions stay recorded, and the item clears. |
| 8 | Smaller window (900×620) | No horizontal scroll, the editor stays at least 480 px wide, and the *Needs you* list fits in the window |
| 9 | Keyboard only | Ctrl+Shift+A focuses the first action; Escape returns to the editor |
| 10 | Return after side trips | People, tests, a task, source control, then back: the file, caret and text are as they were, and the Relay bar closes |

Other browser coverage:

- `calm.e2e.test.ts` checks the *Needs you* contents, the file's task, one dismissible notice per new situation, the typefaces (with persistence), no uppercase text anywhere, and a 1024 px window.
- All earlier suites still pass.

Final run: 76 unit tests and 24 browser tests passing, and both type-checks clean (numbers from the run recorded in the commit).

## Not done in this pass

- **Agents in validation are simulated.** A real Claude Code run was proven in earlier phases (docs/09), but it was not repeated for this UI pass.
- **Split editors and project-wide replace** are still not built (tracked separately).
- **Notices** stack at the bottom right. When the Relay side bar is open they can cover its lower edge (the agent composer) for up to 12 s; they never sit over the editor at the default layout.
- **Visual review** was done from screenshots at 1440, 1100, 1024, 900 and 820 px in the light theme. The dark theme uses the same tokens but was not re-screenshotted in this pass.
