# Integration proof: individually green, combined red

**Claim under test.** Two changes that each pass their own checks can break the project when combined. Relay's integration rehearsal finds that before anything is applied, leaves the shared project unchanged, and says why it failed when the evidence establishes it.

**Scenario.** `T-api` renames the field `name` to `fullName` in the API (the accepted `user-api` contract). `T-ui` makes an unrelated change in a different file, `src/ui.js`, whose `greet()` still reads `.name`. Different files, so Git sees no conflict.

Two kinds of evidence are kept apart below. Each section is written by its own script, and rerunning one leaves the other as it is.

| Section | Agents | Script | Deterministic? |
|---|---|---|---|
| Deterministic experiment | simulated (fixed edits) | `node scripts/prove-integration.ts` (also run on every `npm test` by `test/integration-proof.test.ts`, which requires a confirmed explanation) | yes |
| Real-agent trials | real Claude Code, headless | `node scripts/prove-integration-real.ts --trials 3 --out <dir> --report docs/evidence/integration-proof.md` | no; costs model usage |

**Which claim rests on which evidence.**

| Claim | Deterministic tests | Real-agent trials |
|---|---|---|
| Each change passes its own checks, Git merges cleanly, the combined project fails | the proof script | 6 of 6 trials (two rounds of 3), both workflows |
| Relay blocks the combination and the shared project is unchanged | the proof script; `test/check-together.test.ts`; `test/cli-together.test.ts`; the VS Code and browser tests | 6 of 6 trials |
| The explanation names the change, the consumer, the contract and the failing test, as **confirmed** | `test/explain.test.ts`; the proof script | 3 of 3 trials in round 2, each judged accurate by running the code |
| **Likely** and **unknown** are reported instead of a guess when the evidence is incomplete | `test/explain.test.ts` (multiple causes, no traceable change, stale or unrelated contract); the VS Code test (unknown) | not exercised: every real trial produced the same, fully traceable break |

<!-- deterministic:start -->
## Deterministic experiment (simulated agents)

Generated 2026-10-27T17:36:07.745Z by `node scripts/prove-integration.ts`. Agents are simulated (deterministic edits); git, tests and Relay are real.

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
| Integration rehearsal | **blocked** | combined worktree at tree `5443af290f`, 455 ms |
| `node --check src/server.js` on the combined change | pass |  |
| `node --test` on the combined change | FAIL | `not ok 1 - greets the user by name` |
| Gap reported | — | verification failed: node --test (exit 1) |
| Shared project | unchanged | nothing applied until the combined check passes and a person approves |

#### Relay's explanation

**Verdict: confirmed.** Confirmed cause: T-api changed getUser in src/server.js (part of contract user-api v1) so it no longer returns `name` (it now returns `fullName`). T-ui still reads `name` from getUser() at src/ui.js:4. The combined verification failed on it: `node --test`, "greets the user by name" (src/ui.test.js). Relay blocked integration because combined verification failed.

Evidence for cause 1 (confirmed):

- src/server.js:1: getUser returns {id, name} → returns {fullName, id} (base ee5a94804d → combined tree)
- src/server.js changed by T-api
- src/ui.js:1 imports { getUser } from './server.js'
- src/ui.js:4 reads .name, which getUser() no longer returns
- node --test: not ok "greets the user by name" (src/ui.test.js, which reaches src/ui.js through imports)
- contract user-api v1 (shared by T-api, T-ui) defines getUser: "getUser(id) -> { id, fullName }"; it does not include `name`; it includes `fullName`

To resolve: T-api and T-ui must be made compatible: either the consumer moves to the new interface or the interface keeps what the consumer reads. Relay does not choose; the task owners decide, then check together again.

### Measured

|  | Without Relay | With Relay |
| --- | --- | --- |
| Broken changes that reached the shared project | 1 | 0 |
| When the break is found | after merge | before apply |
| Cause shown | a failing test, after the fact | the failing combined test, and the cause: confirmed (below) |
<!-- deterministic:end -->

<!-- real-agent:start -->
## Real-agent trials (Claude Code)

