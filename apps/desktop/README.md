# Recast for the desktop (macOS, Windows, Linux)

Recast on top of whatever app you are in, and a library of everything you grabbed. Same objects, same module, same recipes as the browser.

## Install
Download the installer from the **desktop** workflow's latest run on GitHub (Actions → desktop → Artifacts):
- **macOS:** `Recast-<version>-arm64` for Apple silicon, `-x64` for Intel, each as `.zip` (double-click it to get Recast.app) or `.dmg` (open it and drag Recast to Applications). The app is not signed with an Apple Developer ID yet, so the first time, **right-click Recast → Open**, then confirm.
- **Windows:** `Recast-<version>-x64.exe` (or `-arm64.exe`). Not signed yet: if SmartScreen says "Windows protected your PC", click **More info → Run anyway**.
- **Linux:** `.rpm` (Fedora, RHEL, openSUSE), `.deb` (Ubuntu, Debian), or the AppImage (make it executable and run it).

Recast is two things, like a dictation app:
- **Recast on top of any app (the overlay).** Nothing opens. It draws only blobs and the wheel, over whatever you are in.
- **The Recast app (the library).** Every blob you have grabbed, newest first, with where it came from and where it went. It opens only when you open it (Applications, the Dock, the start menu, the tray); closing it hides it, and Recast keeps running. **Quit** is in the tray menu.

## Use
1. In any app (YouTube, Slack, Mail, a PDF, a terminal), **tap ⌥ Option twice** on a Mac, **Ctrl twice** on Windows and Linux. Recast is on, right there. If you had text selected, it is already a blob beside it.
2. **Click a highlight.** When Recast turns on it reads the screen (here, on this computer: the image and the words are never sent or kept) and highlights what you are likely to pick up: times and dates, email addresses, error lines, web addresses. Click one and it is a blob beside it; drag one straight onto another blob to press them together. Highlights refresh after you scroll or click in the app.
3. **Or select any text.** While Recast is on, each selection (drag across it, or double or triple click) lifts into a blob where you let go: a time, a person (an email address), an error or text, with the app it came from (and the page's address in a browser on a Mac).
4. **Drag one blob onto another** to press them together (a name and a time become an event).
5. **Click a blob**: the wheel opens beside it, on the same screen. Choose where it goes (Calendar, Tasks, Gmail drafts, Docs, GitHub, Linear, Maps), review, place. Undo where the place allows it.
6. **Esc**, or the trigger key once, turns Recast off. Blobs you did not place come back next time; everything is in the library.

Everywhere else on the screen, clicks go straight to the app underneath: the overlay takes the mouse only on its own blobs and wheel.
- **Mac:** highlights need **Screen Recording** (System Settings → Privacy & Security → Screen Recording → Recast); selecting by hand works without it. Recast also needs the **Accessibility** permission (System Settings → Privacy & Security → Accessibility → Recast), to notice the trigger key and to copy your selection (it puts your clipboard back as it was). The library shows a button for it. Option twice is the trigger because Control twice is the Mac's own Dictation shortcut.
- **Linux:** the highlighted text is read directly; nothing is copied. X11 desktops; on Wayland, global keys and window shapes depend on the desktop.
- **Windows:** Recast presses Ctrl+C in the app in front and puts your clipboard back. The source app is not named yet.
- Also: **⌘⇧Space / Ctrl+Shift+Space** does what the trigger does; **⌃⌥Space / Ctrl+Alt+Space** opens the library. Both can be changed in the library's settings.

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
