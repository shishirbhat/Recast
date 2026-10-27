# Integration proof: individually green, combined red

**Claim under test.** Two changes that each pass their own checks can break the project when combined. Relay's integration rehearsal finds that before anything is applied, and the shared project stays unchanged.

**Scenario.** `T-api` renames the field `name` to `fullName` in the API (the accepted `user-api` contract). `T-ui` makes an unrelated change in a different file, `src/ui.js`, whose `greet()` still reads `.name`. Different files, so Git sees no conflict.

Two kinds of evidence are kept apart below. Each section is written by its own script, and rerunning one leaves the other as it is.

| Section | Agents | Script | Deterministic? |
|---|---|---|---|
| Deterministic experiment | simulated (fixed edits) | `node scripts/prove-integration.ts` (also run by `test/integration-proof.test.ts`) | yes |
| Real-agent trials | real Claude Code, headless | `node scripts/prove-integration-real.ts --trials 3 --out <dir> --report docs/evidence/integration-proof.md` | no; costs model usage |

<!-- deterministic:start -->
## Deterministic experiment (simulated agents)

Generated 2026-10-27T12:18:30.566Z by `node scripts/prove-integration.ts`. Agents are simulated (deterministic edits); git, tests and Relay are real.

**Scenario.** `T-api` renames `name` to `fullName` in `src/server.js` (the accepted `user-api` contract). `T-ui` makes an unrelated change to `src/ui.js`, whose `greet()` still reads `.name`. Different files: Git sees no conflict.

### A. Without Relay

| Step | Result | Evidence |
| --- | --- | --- |
| T-api's own check | pass | `node --check src/server.js` in its worktree |
| T-ui's own check | pass | `node --test` in its worktree |
| Merge both diffs | clean | `git apply` of both patches, no conflict |
| Project tests after merge | **FAIL** | `not ok 1 - greets the user by name` |

Both tasks were green, the merge was clean, and the shared project is now broken. The failure is found only after integration.

### B. With Relay

| Step | Result | Evidence |
| --- | --- | --- |
| Integration rehearsal | **blocked** | combined worktree at tree `5443af290f`, 284 ms |
| `node --check src/server.js` on the combined change | pass |  |
| `node --test` on the combined change | FAIL | `not ok 1 - greets the user by name` |
| Gap reported | — | verification failed: node --test (exit 1) |
| Shared project | unchanged | nothing applied until the combined check passes and a person approves |

### Measured

|  | Without Relay | With Relay |
| --- | --- | --- |
| Broken changes that reached the shared project | 1 | 0 |
| When the break is found | after merge | before apply |
| Cause shown | a failing test, after the fact | the failing combined test, with the tasks and contract versions checked (not the cause) |
<!-- deterministic:end -->

<!-- real-agent:start -->
## Real-agent trials (Claude Code)

Generated 2026-10-27T12:15:16.101Z by `node scripts/prove-integration-real.ts --trials 3`. Agent: 2.1.311 (Claude Code), headless (`claude -p`). Every trial is listed, including failed and different outcomes; agent output was not edited.

Starting revision: the same fixture (tree `970127fbe8d9`) in a fresh temp repository for every workflow and trial. Own checks: T-api `node --test src/server.test.js`, T-ui `node --test src/ui.test.js src/footer.test.js`. Combined check: `node --test`.

### A. Without Relay (plain `claude -p` in two clones, then merge)

| Trial | T-api files | T-api own check | T-ui files | T-ui own check | Merge conflict | Combined tests | Agent time / cost | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | src/server.js, src/server.test.js | pass | src/footer.test.js, src/ui.js | pass | no | **FAIL** `not ok 3 - greets the user by name` | 17 s / $0.178 | reproduced: both green, combined red |
| 2 | src/server.js, src/server.test.js | pass | src/footer.test.js, src/ui.js | pass | no | **FAIL** `not ok 3 - greets the user by name` | 14 s / $0.167 | reproduced: both green, combined red |
| 3 | src/server.js, src/server.test.js | pass | src/footer.test.js, src/ui.js | pass | no | **FAIL** `not ok 3 - greets the user by name` | 14 s / $0.169 | reproduced: both green, combined red |

### B. With Relay (Relay's agent runner, then the integration rehearsal)

