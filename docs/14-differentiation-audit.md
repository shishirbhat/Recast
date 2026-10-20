# Relay — Differentiation Audit (2026-10-20)

The brief asked for `docs/13-differentiation-audit.md`. `13` is already taken by the IDE structure audit, so this is `14`.

- **Branch:** `relay` (orphan branch in `shishirbhat/Recast`; Recast itself is untouched).
- **Head at audit:** `5f79001`. The working tree was clean.
- **Runtime:** Node 22, TypeScript run natively, `node:sqlite`.
- **Client:** Next.js 16 static export.
- **Unavailable credentials:** no OpenAI key (Codex adapter blocked) and no GitHub token in this environment. The real Claude Code CLI is available and was used for the real-provider tests on 2026-10-19.

## Test inventory (run at audit time)

| Suite | Kind | Result |
|---|---|---|
| `test/engine.test.ts` (17) | Unit, real git repos | pass |
| `test/adapters.test.ts` (8) | Hook process + MCP server, real processes | pass |
| `test/collab.test.ts` (10) | Real y-websocket clients against the real server | pass |
| `test/agents.test.ts` (6) | Agent orchestration with a **simulated** agent binary (labelled as such) | pass |
| `test/terminal.test.ts` (3) | Real PTYs | pass |
| `test/github.test.ts` (7) | **Mock** GitHub REST API, real bare git remote | pass |
| `test/e2e/*.e2e.test.ts` (9) | Chromium against the built IDE | pass |
| `test/real/claude-code.real.test.ts` (3) | **Real** Claude Code (`RELAY_REAL_PROVIDER=1`) | pass on 2026-10-19 (evidence in `docs/evidence/`); not re-run here (cost) |

Root and web type-checks are clean and `next build` succeeds. No linter is configured.

## Feature matrix

