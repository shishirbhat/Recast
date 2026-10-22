# Relay IDE — Architecture

## Decisions

### ADR-1: Browser IDE on CodeMirror 6, served by a local Relay server
| Option | Verdict |
|---|---|
| **Code OSS fork (desktop)** | Rejected for now. A large fork to maintain. Microsoft's marketplace isn't licensed for forks (Open VSX only). Live collaboration would mean patching deep into the workbench. Revisit once Relay's collaboration model is proven. |
| **Monaco in a browser app** | Viable, but Monaco isn't a VS Code extension host either, it's heavy to bundle, and the Yjs binding (y-monaco) is less maintained. |
| **CodeMirror 6 in a browser app** | **Chosen.** A proven editor (Replit, Sourcegraph, Chrome DevTools). First-class Yjs binding (`y-codemirror.next`) with remote cursors, selections and collaborative undo. Small and fast. |
| **VS Code extension only** | Kept as a later distribution channel (task 11). It can't own the collaborative experience. |

Consequences:
- **No VS Code extension compatibility.**
- **Language intelligence starts at syntax highlighting.** LSP over WebSocket is the next step.
- **No terminal or debugger in the first slice.** These are listed in `12-known-limitations.md`.
- **A desktop shell (Tauri or Electron) can wrap the same app later** without architectural change.

### ADR-2: Yjs CRDT, our own sync server
- **CRDT, not OT.** Yjs gives deterministic convergence, offline edits and a cheap merge of reconnecting clients, and it's the most widely deployed CRDT for text.
- **Server written on `y-protocols`** (sync and awareness) rather than the stock `y-websocket` server. That way the server owns authentication, per-document authorization, persistence and filesystem reconciliation. The client uses the stock `y-websocket` provider.
- **One Y.Doc per file**, named `file:<repo-relative path>`. Text lives in `Y.Text("content")`.

### ADR-3: Shared document vs. disk vs. git
- **While a file is open, its shared Y.Doc is canonical.** The server writes it to disk debounced (300 ms) and atomically (temp file, then rename), and records the bytes it wrote.
- **External changes** (an editor outside Relay, `git checkout`, a formatter) are detected by a file watcher. If disk differs from what the server last wrote, the server diffs *last-written → disk* and applies that diff to the Y.Text as a server-originated change. The CRDT merges it with any concurrent human edits, so neither side is overwritten. The merge is recorded as an event.
- **Git stays the history of record.** Relay never commits on its own. Humans commit as usual, and agent changes arrive as reviewable changesets.
- **Durability.** Every Yjs update is appended to SQLite (`doc_updates`) before it's broadcast, and compacted into a snapshot every 500 updates. On restart, docs load from SQLite; if a doc has no state yet, it seeds from disk.

### ADR-4: Identity and authorization
- **Members** live in the Relay DB with a role: `owner`, `editor` or `viewer`.
- **Invites.** `relay ide invite <name> --role editor` prints a one-time join link. The server stores only a SHA-256 hash of the token. Joining sets an HttpOnly, SameSite=Strict session cookie (random 32 bytes, hashed at rest, 7-day expiry).
- **Every HTTP and WebSocket request is authenticated from the cookie.** The engine actor is derived from the session: humans are `{kind: "human", id: member.id}`.
- **Server-side permission matrix:**
  - viewer: read;
  - editor: edit documents, create, claim and move tasks, run agents;
  - owner: also approve tasks and integrations, accept contracts, invite members.

### ADR-5: Stack
- **Server:** Node 22 (`ws`, `yjs`, `y-protocols`) in the existing root package, calling the engine in-process.
- **Client:** Next.js App Router with a static export, Tailwind CSS v4, Motion (framer-motion) and CodeMirror 6. This matches the team's stack. Static export lets the local server serve it with no Node rendering at runtime.
- **Supabase / Vercel: not used in the first slice.** Relay runs locally next to the repo and needs long-lived WebSockets and filesystem and git access, which Vercel functions don't provide. A hosted mode could use Supabase Auth and Postgres for membership and a hosted sync server; it's out of scope until local collaboration is proven.

## Components

```
 Browser (each collaborator)                       Relay server (one per project, local)
 ┌───────────────────────────────┐   WS /collab    ┌──────────────────────────────────────────┐
 │ CodeMirror 6 + y-codemirror   │ ◀─────────────▶ │ Collaboration service                    │
 │ y-websocket provider          │  sync+awareness │  Y.Doc per file · awareness · auth       │
 │ Presence, tabs, file tree     │                 │  update log (SQLite) · disk reconciler   │
 │ Tasks · Contracts · Review    │   WS /events    ├──────────────────────────────────────────┤
 │                               │ ◀────────────── │ Relay API (HTTP JSON)                    │
 │                               │   HTTP /api     │  session → actor · permission matrix     │
 └───────────────────────────────┘ ──────────────▶ │  calls Relay engine (src/core)           │
                                                   ├──────────────────────────────────────────┤
                                                   │ Agent runner                             │
                                                   │  snapshot → worktree → claude -p (hooks, │
                                                   │  MCP) → changeset → review → 3-way apply │
                                                   └──────────────────────────────────────────┘
```

