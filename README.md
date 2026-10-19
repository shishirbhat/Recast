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
npm run typecheck && npm test        # 41 tests, no model calls
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
./bin/relay ide --cwd /path/to/your/repo        # prints a one-time owner sign-in link
./bin/relay ide invite "Kai Chen" --role editor  # one-time link for a collaborator
```

A standard IDE layout: command centre and palette (Ctrl/⌘+P, Ctrl/⌘+Shift+P), Explorer / Search / Source Control, tabs, a Problems / Agents / Activity panel, a Relay side bar, and a status bar. Underneath it:
- Live multi-person editing (Yjs CRDT) with named cursors and selections.
- Tasks, contracts and integration review go through the same engine as the CLI.
- Agent runs happen in isolated worktrees and are applied with a 3-way merge only after Relay's checks and a person's approval.

Tests:
- `npm test`: 41 tests, including real y-websocket clients and simulated-agent orchestration.
- `RELAY_E2E=1 node --test test/e2e/ide.e2e.test.ts`: two real Chromium sessions.

Screenshots are in `docs/screenshots/`.

## Docs

- [docs/01-phase0-audit.md](docs/01-phase0-audit.md): repository and provider audit, plus the first hook probe
- [docs/02-specs.md](docs/02-specs.md): architecture, state machine, conflict rules, hook protocol, MCP tools, security model
- [docs/03-findings.md](docs/03-findings.md): real-provider results, capability matrix, known limitations, next steps
- `docs/evidence/`: raw JSON from real-provider runs
- [docs/07-ide-architecture-audit.md](docs/07-ide-architecture-audit.md), [docs/08-ide-architecture.md](docs/08-ide-architecture.md): IDE audit and architecture decisions
