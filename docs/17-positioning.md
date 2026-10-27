# 17 · Positioning: the integration trust layer

**Thesis.** Every change must earn its way into the project. Relay is the editor-independent coordination and integration layer for human-and-agent software development. It doesn't compete with Cursor or Claude Code on editor polish, agent count or parallelism.

**The claim we defend.** Changes that each pass their own checks can break the project when combined. Relay finds that before anything is applied.

## Evidence

All of it is in `docs/evidence/integration-proof.md`, in two separate sections.

**Deterministic experiment (simulated agents).** `node scripts/prove-integration.ts`, also run on every `npm test` by `test/integration-proof.test.ts`.
- One task renames an API field. Another edits the UI, in a different file, against the old field.
- Without Relay: both checks pass, the merge is clean, and the project tests fail.
- With Relay: the rehearsal blocks the change, and the project is unchanged.
- The agents' edits are fixed. Git, the tests and Relay are real.

**Real-agent trials (Claude Code 2.1.311, headless).** `node scripts/prove-integration-real.ts`.
- The same scenario, with real agents, run 3 times in each workflow.
- All 3 trials reproduced in both workflows: both agents green, no merge conflict, combined tests red.
- Without Relay the break was merged every time. With Relay the rehearsal blocked it every time, and the project was unchanged.
- Cost: about $0.17 per trial without Relay and $0.24 with it.
- Twice, an agent noticed the problem and said so in its final message. That warning was only chat text; it gated nothing.
- **Limits.** The tasks were designed to set up the conflict. The fixture has five files. One agent was tried, for three trials. The trials show Relay catches this when it happens, not how often it happens in real projects.

## Where Relay runs today

| Surface | What it does | Integration rehearsal from there? |
|---|---|---|
| **Agents (Claude Code)** | Runs each agent in its own worktree. A PreToolUse hook enforces scope and fails closed. MCP tools: `claim_task`, `get_task`, `get_contract`, `declare_intent`, `report_evidence`, `submit_for_review` and others. | No. Agents can't approve or integrate, by design. |
| **CLI (`relay …`)** | `init`, `task`, `contract`, `integrate check/approve` (on a given working directory), `verify`, `impact`, `change`, `context`, `decision`, `investigation`, `events`, `serve`, `mcp`, `hook`, `agent-config`. | Yes, on one working directory. It does not build the combined worktree of agent runs. |
| **HTTP API (`relay serve`)** | `POST /integrations/check` builds the combined worktree for agent tasks and rehearses it. `POST /integrations/:id/approve` applies it after a person approves. | Yes. |
| **Browser IDE** | Shared editing, review, agent runs, and the combined check and approval. | Yes. |
| **VS Code extension (`vscode/`)** | Join by invite link. Live shared files in your own checkout and with your own extensions. Presence. Undo that reverts only your own edits. A Coordination view of tasks, status and blockers. A per-task **Apply to Project** for owners. | No. For coupled tasks, a per-task apply is refused (`test/agents.test.ts`), so they still need the browser IDE or the API. |

On editor independence, the core (engine, hook, MCP, CLI, server) has no editor in it. Two editors are wired up: the browser IDE and VS Code. Cursor should work, since it runs VS Code extensions, but this hasn't been tested. The VS Code extension's tests run inside a real VS Code (`npm test` in `vscode/`). They were not rerun in this session, because doing so needs its dependencies and a VS Code download.

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
- **Evidence for the next step:** in 2 of the 6 real-agent workflow runs, an agent saw the break coming and only said so in text. Capturing that as structured "known risk" on the passport is the smallest change that turns an ignored warning into a blocker a reviewer sees.

### B. Integration Rehearsal (`checkTogether` / `approveTogether` in `src/server/runs.ts`)

- **Exists:**
  - `checkTogether` builds one isolated worktree from the coupled tasks' changes. It rebases them 3-way onto the newest snapshot, or refuses on a real conflict.
  - It runs the project's checks and each task's own checks on the result, and blocks with the failing commands and their output.
  - `approveTogether` applies the change only if the check passed, the tree is unchanged since, the contract versions still hold and a person approves. These rules are enforced in the engine, not the client.
  - Approving one coupled task alone is refused.
- **Tested:**
  - `test/agents.test.ts`: the coupled gate; recovery after a block, where only the broken task is rerun.
  - `test/depgraph.test.ts`: the full loop.
  - `test/integration-proof.test.ts`: the deterministic proof.
  - 3 real-agent trials, recorded but not run in CI.
- **Missing:**
  - Choosing *which* tests are relevant; today it runs the commands it is given.
  - Rehearsing every pending change set automatically, not only tasks someone checks together.
  - Explaining the cause. It reports "`node --test` failed: greets the user by name", not "T-ui reads `name`, which T-api removed under user-api".
  - A rehearsal in the VS Code extension and in the CLI's agent-run path.
- **Evidence for the next step:** the rehearsal caught 3 of 3 real-agent breaks that a clean merge let through 3 of 3 times. What it reported each time was a failing test name. The next measurable step is the cause explanation, built from the impact map (C) and the contract.

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
- **Evidence for the next step:** none yet that justifies building the full graph. The real-agent trials need only the slice that links T-api's changed export to T-ui's read of it. That slice already exists in the impact map; it just isn't joined to the rehearsal. Building more waits until a measured case needs it.

## What changes in the plan

1. **Stop:** IDE parity work.
   - The VS Code-parity changes are archived on the branch `archive/vscode-parity-wip` and in `stash@{0}`. They are not merged.
   - The browser IDE and the VS Code extension are clients, not the product.
2. **Editor independence:** the core is already editor-free. What is missing:
   - the combined rehearsal from the CLI for agent runs, so terminal-only users get it;
   - a "Check together" action in the VS Code extension, where Apply is refused today for coupled tasks.
3. **Deepen B, then A, then C.** Each step is measured by an extension of the two proof scripts:
   1. cause explanation in the rehearsal, from the impact map and the contract;
   2. known risks and scoped invalidation in the passport;
   3. relevant-test selection;
   4. automatic rechecks from the graph.
4. **Widen the real-agent evidence** before making broader claims:
   - more task pairs, including ones not designed to conflict;
   - larger repositories;
   - a second agent (Codex needs an OpenAI key, which is not set up);
   - outcome rates reported rather than single scenarios.

## Moat (hypotheses to test, not facts)

- **Integrations:** Relay works with every agent and editor a team already uses.
- **Accuracy:** tasks, changes, dependencies and revisions are mapped correctly.
- **History:** a trustworthy record of verification and integration outcomes builds up per project, which creates switching costs.