## State classification

| State | Where | Shared? | Durable? |
|---|---|---|---|
| File contents being edited | Y.Doc, then SQLite update log, then disk | Yes | Yes |
| Tasks, contracts, integrations, events | Relay DB | Yes | Yes (append-only events) |
| Presence (cursor, selection, active file, name, color) | Yjs awareness | Yes | **No.** Ephemeral, with a 30 s timeout |
| Theme, panel layout | Browser localStorage | No | Per browser |
| Session token | HttpOnly cookie (hash in DB) | No | 7 days |
| Provider credentials | Server process environment only | **Never** sent to clients | — |
| `.env*`, keys, `.git/`, `.relay/`, gitignored paths | Excluded from the tree and from document access | No | — |

## Agent run flow (first slice)
1. An editor clicks **Run with Claude Code** on a queued task.
2. The server snapshots the shared state into a commit (`git stash create`, or HEAD if the tree is clean) and runs `git worktree add --detach .relay/worktrees/<task> <snapshot>`.
3. The task's `baseCommit` is set to the snapshot. `claude -p` runs in the worktree with Relay's hooks and MCP (fail-closed, scope- and contract-checked). Output events stream to the IDE.
4. While it runs, any human edit to a file in the task's scope emits `task.input_changed` and shows on the task as **stale input**.
5. When the agent submits, Relay runs its diff check and verification in the worktree. The IDE shows the changeset.
6. On approval (task or integration gate), each changed file is applied to the shared Y.Doc with a 3-way merge (base = snapshot, ours = current shared text, theirs = agent result, using `git merge-file`). A clean merge is applied as a minimal diff; a conflicted merge is not applied and is shown for manual resolution.

## API and event contract (v0, 2026-10-20)

**Versioning.** The IDE, the CLI and this HTTP API all go through the same `Relay` engine and the same role checks. The API is **v0**: unversioned and same-origin, used by the bundled IDE. Breaking changes are allowed until a versioned `/api/v1` is cut for third-party clients. Event types below are append-only: new fields may be added, and existing fields keep their meaning.

**Requests.**
- All state-changing requests need the `relay_session` cookie and the `x-relay: 1` header, and are origin-checked.
- Roles: **read** = any member; **edit** = owner or editor; **approve/admin** = owner.

