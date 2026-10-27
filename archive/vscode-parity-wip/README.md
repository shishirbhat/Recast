# Archived WIP: VS Code-parity IDE changes (not applied)

Set aside on 2026-10-26 when Relay was repositioned as the integration trust layer (docs/17-positioning.md).
Nothing here is applied to any branch. Kept only so the work isn't lost.

- `untracked-files/` — 7 new files that were never committed (Explorer/Outline/Timeline panes, menus, editor
  commands, special editors, document symbols and their test). Paths mirror the repository layout.
- `stash-tracked-changes.patch` — the same change set's edits to tracked files, exported from the stash entry
  "vscode-parity WIP (uncommitted)" (stash@{0} in the session that made it; 18 files, +1781 −425).
  The base it was made on is commit a540b61's parent line of `relay` before the VS Code extension work landed;
  the `relay` branch has since changed (including a file named ide/web/lib/editorCommands.ts), so expect
  conflicts if this is ever revived. Revive by hand, not by blind apply.