Generated 2026-10-27T17:24:54.729Z by `node scripts/prove-integration-real.ts --trials 3`. Agent: 2.1.311 (Claude Code), headless (`claude -p`). Every trial is listed, including failed and different outcomes; agent output was not edited.

Starting revision: the same fixture (tree `970127fbe8d9`) in a fresh temp repository for every workflow and trial. Own checks: T-api `node --test src/server.test.js`, T-ui `node --test src/ui.test.js src/footer.test.js`. Combined check: `node --test`.

### A. Without Relay (plain `claude -p` in two clones, then merge)

| Trial | T-api files | T-api own check | T-ui files | T-ui own check | Merge conflict | Combined tests | Agent time / cost | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | src/server.js, src/server.test.js | pass | src/footer.test.js, src/ui.js | pass | no | **FAIL** `not ok 3 - greets the user by name` | 23 s / $0.194 | reproduced: both green, combined red |
| 2 | src/server.js, src/server.test.js | pass | src/footer.test.js, src/ui.js | pass | no | **FAIL** `not ok 3 - greets the user by name` | 21 s / $0.169 | reproduced: both green, combined red |
| 3 | src/server.js, src/server.test.js | pass | src/footer.test.js, src/ui.js | pass | no | **FAIL** `not ok 3 - greets the user by name` | 21 s / $0.167 | reproduced: both green, combined red |

### B. With Relay (Relay's agent runner, then the integration rehearsal)

| Trial | T-api files | T-api own check | T-ui files | T-ui own check | Rehearsal | Combined tests | Project unchanged | Explanation | Accurate | Agent time / cost | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | src/server.js, src/server.test.js | pass | src/footer.test.js, src/ui.js | pass | **blocked** | **FAIL** `not ok 2 - greets the user by name` | yes | confirmed | yes | 36 s / $0.238 | reproduced: both green, combined red |
| 2 | src/server.js, src/server.test.js | pass | src/footer.test.js, src/ui.js | pass | **blocked** | **FAIL** `not ok 2 - greets the user by name` | yes | confirmed | yes | 31 s / $0.241 | reproduced: both green, combined red |
| 3 | src/server.js, src/server.test.js | pass | src/footer.test.js, src/ui.js | pass | **blocked** | **FAIL** `not ok 2 - greets the user by name` | yes | confirmed | yes | 37 s / $0.241 | reproduced: both green, combined red |

#### Relay's explanation in each trial

Judged by running the code, not by matching words: the provider function is called on the base and the combined tree, the cited consumer line is read, and the cited tests must really fail (`judge()` in the script).

- **Trial 1: confirmed, accurate.** Confirmed cause: T-api changed getUser in src/server.js (part of contract user-api v1) so it no longer returns `name` (it now returns `fullName`). T-ui still reads `name` from getUser() at src/ui.js:4. The combined verification failed on it: `node --test src/ui.test.js src/footer.test.js`, "greets the user by name" (src/ui.test.js). Relay blocked integration because combined verification failed.
  - ok getUser(1) really stopped returning name (base ["id","name"], combined ["id","fullName"])
  - ok src/ui.js:4 reads .name: return 'Hello ' + getUser(id).name;
  - ok src/server.js was changed by T-api's own patch
  - ok src/ui.js is in T-ui's scope
  - ok cited failing test(s) really fail on the combined tree: greets the user by name
- **Trial 2: confirmed, accurate.** Confirmed cause: T-api changed getUser in src/server.js (part of contract user-api v1) so it no longer returns `name` (it now returns `fullName`). T-ui still reads `name` from getUser() at src/ui.js:4. The combined verification failed on it: `node --test src/ui.test.js src/footer.test.js`, "greets the user by name" (src/ui.test.js). Relay blocked integration because combined verification failed.
  - ok getUser(1) really stopped returning name (base ["id","name"], combined ["id","fullName"])
  - ok src/ui.js:4 reads .name: return 'Hello ' + getUser(id).name;
  - ok src/server.js was changed by T-api's own patch
  - ok src/ui.js is in T-ui's scope
  - ok cited failing test(s) really fail on the combined tree: greets the user by name
