# Relay IDE — Structural Audit (Phase 1) (2026-10-20)

Code at `2c4dfdf`. Client: Next.js static export in `ide/web`. Server: `src/server`. Every claim below is from reading the code or measuring the running build.

## Region map

| Region | Implementation | State |
|---|---|---|
| Title bar and command centre | `workbench/Workbench.tsx` (header) → `CommandPalette.tsx` | **Works.** Quick open and commands. The command list is built inline in `Workbench` (no registry module, no keywords, no availability reasons). |
| Activity bar | `Workbench.tsx` `<nav>` | **Partial.** Explorer, Search, Source Control, Relay, plus two bottom shortcuts (agents, people). No Run, Extensions, Community or Accounts/Settings. |
| Primary sidebar | `Workbench.tsx` + `FileTree.tsx`, `Views.tsx` (`SearchView`, `SourceControlView`) | **Works.** Explorer (open editors and tree), Search (server `git grep`), Source Control (server `git status`, read-only). |
| Editor and tabs | `Editor.tsx` (CodeMirror 6 + y-codemirror.next), tabs in `Workbench.tsx` | **Works.** Real collaborative editor. The server writes to disk within ~300 ms, so there is no explicit save, no indicator of edits not yet confirmed by the server, and no guard when closing with offline edits. |
| Secondary sidebar (Relay) | `Coordination.tsx` | **Works.** Tasks, contracts, task detail, ladder, gate explanations, integration check, agent runs. Styled as rounded cards with shadows, which is dashboard-like. |
| Bottom panel | `Views.tsx` `BottomPanel` | **Works.** Problems (Relay coordination problems), Agents, Activity. No Terminal or Output. |
| Status bar | `Workbench.tsx` footer | **Works.** Saturated violet background. |
| Terminal | — | **Missing.** No backend, no client. |
| Extensions / Community | — | **Missing.** There is no extension system and no community backend. |
| Settings / accounts | Theme toggle only | **Missing** as a destination. |
| Layout persistence | `localStorage` key `relay.layout` | **Works.** |

## Layout defects (measured with the built app in Chromium)

| Window width | Editor width | Problem |
|---|---|---|
| 1440 | 756 px | OK |
| 1024 | 340 px | Cramped. Both sidebars keep their persisted widths. |
| 800 | 116 px | Unusable |
| 600 | **0 px** | Editor gone |

Cause: sidebar widths are persisted absolute pixels and are never clamped against the window, and the editor has no minimum width. Other findings:
- Sashes are mouse-only (no keyboard resizing) and carry no `aria-valuenow`.
- The bottom panel height isn't clamped against the window height.
- The palette doesn't restore focus to the previously focused element when it closes.
- Shortcuts are matched by string in one `keydown` handler. There are no explicit priority rules (the editor and palette inputs see the same events).
- **Server bug (fixed in this phase):** a relative `staticDir` failed the path-safety comparison, so every route served `index.html`.

## Plan (smallest changes on the existing code)

1. **Layout shell.** Derive effective pane widths from the window:
   - the editor keeps a minimum width of 420 px;
   - the Relay sidebar auto-collapses first, then the primary sidebar;
   - user-hidden and auto-hidden states stay separate, so nothing is persisted by accident;
   - keyboard-resizable sashes with ARIA;
   - panel height clamped against the window;
   - neutral status bar and flatter Relay sidebar (no cards in panes).
2. **Command registry.** Move commands into `lib/commands.ts` with id, title, category, keywords, keybinding, a `when` that returns availability or a reason, and `run`. The palette lists unavailable commands as disabled with the reason. Shortcuts dispatch from the registry, with an explicit rule: the palette and dialogs take precedence; the editor keeps keys that aren't bound.
3. **Activity bar.** Eight destinations, each with a defined view:
   - Explorer, Search, Source Control: existing.
   - **Run**: `package.json` scripts, run in the integrated terminal.
   - **Extensions**: built-in language support (real), with the marketplace and extension host marked unavailable.
   - **Community**: real project members, presence and invites, plus honest notes on what's missing.
   - **Relay**: opens the coordination sidebar.
   - **Accounts and Settings**: identity, role, theme, keyboard shortcuts, sign out.
4. **Terminal.** A real PTY through `node-pty` on an authenticated WebSocket, with an `xterm.js` client. Sessions survive panel toggles and reconnects. **Owners only**, and only when the server is bound to loopback unless started with `--allow-terminal`. Anyone else sees a labelled unavailable state that explains why.
5. **Editor save semantics.** Ctrl/⌘+S forces a server flush. A tab indicator shows edits not yet confirmed by the server. Closing such a tab, or unloading the page, asks for confirmation.
6. **Tests.** Browser tests covering pane toggling and resizing, narrow windows, switching activities without losing tabs, palette keyboard navigation and focus restore, the terminal running a real command, and save.

---

## Implementation report (Phase 1)

### Architecture
- **Shell (`workbench/Workbench.tsx`).** Title bar, activity bar, primary side bar, editor group, bottom panel, secondary side bar and status bar.
  - Layout preferences (visibility and sizes) persist in `localStorage` (`relay.layout.v2`).
  - `allocate()` derives the *effective* layout for the current window: the editor keeps ≥ 420 px (≥ 300 below 900 px), panes shrink to their minimums first, then the pane opened least recently auto-hides. Preferences are never overwritten, so panes come back when the window grows.
  - Sashes resize by pointer or keyboard (arrows, Shift for big steps, Home/End) and carry ARIA values.
