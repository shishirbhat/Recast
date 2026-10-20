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
