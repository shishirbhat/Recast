# Relay for VS Code

Work on a Relay project from VS Code, in your own checkout, with your own extensions (PlatformIO, debuggers, language servers): files are shared live with everyone in the project, people in the browser IDE included, and with the agents Relay coordinates.

## Install and join

1. Get the extension. The project's Relay server offers it in the invite dialog ("Download the Relay extension for VS Code"), or build it here: `npm install && npm run package` makes `relay-vscode-<version>.vsix`. Install it with **Extensions › … › Install from VSIX…** or `code --install-extension relay-vscode-<version>.vsix`. A newer version installs over an older one.
2. Open your checkout of the project's repository in VS Code.
3. Open the **VS Code** link from your invite, or run **Relay: Join Project…** and paste the invite link. VS Code first asks whether Relay may open the link; Relay then asks whether to join that server, naming it. Nothing is joined, and the one-time invite isn't used, unless you say yes to both.
4. The session is kept in VS Code's secret storage for this folder, so it survives restarts. On Linux without a keyring VS Code asks how to store it; if it can't be stored you're told, and you'll need a new invite after a restart. **Relay: Leave Project** ends it.

Before an invite is used, the extension checks the server's protocol version. A server it can't talk to is refused with an explanation (update the extension or the server), and the invite stays valid.

## Editing together

| | |
|---|---|
| Live files | Every file you open that belongs to the project is shared. Your typing reaches others at once; theirs appears in your editor at exactly the right place, even when you both type on the same line. |
| Saved, honestly | **Relay: Synced** only after the Relay server confirms it has your edits. If a connection silently dies it says **Not saved yet**; while offline, **Offline: edits kept here, sent when back**. Edits are kept and sent when the connection recovers, including after a server restart. |
| Your copy vs. the shared one | If a file you open differs from the shared copy, you choose: use the shared version, share yours, or don't share that file. Nothing is overwritten silently (`relay.whenFilesDiffer`: `ask`, `useShared`, `shareMine`). |
| Other programs | If git, a generator or Revert File rewrites a shared file you have open, nothing is shared or overwritten until you choose: share the new content, or put the shared version back (`relay.externalChanges`: `ask`, `share`, `keepShared`). |
| Presence | Collaborators' carets and selections in their own colour, with their name; they see yours, in VS Code or in the browser. |
| Who wrote this line? | Right-click › **Who Wrote This Line?**: each part of the line with its author and time; pick one to open that edit session as a diff. |
| Coordination | The Relay view in the activity bar: every task with Relay's status and why, its files and blockers. Owners can **Apply to Project** on agent work that's ready. |

## Undo

In a shared file, undo and redo revert **only your own edits**, never a collaborator's, wherever you start them:

- Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y (Cmd on macOS) run Relay's undo and redo directly.
- **Edit › Undo**, **Undo** from the Command Palette, and any other way of running VS Code's own undo: VS Code's history includes collaborators' edits, so Relay puts the text back and runs its own undo instead. With nothing of yours to undo, nothing changes (and the status bar says so).
- **Relay: Undo My Last Edit / Redo My Last Edit** in the Command Palette.

One limitation: after an undo started from the **Edit menu or the palette**, **Edit › Redo** has nothing to redo (VS Code's redo history is cleared when Relay restores the text). Use Ctrl+Shift+Z or **Relay: Redo My Last Edit**, which work. Undo history survives renames and reconnects.

## Files and folders, both ways

| Done in VS Code (Explorer, refactorings, Save As) | In Relay |
|---|---|
| Create a file or folder | Created in Relay with its content. If Relay already has that path, neither copy is overwritten; you choose when you open it. Files git ignores, protected files (`.env` …), binary files and files over 2 MB aren't shared, and you're told why. |
| Rename or move | Renamed in Relay; your open editor keeps its shared session, undo history and anything not yet sent. If Relay refuses (the name is taken, ignored or protected), you're told, and can rename it back. |
| Delete | You're asked whether to delete it for everyone or only here (`relay.shareDeletes`: `ask`, `always`, `never`). |

| Done in Relay (browser, others, agents) | In your checkout |
|---|---|
| A file or folder created | Written into your checkout, unless you already have a different file there (yours is kept). |
| A file renamed or moved | Renamed here, with your open editor following it. If the new name is taken here, nothing changes and you're told. |
| A file deleted | Removed here only if your copy holds exactly what Relay last had (on disk and in any open editor, nothing unsaved or unsent); it goes to the trash where there is one. Otherwise your copy is kept, and you can restore it in Relay. |

Files that **other programs** create or delete in your checkout (a `git checkout`, a generator, a terminal) are never shared or deleted in Relay automatically: they're listed and you decide. **Relay: Restore Shared Files Missing Here…** brings back shared files your checkout doesn't have. When you join, Relay tells you which shared files are missing here and how many differ.

## Settings

| Setting | Default | |
|---|---|---|
| `relay.whenFilesDiffer` | `ask` | A file you open differs from the shared copy |
| `relay.externalChanges` | `ask` | Another program rewrote a shared file you have open |
| `relay.shareDeletes` | `ask` | You deleted a shared file in VS Code |

## Limits

- Files are matched by their path in the project. Shared files are UTF-8 text up to 2 MB.
- The undo limitation above (Edit-menu redo after an Edit-menu undo).
- Files you don't have open aren't kept up to date on disk while others edit them; each is brought in step (with your choice if it differs) when you open it, and **Restore Shared Files** fetches missing ones.
- Case-only differences between paths are compared as the server's disk sees them; the extension has been tested on Linux only.
- One Relay server per VS Code folder. Not published on the VS Code Marketplace; install the `.vsix`.

## Development

- `npm test` builds the extension, starts a real Relay server, makes a separate clone as "your checkout", and runs the tests inside a real VS Code (downloaded by `@vscode/test-electron`; under `xvfb-run` when there's no display). A real Chromium joins as browser-IDE users for the interop and whole-file-lifecycle tests, and the server is restarted mid-run to test recovery. Real keystrokes (Ctrl+Z, Alt+E for the Edit menu) are sent through X's XTEST extension by `test/keys.py` (needs `pip install python-xlib`). `RELAY_TEST_ONLY=<regex>` runs a subset.
- `npm run test:install` packages the `.vsix` and tests it in a normally started VS Code with a clean profile: package contents, upgrade over an older `.vsix` lying next to it, the two real confirmation dialogs answered by mouse and keyboard, the version the server sees, and restoring the session after restarting VS Code. VS Code's extension test host refuses modal dialogs, which is why that path is tested here.
- Screenshots go to `docs/evidence/vscode-extension-2026-10-22/`. How the sync works is described at the top of `src/fileSync.ts` and `src/fileOps.ts`.
