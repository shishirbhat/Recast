# 17 · Workbench redesign audit (2026-10-21)

Baseline for the Cursor-quality redesign, taken from the code at the start of the work. It covers branch `relay`, after the VS Code parity phases 1–4 and split editors. Statuses come from reading the code and running it, not from earlier docs.

## Stack

| Area | What it is | Verdict |
|---|---|---|
| Client | Next.js 16 static export (`ide/web`), React 19, Tailwind 4 with CSS variables in `app/globals.css`, Motion, lucide icons | Keep. The token layer already exists; refine it rather than replace it |
| Editor | **Real CodeMirror 6** bound to Yjs (`components/Editor.tsx`): syntax highlighting, folding, search, minimap, indent guides, lint gutter, authorship gutter, multi-cursor | Keep. Monaco would not add enough to justify a rewrite, and Yjs binding, attribution and presence are built on CodeMirror |
| Shell | `components/workbench/Workbench.tsx`: command registry (`lib/commands.ts`), VS Code menus, palette with prefixes, activity bar, two resizable side bars, bottom panel, status bar, editor groups (split), persisted layout `relay.layout.v3` | Keep. Polish proportions, states and density |
| Server | Node 22 HTTP + WebSocket (`src/server/server.ts`), SQLite (`node:sqlite`) | Keep |
| Collaboration | Yjs over our own y-protocols server, durable documents, attribution, presence, follow | Keep |
| Terminal | Real PTY (`src/server/terminal.ts`) over WebSocket, xterm.js client, several sessions, owner-only | Keep; tidy the session strip |
| Git | Status, diffs, stage/unstage, commit, branches, pull/push, history (`gitops.ts`), GitHub ship/merge (mock-tested) | Keep |
| Tests | Integrated runner (node:test reporter for per-test results), Tests panel, Testing view | Keep |
| Diagnostics | TypeScript-parser syntax diagnostics per open file plus coordination problems | Keep. No language server |

## Coordination engine (what the UI may show)

- **Task states (engine):** `proposed`, `queued`, `running`, `blocked`, `review_required`, `failed`, `cancelled`, `completed` (`src/core/types.ts`). Active states hold their scope: queued, running, blocked, review_required.
- **Agent runs:** `starting`, `running`, `finished`, `failed`, `cancelled`, `applied` (`src/server/runs.ts`).
  - Each run has its own git worktree (`.relay/worktrees/<task>-<run>`), a snapshot commit, its changed files, stale inputs (people editing files the agent read) and an activity log.
- **Change record:** `GET /api/tasks/:id/change` (`src/analysis/change.ts`).
  - Six stages: claimed, executed, tested, contracts, approved, integrated.
  - Each stage is done, missing, failed, stale or n/a, and carries evidence.
  - The record also holds blockers, approvals and `safeToIntegrate`.
  - It is derived from what the engine stores, so it can't drift from the gates.
- **Gates enforced by the engine:**
  - completion (`relay task complete`)
  - integration across tasks that share a contract
  - an apply-run dry merge that refuses on conflict
  - approvals that only humans can give
- **Dependencies:**
  - Prerequisites: task to task.
  - Contracts: task to contract version, with superseded versions detected.
  - Contract partners: tasks on the same contract must integrate together.
  - The dependency map (`/api/impact`) links files to their consumers and the tests they affect.
- **Conflicts:**
  - Scopes can't overlap among active tasks (deterministic rule, `src/core/conflicts.ts`).
  - Outside-edit conflicts are kept as `doc_conflicts`.
  - Agents' stale inputs are tracked.

## What the UI showed before this redesign

| Surface | State |
|---|---|
| Relay side bar (right): Agents, Tasks, Contracts, Records tabs | Works, but it's a narrow list. You can't see the project's coordination at a glance: what's running, what blocks what, what's safe next |
| Task detail | Strong: a decision summary first, then the claim/verified/approved ladder, evidence and the run log |
| "Needs you" | Works: real blockers with one action each |
| Change impact (bottom panel) | Works |
| Diff view | Unified only, one file at a time; no navigation between a task's changed files |
| Overlap awareness | Partial. Scope overlap is enforced at task creation. Files an agent changed outside its scope, or files two tasks' runs both touched, are only visible inside each task |
| Visual system | Calm and consistent, but sparse. The orange accent is used for focus and active states. Dark is the default |

## Gaps this redesign closes (priority order)

1. **Coordination overview.** A first-class editor tab ("Relay: Coordination") built on a new read-only `GET /api/coordination`. It answers the six questions: what's running, what blocks what, which agents touch related files, what's finished but unverified, what's ready for review, and what can be integrated safely next. It has a dependency lane view, and every status maps to engine states.
2. **Overlap and conflict surfacing, server-side and grounded.**
   - Changed-file overlaps between tasks' runs and scopes.
   - Out-of-scope changes.
   - Stale verification and stale inputs.
   - Superseded contracts and unmet prerequisites.
   - The UI never shows "no conflicts" unless the server computed it.
3. **Diff review.**
   - Side-by-side as well as unified.
   - The changed-file list with next and previous file.
   - The task's stages beside the diff.
4. **Visual polish.**
   - Tokens: surfaces, borders, text, accent, semantics, states, type, spacing, radii, motion.
   - Denser and more precise tabs, side bars and status bar.
   - Dark and light parity.
5. **Terminal and Problems.** Problems grouped by severity and source, with counts; terminal session status.
6. **Workspace context.** Repository and worktree identity, so the main checkout is never confused with an agent's worktree.

## Known limits (unchanged by this work)

- No language server: no go to definition, references or rename symbol.
- No debugger.
- No extension host: Open VSX is browsed only.
- One provider adapter: Claude Code. Codex and Cursor aren't built.
- GitHub has only been tested against a mock API.
- No independent users have tried it yet.
