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