- **Trial 3: confirmed, accurate.** Confirmed cause: T-api changed getUser in src/server.js (part of contract user-api v1) so it no longer returns `name` (it now returns `fullName`). T-ui still reads `name` from getUser() at src/ui.js:4. The combined verification failed on it: `node --test src/ui.test.js src/footer.test.js`, "greets the user by name" (src/ui.test.js). Relay blocked integration because combined verification failed.
  - ok getUser(1) really stopped returning name (base ["id","name"], combined ["id","fullName"])
  - ok src/ui.js:4 reads .name: return 'Hello ' + getUser(id).name;
  - ok src/server.js was changed by T-api's own patch
  - ok src/ui.js is in T-ui's scope
  - ok cited failing test(s) really fail on the combined tree: greets the user by name
<!-- real-agent:end -->

### How Relay explains a failed combined check

The block always comes from the combined verification. The explanation is computed afterwards from the same tree and stored with the integration record (`explanation`), so the browser IDE, VS Code and the CLI show the same one. It never changes the result. It follows one chain, step by step, and each step needs evidence (`src/analysis/explain.ts`):

1. **An exported interface changed** between the base revision and the combined tree, parsed from source. Examples: a function no longer returns a key, its signature changed, or it was removed.
2. **Who changed it.** The providing task's own run diff when Relay ran it as an agent, otherwise the task's declared scope. The two are labelled differently.
3. **A consumer imports it and reads what's gone.** Static data flow from the dependency map: `const u = getUser(); u.name`, `getUser(id).name`, `(await getUser(id)).name`, destructuring, and re-exports along the way. Similar names are never enough: the consumer must import the symbol.
4. **Who owns the consumer:** the task whose scope covers the file.
5. **The failure points at it.** A failing test's reported location (TAP `location:`), or a project file named in a non-TAP failure's output, must reach the consumer through imports.
6. **The contract.** Used only when it is accepted and every involved task is on its current version, and only if its definition names the symbol. A stale, missing or unrelated contract is listed as such and is not presented as proof.

| Verdict | When | What it says |
|---|---|---|
| **confirmed** | every failing test is linked to exactly one concrete break through steps 1–5 | the task that changed the interface, the task that still uses it, the field and `file:line`, the failing test, the contract when current |
| **likely** | a link is missing: no specific broken read, a failing test that also reaches another candidate break, a failure that can't be traced to the consumer, or not every failure explained | each candidate cause, and for each what is not established |
| **unknown** | no traced change explains the failure | the failing tests and output only; no cause is invented |

The report every client prints puts the verification result first (each command, pass or fail, the failing tests with `file:line` and expected vs. actual), then why Relay blocked it, then the cause with its evidence. It ends with what must be resolved, without choosing which task's change should win.

### How the real-agent trials were run

- **Two rounds**, the same setup:
  - **Round 1:** 3 trials, before the explanation existed. Raw data in `real-agent-2026-10-27/`.
  - **Round 2:** 3 trials, with the explanation recorded and judged. Raw data in `real-agent-2026-10-27-explanations/`. The tables above are round 2.
- **Isolation.** Every workflow in every trial starts from a fresh temp repository holding the same fixture (same tree hash). Nothing runs inside this project. Each agent works in its own copy: a `git clone` in workflow A, a Relay worktree in workflow B.
- **Prompts.** The same objective and file scope in both workflows (full text in `results.json`):
  - `T-api`: rename `name` to `fullName` in `src/server.js`, update `src/server.test.js`, run `node --test src/server.test.js`.
  - `T-ui`: change the footer in `src/ui.js`, add `src/footer.test.js`, run `node --test src/ui.test.js src/footer.test.js`.
  - Neither agent was asked to break anything, skip a check or ignore a failure.
- **Workflow A.** Plain `claude -p --permission-mode acceptEdits` with Read, Edit, Write, Bash, Glob and Grep. The harness reruns each task's own check in its clone, applies both diffs to a third clone and runs `node --test`.
- **Workflow B.**
  - Relay's agent runner launches the same CLI with Relay's PreToolUse hook and MCP server.
  - Its prompt wraps the same objective and scope with Relay's coordination lines (`claim_task`, `get_task`, read the contracts, `submit_for_review`).
  - Both tasks are bound to `user-api` v1, and Relay runs each task's own check itself.
  - Then `checkTogether` builds the combined change in a separate worktree, runs `node --test`, and records the explanation.
