# Collaboration reliability evidence, 2026-10-22

Real Chromium against a real Relay server, made by `THEME=light|dark node scripts/reliability-shots.ts docs/evidence/reliability-2026-10-22`. The agent in 04 is the simulated agent fixture (a real process that edits files as instructed); the verification is a real `node --test` run.

| File | What it shows |
|---|---|
| `01-not-saved-yet-*.png` | The connection is cut silently (WebSocket messages dropped, browser not told). Text typed after the cut isn't confirmed by the server, so the status bar says **Not saved yet** instead of "Synced". |
| `02-synced-after-recovery-*.png` | The connection is restored; the edit reaches the server and the status returns to **Synced**. |
| `03-line-history-*.png` | Line 4 written by three origins: the original file, Maya (typed during the outage, credited on arrival) and Bo. Each part shows its time and a link to the edit session. |
| `04-apply-refused-merged-check-*.png` | The agent's README change passed its tests in its worktree. Bo then changed `src/ui.js`. Apply rebuilt the change on the project as it is now, ran `node --test` there, saw it fail and applied nothing. The row now shows the failure instead of "Ready". |

Test runs on the final code: `npm test` 98/98, `RELAY_E2E=1 node --test test/e2e/*.e2e.test.ts` 57/57. Earlier repeat runs: unit 98/98 ×3, E2E 57/57 ×3; `test/e2e/reliability.e2e.test.ts` 8/8 ×3.
