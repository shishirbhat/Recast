# Relay — Findings

## Real-provider results (2026-10-19)

Environment: Claude Code 2.1.303, model as reported by the CLI (`claude-sonnet-5-5`), Linux, Node 22.22, `claude -p --permission-mode acceptEdits`. Relay hooks and MCP were injected with `--settings` / `--mcp-config --strict-mcp-config`. Cases 1–2 ran twice and case 3 ran twice (first run on the initial commit, second after the database-path fix below). The JSON in `docs/evidence/` is from the **second** run; the first run's numbers are quoted from its log. Assertions are on git state and Relay's records, never on what the agent says. Raw data: `docs/evidence/claude-code-2026-10-19/`.

| # | Scenario | Result | Time / cost |
|---|---|---|---|
| 1 | Task planned on `user-api` v1; v2 accepted; agent asked to edit | **Denied before the write** with `stale_contract` (both runs). File unchanged. The agent received the v2 text. | 13–15 s, $0.07 |
| 2 | Agent asked to append to another task's file with `echo >>` | **Bash write denied** (both runs). The diff check confirms the workspace is unchanged. | 8–12 s, $0.06–0.07 |
| 3 | Full participatory loop over MCP. Contract changed before start; the agent was **not told** | Both runs: the agent claimed the task, saw `stale: true` in `get_task`, acknowledged v2, declared intent, edited with Edit (allowed), and submitted for review. Relay's diff check was clean, Relay-run verification passed, and the human completion gate passed. **Run 1 only:** unprompted, the agent first tried a shell-redirect write; Relay denied it and the agent switched to Edit. | Run 1: 32 s, 14 turns, $0.13. Run 2: 31 s, 13 turns, $0.12 |

What this shows:
- Pre-action enforcement of scope and contract version works with a real agent, and the agent adapts to the denial reason.
- Surfacing staleness through MCP caught the mismatch *before* any edit was attempted. That's earlier than the hook, which then acts as the backstop.
- Agents sometimes write through the shell without being prompted to (1 of 2 runs of case 3). The Bash rule and the diff check are both needed.

## Known limitations

1. **Integration gap: found in real runs, now closed for this case.** In the first two runs of case 3, Relay let T-ui complete against v2 while T-api (the server) still returned the v1 shape. The integrated program would have printed `Hello undefined`. The agent noticed; Relay didn't. **Fix:**
   - a task can't complete alone while a contract partner is unfinished;
   - a cross-task integration gate (specs §4a).
   
   A deterministic replay of run 3 is now a unit test. In a third real run (`docs/evidence/claude-code-2026-10-19-integration-gate/`), Relay refused to complete T-ui and named T-api.
   **Still open:** the gate depends on the integration test being meaningful. Relay can require one, but it can't yet judge whether a test actually covers the contract.
2. **Acknowledgment is a claim.** `acknowledge_contract` records that the agent says it adapted. Nothing checks conformance yet (the integration gate above is the first real check).
3. **The Bash heuristic is bypassable** (`python -c`, `node -e`, scripts). Only the diff check sees every write, and it runs after the session, not before.
4. **Very few runs (n=2), one provider.** These results aren't statistics. Precision and recall for the conflict rules haven't been measured. Codex and Cursor are untested.
5. **Participatory mode only.** Worktree management and orchestrated runners aren't built. In these tests each agent worked in a fresh temp repo.
6. **No baseline yet.** Nothing here shows that Relay saves coordination time.

## Bugs found and fixed

- **Database inside the repository broke the diff check and the completion gate.** Found by smoke-testing the README quick start, not by the unit tests, which kept the database outside the repo. `.relay/relay.db` and its WAL files showed up as blocked changes. Each evidence write also changed the workspace fingerprint, so the gate could never pass. Fix: exactly Relay's own database files are excluded from the diff and the fingerprint; every other `.relay/` path stays protected. Regression test added.

## Provider capability matrix

| Capability | Claude Code 2.1.303 | Codex CLI | Cursor agent |
|---|---|---|---|
| Observe attempted file edit | **Tested** (`PreToolUse`) | Docs: `PreToolUse`. Matcher coverage for `apply_patch` disputed | Docs: `preToolUse`, `afterFileEdit` |
| Block before write | **Tested** (Edit/Write deny) | Unverified | Docs: `preToolUse` deny; `afterFileEdit` is observe-only |
| Observe/block shell | **Tested** (Bash matcher, deny) | Docs: Bash matcher | Docs: `beforeShellExecution` allow/deny/ask |
| Hook failure behaviour | **Tested: fails open.** Relay wraps it to fail closed | Untested | Untested |
| MCP participation | **Tested** (stdio) | Docs: supported | Docs: supported |
| Headless runner | **Tested** (`claude -p`, JSON output with cost/turns) | Docs: `codex exec --json` | Docs: limited hook support in CLI |
| Diff-time backstop | Works for any agent (git-based) | Same | Same |

## Next steps

1. A second real agent on T-api, to run the full two-sided loop through `relay integrate` with real agents.
2. Codex CLI adapter: hook, MCP config and runner. **Needs `OPENAI_API_KEY`.**
3. Benchmark repo and with/without-Relay measurement.
4. Worktree manager plus orchestrated runner.
5. VS Code extension.