| # | Capability | Implementation | Evidence | Status | Remaining work |
|---|---|---|---|---|---|
| 1.1 | Concurrent editing converges | Yjs; own y-protocols server `src/server/collab.ts`; `DocStore` in `docs.ts` | 5-client randomized test (inserts with unique markers, then mixed deletes); 2-person browser E2E | **Complete** | — |
| 1.2 | Identity and presence | `auth.ts` members/sessions, awareness with anti-forgery | Presence test, forged identity refused | **Complete** | — |
| 1.3 | Remote carets stay correct as text changes | y-codemirror relative positions; `ide/web/lib/presence.ts` | `collab.test.ts` caret test (3 clients: concurrent inserts, a delete and an insert at the same spot; reconnect) | **Complete** (one gap found and fixed, see log) | — |
| 1.4 | Offline edits and reconnect | Yjs; `pendingOffline` in the client | Offline-edit merge test | **Complete** | — |
| 1.5 | External filesystem changes | Watcher, 3-way merge, `doc_conflicts` | Two tests (merge, conflict kept) | **Complete** | — |
| 1.6 | Persistence across restarts | Update log in SQLite with compaction; atomic writes | Restart test | **Complete** | — |
| 1.7 | Secrets not shared | `isSecretPath` in files, search and git; GitHub ship | Security, search and GitHub tests | **Complete** | — |
| 1.8 | Server-side permissions | `can()` on every route; viewer read-only in sync | Security test | **Complete** | — |
| 2.1 | Tasks with acceptance criteria | `Task.verify` (commands Relay runs itself) | Completion-gate tests | **Partial** | No human-readable acceptance criteria next to the executable ones |
| 2.2 | Dependencies and contracts | Prerequisites, versioned contracts (only humans accept), partner rule | Engine tests | **Complete** | — |
| 2.3 | Isolated agent execution | Worktree per task from a snapshot commit (`runs.ts`) | Agents tests (simulated) + real Claude CLI runs | **Complete** | — |
| 2.4 | Stale assumptions from human edits | `noteHumanEdit` → `staleInputs` | Agents test | **Complete** | — |
| 2.5 | Cross-task integration gate | `checkIntegration`, `approveIntegration`, combined worktree | Engine tests incl. the real-run-3 replay; agents coupled-task test | **Complete** | — |
| 2.6 | Cancel / retry / recovery | Cancel kills the process group; `failed → queued` is human-only | Agents test, state-machine table | **Complete** | — |
| 3 | Live dependency map (consumers, tests, tasks, stale verification) | Was: none. **Now:** `src/analysis/depgraph.ts`, `impact.ts`, `GET /api/impact`, `relay impact`, IDE Impact tab | `test/depgraph.test.ts` (5) | **Implemented (JS/TS)** | Build: incremental import/export graph from the TypeScript compiler's parser; changed-interface detection; consumers, tests, tasks; stale evidence |
| 4.1 | Evidence ladder (claimed / verified / approved) | `why()` ladder, evidence table, completion gate | Engine and API tests | **Complete** | — |
| 4.2 | Single change record (owner, revision, files, tests, contracts, freshness, blockers, rollback) | **Now:** `src/analysis/change.ts`, `GET /api/tasks/:id/change`, `relay change`, IDE task detail | `test/change.test.ts` | **Implemented** | Assemble one record per task, including what makes verification stale (depends on 3) |
| 5 | Shared investigations | Was: event log only. **Now:** `src/knowledge/records.ts`, `/api/investigations`, IDE Records tab, CLI | `records.test.ts`, `records.e2e.test.ts` | **Implemented** | Investigation records: revision, repro, failing output (sanitized), hypotheses, findings vs. assumptions, attempts, owner, next steps; multi-client |
| 6 | Traceable project knowledge | Contract history + **new** decision records (`records.ts`), task context (`/api/context`, `relay context`, agent prompts) | `records.test.ts` | **Implemented** | Decision records with sources, supersede/invalidate, retrieval scoped to a task |
| 7.1 | Cross-repository coordination | Single-repo model | — | **Deferred** (reasons in the log) | — |
| 7.2 | Provider adapter boundary | **Now:** `src/providers/types.ts` contract, `claude-code.ts` adapter; runner is provider-neutral | agents tests (simulated), **real run through the runner** | **Implemented** for Claude Code; Codex blocked on an OpenAI key | Codex adapter |
| 8 | IDE and CLI share one engine | Both call `Relay` in `engine.ts`; the server adds auth. New capabilities (impact, change, context, decisions, investigations) have both an API and a CLI command | gate-bypass test, `change.test.ts` | **Complete** | API/event contract now documented in `docs/08` (v0) |
| 9.1 | Auth, authorization, path safety, CSRF, rate limits | `server.ts`, `files.ts` | Security tests | **Complete** | — |
| 9.2 | Measured performance | `bench/latency.ts`; raw results in `docs/evidence/latency-2026-10-20.json` | measured (see log) | **Measured**; one bottleneck found and fixed | WAN and multi-machine runs |
| 10 | Differentiation demo vs. baseline | **Now:** `bench/demo.ts`, `docs/evidence/demo-2026-10-20.md` (simulated agents) | demo run | **Demo implemented; baseline comparison not done** | A comparable baseline needs repeated real-provider runs (cost, time). The demo can be built; the baseline is noted as a limit |

## Prioritised plan

1. **Dependency map (3)**: the largest missing differentiator, and the change record (4.2) depends on it. Use concrete analysis only; anything inferred is labelled.
2. **Caret regression test (1.3)**: cheap, and turns "unverified" into evidence.
3. **Investigations (5) and decision records (6)**: share one sourced, sanitized record store, with an API and an IDE view.
4. **Performance measurements (9.2)**: a reproducible script with recorded conditions.
5. **Change record (4.2)**: once 3 exists.
6. **Cross-repo (7.1)**: deferred. Single-repo coordination isn't yet validated with users, and a multi-repo model adds an auth and revision surface. The dependency map's file-level model is the foundation to extend later.
7. **Demo and baseline (10)**: after 3–5. Any baseline numbers need real runs and will be reported as such.

## Risks
- Static analysis covers JS/TS imports and exports. Dynamic imports with computed paths, other languages, and runtime-only coupling (HTTP calls between services) are not seen. These are reported as gaps, never guessed.
- The TypeScript parser (`typescript`) moves from a dev dependency to a runtime dependency of the server.

## Implementation log

### Phase 3: live dependency map (implemented)

