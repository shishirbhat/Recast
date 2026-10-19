# Relay — CLI Audit and Plan (2026-10-19)

## Verified state (commit e2ad78d)

| Check | Result |
|---|---|
| `git status` on `relay` | Clean, up to date with `origin/relay` |
| `npm run typecheck` | Pass |
| `npm test` | 26/26 pass |
| CI (GitHub Actions, `relay` branch) | Green on e2ad78d (runs 29 and 30) |
| Real Claude Code tests | 3/3 passed on the latest run (evidence in `docs/evidence/claude-code-2026-10-19-integration-gate/`) |

## Commands that exist today

`init` (opens and creates the DB only), `task create|list|show|approve|move|complete`, `contract propose|accept|reject|show`, `intent approve`, `integrate check|approve`, `check`, `verify`, `events`, `agent-config claude-code`, `hook claude-code`, `mcp`.

## Gaps against the CLI-first phase

| Need | Today | Plan |
|---|---|---|
| `relay init` safe to rerun, with defaults | Only opens the DB. Doesn't record repo identity or add `.relay/` to git's local exclude | Record the repo root and baseline in `meta`; add `.relay/` to `.git/info/exclude` once; never overwrite |
| `relay status` | Missing | New: tasks, owners, blockers, contracts (stale tasks), what needs a human. `--json` |
| `relay doctor` | Missing | New: git/worktree, DB path writable, node version, Claude Code present, hook/MCP config sanity |
| Claim / release ownership from the CLI | Only through MCP (claim). No release | `task claim` (as an agent or human) and `task release` (running→queued). Release is a **new legal transition**; needs a state-machine change and tests |
| Why a task can't be approved | Only an error string from `complete` | `relay why <task>`, reusing `completionGaps` and contract partners. Shows claimed / verified / approved separately |
| Blockers and dependents | Not shown | Part of `status` and `task show` |
| Evidence / submit from the CLI | Only through MCP | `task report` (agent claim) and `task submit` (running→review_required) |
| Contract → affected tasks | Only on accept | `contract show` lists the tasks on each version |
| Help, examples, exit codes | One usage block. Exit 1/2 only | Per-command help with examples. Exit codes: 0 ok, 1 error, 2 usage, 3 blocked by policy |
| Human-readable output | Plain `console.log` | New theme (`src/ui/theme.ts`), pending design sign-off. `--json` stays unthemed |

## Discrepancies found

- The README quick start says `relay init` but then exports `RELAY_DB` manually. After this phase, `init` should make that unnecessary.
- The README lists `task complete`, which can now be blocked by the contract-partner rule. The quick start doesn't mention that.
- `task move` lets a human perform any legal transition, including `running` on behalf of an agent. That's allowed by the state machine, but status should show the actor clearly.

## Order of work

1. Design sign-off on the terminal look (preview: `node scripts/preview-ui.ts`).
2. `init` / `status` / `why` / `doctor`, then claim, release, submit and report. Then help and exit codes.
3. Disposable-repo demo script (simulated agents labelled as such).
4. Claude-only benchmark (method, scripts, evidence, results).
5. Extension interface doc over the `--json` outputs.
