# 17 · Positioning: the integration trust layer

**Thesis.** Every change must earn its way into the project. Relay is the editor-independent coordination and integration layer for human-and-agent software development. It doesn't compete with Cursor or Claude Code on editor polish, agent count or parallelism.

**The claim we defend.** Changes that each pass their own checks can break the project when combined. Relay finds that before anything is applied and shows why.

**Evidence.** `node scripts/prove-integration.ts` runs the same scenario two ways on a fresh repository and writes `docs/evidence/integration-proof.md`.

- **Scenario:** one task renames an API field; another edits the UI against the old field. The two touch different files, so Git sees no conflict.
- **Without Relay:** both checks pass, the merge is clean, and the shared project is broken.
- **With Relay:** the integration rehearsal is blocked on the failing combined test, and the shared project is untouched.
- **Repeatability:** it gave the same result in 3 of 3 runs.
- **Caveat:** the agents are simulated (deterministic edits). Git, the tests and Relay are real.

## The three innovations against the code today

| Innovation | Built | Missing |
|---|---|---|
| **A. Change Passport** | The per-task change record (`src/analysis/change.ts`) holds the starting revision (snapshot), the files changed, the contracts it relied on, the verification Relay ran, approval and rollback. Evidence is marked stale when the workspace changes after verification. | Explicit *remaining uncertainty*: what the agent didn't verify, and assumptions it stated. Invalidation is workspace-wide; it should be scoped to the files and contracts the evidence covered. A portable export format. |
| **B. Integration Rehearsal** | `checkTogether` builds one isolated worktree from the coupled tasks' changes (rebased 3-way onto the newest snapshot), runs the verification, and blocks with the failing command and output. `approveTogether` applies the change only after the check passes and a person approves. | Choosing *which* tests are relevant rather than running a given command. Rehearsing every pending change set automatically, not only coupled tasks. Explaining the cause beyond "this test failed", e.g. "T-ui reads `name`, removed by T-api under user-api v2". |
| **C. Dependency and decision graph** | Contracts with versions; tasks bound to contract versions (stale when a newer one is accepted); the impact map (changed interfaces → consumers → tests → affected tasks); decision records with sources that go stale. | One graph joining all of these. Automatic rechecks of active tasks when a node changes. History of integration outcomes feeding back in. |

## What changes in the plan

1. **Stop:** further IDE parity work. The VS Code-parity changes in the working tree stay uncommitted until decided; the browser IDE becomes one client among several.
2. **Editor independence first:** the CLI (`relay status / why / integrate`) and an MCP server, so Claude Code, Codex and Cursor users get Relay without switching editors. The MCP adapter and hooks already exist.
3. **Deepen B, then A, then C**, in that order; each step is measured by an extension of `prove-integration.ts`:
   - Relevant-test selection from the impact map.
   - Cause explanation from the contract and the impact map.
   - Uncertainty and scoped invalidation in the passport.
   - Automatic rechecks from the graph.
4. **Validate with real agents:** rerun the experiment with real Claude Code runs instead of simulated ones, and publish both results.

## Moat (hypotheses to test, not facts)

- **Integrations:** Relay works with every agent and editor a team already uses.
- **Accuracy:** tasks, changes, dependencies and revisions are mapped correctly.
- **History:** a trustworthy record of verification and integration outcomes builds up per project, which creates switching costs.
