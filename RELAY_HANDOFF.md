# Relay — session handoff

Read this first. Every session working on Relay keeps it current: update "State" and the log at the end of each phase, in the same commit as the work.

## Scope and rules (from the owner)

- **Only Relay.** Recast (branches `main`, `claude/clever-heisenberg-s3taqj`) is out of scope. Relay lives on the orphan branch `relay`.
- **Goal of the current work:** Relay should look and behave *structurally* like VS Code (and Cursor), so it no longer feels empty. Only the colours and Relay's own features (tasks, contracts, agents, records, "Needs you", change records) should stand out.
- **No fake buttons.** Every menu item, command and control either really works, or is visibly disabled with a one-line reason (e.g. "Debugging needs a debug adapter"). The command registry's `when()` returns that reason; menus, palette and buttons show it.
- **Commit and push after every phase** (`git push -u origin relay`). A previous session lost a whole phase of work because it never committed. Uncommitted work in a cloud container is gone when the session ends.
- Commit messages: plain, no model names.

## How to run and check

```sh
npm install && (cd ide/web && npm install && npm run build)
npm run typecheck && npm test                     # server + engine (node:test)
(cd ide/web && npx tsc --noEmit)                  # client types
RELAY_E2E=1 node --test test/e2e/*.e2e.test.ts    # Chromium E2E (Playwright core, /opt/pw-browsers)
node scripts/shots.ts <dir> <label>               # screenshots of the running IDE
./bin/relay ide --cwd <repo>                      # run the IDE; prints a one-time owner sign-in link
```

Key files: `ide/web/components/workbench/Workbench.tsx` (layout, menus, command registry), `ide/web/lib/commands.ts` (Command type, keys, fuzzy), `ide/web/components/workbench/CommandPalette.tsx`, `ide/web/components/Editor.tsx` (CodeMirror + Yjs), `src/server/server.ts` (HTTP API), `src/server/docs.ts` (shared documents), `src/server/files.ts`.

Docs: `docs/08-ide-architecture.md` (API and event tables — update when adding routes), `docs/13`–`16` (audits).

## VS Code parity plan

| Phase | Content | Status |
|---|---|---|
| 1 | Editor: minimap, indent guides, render whitespace, line-number toggle, language mode per file, Format Document (Prettier in the browser, applied as minimal edits so collaborators' carets and authorship survive), VS Code line/cursor commands in the palette | see State |
| 2 | Full VS Code menus (File/Edit/Selection/View/Go/Run/Terminal/Help) with toggle checkmarks; palette prefixes `:` line, `@` symbol, `#` workspace symbol, `?` help; quick picks (language, indentation, run task, open view, switch editor); Run Active File / Run Selected Text in the terminal | |
| 3 | Replace in Files through the shared documents (attributed to the person); explorer rename / delete / new folder | |
| 4 | Welcome tab, Testing view, Extensions marketplace (Open VSX, browse only — installing needs an extension host, disabled with reason), split editor | |
| later | Breadcrumb symbol pickers, outline view, timeline, keyboard shortcuts editor, settings JSON | |

Deliberately disabled (with reasons): debugging (no debug adapter), installing extensions (no extension host), language-server features beyond the syntax checker (no LSP bridge).

## State

- `relay` at `a5613f5` before this work: calm editor-first IDE, ten workflows validated end to end. See `README.md` (its status table is dated 2026-10-19 and lags).
- **VS Code parity phases 1–4 done**, including split editors. **Cursor-quality redesign done** (see the 2026-10-21 log entries and `docs/17-workbench-redesign-audit.md`): coordination workspace, diff review with task context, Problems by source, agent worktrees in Source Control, one status vocabulary, tokens.
- Known small gaps: when a collaborator renames your open file, your editor moves to the new name but loses keyboard focus (click to continue). Regex Replace uses JavaScript regex while the search preview list comes from `git grep -E`; exotic syntax can differ between the two (the preview counts come from a dry run with the same engine as the replace).

### Conventions introduced (keep using them)

- `Command.native`: CodeMirror's keymap already binds the chord; the registry shows the binding but never dispatches it from the keyboard (no double-firing). `Command.editorKey`: the shortcut only applies while the editor has focus (VS Code's `editorTextFocus`). `Command.checked()`: toggle state for menu check marks.
- Chords are matched by physical key (`e.code`) with modifiers in canonical order, so `Shift+Alt+F` works on every layout and platform.
- Quick picks: `showPick({ placeholder, items })` in the Workbench opens the palette in pick mode (`CommandPalette` `QuickPick`). `quickOpen(prefix)` opens it on a prefix (`""` files, `>` commands, `:` line, `@` symbol in file, `#` symbol in workspace, `?` help).
- Menus are the `MENUS` table in `Workbench.tsx`: command ids only. A command that can't run keeps its place, greyed, with its `when()` reason as the tooltip (e.g. `NO_DEBUG`). The E2E "menus" test fails if a disabled item has no reason.
- Server-side edits on a person's behalf use the `member:<id>` origin (`DocStore.applyEdits`), so line authorship credits that person for exactly the ranges changed.
- A document whose file is renamed or deleted is closed with WebSocket code 4410 (`CollabService.closeDocument`, then `DocStore.unload`); the client (`DocSession`) stops reconnecting and the Workbench moves or closes the tab from the `file.renamed` / `file.deleted` events.
- **Status vocabulary** (`STATUS` in `components/workbench/CoordinationView.tsx`, mirrored from `src/analysis/coordination.ts` `statusOf`): proposed, waiting, queued, running, stopped, checking, blocked, verification failed, verification required, needs review, ready to integrate, failed, cancelled, done. Each maps to engine facts (tooltip shows the engine state). Never add a UI-only state; derive it in `statusOf` and test it in `test/coordination.test.ts`. Plain task states use `StatePill` labels: Awaiting approval, Queued, Running, In review, Blocked, Failed, Cancelled, Done.
- Non-file editor tabs: `welcome:`, `relay:coordination`, `diff:…`. Use `isFileTab` / `tabLabel` in `Workbench.tsx`.
- Editor groups: `groups` + `focus` in `Workbench.tsx`; `tabs`/`active`/`setTabs`/`setActive` are the focused group's. Act on all groups with `setGroups`.
- Overlays (menus, palette, notifications) are solid (`.glass` in `globals.css`), not translucent.
- Editing commands that change text go through CodeMirror transactions, so they reach collaborators as ordinary shared edits. Whole-document rewrites (Format Document) use `applyMinimalEdits` (`lib/format.ts`) so unchanged text keeps its CRDT identity, carets and authorship.

