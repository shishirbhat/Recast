# Relay — Architecture and Specifications

Status labels: **[impl]** implemented and tested · **[design]** designed, not built.

## 1. Architecture

```
 Human surfaces            Agent participation        Agent enforcement          Execution
 CLI [impl]                Relay MCP server [impl]    Claude Code hook [impl]    worktrees + runners [design]
 VS Code ext [design]      (stdio, one task/process)  Codex hook [design]
                                                      Cursor hook [design]
              \                    |                        |                     /
               +------------- Relay core engine (src/core) [impl] ---------------+
                 tasks · state machine · contracts · intents · conflict rules ·
                 evidence · completion gate · append-only events   (SQLite, node:sqlite)
```

- The engine is a library over one SQLite file. The CLI, hook and MCP processes each open it per invocation. Concurrency is handled with `BEGIN IMMEDIATE` transactions and a 1.5 s busy timeout.
- Nothing in `src/core` depends on any editor or provider.
- Agent configuration is injected through `--settings` and `--mcp-config` from a directory **outside** the agent's workspace. The agent therefore can't edit its own guard, and the diff check doesn't see Relay's own files.

## 2. Task state machine [impl]

| From \ To | queued | running | blocked | review_required | failed | cancelled | completed |
|---|---|---|---|---|---|---|---|
| proposed | human | | | | | human | |
| queued | | agent/human/system ¹ | agent/human/system | | | human | |
| running | | | agent/human/system | agent/human/system | agent/human/system | human/system | |
| blocked | human/system | | | | | human | |
| review_required | | human (changes requested) | | | human/system | human | human ² |
| failed | human (retry) | | | | | human | |

1. Requires every prerequisite task to be `completed`. A claim also requires the task to be `queued`, so two concurrent claims can't both succeed.
2. **Completion gate.** Relay itself must have recorded, against the workspace's current tree hash:
   - a diff check with no blocking conflicts;
   - a passing run of every `verify` command.
   
   Agent-reported evidence is stored as `agent_claim` and never counts.

`completed` and `cancelled` are terminal. Any transition can carry an idempotency key, and a repeated key is applied once.

## 3. Contracts [impl]

- Versions are `proposed → accepted | rejected`. Accepting a version supersedes the previous accepted version. Only a human can accept or reject.
- Anyone, agents included, can propose. A proposal has no authority.
- On acceptance, Relay lists the active tasks planned against an older version and emits `task.contract_stale` for each.
- A task leaves the stale state by `acknowledge_contract(id, currentVersion)`. **That is an agent claim that it adapted.** Relay does not yet check whether the code actually conforms (see findings).

## 4. Conflict rules (deterministic) [impl]

| Rule | Severity | Trigger |
|---|---|---|
| `unknown_task` | block | Task id doesn't exist |
| `inactive_task` | block | Pre-action edit while the task isn't `running` (claim first) |
| `protected_path` | block | Path escapes the repo (`..`, absolute, through a symlink), or is under `.relay/ .git/ .claude/ .codex/ .cursor/ .mcp.json` |
| `owned_by_other_task` | block | Outside this task's scope and inside another active task's scope |
| `outside_scope` | block | Outside this task's scope. Fix: `declare_intent` plus human approval |
| `shared_scope` | warn | Inside this task's scope *and* another active task's scope. Allowed, but recorded |
| `stale_contract` | block | The task depends on a contract version that has been superseded. The denial includes the authoritative text |

The same rules run at three points:
- **pre-action**, through the hook;
- **diff-time**, through `relay check`, over every file differing from the task's base commit, untracked files included;
- **intent declaration**.

Planned rules [design]: a schema change that invalidates a known consumer; a stale base commit; cross-task integration conformance.

## 5. Hook decision protocol (Claude Code) [impl]

- Invocation: `relay --db DB hook claude-code --task T --root R || printf '<deny JSON>'`, registered under `PreToolUse` with matcher `Edit|Write|MultiEdit|NotebookEdit|Bash` and `timeout: 10`.
- Output: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow|deny","permissionDecisionReason":"..."}}`. The reason text is shown to the agent and includes the remediation.
- **Fail-closed in three layers:**
  - every exception becomes a deny;
  - an internal 3 s deadline denies if the engine stalls, and the SQLite busy timeout (1.5 s) bounds blocking calls;
  - the shell `||` fallback denies if the process can't start at all.
  
  This is needed because Claude Code lets the tool run when a hook crashes or times out (measured in Phase 0).
- Bash: commands matching a write heuristic (redirection, `sed -i`, `tee/mv/cp/rm/...`, state-changing `git`) are denied and the agent is steered to Edit/Write. **This is a heuristic, not a boundary.** Interpreters and scripts can still write. The diff check is the backstop.
- Every decision is recorded as an `enforcement.decision` event, with provider, point, tool, path or command, and conflicts.

## 6. MCP tools [impl]

The server is bound to one task and one agent identity at launch (`relay mcp --task T --agent NAME`). No tool takes a task id, so an agent can't address another task. Errors return `isError: true` with `{error: code, message}`.

| Tool | R/W | Input | Effect | Notes |
|---|---|---|---|---|
| `get_task` | R | none | none | Task, contract versions with a `stale` flag, intents |
| `get_contract` | R | `contract_id`, `version?` | none | Latest accepted version, or a specific one; plus status history |
| `claim_task` | W | `idempotency_key?` | queued→running | Re-claiming by the holder is a no-op. A second agent gets `stale_state` |
| `acknowledge_contract` | W | `contract_id`, `version` | updates the task's planned version | Must equal the current accepted version |
| `declare_intent` | W | `files[]` (≤200) | records an intent | In scope → `active`. Otherwise `proposed`, which needs human approval to widen scope |
| `report_evidence` | W | `summary`, `command?`, `exit_code?` | stores an `agent_claim` | Never verified, never counts toward the gate |
| `report_blocker` | W | `reason` | running→blocked | |
| `request_contract_change` | W | `contract_id`, `definition`, `rationale` | new `proposed` version | No effect until a human accepts it |
| `submit_for_review` | W | `summary` | running→review_required | Doesn't complete the task |

Deliberately absent: file read/write, shell, merge, approve, complete, cancel, deploy.

## 7. Security model

- **Identity.** The hook and MCP processes are bound to a task by launch arguments that the agent can't change. The agent's configuration lives outside its workspace, and Relay's paths are protected.
- **Authority.** Only humans approve tasks, accept contracts, widen scope, and complete tasks.
- **Evidence.** Only evidence produced by Relay (the diff check and verification commands) counts. It's tied to the workspace tree hash, so any later change invalidates it.
- **Audit.** The events table is append-only by convention: no code path updates or deletes events. It is **not tamper-proof**. Anyone with write access to the SQLite file can change it.
- **Not provided yet:** sandboxing of shell or network access (worktrees aren't sandboxes), secret redaction, credential separation for runners, and log retention controls.
