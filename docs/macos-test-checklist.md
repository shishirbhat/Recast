# macOS test checklist for the desktop app (D61)

The desktop app has **never been confirmed on a Mac by a person**. Everything below is automated on Linux (Xvfb, real X11 keys and mouse) or not tested at all; nothing on this page is evidence of macOS readiness. Run it on a real Mac (Apple silicon first), and record each line as pass, fail (with what happened) or not run, in `docs/REAL_TEST_PLAN.md` section K.

**Setup:** install the latest `Recast-for-Mac-Apple-silicon` artifact with `apps/desktop/scripts/install-mac.sh` (HANDOFF, "Desktop app"). Have a browser and a second app (Notes or TextEdit) open, and a second display if you have one.

## 1. First launch and permissions (code: `canGrab`, `startHook`, `screenAccess` in `apps/desktop/src`)
1. The app opens without "damaged" or "unidentified developer" errors. Expect it to be blocked without the install script until there is a Developer ID; that is a known, owner-level item.
2. The library says to allow **Accessibility**, and System Settings opens from its button.
3. After allowing it **without restarting**, the trigger starts working within about 2 s (the app checks every 2 s).
4. The library says to allow **Screen Recording** for highlights. After allowing it, macOS asks to quit and reopen. After reopening, highlights appear.
5. With Screen Recording refused, selecting text by hand still makes blobs, and the line says highlights are off.

## 2. Turning on and off (code: `hook.ts`, trigger key `Alt` = Option on a Mac)
6. In Notes, tap **Option** twice: Recast is on, and the status pill appears at the bottom centre. No Recast window opens, and Notes keeps the keyboard (typing still goes into Notes).
7. Option used in a chord (⌥E, ⌥-click) or held down never turns Recast on or off.
8. Tap Option once while on: off. Press **Escape** in Notes while on: off.

## 3. Grabbing and highlights
9. While on, select a sentence in the browser: a blob appears beside the selection, not in a corner.
10. Double-click a word and triple-click a line: one blob each, after the click settles (not two).
11. Highlights sit on the words (time, email address, error line, link, phone number, `file.ts:42`), on a Retina display. Check that they are not shifted.
12. Clicking anywhere that is not Recast reaches the app underneath (click a button in the browser while Recast is on).
13. Scroll the page: highlights go at once and come back for what is on screen.

## 4. The keyboard (D53; the part most likely to differ on a Mac)
14. Rest the pointer on a blob: Notes **still has the keyboard** (type: the text goes into Notes).
15. Press **⌘⇧↵**: the keyboard moves to the first blob, and the pill says "Keyboard on Recast …".
16. Tab and the arrows move between blobs and highlights. Space picks one up; an arrow, then Enter on another, presses them together.
17. Enter on a blob opens the wheel; Escape closes the wheel and the keyboard is back on the blob.
18. Escape again: the keyboard goes **back to Notes**, and the menu bar shows Notes as the active app. This uses `app.hide()` and then shows the overlay without focus, so watch for a flicker. Recast stays on.
19. Escape once more, in Notes: Recast turns off.
20. ⌘⇧↵ with Recast off does nothing in Recast, and the app in front gets the keys as usual.
21. With the library window open and in front, steps 15–18 still return the keyboard to the app that had it. If they don't, note which app ends up active.

## 5. More than one display
22. With the pointer on the second display, tap Option twice: the overlay covers **that** display, and highlights read that display.
23. Move to the other display while Recast is on, then grab: the overlay stays on the display where Recast was turned on (and highlights keep reading that display, D61), so turn Recast off and on again on the new display. Record whether a grab on the other display lands somewhere sensible.

## 6. Restart and recovery
24. Quit Recast with a blob on the screen, then reopen it and turn it on: the blob comes back where it was.
25. Start placing something (Google Calendar, or the stand-in), then quit Recast before the answer arrives. On reopening, the review says it is unknown and offers a check, not "added", and it is not sent again.
26. Quit during a recipe run: on reopening, the step in flight is "No answer", steps never sent are "Not run" with "Recast closed before this was sent", and Try again is offered only on those.

## 7. Icons
27. The Dock and Finder icon is the dark rounded square with the cream R and ember dot. The menu bar icon is the R mark, black or white with the menu bar, not a coloured square.
28. The library header shows the same R mark.

## What is automated (Linux only)
Trigger (real Ctrl taps), grabbing by drag and clicks, click-through, highlights read by OCR from the real screen, the keys shortcut, Tab, Space, Enter and Escape on the overlay, keys handed back, the library, restart with blobs, and a recipe against the stand-in Google: `apps/desktop/test/app.test.ts` (18 tests). CI also runs a packaged launch check on Linux, Windows and macOS, and an install check on macOS. **None of these involve a person pressing keys on a Mac.**
