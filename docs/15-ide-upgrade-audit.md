# Relay IDE — Upgrade Audit and Gap Analysis (2026-10-20)

Code at `91bd591` (branch `relay`). Statuses come from reading the code and its tests, not from the docs.

## Architecture as found

| Area | What exists |
|---|---|
| Client | Next.js 16 static export (`ide/web`), React 19, Tailwind 4, Motion. Workbench shell with a command registry (`lib/commands.ts`), palette, menus and persisted layout (`relay.layout.v2`) |
| Editor | **CodeMirror 6**: line numbers, folding, bracket matching and closing, autocompletion, in-file search and replace (`@codemirror/search`), JS/TS/JSON/MD/CSS/HTML/Python highlighting. Collaborative through `y-codemirror.next` |
| Server | Node 22 HTTP + WebSocket (`src/server/server.ts`), SQLite (`node:sqlite`, WAL) |
| Collaboration | Yjs; our own y-protocols server (`collab.ts`) with forged-awareness rejection and read-only viewers. Update log in SQLite with compaction; disk flush, external-change 3-way merge, conflicts kept (`docs.ts`) |
| Auth | Members, one-time invites, hashed session cookies, roles owner/editor/viewer, CSRF header and origin checks (`auth.ts`) |
| Coordination | Relay engine (tasks, contracts, intents, gates, integration), dependency map, change records, investigations and decisions, agent runner with worktrees and a provider adapter |
| Terminal | Real PTY over WebSocket, owner-only, loopback-only by default |
| Tests | 66 node:test tests, 10 Playwright E2E, 2 real-provider tests; type checks; no linter configured |

## Requirement status

Legend: **Done** (implemented and tested) · **Partial** · **Missing** · **Broken**.

| # | Requirement | Status at audit | Plan |
|---|---|---|---|
| 1 | Visual identity, themes, persisted preferences, focus rings, reduced motion | Done (previous pass) | Refine new surfaces only |
| 2a | Syntax highlighting, tabs, line numbers, bracket matching, in-file find/replace, go to line, palette | Done | — |
| 2b | Dirty state | Partial: edits are live-persisted, and "dirty" means *offline edits not yet on the server*; tracked and guarded | Keep. Document the save model |
| 2c | Project-wide search | Done (`git grep`) | Add **project-wide replace** through the shared documents |
| 2d | Diagnostics | Partial: Problems shows coordination problems only | Add **syntax diagnostics** (TypeScript parser) in the editor and Problems |
| 2e | Editor font size, line height, tab size, zoom | Missing | Add persisted preferences |
| 2f | Split editors / editor groups | Missing | Add a second editor group |
| 2g | Minimap | Missing | Defer. Documented; an overview ruler of diagnostics is cheaper |
| 2h | Language servers (definition, references) | Missing | Defer with a capability matrix. Needs an LSP bridge process per language |
| 3 | Resizable panes, persisted layout, reset | Done | Panel placement is fixed (left/right/bottom); documented |
| 4 | Command palette invoking real commands | Done (registry, permissions, shortcuts) | Add the new commands (tests, git, people, follow) |
| 5 | Presence: identity, colour, name label, file | Partial: stable colour per member, labels via y-codemirror, file presence. **No active/idle/away state, no last-active, no human/agent distinction in presence** | Add presence states, last active and the current task |
| 6 | Real-time collaborative editing (CRDT, reconnect, persistence) | Done (5-client convergence, offline merge, restart, external changes, caret stability tests) | — |
| 7 | Typing visibility, jump to participant, **follow mode** | Partial: live cursors yes; jump and follow missing | Add jump, follow and stop-following; typing state derived from document updates |
| 8 | **Per-person contribution history** (historical vs surviving, sessions, exact lines) | Missing | Build on Yjs item authorship plus an update-attribution log (model below) |
| 9 | Collaboration timeline with filters and navigation | Partial: Activity tab is unfiltered; no edit-session events | Add edit-session events, filters and navigation |
| 10 | Security: auth, server-side membership, revocation | **Broken in one respect**: revoking a member blocks new requests but **live sockets stay connected**, and there is no revoke endpoint. Single project per server, so cross-project IDs don't apply (documented) | Add a revoke endpoint that closes all of the member's sockets and sessions, with tests |
| 11–12 | Actionable task panel, evidence-backed integration status | Done (change record, six stages, gates) | Link changed files to diffs |
| 13 | Diff review, line comments bound to revisions, approve by revision | Partial: approvals bound to a tree hash; **no diff viewer, no line comments** | Add a diff viewer (`@codemirror/merge`) and review comments bound to a blob hash (outdated when it changes) |
| 14 | Agent visibility | Done (runs, activity, capabilities, cancel) | — |
| 15 | Git workflow | Partial: status is read-only | Add stage/unstage, commit, branch list/create/switch (dirty-safe), log; errors surfaced verbatim |
| 16 | Integrated test runner | Missing (scripts run in the terminal) | Add a test panel: run the project's `node --test` / test script, parse TAP, link failures to source, stop, stale marking |
| 17 | Navigation: recent files, symbols, definition | Partial: quick open and recent | Symbol search from the dependency map's exports; definition via imports (static) |
| 18 | Integration boundary display | Partial: capabilities endpoint | Add LSP/formatter/linter rows to the capability matrix (not connected) |

## Attribution model (requirement 8)

- **Who made an edit.** Every Yjs edit carries the client ID of the editor that produced it. The server already learns which client IDs belong to which authenticated connection (awareness anti-forgery). It now persists `client ID → member` per document (`doc_clients`). Edits the server makes itself are attributed to their origin: `disk` (outside change), `agent` (applied agent work), `baseline` (content that existed when the document was first opened).
- **Historical contribution.** For every update from a connection, the server records an `edit` row (document, member, time, characters inserted and deleted, lines touched, whitespace-only flag). Rows are grouped into **sessions**: consecutive edits by one person in one file, with gaps under 5 minutes. Durable timeline events are written per session, never per keystroke.
- **Surviving contribution.** Computed from the live document. Yjs keeps the author client ID on every surviving character. Each current line is attributed to the single author of all its non-whitespace characters, otherwise **shared**; lines with only baseline characters are **pre-existing**.
- **Revisions.** The document can be reconstructed at any recorded update sequence by replaying the update log. Compaction squashes history, and compaction points are reported as a horizon: "history before … was compacted".
- **Not claimed.** Characters are not "effort". Renames and moves between files are not tracked as moves (a delete plus an insert). Formatting-only edits are counted separately. Commits made outside Relay are not attributed to people.