| Endpoint | Role | Purpose |
|---|---|---|
| `GET /api/state` | read | project, members, presence, tasks with agent runs, contracts, doc conflicts |
| `GET /api/files`, `/search?q=`, `/git`, `/scripts`, `/output` | read | files (secrets excluded), search, git status, scripts, Relay-run evidence |
| `GET /api/symbols?q=` | read | Go to Symbol in Workspace: JS/TS/Python declarations and Markdown headings whose name contains `q` (identifier characters only), via `git grep` over the shared files; secrets excluded |
| `GET /api/files` also returns `folders` | read | empty folders (untracked, not ignored), so New Folder shows before its first file |
| `GET /api/search?q=&case=1&word=1&regex=1` | read | Find in Files toggles: match case, whole word (`git grep -w`), extended regex (`-E`) |
| `POST /api/replace` `{query, replacement, paths, matchCase, wholeWord, regex, dryRun}` | edit | Replace in Files on the shared documents: one change per file, only the replaced ranges credited to the member (`member:<id>` origin). JS regex (multiline) with `$1`/`$<name>`/`$&`; runs in a `vm` context with a 1 s limit per file. `dryRun` only counts. Event `files.replaced` |
| `POST /api/files/rename` `{from, to}` | edit | File or folder. Each shared file is flushed, its live connections closed with **4410**, its document unloaded and its history (updates, snapshots, authorship, sessions) moved to the new name. Event `file.renamed` `{from, to, files: [{from, to}]}` |
| `POST /api/files/delete` `{path}` | edit | File or folder. Connections closed with 4410; history moved aside to `deleted:<ts>:file:<path>` so a new file at that path starts empty. Event `file.deleted` |
| `POST /api/folders` `{path}` | edit | New folder. Event `folder.created` |
| WebSocket `/collab/file:<path>` close **4410** | — | The file was renamed or deleted (or never existed and isn't loaded). Clients stop reconnecting: reconnecting would send the stale copy back and recreate the file |
| `GET /api/capabilities` | read | terminal policy, agent provider and its declared capabilities, extension host status |
| `POST /api/tasks` · `/tasks/:id/transition` · `/check` · `/run` · `/cancel-run` · `/apply` | edit (consequential transitions and apply: approve) | task lifecycle through the engine's state machine and gates. Verification runs without blocking the server. `/apply` re-checks the agent's change merged into the project as it is now when the project changed since the agent's snapshot, and refuses while Relay is still checking, during another apply, or when a changed file was renamed or deleted |
| `GET /api/tasks/:id` · `/why` · `/change` | read | task, evidence, events; completion gaps; the change record (six stages) |
| `POST /api/agent` | edit | agent composer: a prompt becomes a scoped task (owners run it, editors propose) |
| `POST /api/runs` | edit | start agents on several tasks from one snapshot |
| `POST /api/contracts` · `/contracts/:id/:v/accept\|reject` | edit / approve | contracts |
| `POST /api/integrations/check` · `/integrations/:id/approve` | edit (extra commands: approve) / approve | the cross-task gate |
| `GET /api/impact?base=\|task=` | read | dependency map: interface changes, consumers, tests, tasks, stale evidence |
| `GET /api/context?task=` | read | accepted decisions, current contracts, warnings and obsolete records for a task |
| `GET/POST /api/investigations` · `/:id` · `/:id/entries` · `/:id/run` | read / edit / approve (run) | shared investigations |
| `GET/POST /api/decisions` · `/:id/accept\|reject\|invalidate` | read / edit / approve | decision records |
| `GET /api/github` · `POST /github/ship\|merge\|refresh` | read / approve | GitHub delivery (token stays server-side) |
| `POST /api/members` | admin | one-time invite links |
| `POST /api/members/:id/revoke` | admin | revoke a member: sessions, invites, live collab/event sockets and terminals end |
| `GET /api/people` · `/people/:id` | read | presence states, per-person history (sessions) and surviving line contributions |
| `GET /api/attribution?path=` · `/sessions/:id/diff` · `/history?path=&seq=` | read | per-line authorship, one edit session's diff, a file at any revision |
| `GET /api/diagnostics?path=` | read | syntax problems (JS/TS via the TypeScript parser, JSON) |
| `GET /api/git/state` · `/git/diff?path=&staged=1` | read | branch, staged/unstaged files, log; diff sides |
| `POST /api/git/stage\|unstage\|commit\|branch` · `/git/switch\|pull\|push` | edit / admin | Git workflow; switching refuses a dirty tree, pull is fast-forward only |
| `GET /api/tasks/:id/diff?path=` · `GET/POST /api/reviews` · `/reviews/:id/resolve` | read / edit | a task's change to one file; line comments pinned to the reviewed revision |
| `GET /api/tests` · `POST /tests/run` · `/tests/stop` | read / admin | discover and run the project's tests on the Relay machine; latest run with per-test results and a stale flag |
| `GET /api/conflicts/:id` · `POST /conflicts/:id/resolve` | read / edit | an outside edit that couldn't merge: both sides; keep the shared copy or take the outside version (both stay recorded) |
| WS `/collab/file:<path>` | read (viewers read-only) | Yjs sync and awareness. With `?ack=1`, the server also sends message type 10 (its state vector) after applying and logging the client's updates, so the client can tell "saved" from "sent" |
| WS `/events` | read | `{ type: "events", events: RelayEvent[] }`, pushed when this server records events and polled every 200 ms for events from hooks, MCP servers and the CLI; also `{ type: "presence" }` (ephemeral, throttled) and `{ type: "tests", run }` |
| WS `/terminal` | owner, loopback unless `--allow-terminal` | PTY sessions |

**Events (`RelayEvent`: `seq`, `id`, `taskId`, `type`, `actor`, `at`, `fromState`, `toState`, `data`).** By family:

| Family | Event types |
|---|---|
| Tasks | `task.created`, `task.transition`, `task.base_changed`, `task.contract_stale`, `task.contract_acknowledged` |
| Contracts | `contract.proposed`, `contract.accepted`, `contract.rejected` |
| Intents | `intent.declared`, `intent.approved` |
| Enforcement and evidence | `enforcement.decision`, `enforcement.diff_check`, `evidence.recorded` |
| Integration | `integration.checked` (with `rebasedOnto` and `originalBases` when the runner rebased runs), `integration.approved` |
| Agent runs | `agent.run_started`, `agent.tool`, `agent.denied`, `agent.result`, `agent.error`, `agent.run_ended`, `agent.run_cancelled`, `agent.changes_applied` |
| Investigations | `investigation.created`, `investigation.entry`, `investigation.command`, `investigation.updated` |
| Decisions | `decision.proposed`, `decision.accepted`, `decision.rejected`, `decision.invalidated` |
| GitHub | `github.shipped`, `github.merged` |
| Git and review | `git.committed`, `git.branch_created`, `git.branch_switched`, `git.pulled`, `git.pushed`, `review.commented`, `review.resolved` |
| Tests | `tests.started`, `tests.stopped` |
| Documents | `doc.edit_session`, `doc.update_rejected`, `doc.external_change_merged`, `doc.external_change_conflict`, `doc.conflict_resolved` |
| Other | `member.joined`, `member.revoked`, `file.created`, `server.error` |
