# Relay

**One project. Any model. Every contributor in sync.**

Relay is a provider-neutral coordination engine for human developers and coding agents working on one repository. It holds authoritative task state, versioned contracts and file ownership. It enforces them at the earliest point each agent supports, and it accepts only evidence it gathered itself before a human approves integration.

This branch (`relay`) is an orphan branch. It shares no history with Recast.

## Status (2026-10-19)

| Component | Status |
|---|---|
| Core engine: tasks and state machine, versioned contracts, intents, deterministic conflict rules, evidence, completion gate, append-only events | **Implemented and unit-tested** |
| Claude Code pre-action hook adapter (fail-closed) | **Tested against the real provider** (Claude Code 2.1.303) |
| Relay MCP server (9 tools, bound to one task per process) | **Tested against the real provider** (Claude Code over stdio) |
| Diff-time backstop (`relay check`) | **Implemented and tested.** Also run after real-provider sessions |
| Relay-run verification (`relay verify`) | **Implemented and tested.** Also run after real-provider sessions |
| CLI | **Implemented.** Exercised by tests |
| Codex CLI adapter | **Not built.** Waiting for an OpenAI API key |
| Cursor | **Docs only.** Needs a desktop test |
| Cross-task integration gate (`relay integrate`) | **Implemented and tested** (replays real run 3). Exercised against the real provider only through the per-task block |
| Benchmark vs. baseline workflow | **Not started** |
| Collaborative IDE (server, Yjs sync, presence, auth, IDE workbench UI) | **Implemented and tested** (real clients, two-browser E2E). Not yet tested by independent users |
| Agent runs from the IDE (worktrees, stale input, 3-way apply, combined gate) | **Tested with a simulated agent only.** No real Claude Code run from the IDE yet |
| VS Code extension | **Not started** |
| Validation with independent users | **None** |

The first milestone (two different real agents, a caught contract mismatch, a verified integrated result, and less coordination effort than the baseline) **has not been reached**. One provider works end to end. The second provider, worktree-based orchestration and the baseline measurement are still open.

## Quick start

Requires Node ≥ 22.18 (types are stripped natively; there is no build step) and git.

```sh
npm install
npm run typecheck && npm test        # 45 tests, no model calls
RELAY_REAL_PROVIDER=1 npm run test:real   # runs real `claude -p`; costs model usage
```

```sh
npm link   # puts `relay` on PATH (or call ./bin/relay)
export RELAY_DB=$PWD/.relay/relay.db
relay contract propose user-api --definition "getUser(id) -> {id, name}" --accept
relay task create T-ui --objective "Greeting UI" --scope src/ui.js --contract user-api@1 --verify "npm test"
relay task approve T-ui
relay agent-config claude-code --task T-ui --root "$PWD" --out /tmp/relay-T-ui
claude --settings /tmp/relay-T-ui/settings.json --mcp-config /tmp/relay-T-ui/mcp.json --strict-mcp-config
# after the agent submits for review:
relay check T-ui --cwd . && relay verify T-ui --cwd . && relay task complete T-ui --cwd .
# tasks that share a contract complete together:
relay integrate check T-ui,T-api --cwd . --verify "npm run test:integration"
relay integrate approve <integration-id> --cwd .
```

## Relay IDE (collaborative, browser-based)

```sh
npm install && (cd ide/web && npm install && npm run build)
./bin/relay ide --cwd /path/to/your/repo        # prints a one-time owner sign-in link (add --allow-terminal only behind TLS on a network address)
./bin/relay ide invite "Kai Chen" --role editor  # one-time link for a collaborator
```

A standard IDE workbench (VS Code / Cursor / Antigravity structure):
- **Menu bar** (File, Edit, Selection, View, Go, Run, Terminal, Help) driven by one command registry.
- **Command centre and palette** (Ctrl/⌘+P, Ctrl/⌘+Shift+P).
- **Activity bar**: Explorer, Search, Source Control, Run, Extensions, Community, Relay, Accounts, Manage.
- **Resizable side bars and panel** that collapse sensibly in narrow windows.
- **Integrated terminal** (real PTY; owners only; Ctrl+`).
- **Panel tabs**: Problems, Output, Agents, Activity.
- **Agent panel**: requests become scoped tasks.
- **Status bar.**
- **Ship to GitHub** from Source Control: one click ships and merges into the default branch; or open a pull request and merge it after review (see below).

### GitHub: ship and merge

Give the Relay server a token and the Source Control view gets two buttons:
- **Ship to main**: pushes the shared workspace as a new `relay/ship-*` branch, opens a pull request and merges it.
- **Open pull request for review**: does the same without merging. A **Merge into main** button appears once the PR is open.

```sh
GITHUB_TOKEN=ghp_... ./bin/relay ide --cwd /path/to/repo   # or have `gh auth login` done; RELAY_GITHUB_REPO=owner/name overrides the origin remote
```

- **Owners only**, enforced by the server.
- **Ship gate.** Blocked by unresolved edit conflicts, agents mid-run, or nothing to ship. Warnings cover unapproved tasks, unapplied agent proposals, and secret-looking files, which are always left out.
- **Your checkout is never touched.** The commit is built in a temporary index, so the working tree, index and current branch stay as they are.
- **The token stays on the server.** It never goes to browsers, logs or command lines; git gets it through `GIT_CONFIG_*` environment variables.
- **After a merge,** if you're on the default branch and the merged tree matches your files, the local branch moves to the merge without changing any file.
- **If GitHub refuses the merge** (branch protection, required checks, conflicts), the PR stays open and the reason is shown.
- **Tested against a mock GitHub API** with a real git remote. The real api.github.com hasn't been exercised yet.

Underneath it:
- Live multi-person editing (Yjs CRDT) with named cursors and selections.
- Tasks, contracts and integration review go through the same engine as the CLI.
- Agent runs happen in isolated worktrees and are applied with a 3-way merge only after Relay's checks and a person's approval.

Tests:
- `npm test`: 52 tests, including real y-websocket clients, real PTYs, simulated-agent orchestration, and GitHub ship/merge (mock API, real git remote).
- `RELAY_E2E=1 node --test test/e2e/*.e2e.test.ts`: two-person live editing, plus workbench structure (panes, narrow windows, activities, palette, menus, terminal, save), plus one-click ship from the browser.

Screenshots are in `docs/screenshots/` (`v2-*` show the current visual identity).

## Docs

- [docs/01-phase0-audit.md](docs/01-phase0-audit.md): repository and provider audit, plus the first hook probe
- [docs/02-specs.md](docs/02-specs.md): architecture, state machine, conflict rules, hook protocol, MCP tools, security model
- [docs/03-findings.md](docs/03-findings.md): real-provider results, capability matrix, known limitations, next steps
- `docs/evidence/`: raw JSON from real-provider runs
- [docs/07-ide-architecture-audit.md](docs/07-ide-architecture-audit.md), [docs/08-ide-architecture.md](docs/08-ide-architecture.md): IDE audit and architecture decisions
- [docs/13-ide-structure-audit.md](docs/13-ide-structure-audit.md): workbench structure audit and Phase 1 implementation report
