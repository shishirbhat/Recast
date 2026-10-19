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
