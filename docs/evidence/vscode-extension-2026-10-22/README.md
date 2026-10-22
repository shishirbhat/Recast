# VS Code extension evidence, 2026-10-22

Produced by `cd vscode && npm test`: a real VS Code 1.143 (via `@vscode/test-electron`, under Xvfb) with the Relay extension, a real Relay server, a separate clone as the developer's checkout, and a real Chromium running the browser IDE.

| File | What it shows |
|---|---|
| `01-vscode-sees-browser.png` | Ada in VS Code. Line 1 is hers; line 2 was typed by Bea in the browser IDE, whose caret and name flag (green) show at the end of it. Status bar: "Relay: Synced · 2 here". |
| `02-browser-sees-vscode.png` | Bea in the browser IDE: Ada's line from VS Code, and Ada's caret with her name flag. |
| `03-invite-browser-or-vscode.png` | The invite dialog: one one-time invite, as a browser link or a VS Code link, plus the extension download served by Relay. |

Results on the final code: extension suite 11/11 plus the browser half; it passed on 6 runs in total during development (after the binding fix). Root suites: `npm test` 98/98, `RELAY_E2E=1` browser suite 59/59.
