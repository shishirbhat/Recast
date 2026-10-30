# 17 · Positioning: the integration trust layer

**Thesis.** Every change must earn its way into the project. Relay is the editor-independent coordination and integration layer for human-and-agent software development. It doesn't compete with Cursor or Claude Code on editor polish, agent count or parallelism.

**The claim we defend.** Changes that each pass their own checks can break the project when combined. Relay finds that before anything is applied, and says why when the evidence establishes it.

## Evidence

All of it is in `docs/evidence/integration-proof.md`, in two separate sections.

**Deterministic experiment (simulated agents).** `node scripts/prove-integration.ts`, also run on every `npm test` by `test/integration-proof.test.ts`.
- One task renames an API field. Another edits the UI, in a different file, against the old field.
- Without Relay: both checks pass, the merge is clean, and the project tests fail.
- With Relay: the rehearsal blocks the change, and the project is unchanged.
- The explanation is "confirmed": T-api removed `name` from `getUser`, and `src/ui.js:4` (T-ui) still reads it. The test also requires this.
- The agents' edits are fixed. Git, the tests and Relay are real.

**Real-agent trials (Claude Code 2.1.311, headless).** `node scripts/prove-integration-real.ts`.
- The same scenario with real agents: two rounds of 3 trials, each trial run in both workflows.
- All 6 trials reproduced in both workflows: both agents green, no merge conflict, combined tests red.
- Without Relay the break was merged every time. With Relay the rehearsal blocked it every time, and the project was unchanged.
- **Round 2 also recorded Relay's explanation.** It was "confirmed" in 3 of 3 trials and accurate in 3 of 3. Accuracy was judged by running the code (the function's real return keys, the cited line, the really failing test), not by matching words.
- Cost: about $0.17–0.18 per trial without Relay and $0.24 with it.
- In round 1, an agent noticed the problem twice and said so in its final message. That warning was only chat text; it gated nothing.
- **Limits.**
  - The tasks were designed to set up the conflict, and the fixture has five files.
  - One agent was tried, for six trials.
  - Every real trial produced the same simple, fully traceable break. "Likely" and "unknown" explanations are tested only on constructed cases.
  - The trials show Relay catches and explains this break when it happens, not how often it happens in real projects.

## Where Relay runs today

| Surface | What it does | Check Together (combined rehearsal)? |
|---|---|---|
| **Agents (Claude Code)** | Runs each agent in its own worktree. A PreToolUse hook enforces scope and fails closed. MCP tools: `claim_task`, `get_task`, `get_contract`, `declare_intent`, `report_evidence`, `submit_for_review` and others. | No. Agents can't approve or integrate, by design. |
| **CLI (`relay …`)** | Local commands on the project database: `init`, `task`, `contract`, `integrate check/approve` (on one working directory), `verify`, `impact`, `change`, `context`, `decision`, `investigation`, `events`. Server commands: `ide`, `remote join/status/leave`, `integrate together`. Agent plumbing: `mcp`, `hook`, `agent-config`. | Yes: `relay integrate together T-a,T-b`, through the running server. Exit codes: 0 passed, 1 blocked, 2 usage, 3 could not complete. Never applies. |
| **HTTP API (`relay ide`)** | `POST /api/integrations/check` rehearses (combined worktree for agent tasks) and returns the record, its explanation and a text report. `GET /api/integrations/:id` reads one back. `POST /api/integrations/:id/approve` applies after a person approves. | Yes. This is the one service every client calls. |
| **Browser IDE** | Shared editing, review, agent runs. "Check with …" on a task with contract partners, the result with its cause and evidence, and approval for owners. | Yes. |
| **VS Code extension (`vscode/`)** | Join by invite link, live shared files in your own checkout, presence, own-edit undo, the Coordination view, per-task Apply. **Check Together…**: multi-select in the view or pick in a list; partners are preselected. Shows the report and explanation, a button back to each task, and Approve and Apply for owners when it passed. | Yes. |

All three clients send the same request and print the same server-rendered report, so they can't disagree about a result for the same change set and base. A per-task Apply is still refused for coupled tasks: they must be checked together.

On editor independence, the core (engine, hook, MCP, CLI, server) has no editor in it. Two editors are wired up: the browser IDE and VS Code. Cursor should work, since it runs VS Code extensions, but this hasn't been tested.

## The three innovations against the code today

**Every claim below is checked against the code.**

### A. Change Passport (`src/analysis/change.ts`)

- **Exists:**
  - One record per task, in six stages kept apart: claimed, executed, tested, contracts, approved, integrated.
  - It lists the files changed (each marked in or out of scope) and the tests with whether they are fresh.
  - It also holds security decisions, blockers, required approvals, rollback steps, and `safeToIntegrate`.
  - The record is derived from the engine's own data, so it can't drift from the gates.
  - Evidence goes stale when the workspace changes after verification.
- **Tested:** `test/change.test.ts` walks one full lifecycle: claim, failed verification, blocked integration, rerun, review, approved integration. It is a single test.
- **Missing:**
  - *Remaining uncertainty*: what the agent didn't verify, and the assumptions it stated. The trials show this matters: the agents' warnings were only chat text, and the passport holds none of it.
  - Invalidation scoped to the files and contracts the evidence covered; today it is workspace-wide.
  - A portable export format.
- **Evidence for the next step:** in round 1 of the real-agent trials, an agent saw the break coming in 3 of 6 workflow runs and only said so in text; in round 2, in none. Capturing that as structured "known risk" on the passport is the smallest change that turns an ignored warning into a blocker a reviewer sees.

### B. Integration Rehearsal (`checkTogether` / `approveTogether` in `src/server/runs.ts`, explanation in `src/analysis/explain.ts`)

