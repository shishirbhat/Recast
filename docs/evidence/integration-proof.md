# Integration proof: individually green, combined red

Generated 2026-10-26T14:12:38.267Z by `node scripts/prove-integration.ts`. Agents are simulated (deterministic edits); git, tests and Relay are real.

**Scenario.** `T-api` renames `name` to `fullName` in `src/server.js` (the accepted `user-api` contract). `T-ui` makes an unrelated change to `src/ui.js`, whose `greet()` still reads `.name`. Different files: Git sees no conflict.

## A. Without Relay

| Step | Result | Evidence |
| --- | --- | --- |
| T-api's own check | pass | `node --check src/server.js` in its worktree |
| T-ui's own check | pass | `node --test` in its worktree |
| Merge both diffs | clean | `git apply` of both patches, no conflict |
| Project tests after merge | **FAIL** | `not ok 1 - greets the user by name` |

Both tasks were green, the merge was clean, and the shared project is now broken. The failure is found only after integration.

## B. With Relay

| Step | Result | Evidence |
| --- | --- | --- |
| Integration rehearsal | **blocked** | combined worktree at tree `5443af290f`, 358 ms |
| `node --check src/server.js` on the combined change | pass |  |
| `node --test` on the combined change | FAIL | `not ok 1 - greets the user by name` |
| Gap reported | — | verification failed: node --test (exit 1) |
| Shared project | unchanged | nothing applied until the combined check passes and a person approves |

## Measured

|  | Without Relay | With Relay |
| --- | --- | --- |
| Broken changes that reached the shared project | 1 | 0 |
| When the break is found | after merge | before apply |
| Cause shown | a failing test, after the fact | the failing combined test plus the tasks and contract involved |
