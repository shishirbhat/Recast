# 09. Windows spike kit (what I need from your machine)

The interaction engine, overlay and element classifier are built and tested in Chromium (`docs/08-layer2-interaction.md`). The Windows shell depends on four OS behaviours that I cannot exercise from a Linux sandbox. Rather than guess, `apps/spike-win` measures them on your machine. I have syntax-checked it but **have not run it**, because it needs Windows.

## Run it (about a minute of your time)
```
cd apps/spike-win
npm install
npx electron .
```
Follow the four prompts. It writes `spike-results.json`; paste it back, or commit it as `docs/spike-results/<name>.json` (window titles appear in it; delete any you want private).

## What it measures, and what each answer decides
| Step | Question | If the answer is bad |
|---|---|---|
| 1. Key state | Can ONE key (default Alt) be read by polling `GetAsyncKeyState` reliably, at what rate, with what worst gap? | Try another lift key; a hook may be needed, which widens the privacy surface |
| 2. Overlay | Does a transparent, click-through, always-on-top Electron window show without stealing focus? Does Electron's cursor agree with Windows' at your DPI and on several monitors? | Different window flags, or a native overlay instead of Electron |
| 3. Hit-testing | Which window is under the cursor, and what does UI Automation return there (Chrome, Notepad, Explorer, Office, VS Code, full-screen apps)? How long? | Drop UIA for that app class and rely on the extension or the user's selection |
| 4. Elevated windows | What happens over a "Run as administrator" window (UIPI)? | Document "cannot place into elevated apps" and show it honestly as `unsupported` |

## Privacy
It does not install a keyboard hook, does not read other keys, does not capture pixels, does not click or type, and sends nothing over the network. It polls one key's up/down state, the cursor position, and the window and UIA element under the cursor, while you watch it run.

## What I will do with the results
Choose the lift-key mechanism, fix the overlay window flags and DPI mapping, decide which app classes get UIA capture versus the extension, and write `docs/10-windows-shell.md` with measured numbers before any shell code is written.