- **Command registry (`lib/commands.ts`).** Every command has an id, title, category, keywords, keybinding, a `when()` that returns null or a reason, and `run`. The menu bar, command palette, title-bar buttons, empty-editor shortcuts, settings shortcut list and keyboard dispatch all read the same registry.
  - Shortcuts dispatch in the capture phase, so they work from the terminal (VS Code's "skip shell" behaviour). Editing chords stay with the focused editor, field or terminal.
  - The palette owns the keyboard while open. After it closes, focus returns to where it was before the command runs.
- **Terminal.**
  - `src/server/terminal.ts`: node-pty over an authenticated `/terminal` WebSocket. Owners only; off on non-loopback binds unless `--allow-terminal`.
  - `workbench/Terminal.tsx`: xterm.js. Sessions stay mounted while the panel is closed and reattach with replay after reloads. The terminal takes focus only when nothing else (such as a dialog) has claimed it.
- **Agent panel (`workbench/AgentPanel.tsx`) and `POST /api/agent`.** A request becomes a scoped task (the @-mentioned files).
  - Owners: approved and run with Claude Code in a worktree.
  - Editors: proposed only.
  - Plan mode: proposed only.
  - Thread view: the run's real tool activity.
- **Neutral tokens (`app/globals.css`).** Same token names as before, so the visual-identity pass can swap values without touching components.

### Activity bar destinations
| Destination | Backed by | State |
|---|---|---|
| Explorer | File tree, git-status letters, open editors | Works |
| Search | `/api/search` (git grep over shared files, secrets filtered) | Works |
| Source Control | `/api/git` | Works (read-only; commit from the terminal) |
| Run | `/api/scripts` → runs `npm run …` in the integrated terminal | Works for owners; debugging **unavailable** (no debug adapter), stated in place |
| Extensions | Built-in language support list | Built-ins real; marketplace and extension host **unavailable**, stated in place |
| Community | Real members, presence, roles, invites | Works; public community hub **not built**, stated in place |
| Relay | Task overview and filters; details in the secondary side bar | Works |
| Accounts / Manage | Identity, role, sign-out (ends the session server-side); theme, terminal status, keyboard shortcuts, layout reset | Works |

### Tests actually run (all passing at the end of this phase)
- `npx tsc --noEmit` (root) and `cd ide/web && npx tsc --noEmit`: clean.
- `npm test`: **45/45**, including new `test/terminal.test.ts` (real PTYs: output, reattach replay, role and ownership refusal, network-bind policy), the agent-composer test, and server-side sign-out.
- `RELAY_E2E=1 node --test test/e2e/workbench.e2e.test.ts`: **7/7** in Chromium, on two consecutive full runs. Covers:
  - pane toggles and keyboard resize;
  - windows at 1100/900/700/560 px (editor ≥ 300 px, no horizontal scroll, panes restored);
  - all eight activities, with tabs preserved;
  - palette keyboard navigation, disabled commands with reasons, Escape focus restore;
  - menus running registry commands, with disabled items;
  - a real terminal command, the session surviving a panel close and reopen, and the viewer's unavailable state;
  - Ctrl+S save;
  - no page errors.
- `RELAY_E2E=1 node --test test/e2e/ide.e2e.test.ts`: 1/1 (two people editing live).
- `cd ide/web && npx next build`: succeeds.
- **No linter is configured in this repository,** so none was run.

### Bugs found and fixed during verification
- Editor width fell to 0 px at 600 px windows (pane widths weren't clamped).
- A relative `staticDir` served the IDE page for every route.
- Killed terminal sessions re-armed a 30-minute idle timer.
- Shortcuts didn't work while the terminal had focus (xterm swallowed them).
- The terminal stole focus from the command palette when it finished loading.
- The palette didn't return focus before running a command.
- Community rows overlapped.

### Known issues and gaps
- **Save model.** Edits are live: the server persists every edit, flushes to disk within ~300 ms, and Ctrl/⌘+S forces a flush. "Unsaved" therefore means *edits made offline that haven't reached the server*. That's tracked per tab, guarded on close and unload, and reconciled automatically on reconnect.
- **Not built:** split editors, LSP intelligence, debugging, an extension host or marketplace, a public community hub, Outline and Timeline views.
- **Untested:** narrow-window layouts below 560 px, Firefox and Safari.
- **No real Claude Code run from the Agent panel yet.** The composer endpoint is tested with the simulated agent; the provider path is the same `runs.start` that the real-provider tests exercise via the CLI.

### Recommendations for the visual-identity pass
- Swap token values only (`--chrome`, `--sidebar`, `--editor`, `--accent`, `--remote-bg`, syntax tokens); the structure doesn't depend on them.
- Typography: reintroduce the display face only in empty states, the join page and the agent welcome, never in panes.
- Give the status-bar remote block and the agent composer Relay's signature treatment; keep the panes calm.
- Keep collaborator colours as the only non-semantic hues in the editor.
