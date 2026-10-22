# Recast for the desktop (macOS, Windows, Linux)

The capsule in a small window of its own, always a shortcut away. Same objects, same module, same recipes as the browser.

## Install
Download the installer from the **desktop** workflow's latest run on GitHub (Actions → desktop → Artifacts):
- **macOS:** `Recast-<version>-universal.dmg`. Open it and drag Recast to Applications. The app is not signed with an Apple Developer ID yet, so the first time, **right-click Recast → Open**, then confirm.
- **Windows:** `Recast-<version>-x64.exe` (or `-arm64.exe`). Not signed yet: if SmartScreen says "Windows protected your PC", click **More info → Run anyway**.
- **Linux:** `.rpm` (Fedora, RHEL, openSUSE), `.deb` (Ubuntu, Debian), or the AppImage (make it executable and run it).

Recast lives in the tray (the menu bar on a Mac). Closing the window hides it; **Quit** is in the tray menu.

## Use
- **Open or hide Recast from anywhere:** ⌘⇧Space on a Mac, Ctrl+Shift+Space on Windows and Linux.
- **Capture what you copied:** copy text in any app, then ⌘⌥Space (Ctrl+Alt+Space). It becomes an object, read as a time, a person (an email address), an error, or text.
- **Type or dictate a piece** in the box at the bottom. **Voice:** on a Mac, press **Fn (🌐) twice** with the box focused and speak (macOS dictation). On Windows, press **Win+H**. Linux has no built-in dictation.
- Drag one object onto another to press them together, then **Choose where it goes**, or run a recipe.
- **The Fn key cannot be a Recast shortcut:** the keyboard's firmware keeps it, and no app on Windows or Linux can see it. On a Mac, Fn is how you dictate into Recast's box.
- Shortcuts, appearance (match the system, dark, light) and "keep on top" are in Settings (the gear) and in the tray menu.

## Connect your accounts
Tray → **Connections…**: paste your Google OAuth client (from Google Cloud), then sign in with Google **in your browser**. GitHub and Linear connect on the same sign-in page. Tokens stay on this computer, readable only by your user. Maps needs nothing.

## Build it yourself
```
pnpm install
pnpm --filter @recast/desktop start          # run from source
pnpm --filter @recast/desktop test           # the real app on a virtual screen (Linux: Xvfb)
pnpm --filter @recast/desktop dist:linux     # .rpm .deb .AppImage (the .rpm needs rpmbuild)
```
A `.dmg` can only be built on a Mac, and the Windows installer on Windows: the `desktop` workflow does both on GitHub's runners.
