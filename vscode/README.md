# Relay for VS Code

Work on a Relay project from VS Code, in your own checkout, with your own extensions (PlatformIO, debuggers, language servers): the files you open are shared live with everyone in the project, people in the browser IDE included, and with the agents Relay coordinates.

## Install and join

1. Get the extension. The project's Relay server offers it in the invite dialog ("Download the Relay extension for VS Code"), or build it here: `npm install && npm run package` makes `relay-vscode-<version>.vsix`. Install it with **Extensions › … › Install from VSIX…** or `code --install-extension relay-vscode-<version>.vsix`.
2. Open your checkout of the project's repository in VS Code.
3. Open the **VS Code** link from your invite (it asks before joining), or run **Relay: Join Project…** and paste the invite link. The session is kept in VS Code's secret storage for this folder; **Relay: Leave Project** ends it.

## What it does

| | |
|---|---|
| Live files | Every file you open that belongs to the project is shared. Your typing reaches others immediately; theirs appears in your editor. Positions are exact even when you both type at once. |
| Saved, honestly | The status bar says **Relay: Synced** only after the Relay server confirms it has your edits. If a connection silently dies it says **Not saved yet**; edits are kept and sent when it recovers. |
| Your copy vs. the shared one | If a file you open differs from the shared copy, you choose: use the shared version, share yours, or don't share that file. Nothing is overwritten silently. Setting: `relay.whenFilesDiffer` (`ask`, `useShared`, `shareMine`). |
| Undo | Ctrl+Z / Ctrl+Shift+Z in a shared file undo and redo only your own edits, never a collaborator's. |
| Presence | Collaborators' carets and selections in their own colour, with their name. They see yours, in VS Code or in the browser. The status bar shows how many people are in the file. |
| Who wrote this line? | Right-click › **Who Wrote This Line?**: each part of the line with its author and time; pick one to open that edit session as a diff. |
| Coordination | The Relay view in the activity bar: every task with Relay's status and why, its files and blockers. Owners can **Apply to Project** on agent work that's ready; if the project changed since the agent started, Relay checks the merged result first. |
| Renames and deletes | When a file is renamed or deleted in Relay, you're told and offered to do the same in your checkout. |

Saving works as usual: the extension changes your editor's text, and your files on disk change when you save (or use VS Code's Auto Save).

## Limits

- Files are matched by their path in the project; only files that exist in the project are shared. New local files aren't added to the project from VS Code yet (create them in Relay).
- VS Code's own Undo from the Edit menu (rather than the keyboard shortcut) still uses VS Code's history, which includes collaborators' edits.
- Viewers can't change shared files; local edits by a viewer are replaced with the shared text.
- The extension talks to one Relay server per folder.

## Development

`npm test` builds the extension, starts a real Relay server, makes a separate clone as "your checkout", and runs the tests inside a real VS Code (downloaded by `@vscode/test-electron`; under `xvfb-run` when there's no display). A real Chromium joins as a browser-IDE user for the interop test. Screenshots go to `docs/evidence/vscode-extension-2026-10-22/`.

How the sync works is described at the top of `src/fileSync.ts`.