| Trial | T-api files | T-api own check | T-ui files | T-ui own check | Rehearsal | Combined tests | Project unchanged | Agent time / cost | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | src/server.js, src/server.test.js | pass | src/footer.test.js, src/ui.js | pass | **blocked** | **FAIL** `not ok 2 - greets the user by name` | yes | 25 s / $0.235 | reproduced: both green, combined red |
| 2 | src/server.js, src/server.test.js | pass | src/footer.test.js, src/ui.js | pass | **blocked** | **FAIL** `not ok 2 - greets the user by name` | yes | 26 s / $0.232 | reproduced: both green, combined red |
| 3 | src/server.js, src/server.test.js | pass | src/footer.test.js, src/ui.js | pass | **blocked** | **FAIL** `not ok 2 - greets the user by name` | yes | 29 s / $0.242 | reproduced: both green, combined red |
<!-- real-agent:end -->

### How the real-agent trials were run

- **Isolation.** Every workflow in every trial starts from a fresh temp repository holding the same fixture (same tree hash). Nothing runs inside this project. Each agent works in its own copy: a `git clone` in workflow A, a Relay worktree in workflow B.
- **Prompts.** The same objective and file scope in both workflows (full text in `real-agent-2026-10-27/results.json`):
  - `T-api`: rename `name` to `fullName` in `src/server.js`, update `src/server.test.js`, run `node --test src/server.test.js`.
  - `T-ui`: change the footer in `src/ui.js`, add `src/footer.test.js`, run `node --test src/ui.test.js src/footer.test.js`.
  - Neither agent was asked to break anything, skip a check or ignore a failure.
- **Workflow A.** Plain `claude -p --permission-mode acceptEdits` with Read, Edit, Write, Bash, Glob and Grep. The harness reruns each task's own check in its clone, applies both diffs to a third clone and runs `node --test`.
- **Workflow B.** Relay's agent runner. It launches the same CLI with Relay's PreToolUse hook and MCP server. Its prompt wraps the same objective and scope with Relay's coordination lines (`claim_task`, `get_task`, read the contracts, `submit_for_review`). Both tasks are bound to `user-api` v1. Relay runs each task's own check itself. Then `checkTogether` builds the combined change in a separate worktree and runs `node --test`.
- **Approval.** Nothing was approved or applied. "Project unchanged" compares the hash of every file in the shared repository, and its HEAD tree, before and after.
- **Classification rules** (`classify()` in the script):
  - an agent that errors or whose own check fails is an *agent failure*;
  - a merge conflict, or a combined change that passes, is a *different outcome*;
  - a harness error is *inconclusive*;
  - only "both green, combined red" counts as *reproduced*.
- **Raw data.** `docs/evidence/real-agent-2026-10-27/` holds, for every trial, both agents' final messages, costs, durations, changed files and the exact patches. Agent output was not edited.

### What the agents did

- **All 12 agent runs did their task and nothing else.**
  - No run changed a file outside its scope.
  - No run was denied by Relay's hook.
  - Every own check passed when the harness reran it.
  - `T-api`'s patch was byte-identical across all six runs.
- **The agents sometimes saw the problem but did not fix it.**
  - A, trial 1: the `T-api` agent said, in its final message, that `src/ui.js` would now print `Hello undefined`. It left the file alone because it was out of scope, and asked whether to fix it.
  - B, trials 1 and 3: the `T-ui` agent read the `user-api` contract through Relay's MCP tools and noticed `greet()` reads `.name`. It left it alone, because its own test passed against the code in its worktree.
  - In both cases the warning existed only as text in a chat transcript. In workflow A, nothing stopped the merge. In workflow B, the rehearsal blocked it, whatever the agents said.
- **Relay blocked for two reasons.** Its gaps named `node --test` failing on the combined change, and also `T-ui`'s own check failing once `T-api`'s change was under it.
- **Cost.** Per trial: about $0.17 in A and $0.24 in B (Relay's coordination turns). Agent time: about 15 s in A and 27 s in B.
- **One extra run, not counted.** Before the three counted trials, one smoke trial was run to validate the harness. It had the same outcome in both workflows (A $0.19, B $0.25).

### What this does and does not show

- **It shows:**
  - real Claude Code agents, given ordinary scoped tasks, produce two changes that are each green and break the project together;
  - without a combined check, that break is merged;
  - Relay's rehearsal blocked it 3 times out of 3 and left the project untouched.
- **It does not show:**
  - **How often this happens in real projects.** The tasks were chosen to set up the conflict. The fixture is five files with one consumer of the renamed field.
  - **That Relay explains the cause.** It reports the failing test and command, not "T-ui reads a field T-api removed".
  - **Agent variety.** Only one agent was tried (Claude Code), one model, 3 trials. A wider task set, other agents and larger repositories are still to be run.
  - **That the workflows are identical.** Workflow B's agents also received Relay's coordination instructions and could read the contract, so their prompts were not identical to workflow A's. In these trials this changed what the agents said, not what they changed.
