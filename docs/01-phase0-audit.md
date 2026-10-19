# Relay — Phase 0 Audit (2026-10-19)

> Snapshot from before implementation started. For what has been built since, see [03-findings.md](03-findings.md). The code ended up as one package (`src/core`, `src/hooks`, `src/mcp`, `src/cli.ts`) instead of the monorepo proposed in §6; it can be split once a second consumer exists.

## 1. Repository status
| Item | Finding |
|---|---|
| Repo in this session | `shishirbhat/Recast`, an unrelated product. **Not modified.** |
| Relay repo | **None.** `list_repos` returns nothing for "relay". |
| Existing Relay code | **None.** Every Relay component is *designed but not implemented*. |
| Reusable ideas in Recast (not code to copy) | Recast has an MCP server and an agent runtime with scopes, policy and signed audit (`docs/13-agent-runtime.md`). These patterns are relevant to Relay. Copying the code would mix the two projects, so we shouldn't. |

## 2. Environment
| Capability | Status |
|---|---|
| Node 22, Python 3.13, git | Available |
| Claude Code CLI 2.1.303, headless `claude -p` | **Works** (runs under the session's credentials, about $0.07–0.09 per probe run) |
| Codex CLI | Not installed. `OPENAI_API_KEY` / `CODEX_API_KEY` **unset**, so it can't run here |
| Cursor / cursor-agent | Not available. There's no GUI in this container |

## 3. Measured probe: Claude Code `PreToolUse` as a Relay enforcement point
Setup: throwaway git repo in the scratchpad. `state.json` holds contract `user-api` v1 → v2, and task `T-frontend` has scope `[src/ui.js]`. A hook script queries that state and returns allow or deny. Real `claude -p` runs with `--permission-mode acceptEdits`. The "file changed" column comes from `git status`, not from what the agent reported.

| Case | Hook | Expected | Observed (file changed?) |
|---|---|---|---|
| A: in-scope edit, task planned on superseded v1 | naive | deny | **Denied before write.** Agent received the v2 contract text. File unchanged. |
| B: out-of-scope edit (`src/server.js`) | naive | deny | **Denied.** File unchanged. |
| C: in-scope, contract current | naive | allow | **Allowed.** `src/ui.js` modified. |
| D: hook process crashes | naive | ? | **FAILS OPEN.** Edit applied. |
| E: hook exceeds its 10s timeout | naive | ? | **FAILS OPEN.** Edit applied. |
| F: write via Bash `echo >>` | naive (Edit/Write matcher) | ? | **BYPASSED.** Edit applied. |
| D2: crash | fail-closed guard | deny | **Denied** ("failing closed"). File unchanged. |
| E2: engine stall (internal 3s budget) | fail-closed guard | deny | **Denied.** File unchanged. |
| F2: Bash redirect write | guard + Bash matcher | deny | **Denied.** File unchanged. |
| C2: legitimate edit | fail-closed guard | allow | **Allowed.** No regression. |

### Conclusions (verified for Claude Code 2.1.303 only, single runs, n=1 per case)
1. Blocking an Edit/Write before it happens, based on scope and contract version, **works**. The deny reason reaches the agent, which can then adapt.
2. **Hooks fail open by default.** A Relay hook must have an internal deadline below the hook timeout and wrap all errors as `deny`. Make this the default; the user can choose fail-open explicitly.
3. **Edit/Write matchers don't cover writes made through the shell.** The Bash heuristic I tested is crude and bypassable (`python -c`, `node -e`, scripts, `git apply`). Pre-edit hooks only *reduce* conflicts. **A diff check at the end of each run, against the worktree's git diff, is the required backstop.** It's the only check that sees every write.
4. Not yet tested:
   - whether an agent tries a workaround after a denial when it hasn't been told to stop;
   - how much latency the hook adds per tool call;
   - concurrent tasks;
   - `MultiEdit` / `NotebookEdit` coverage.

## 4. Provider capability matrix (current state)
| Provider | Block before edit | Observe after edit | Headless runner | Status |
|---|---|---|---|---|
| Claude Code | `PreToolUse` on Edit/Write/Bash | `PostToolUse` | `claude -p`, Agent SDK | **Tested with the real provider** (this probe) |
| Codex CLI | `PreToolUse` (docs; matcher coverage for `apply_patch` disputed between sources) | `PostToolUse` | `codex exec --json` | **Docs only.** No credentials here |
| Cursor agent | `preToolUse` deny (docs). `afterFileEdit` is observe-only | `afterFileEdit` | CLI with limited hook support (docs) | **Docs only.** Needs a desktop test |

Docs: https://cursor.com/docs/hooks · https://cursor.com/docs/plugins · https://developers.openai.com/codex/hooks · https://developers.openai.com/codex/noninteractive

## 5. Major risks found so far
- **Fail-open defaults** in hook systems. Proven for Claude Code; assume the same for the others until tested.
- **Shell-write bypass**, which makes diff-time detection mandatory, not optional.
- **The second provider (Codex) can't be validated** in this environment without an OpenAI credential.
- Terms for automated runs that use subscription credentials have not been reviewed yet.

## 6. Smallest plan to reach the first real experiment
1. **Repo:** create `relay` with a TypeScript/Node 22 monorepo containing `packages/core`, `packages/mcp`, `packages/hooks`, `packages/runners` and `apps/cli`. Use SQLite (`node:sqlite`) for state, with an append-only event table.
2. **Core:** task, contract (versioned), intent, evidence and event models; a state machine with legal transitions; deterministic conflict rules 1–4 (shared declared file, edit outside ownership, superseded contract, changed interface with active dependents). Unit tests.
3. **Hook bridge:** move the probe's guard into the engine as `relay hook claude-code`, fail-closed by default, with every decision logged as an event. Integration test it against real `claude -p` using the A–F2 cases.
4. **Diff-time backstop:** run `relay check <task>` after each run on the worktree diff, using the same conflict rules.
5. **MCP server (stdio):** `get_task`, `get_contract`, `declare_intent`, `report_evidence`, `report_blocker`, `request_contract_change`. Agent-supplied content always stays at status `proposed`.
6. **Codex adapter:** same experiment, once credentials exist.
7. **Benchmark:** a small real repo with a test suite (candidate: a small Express/TypeScript API plus a client that consumes it). Run it with and without Relay.
