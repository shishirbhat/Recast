# Recast for the desktop (macOS, Windows, Linux)

The capsule in a small window of its own, always a shortcut away. Same objects, same module, same recipes as the browser.

## Install
Download the installer from the **desktop** workflow's latest run on GitHub (Actions → desktop → Artifacts):
- **macOS:** `Recast-<version>-universal.dmg`. Open it and drag Recast to Applications. The app is not signed with an Apple Developer ID yet, so the first time, **right-click Recast → Open**, then confirm.
- **Windows:** `Recast-<version>-x64.exe` (or `-arm64.exe`). Not signed yet: if SmartScreen says "Windows protected your PC", click **More info → Run anyway**.
- **Linux:** `.rpm` (Fedora, RHEL, openSUSE), `.deb` (Ubuntu, Debian), or the AppImage (make it executable and run it).

Recast lives in the tray (the menu bar on a Mac). Closing the window hides it; **Quit** is in the tray menu.

## Use
- **Grab: select text in any app** (Mail, Slack, a browser, a PDF, a terminal), then press **⌘⇧Space** (Mac) or **Ctrl+Shift+Space** (Linux). It lifts into Recast as an object, read as a time, a person (an email address), an error or text, and it keeps the app it came from (and the page's address when it is a browser). Recast appears without taking the keyboard from the app you are in.
  - **Mac:** the first grab asks for the **Accessibility** permission (System Settings → Privacy & Security → Accessibility → Recast). Recast uses it to ask the front app to copy your selection, then puts your clipboard back as it was. Browsers may also ask once whether Recast may read the page address; saying no only leaves the address out.
  - **Linux:** the highlighted text is read directly; nothing is copied. This works on X11 desktops; on Wayland it depends on the desktop.
- **The capsule** floats above your windows: a small pill while there is nothing on it, opening into the panel when there is. Drag one object onto another to press them together, then **Choose where it goes**, or run a recipe. Open or hide it with ⌘⌥Space (Ctrl+Alt+Space).
- **Type or dictate** a piece with the **+** on the pill. Voice: on a Mac press **Fn (🌐) twice** in the box and speak; on Windows, Win+H.
- **The Fn key cannot be a Recast shortcut** (the keyboard keeps it to itself); on a Mac it is how you dictate into Recast's box.
- Shortcuts, appearance (match the system, dark, light) and "keep on top" are in Settings (the gear) and the tray menu.

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
