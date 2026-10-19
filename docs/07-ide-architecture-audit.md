# Relay IDE — Architecture Audit (2026-10-19)

## What exists (verified at c56a0a1)

| Area | State | Evidence |
|---|---|---|
| Coordination engine (`src/core`) | Task state machine, versioned contracts, intents, deterministic conflict rules, completion gate, cross-task integration gate, append-only events. SQLite through `node:sqlite` | 26 unit/integration tests pass. CI green |
| Claude Code adapter | Fail-closed `PreToolUse` hook plus a task-bound MCP server, injected with `--settings`/`--mcp-config` | 3 real `claude -p` tests pass (`docs/evidence/`) |
| CLI (`src/cli.ts`) | Every engine operation, plain output | Exercised by tests and a smoke run |
| Terminal theme (`src/ui/theme.ts`) | Preview only. No command uses it | `scripts/preview-ui.ts` |
| IDE, collaboration, presence, auth | **None** | — |
| Agent worktree isolation / orchestration | **None.** Agents ran in disposable temp repos | — |
| Lint / build | No linter configured. No build step (Node type stripping) | — |

### Reusable as-is
- `Relay` engine: the single source of truth for tasks, contracts and gates. The IDE server calls it in-process, so there's no second implementation.
- `checkEdit` / `diffCheck` / `checkIntegration` / `approveIntegration`: the same rules for CLI, IDE and agents.
- The Claude Code hook and MCP server, for agent runs started from the IDE.
- `workspaceFingerprint` / `changedFiles` (git plumbing) for snapshots and reviews.

### Needs extending
- **Identity.** Today the actor is a free-form string (`--as NAME`). The IDE needs authenticated members with roles, enforced by the server. The CLI stays a local, trusted, owner-level tool (it already has filesystem access to the DB).
- **Events** are written but not pushed. The IDE needs a live event feed (server broadcast after each engine call).
- **Agent execution** needs worktrees taken from a snapshot of the *shared* state, plus a safe way to apply changes back.

## Risks found

| Risk | Severity | Note |
|---|---|---|
| Engine methods trust their `actor` argument | High once networked | The server must derive the actor from the authenticated session, never from the request body. |
| SQLite with concurrent writers | Medium | WAL plus `BEGIN IMMEDIATE` plus a busy timeout already serialize writers. The IDE server is a single process, so contention stays low. |
| Agents and humans writing the same working tree | High | Today nothing stops it. The IDE design routes human edits through Yjs and agent edits through worktrees, and applies agent changes back only with a 3-way merge. |
| Secrets in project context | High | The file tree and docs must exclude `.env*`, keys, `.git/`, `.relay/`, and anything gitignored by default. |
| Running the server on a network interface | High | Default bind is 127.0.0.1. Sharing needs an explicit flag and should sit behind TLS (a reverse proxy or tunnel). Documented, not built. |

## Proposed architecture and migration (summary; details in 08)

1. **Collaboration service** inside the Relay server: Yjs documents, one per file, synced over WebSocket (y-protocols sync + awareness). It has its own auth, durable update log and filesystem reconciliation.
2. **IDE client**: a browser app (CodeMirror 6 with y-codemirror.next) served by the same local server. A desktop shell can wrap it later.
3. **Relay API** on the same server: tasks, contracts, integration and agent runs. Every call goes through the engine with the session's identity.
4. **Agent runner**: a worktree per task from a snapshot commit of the shared state; review; 3-way apply back.

## Acceptance tests for the first slice

- Two or more authenticated clients edit one file concurrently and converge. Cursors and selections are visible on both sides.
- Five clients edit concurrently and converge. p95 propagation is measured.
- A client that disconnects, edits offline and reconnects converges without losing accepted edits.
- A server restart keeps document state, and the file on disk matches the shared document.
- An external file change merges into the shared doc, with no silent overwrite.
- Requests without a session, with a forged session, or with a wrong role, and path traversal, are all rejected.
- Task, contract and integration operations from the IDE go through the engine, and the integration gate holds.
- A human edit to a file inside a running agent task's scope marks that task's input as stale.
