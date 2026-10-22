# VS Code extension evidence, 2026-10-22

Produced by `cd vscode && npm test`: a real VS Code 1.143 (via `@vscode/test-electron`, under Xvfb) with the Relay extension, a real Relay server, a separate clone as the developer's checkout, and a real Chromium running the browser IDE.

| File | What it shows |
|---|---|
| `01-vscode-sees-browser.png` | Ada in VS Code. Line 1 is hers; line 2 was typed by Bea in the browser IDE, whose caret and name flag (green) show at the end of it. Status bar: "Relay: Synced · 2 here". |
| `02-browser-sees-vscode.png` | Bea in the browser IDE: Ada's line from VS Code, and Ada's caret with her name flag. |
| `03-invite-browser-or-vscode.png` | The invite dialog: one one-time invite, as a browser link or a VS Code link, plus the extension download served by Relay. |
| `04-browser-after-vscode-deleted-the-file.png` | The whole-file-lifecycle test, browser side: Cy's view after Ada (in VS Code) created a file, both edited it, Cy renamed it in the browser, Ada undid her line and then deleted the file for everyone from VS Code. The tab closed with a notice. |
| `05-join-link-asks-first.png` | In VS Code's extension *test* host a join link reaches Relay, which asks; the test host refuses modal dialogs ("refused to show dialog in tests"), which Relay treats as no. |
| `06-vscode-asks-to-open-the-link.png` | A normally started VS Code with the packaged `.vsix`: VS Code's own "Allow 'Relay' extension to open this URI?" for the invite link. Cancelled: nothing joined. |
| `07-relay-asks-before-joining.png` | After allowing it in VS Code, Relay's own confirmation names the server. Cancel declined (the test checks the dialog's pixels before and after, and the server saw no join). |
| `08-real-vscode-joined.png` | After clicking Join: joined; the server recorded the client as `vscode/0.2.0`, the packaged version. |
| `09-real-vscode-after-restart.png` | VS Code restarted: the session came back from VS Code's secret storage and the opened file is shared again (checked on the server). |

Results: see `RELAY_HANDOFF.md` (log entry "VS Code extension: filesystem parity …") for the final counts. Produced by `cd vscode && npm test` (01, 02, 04, 05) and `npm run test:install` (06–09).