- **Explanation accuracy** (`judge()` in the script). Checked against the code, not against the wording:
  - the combined tree is rebuilt from the agents' patches;
  - the function the explanation blames is imported from the base and the combined tree and called, and the keys it really stopped returning must include the ones claimed;
  - the cited consumer line must read one of them;
  - the blamed file must be in the providing task's own patch, and the consumer must be in the other task's scope;
  - the cited tests must really fail on the combined tree.
- **Approval.** Nothing was approved or applied. "Project unchanged" compares the hash of every file in the shared repository, and its HEAD tree, before and after.
- **Classification rules** (`classify()` in the script):
  - an agent that errors or whose own check fails is an *agent failure*;
  - a merge conflict, or a combined change that passes, is a *different outcome*;
  - a harness error is *inconclusive*;
  - only "both green, combined red" counts as *reproduced*.
- **Raw data.** The raw-data folders hold, for every trial, both agents' final messages, costs, durations, changed files, the exact patches, and in round 2 the explanation and each accuracy check. Agent output was not edited.

### What the agents did

- **Both rounds: all 24 agent runs did their task and nothing else.**
  - No run changed a file outside its scope.
  - No run was denied by Relay's hook.
  - Every own check passed when the harness reran it.
  - `T-api`'s patch was byte-identical across all 12 runs.
  - No trial was an agent failure, a different outcome or inconclusive.
- **The agents sometimes saw the problem but did not fix it (round 1).**
  - A, trial 1: the `T-api` agent said, in its final message, that `src/ui.js` would now print `Hello undefined`. It left the file alone because it was out of scope.
  - B, trials 1 and 3: the `T-ui` agent noticed, from the contract, that `greet()` reads `.name`, and left it alone because its own test passed.
  - In round 2, no agent mentioned it.
  - Either way, the warning existed only as chat text. Relay's explanation is derived from the code and the test result, not from what an agent said.
- **Relay blocked for two reasons** in every workflow B trial: `node --test` failing on the combined change, and `T-ui`'s own check failing once `T-api`'s change was under it. The explanation linked both to the same break.
- **Cost (round 2).** Per trial: about $0.18 in A and $0.24 in B. Agent time: about 22 s in A and 37 s in B.
- **Uncounted runs.** Each round started with one smoke trial to validate the harness:
  - round 1, both workflows (A $0.19, B $0.25);
  - round 2, workflow B only ($0.24, confirmed and accurate).
  - Both had the same outcome as the counted trials.

### What this does and does not show

- **It shows:**
  - real Claude Code agents, given ordinary scoped tasks, produce two changes that are each green and break the project together;
  - without a combined check, that break is merged;
  - Relay's rehearsal blocked it 6 times out of 6 and left the project untouched;
  - in 3 of 3 trials, Relay's explanation named the right change, task, consumer line, contract and failing test, as checked by running the code.
- **It does not show:**
  - **How often this happens in real projects.** The tasks were chosen to set up the conflict. The fixture is five files with one consumer of the renamed field.
  - **Explanations in harder cases.** Every real trial produced the same simple break. "Likely" and "unknown" are tested only on constructed cases.
  - **Breaks Relay can't trace.** The dependency map is static analysis of JavaScript and TypeScript:
    - dynamic access (`obj[key]`) is not followed;
    - values passed through other functions are not followed;
    - other languages, behaviour changes that keep the same interface, and failures in runners without TAP locations and without file paths in their output are not traced.
    - These come out as "likely" or "unknown", with the failing output shown.
  - **Agent variety.** One agent (Claude Code), one model, 6 trials. Other agents and larger repositories are still to be run.
  - **That the workflows are identical.** Workflow B's agents also received Relay's coordination instructions and could read the contract. In these trials this changed what the agents said, not what they changed.
