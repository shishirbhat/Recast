# Recast Windows spike

Measures what the Windows shell depends on. **It changes nothing, records no keystrokes, reads no screen pixels, and sends nothing anywhere.** It polls the state of one key (Alt by default), the cursor position, the window under the cursor, and the UI Automation element there.

```
cd apps/spike-win
npm install          # Electron + koffi, about 200 MB
npx electron .       # or: set RECAST_KEY=Ctrl && npx electron .
```
It walks you through four short steps (about 1 minute of your time) and writes `spike-results.json`. Paste it back, or commit it as `docs/spike-results/<your-name>.json`. Window titles appear in it; delete any you do not want to share.

What each step answers:
1. **Key state**: can one key be read reliably by polling, without a keyboard hook? How often, and what is the worst gap?
2. **Overlay**: does a transparent click-through always-on-top window appear without taking focus? Does Electron's idea of the cursor match Windows' on your DPI and monitors?
3. **Hit-testing**: which window is under the cursor and what does UI Automation return there (browser, Notepad, Explorer, Office, VS Code, a full-screen app)? How long does it take?
4. **Elevated windows**: what happens over an "Run as administrator" window?

Run it on the machine and setup you actually use (your DPI scaling, your monitors). If you have a second monitor with a different scale, put some of the hover time on it.