- **Exists:**
  - `checkTogether` builds one isolated worktree from the coupled tasks' changes on top of the project as it is now. It rebases 3-way, or refuses on a real conflict.
  - It runs the project's checks and each task's own checks, and blocks with the failing commands and output.
  - It records the change set (each task's changed files) and the base revision.
  - It refuses while a task's run is unfinished or still being checked, and while the same tasks are already being checked. Applying or approving those tasks also waits.
  - **Explanation:** a blocked check says why when the evidence establishes it:
    - **confirmed:** which task changed which exported interface, which task's code still reads what was removed (`file:line`), the contract when current, and the failing test that reaches it;
    - **likely**, with what's not established;
    - **unknown**, with the failure only.
  - The explanation never changes the decision.
  - `approveTogether` applies only if:
    - the check passed;
    - nothing moved since: the combined tree, the shared project (new), the task states and the contract versions;
    - a person approves.
- **Tested:**
  - `test/explain.test.ts` (8): confirmed with and without a contract, unknown, stale and unrelated contracts, multiple causes, passing, TAP parsing, an old database.
  - `test/check-together.test.ts` (5, API): blocked and explained, project unchanged; refusals (viewer, editor adding commands, unknown task, empty list, mixed agent/human); approval required, and refused when stale; no apply or second check mid-rehearsal; refused while a run failed.
  - `test/cli-together.test.ts` (3, the real CLI binary).
  - The VS Code extension in a real VS Code (2 tests: selection, blocked + confirmed, unknown, refusal).
  - `test/e2e/together.e2e.test.ts` (real Chromium).
  - `test/agents.test.ts`; `test/integration-proof.test.ts`.
  - 6 real-agent trials (3 with the explanation judged).
- **Missing:**
  - Choosing *which* tests are relevant; today it runs the commands it is given.
  - Rehearsing pending change sets automatically.
  - Tracing breaks the static map can't see: dynamic property access, values passed through other functions, other languages, behaviour changes behind an unchanged interface.
  - Combining agent work with a person's uncommitted work in one check; it is refused today.
  - VS Code's "Approve and Apply" is tested only through the API, not by clicking its modal.
- **Evidence for the next step:**
  - The explanation was correct every time the break was a removed field read directly.
  - Nothing yet shows how often real agent pairs produce breaks that fall outside what the static map traces.
  - That rate decides whether to invest in deeper tracing (B) or in relevant-test selection.

### C. Dependency and decision graph

- **Exists**, as separate structures rather than one graph:
  - contracts with versions;
  - tasks bound to contract versions, which go stale when a newer version is accepted;
  - the impact map (`src/analysis/impact.ts`): changed exports → consumers → affected tests → affected tasks, parsed incrementally;
  - decision records and investigations, with sources, that go stale.
- **Tested:** `test/depgraph.test.ts` (5 tests: the parser, tracing through re-exports, incremental parsing, the full loop, the API) and `test/records.test.ts` (4 tests).
- **Missing:**
  - One graph joining all of these.
  - Automatic rechecks of active tasks when a node changes.
  - Integration outcomes feeding back into the graph.
- **Evidence for the next step:** none yet that justifies building the full graph. The real-agent trials needed only the slice that links one task's changed export to another task's read of it. That slice is now joined to the rehearsal (the explanation uses the impact map's parser and import graph), and it was enough in every trial. Building more waits until a measured case needs it.

## What changes in the plan

1. **Stopped:** IDE parity work.
   - The VS Code-parity changes are archived on the branch `archive/vscode-parity-wip` and in `stash@{0}`. They are not merged.
   - The browser IDE and the VS Code extension are clients, not the product.
2. **Editor independence: done for Check Together.** The rehearsal is reachable from the browser IDE, VS Code and the CLI through one service and one result model.
3. **Deepen B, then A, then C.** Each step is measured by an extension of the two proof scripts:
   1. ~~cause explanation in the rehearsal, from the impact map and the contract~~: done (confirmed / likely / unknown);
   2. known risks and scoped invalidation in the passport;
   3. relevant-test selection;
   4. automatic rechecks from the graph.
4. **Widen the real-agent evidence** before making broader claims. This is the recommended next investment:
   - task pairs not designed to conflict, so the base rate is known;
   - breaks the static map can't see, to measure how often the explanation is "likely" or "unknown" in practice;
   - larger repositories;
   - a second agent (Codex needs an OpenAI key, which is not set up);
   - outcome rates reported rather than single scenarios.

### Progress (2026-10-30)

- **B (rehearsal), hardened.**
  - Agent runs and combined worktrees survive restarts.
  - Retries after an uncertain outcome are idempotent.
  - Apply and approve can't overlap.
  - A failed write after approval resumes.
  - The Conflict Radar warns before a rehearsal, and a rehearsal's result settles the radar's suspicions.
  - The Arena turns the proof into a scored benchmark that also counts false alarms; four simulated scenarios so far.
- **A (passport), made portable.**
  - A changeset carries its base, patch and the exact tree every check ran on, and can be verified offline in any clone.
  - Failures can be rebuilt from their recorded tree and rerun, and are reported as reproduced or not.
- **C (graph), partly.**
  - Decision changes now mark the live tasks they touch.
  - The radar uses the dependency map across agent worktrees.
  - Relevant-test selection and automatic rechecks are still open.
- **Still open, and needing the owner:**
  - real-agent evidence beyond the one designed scenario (spend approval);
  - a second agent (OpenAI key);
  - independent users.

## Moat (hypotheses to test, not facts)

- **Integrations:** Relay works with every agent and editor a team already uses.
- **Accuracy:** tasks, changes, dependencies and revisions are mapped correctly.
- **History:** a trustworthy record of verification and integration outcomes builds up per project, which creates switching costs.