## Log

- 2026-10-21 — An earlier session began the VS Code parity work (minimap, Prettier, editor commands, palette prefixes, Replace in Files, Welcome/Settings/Extensions surfaces) but never committed; the container is gone and the work was lost. Restarted from `a5613f5`. This file created.
- 2026-10-21 — **Phase 1 (editor).** Minimap (`@replit/codemirror-minimap`), indent guides (`@replit/codemirror-indentation-markers`), render whitespace (none/trailing/all), line-number toggle, all persisted in editor prefs and in Settings. Language registry `lib/languages.ts` and per-file Change Language Mode (status bar click). Format Document / Format Selection with Prettier 3 in the browser (`lib/format.ts`; plugins loaded per language; aborts if someone typed meanwhile). ~45 VS Code editor commands in the registry (clipboard, find/replace/next/previous, comments, line move/copy/delete/insert, indent/outdent/reindent, join, transpose, case transforms, sort, duplicate, expand/shrink selection, multi-cursor, fold/unfold, go to bracket/top/end, indentation conversion, indentation quick pick from the status bar); custom ones in `lib/editorCommands.ts`. Fixed: Ctrl+L in the editor reached the browser; chord matching depended on modifier order; palette Enter could hit a stale selection right after typing. Tests: `test/e2e/vscode.e2e.test.ts` (5); full suite 76 unit + 29 E2E passing.
- 2026-10-21 — **Phase 2 (menus, palette, navigation, run).** Menus rebuilt to VS Code's layout (File/Edit/Selection/View/Go/Run/Terminal/Help, ~90 entries) with check marks (`menuitemcheckbox`), scrolling when taller than the window. Palette prefixes `:` `@` `#` `?` (file symbols: `lib/symbols.ts`; workspace symbols: `GET /api/symbols`, `workspaceSymbols` in `src/server/files.ts`). Quick picks: Open Recent (Ctrl+R), Switch Editor, Open View, Color Theme, Run Task (package.json scripts). Go Back/Forward (Ctrl+Alt+- / Ctrl+Shift+-) with a 50-entry history; Next/Previous Problem (F8). Run Active File / Run Without Debugging (Ctrl+F5; node, python3, bash; saves first), Run Selected Text, in the real terminal. Save All, Copy Relative Path, Reveal in Explorer, Keyboard Shortcuts. Disabled with reasons: Start Debugging (F5), Toggle Breakpoint (F9), Add Configuration, Auto Save (always on). Fixed: opening a file at a line (search result, symbol) didn't move to the line when the file wasn't open yet; overlays were translucent. Tests: 3 more E2E in `vscode.e2e.test.ts`, `test/symbols.test.ts`; 77 unit + 32 E2E passing.
- 2026-10-21 — **Phase 3 (files).** Replace in Files (Ctrl+Shift+H): Search view gains VS Code's Aa / ab / .* toggles, a Replace row with inline struck/inserted preview, Replace All (dry-run count, confirm), per-file Replace and Dismiss. Server `POST /api/replace` edits the shared documents live, credited to the person. Explorer: context menu (New File, New Folder, Copy Relative Path, Rename F2, Delete), inline name box selecting the name without extension, empty folders shown, New Folder button; viewers see the actions disabled with a reason. Rename/delete close everyone's connection to the old document (4410), carry history to the new name (or set it aside on delete), and collaborators' tabs follow with a notice. Fixed (pre-existing): New File didn't write the empty file to disk, so it was missing from the file list and git until someone typed; a new file now gets focus. Tests: `test/fileops.test.ts` (3, real Yjs clients), 3 more E2E; 80 unit + 35 E2E passing.
- 2026-10-21 — **Phase 4, part 1 (WIP).** Welcome page as an editor tab on startup (`components/workbench/Welcome.tsx`; Help > Welcome; "Show welcome page on startup" stored in `relay.welcome`): Start actions, Recent, Help, Needs you, In progress. Testing view in the activity bar (`TestingView` in `Tests.tsx`): test files from the runner, per-test results from the latest run, run all / one file / failed, filter, "not run" never shown as passed. Extensions view searches Open VSX from the browser (CORS allowed), shows real results; Install disabled with "Installing needs a VS Code extension host, which Relay doesn't have yet". E2E helpers now wait for `welcome` instead of `empty-editor`. Full E2E run: 33 passed, 2 failed (see State). Screenshots gallery of the IDE published as a private artifact for the owner.
- 2026-10-21 — **Phase 4 finished: split editors.** Up to two editor groups (Ctrl+\, Ctrl+1/2, move editor, close group); files open in the focused group; same shared document in both. The records and Explorer E2E tests turned out green (the records test already used an exact match; the Explorer test passed in repeated runs).
- 2026-10-21 — **Cursor-quality redesign** (owner's brief: Cursor-level polish, Relay's coordination as the differentiator, everything real). Audit in `docs/17-workbench-redesign-audit.md`. Built:
  - `GET /api/coordination` (`src/analysis/coordination.ts`): one status per task from engine state + latest run + change record; prerequisites (waits on / blocks), contract partners, overlapping files between live tasks, out-of-scope files, stale inputs; answers (running, blocking, related, unverified, review, safe next). Read-only.
  - Coordination editor tab (`CoordinationView.tsx`; Ctrl+Alt+C, activity bar, Relay menu, Welcome, status bar): answers grid, dependency graph (prerequisites, shared contracts, overlaps), lanes by next action, rows with worktree, last activity, six stages, files, overlaps; actions are engine endpoints only (start agent, stop run, run checks — refused for agent work, which is checked in its worktree — open/review task, open diff).
  - Diff review: task stages and integration readiness beside the diff, file n of m navigation, real +/− line counts, next/previous change, non-colour markers (solid/dashed bars).
  - Problems panel grouped by source (Syntax, Tests from the latest run, Conflicts, Coordination) with filter and severity toggles.
  - Source Control: "Main checkout" identity and an "Agent worktrees" section (each run's `.relay/worktrees/…` path and changed files → task diff).
  - Status bar: coordination summary and latest test run. One task-state vocabulary in every panel. Layout/type/motion tokens in `globals.css`; dead decoration CSS removed; graph nodes keyboard-reachable.
  - Tests: `test/coordination.test.ts` (status mapping + API), `test/e2e/coordination.e2e.test.ts` (simulated agent: a real verification failure, nothing called safe, worktree named, diff counts), split-editor E2E.
- 2026-10-21 — **Final check of the redesign:** `npm run typecheck`, client `tsc --noEmit`, `npm test` (82 passing), `RELAY_E2E=1` browser suite (38 passing, 0 failing), static build. Screenshots at 1440/1100/820 in dark and light inspected (welcome, editor, split, palette, problems, coordination, task diff, source control). Next priorities: a real (non-simulated) Claude Code run from the IDE; an integrate/apply action in the coordination row once a task is ready (today it routes to the task review); language-server bridge (definition/references); keep editor focus when a collaborator renames your open file.
