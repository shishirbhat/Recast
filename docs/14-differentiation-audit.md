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
| 4.2 | Single change record (owner, revision, files, tests, contracts, freshness, blockers, rollback) | Spread across task, evidence, runs and integrations | — | **Partial** | Assemble one record per task, including what makes verification stale (depends on 3) |
| 5 | Shared investigations | Was: event log only. **Now:** `src/knowledge/records.ts`, `/api/investigations`, IDE Records tab, CLI | `records.test.ts`, `records.e2e.test.ts` | **Implemented** | Investigation records: revision, repro, failing output (sanitized), hypotheses, findings vs. assumptions, attempts, owner, next steps; multi-client |
| 6 | Traceable project knowledge | Contract history + **new** decision records (`records.ts`), task context (`/api/context`, `relay context`, agent prompts) | `records.test.ts` | **Implemented** | Decision records with sources, supersede/invalidate, retrieval scoped to a task |
| 7.1 | Cross-repository coordination | Single-repo model | — | **Missing** | Deferred; see below |
| 7.2 | Provider adapter boundary | Claude Code hook + MCP; Codex not built | Real Claude tests | **Partial** | Codex needs an OpenAI key; the adapter contract isn't documented |
| 8 | IDE and CLI share one engine | Both call `Relay` in `engine.ts`; the server adds auth | "IDE API cannot bypass the integration gate" test | **Complete** | Document API/event contracts (`docs/08` covers part) |
| 9.1 | Auth, authorization, path safety, CSRF, rate limits | `server.ts`, `files.ts` | Security tests | **Complete** | — |
| 9.2 | Measured performance | — | — | **Unverified** | Measure edit propagation, reconnect, task-event latency |
| 10 | Differentiation demo vs. baseline | — | — | **Missing** | A comparable baseline needs repeated real-provider runs (cost, time). The demo can be built; the baseline is noted as a limit |

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
