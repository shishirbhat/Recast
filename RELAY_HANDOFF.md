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
- Phase 1–4: not started in a pushed commit yet (an earlier attempt was lost; see log).

## Log

- 2026-10-21 — An earlier session began the VS Code parity work (minimap, Prettier, editor commands, palette prefixes, Replace in Files, Welcome/Settings/Extensions surfaces) but never committed; the container is gone and the work was lost. Restarted from `a5613f5`. This file created.