**What it does.** It parses every JS/TS file in the project with the TypeScript compiler's parser (syntax only: no type checker, no LLM). For each file it records:
- imports, re-exports, `import()` and `require()`;
- exports, with a normalized signature;
- for functions that return object literals, the keys they return;
- property reads on values returned by imported functions: `const u = getUser(); u.name`, or `const { name } = await getUser()`.

When the workspace differs from a base revision (HEAD, or a task's base commit):
1. **Interface changes.** Each exported symbol is classified as removed, signature changed, returned-shape changed (with the removed and added keys), implementation-only changed, or added.
2. **Consumers.** These are found by following imports, including through re-export barrels. Each one carries its evidence (`web/greeting.js:1 imports { getUser } from '../api/index.js' (via api/index.js:1)`). Each also lists concrete breaks: a read of a key the function no longer returns, with its line number.
3. **Affected tests.** Test files that reach the change through imports, with the import chain.
4. **Dependent tasks.** Each reason is labelled as one of:
   - **static**: from the parser (the task owns a consumer or test);
   - **declared**: from Relay (the task owns the changed file, or shares a contract with the task that does).
5. **Stale verification.** For affected tasks, the latest system evidence (diff checks, verification commands) that was recorded on a different workspace tree is listed with the change that invalidated it. The engine's completion and integration gates were already tree-bound, so they enforce this; the map explains it.
6. **Suggestions and gaps.**
   - Suggestions are concrete edits ("Update web/greeting.js:5: it reads .name, which getUser() no longer returns (now returns fullName)") plus the affected test commands.
   - What the parser can't see is listed under "unseen": computed `import()` paths, namespace re-exports, changes no test reaches.

**Incremental.** Files are re-read only when their size or mtime changes, and parses are cached by content hash. Base revisions share the same cache. A no-op refresh parsed 0 files in the test; one edit parsed 1.

**Surfaces:**
- **API:** `GET /api/impact?base=REF|task=ID`, readable by any member; the base revision is validated.
- **CLI:** `relay impact [--base REF | --task ID] --cwd DIR`.
- **IDE:** the bottom-panel **Impact** tab and the "Show Change Impact" command.

**Acceptance (fixture with a shared API, a re-export barrel, a type file, two frontend consumers, a test and an unrelated module):**
- The test changes `getUser` to return `fullName` instead of `name`. Relay finds both consumers (one through the barrel), the exact breaking lines, the test and its import chain, and the dependent tasks. The unrelated module and the docs task are not reported.
- Earlier verification of the frontend task is reported stale.
- The integration gate, given the affected tests, **blocks**. After the consumers are fixed, no breaks remain and the gate **passes**. An agent cannot approve; a person approves and both tasks complete.

**Limits:**
- JS/TS only.
- Data-flow is local and direct (assignment or destructuring from a call). Values passed through other functions aren't followed.
- No database schemas, services or cross-repo interfaces yet.
- Types are compared textually, not structurally.

### Defect found and fixed: verification commands inherited test-runner context (Broken → repaired)
While building the acceptance test, a verification command `node --test web/greeting.test.js` **passed while the test was failing**.

Cause: Relay ran verification commands with its own environment. When Relay itself runs under `node --test`, `NODE_TEST_CONTEXT` was inherited, so the nested runner skipped every file and exited 0. Relay recorded that as passing evidence. In production this would happen whenever Relay is launched from inside a test runner.

Fix: `verificationEnv()` in `src/core/engine.ts` strips `NODE_TEST_*`, `VITEST` and `JEST_WORKER_ID` from the environment of verification and integration commands. The regression test is in `test/engine.test.ts`.

### Phase 1: caret stability (Unverified → verified; one defect fixed)
**Test.** Three real clients. Ada selects a word, encoded as Yjs relative positions the way y-codemirror does it. Bo and Cy then insert before it concurrently, delete before it, and insert at the same spot. On every replica her selection still resolves to the same word.

**Defect.** After Bo dropped and reconnected, Ada's selection did not come back until her next awareness renewal (up to about 15 s). y-websocket drops remote states on disconnect but keeps their clocks, so the server's resend of an unchanged state was ignored.

**Fix.** `ide/web/lib/presence.ts` forgets remote clocks on disconnect; the IDE's `DocSession` uses it, and the test exercises the same function against the real server.

### Phases 5–6: investigations and decision records (implemented)
`src/knowledge/records.ts` is a single store for both.

**Sources.** A source is a project file or test (pinned to its blob hash), a commit (pinned to its sha), a Relay evidence record, a contract version, another decision, or a URL (unchecked).
- Citing a missing file or a secret path is refused.
- Readers see each source as current, changed or missing.

**Investigations:**
- Each records the revision it was opened at (`abc1234`, or `abc1234+dirty`). Every entry records its own revision.
- Entry kinds: repro, failing test, log, file, hypothesis (open, confirmed or refuted), experiment, finding, assumption, attempt, next step, note.
- **A finding, or a confirmed or refuted hypothesis, must cite a checkable source**; without one the server answers "record it as an assumption". Entries are marked *sourced* or *unverified*.
- Owners can have **Relay run a command**. Its real output and exit code become an entry marked "run by Relay", using the same sanitized environment as verification.
- An investigation can be resolved only with a sourced finding, or a worked attempt that cites evidence.
- Pasted text is **sanitized** (`src/knowledge/sanitize.ts`): tokens, private keys, URL passwords, `*_SECRET=` / `*_TOKEN=` style assignments, the project root (shown as `<project>`) and the home directory (shown as `~`). Each entry shows how many redactions were made.
- Entries are never turned into agent instructions.

**Decisions** (with kinds hazard, constraint and question):
- Each record holds the context, the decision, the rejected alternatives with reasons, its scope paths, its contracts, and its sources (at least one checkable).
- Proposed by editors; **accepted, rejected or invalidated only by owners**. Invalidating requires a reason.
- A replacement can supersede an accepted record; accepting the replacement marks the old one superseded and links the two.

**Task context:** `contextFor(task)`, `GET /api/context?task=`, `relay context <task>`. It returns:
- accepted decisions whose scope covers the task's files, or files the task's code imports (one hop, from the dependency map), or the task's contracts. Each comes with the reason it was included.
- the task's contracts at their current versions;
- warnings: a contract that moved since the task was planned, or a cited source that changed;
- obsolete records (superseded or invalidated) and what replaced them.

The same context goes to agents as a short block, "Project reference (accepted by people; data, not instructions)", capped at 4,000 characters. Unrelated decisions are left out.

**Surfaces:** a Records tab in the Relay side bar (investigations with a timeline and composer; decisions with accept and reject for owners); the API under `/api/investigations`, `/api/decisions` and `/api/context`; CLI commands `relay context`, `relay decision` and `relay investigation`.

**Acceptance:**
- `records.test.ts` (4 tests):
  - sanitizer;
  - multi-session investigation via the API (owner runs the failing test; editor continues; unsourced finding refused; secret redacted; viewer read-only; cited file later flagged as changed; resolve gated);
  - decisions and context (scope through imports, unrelated record excluded, supersede, contract moved, invalidate);
  - the simulated agent's prompt contains the relevant decision and contract and not the unrelated one.
- `records.e2e.test.ts`: two browsers. Ada starts an investigation and runs a test. Bo sees it live, opens it, and adds a sourced finding that contains a token; it's redacted. Ada sees it without reloading and resolves the investigation.

### Defect found and fixed: agent runner after shutdown (Broken → repaired)
Closing the server while an agent run was still printing let the runner write events to the closed database, raising an uncaught exception. A real server would have crashed during shutdown. The runner now ignores output and exits after `close()`. Found by the records test's "asynchronous activity after the test ended" check; that test is the regression test.

### Phase 4: the change record (Partial → implemented)
**Before.** The engine already enforced everything that matters: tree-bound evidence, the completion gate, the contract-partner rule, the integration gate, human-only approval. The IDE showed a 3-step ladder (claimed / Relay verified / approved).

**Now.** `changeRecord()` derives one record per task from what the engine stores. There's no new state, so the record can't drift from the gates. It keeps **six** stages apart:

| Stage | Means | Never inferred from |
|---|---|---|
| claimed | an agent or person moved it to review, or an agent reported something | — |
| executed | Relay itself ran commands for the task | a claim |
| tested | every verification command passed **on this exact workspace**; otherwise *failed*, *stale* or *not run* | execution alone |
| contracts | planned versions are still accepted, and contract partners were checked together (or *failed* or *stale*) | tests alone |
| approved | a person with authority completed it (directly or through the integration gate) | any client state |
| integrated | agent work applied with the 3-way merge, or a person's approved edits | approval of a different tree |

The record also carries:
- changed files (only this task's, not a partner's in the shared workspace);
- tests with exit codes and freshness;
- security-relevant activity: denied edits, out-of-scope intents, commands Relay runs on the machine;
- required approvals and who gave them;
- blockers from **the gate that actually applies** (per-task for a lone task, the combined integration gate for contract partners) plus breaking consumers from the dependency map;
- rollback information: the base revision with the exact `git diff` / `git checkout` commands, and the agent snapshot commits.

**Acceptance (`test/change.test.ts`, backend and frontend sharing a contract, every step through the HTTP API):**
1. The claim shows as claimed but not executed.
2. Relay's verification fails, so the record shows *failed*.
3. The combined gate **blocks**. Editor approval → 403. Owner approval of the blocked integration → 409. Editor completion → 403. Owner completion → 409 (completion gate). An editor adding machine commands to an integration check → 403.
4. The fix is made, verification reruns and passes on a fresh tree, the combined gate passes, and the record says *safe to integrate*. An agent can't approve.
5. The owner approves: approved and integrated are done, both tasks completed, rollback and security activity listed.

**Found while building it:** the first version listed the partner's file as "outside scope" and showed per-task diff-check gaps that the integration gate deliberately supersedes. The record now follows the gate that applies. The engine itself was already correct.

### Phase 9: measured latency (Unverified → measured; one bottleneck fixed)
**How it was measured.** `node bench/latency.ts --out <file>`. Real Relay server, real y-websocket clients, real Chromium for typing.
- **Conditions:** 4 × Intel Xeon 2.8 GHz, 17 GB RAM, Node 22.22, loopback 127.0.0.1, server flush interval 300 ms.
- This measures Relay's own overhead. There is no network distance and no multi-machine run.

| Measure | Target | p50 | p95 | p99 | n |
|---|---|---|---|---|---|
| Remote edit propagation, 2 clients | p95 < 50 ms | 1.87 ms | 2.58 ms | 4.0 ms | 200 |
| Remote edit propagation, 5 clients | p95 < 50 ms | 0.45 ms | 0.77 ms | 0.86 ms | 200 |
| Remote edit propagation, 10 clients | p95 < 50 ms | 0.85 ms | 1.17 ms | 2.57 ms | 200 |
| Reconnect and resync after 50 missed edits | p95 < 500 ms | 23.4 ms | 25.0 ms | 25.0 ms | 20 |
| Keystroke to paint in the IDE, with a peer in the file | p95 < 50 ms | 11.5 ms | 17.3 ms | 19.6 ms | 100 |
| Task event to subscriber, same process | p95 < 100 ms | 1.62 ms | 2.95 ms | 3.35 ms | 50 |
| Task event to subscriber, written by another process (hook/MCP/CLI) | p95 ≤ 250 ms | 48 ms | 180 ms | 180 ms | 20 |
| Edit to file on disk | ≤ flush + 50 ms | 304.6 ms | 310.1 ms | 310.1 ms | 20 |

Server RSS with 10 clients connected was 213 MB. That includes the benchmark's own clients, which run in the same process.

**Fixed.** The first run measured task-event propagation at p50 176 ms / p95 199 ms. Every event, including the server's own, waited for the 200 ms poll of the event log. The engine now notifies after each synchronous unit of work (`Relay.onEvent`, batched with `setImmediate`, so listeners only see committed rows). The server pushes its own events at once, and the poll remains for events written by other processes.
- Same process: 176 → 1.6 ms (p50).
- Regression test: `collab.test.ts`, "events recorded by the server are pushed … at once".

**How to read these:**
- Keystroke-to-paint is measured from the `keydown` timestamp to the first animation frame after CodeMirror's DOM changes. That's a close proxy for, but not the same as, compositor presentation.
- Edit-to-disk tracks the deliberate 300 ms flush. Durability before that comes from the SQLite update log, written on every update.

### Phase 7: provider adapters (implemented for Claude Code) and cross-repository work (deferred)
**Adapter contract** (`src/providers/types.ts`). An adapter declares:
- its **capabilities**: pre-edit enforcement (`pre-tool-hook` or `none`), coordination (`mcp` or `none`), cost reporting, allowed tools;
- `available()`: whether the binary or credentials are present, with a reason;
- `launch(ctx)`: writes its config and returns the command;
- `parse(line)`: turns output into tool calls, denials, results and errors. Never prose.

The runner (`src/server/runs.ts`) is now provider-neutral: snapshot and worktree, process group and cancellation, Relay's own diff check and verification after the run, combined check and 3-way apply. `GET /api/capabilities` reports the provider and its declared capabilities, so a client never implies enforcement the provider lacks.

Claude Code is the only adapter. **Codex is not implemented**: it needs an OpenAI key, which isn't available, and nothing pretends otherwise. Missing credentials block nothing else: real-provider tests are gated by `RELAY_REAL_PROVIDER=1`, and the rest of the suite uses the simulated agent.

**Real provider through the runner (first time; the IDE's Agent panel uses this path).** `test/real/runner.real.test.ts`, raw evidence in `docs/evidence/claude-code-runner-2026-10-20/run.json`. Claude Code 2.1.304:
1. claimed the task through MCP, read it, and declared an intent;
2. edited `src/greeting.js` in its worktree;
3. reported evidence and submitted for review.

Then Relay's own diff check and test passed in the worktree, and the shared file was untouched until the owner applied it. About 31 s, $0.12. One run, not a statistic.

**Defect found by that real run (Broken → repaired).** The agent's own shell inherited `NODE_TEST_CONTEXT` from the process that started Relay, so its first `node --test` silently ran nothing. The agent noticed and worked around it with `env -u`; a less careful agent would have reported a pass. Agents now get the same sanitized environment as verification commands. Regression check: `records.test.ts`, which records the environment the agent receives.

**Cross-repository coordination: deferred, deliberately.**
- **No validated demand yet.** Single-repository coordination (contracts, gates, dependency map) hasn't been validated with users. Multi-repo adds a trust surface (credentials per repository), a revision model (pinning N heads), and failure modes (partial pushes) that would dilute that validation.
- **The groundwork carries over.** Contracts already carry the interface between producers and consumers, and the dependency map's file-level model and the integration gate's "check together on one tree" are what a multi-repo version would extend.
- **What it would take:**
  - a repository registry with a pinned revision per repo;
  - contracts tagged with producer and consumer repositories;
  - a combined check that materializes each repo at its candidate revision in sibling worktrees and runs cross-repo verification;
  - approval that records every repository's tree hash.

  That would be a separate milestone, with a two-repository fixture as its acceptance test.

### Phase 2 addition: recovery after a blocked combined check (Partial → repaired)
Found while building the demo. After the combined gate blocked T-api + T-web, rerunning **only** T-web made the pair impossible to integrate: the runner required runs from one snapshot. The only option was to throw away T-api's correct work and rerun both.

The combined check now rebases runs from older snapshots onto the newest one with a 3-way apply. A real conflict refuses and asks for a joint rerun. The engine judges the combined tree against that snapshot (`rebasedOnto`, recorded with each task's original base in `integration.checked`). Each task's own base is still frozen once work starts. Regression test: `agents.test.ts`, "recovery: …".

The change record also judges agent tasks with partners by the **combined** check, not by the task's isolated worktree, where a consumer's test correctly fails without its partner.

### Phase 10: differentiation demo (implemented; baseline comparison not done)
`node bench/demo.ts --out docs/evidence/demo-2026-10-20.md` runs all 11 steps of the brief against the real server, real Yjs clients, real worktrees and the real gates. **The two coding agents are the simulated agent**, scripted to make a realistic mistake: the frontend agent updates the greeting but misses the profile card.

Results of the recorded run:

| Step | Result |
|---|---|
| 1. People edit together | 20 concurrent README lines from two people converged |
| 2. Coordinated plan | contract, two tasks and a decision record; T-web's context includes the decision through its import of `api/users.js` |
| 3–4. Agents in isolation | both ran in worktrees while Bo kept editing; shared files untouched |
| 5. Dependency found | 3 consumers and 2 breaking lines (`web/greeting.js:5`, `web/profile.js:4`), with the affected tests' import chains |
| 6. Unsafe integration blocked | combined check **blocked** on `web/web.test.js`; editor approve 403, owner approve 409; shared files unchanged; Bo records a sourced finding |
| 7. Update and recheck | only T-web reruns; the combined check rebases T-api and **passes**, with both tests run by Relay |
| 8. Inspect | change record: claimed, executed, tested (combined), contracts done; approval missing |
| 9. Approve and integrate | owner approves; 3 files applied; the shared project's tests all pass |
| 10. Edits | 25/25 typed lines present (0 lost) |
| 11. Another collaborator | a viewer reads the resolved investigation and T-web's 34-event history, and is refused any action (403) |

**The demo found three things:**
- the recovery gap above;
- the change-record freshness rule above;
- a false "FAILING" from the demo's own post-check: an empty-but-set `NODE_TEST_CONTEXT` still makes node skip. That was the same trap a third time, and it's fixed in the demo.

**Not done: a baseline comparison.** A fair comparison (same repository, task, revision and time limit; Relay vs. two agents in separate branches merged by hand) needs repeated **real-provider** runs to say anything about completion, rework or time. With the simulated agent the outcome is fixed by the script, so any "advantage" would be fabricated. The protocol is ready to run: `bench/demo.ts` for the Relay arm; the baseline arm is the same two task prompts in two plain worktrees, merged with `git merge`, then the same tests. It needs a model budget for, say, 5 runs per arm.

## Final report (2026-10-20)

**Already complete, reused unchanged:**
- Yjs collaboration, presence, auth and roles;
- offline merge, restart persistence, external-change merge and conflict keeping;
- the engine (state machine, contracts, intents, completion gate, contract-partner rule, integration gate);
- the Claude Code hook and MCP server;
- worktree isolation and 3-way apply;
- the terminal and the workbench.

**Partial, improved:**
- explicit acceptance criteria (still executable `verify` commands only);
- the change record (now six separate stages, freshness, blockers from the applicable gate, rollback);
- project knowledge (decision records with sources);
- the provider boundary (an adapter contract);
- the API and event documentation.

**Missing, newly implemented:**
- the live dependency map (`relay impact`, Impact tab);
- shared investigations;
- decision records and task context (including the agent prompt);
- the latency benchmark;
- the differentiation demo.

**Broken or unverified, repaired:**

| # | Defect | Effect | Status |
|---|---|---|---|
| 1 | Verification inherited `NODE_TEST_CONTEXT` | false passes recorded as evidence | fixed |
| 2 | Agents inherited `NODE_TEST_CONTEXT` | found in a real run | fixed |
| 3 | Remote carets didn't reappear after reconnect | up to 15 s gap | fixed |
| 4 | Agent runner wrote to the database after shutdown | uncaught exception | fixed |
| 5 | Every event waited for the 200 ms poll | slow event feed | fixed: p50 176 → 1.6 ms |
| 6 | No recovery after a blocked combined check, short of rerunning everything | lost good work | fixed |

Each has a regression test.

**Tests at the end:**
- `npm test` **66/66**;
- `RELAY_E2E=1` **10/10**;
- real-provider runner test **1/1** (real Claude Code);
- root and web type-checks clean; `next build` succeeds.

**Real vs. simulated:**
- **real:** server, clients, browser, git, worktrees, verification, and Claude Code in `test/real/` and `bench`'s runner evidence;
- **simulated:** the agent in `agents.test.ts`, `records.test.ts` and `bench/demo.ts` (labelled in each);
- **mock:** the GitHub API.

**Limits and blockers:**
- no Codex (no OpenAI key);
- no baseline comparison (needs a real-provider budget);
- the dependency map is JS/TS only, with local data-flow;
- latency was measured on loopback only;
- cross-repository work is deferred;
- the GitHub flow hasn't been run against api.github.com.

**Next highest-value task:** run the baseline comparison with the real provider: 5 runs per arm on the demo repository with a fixed time limit, measuring completion, integration failures, rework and time to verified integration. Every mechanism is now in place and measured; whether it beats the plain workflow is the open question.
