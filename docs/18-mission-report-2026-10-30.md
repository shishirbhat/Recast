# 18 · Mission report: the trustworthy multi-contributor environment (2026-10-30)

What was built for the twelve features in the owner's brief, how each is tested, what is honestly not proven yet, and
what needs the owner. Details per feature are in `RELAY_HANDOFF.md` (log entries 2026-10-29/30).

## Reliability first (the brief puts gaps before features)

| Defect found | Fixed | Regression test |
|---|---|---|
| A server restart orphaned unapplied agent work: finished runs couldn't be applied, a passed Check Together couldn't be approved | Runs and combined worktrees persisted and restored; interrupted runs recorded and their task released | `test/runs-restart.test.ts` (fails without the fix) |
| Keys typed into a file before it synced were wiped by the next keystroke (the Explorer E2E "flake") | The line is selected on sync only if nothing was typed | `vscode.e2e.test.ts` "typing into a file before it has synced…" (fails without the fix) |
| A retried approve/apply after a timeout errored; apply and a combined approve could overlap; a failed write after approval left a completed task without its files | Idempotent retries, mutual exclusion, resumable writes | `test/hardening.test.ts` |
| Check Together blamed "the newer shared state" when two tasks edited the same lines | Says which tasks clash and where | `test/arena.test.ts` |
| Needs-you said "All clear" before it had loaded; announced old items as new; listed one situation twice | Fixed | `calm.e2e.test.ts` |
| VS Code's Relay view waited for the radar before showing tasks | Tasks first, radar after | VS Code suite, Check Together |

## The twelve features

| # | Feature | Where | Surfaces | Tested how |
|---|---|---|---|---|
| 1 | Conflict Radar | `src/analysis/radar.ts` | Coordination tab, `relay radar`, VS Code Relay view, needs-you | API, CLI, browser E2E, VS Code suite |
| 2 | Proof-carrying changesets | `src/analysis/changeset.ts` | task view, `relay changeset [verify]` | incl. verification in a fresh clone and a forged patch |
| 3 | Integration rehearsal (hardened) | `src/server/runs.ts` | all clients | restart, retry, overlap, failed write |
| 4 | Flight recorder | `src/analysis/timeline.ts` | Relay › Flight Recorder, `relay timeline` | API, CLI, browser E2E |
| 5 | Cross-agent handoff packets | `src/knowledge/handoff.ts` | task view, needs-you, next agent's briefing | API, browser E2E (two people), simulated agent prompt |
| 6 | Reproduction from failure evidence | `src/analysis/repro.ts` | task view, `relay repro` | reproduced, not reproduced (flaky), blocked combined check |
| 7 | Attention inbox | `src/analysis/attention.ts` | needs-you (per person, seen marks) | API, browser E2E |
| 8 | Shared decision records (staleness) | `src/knowledge/records.ts` | radar, needs-you, timeline | API |
| 9 | Changed-file ownership map | `src/analysis/radar.ts` (`ownership`) | Coordination tab, `relay ownership` | API, CLI, browser E2E |
| 10 | Shareable run reports | `src/server/shares.ts` | task view, `/share/<token>` | API, browser E2E (signed-out reader, revoke) |
| 11 | Project onboarding / environment discovery | `src/analysis/onboarding.ts` | Relay › Project Setup, New Task defaults | API, browser E2E |
| 12 | Relay Arena | `scripts/arena.ts` | `relay arena`, `relay arena --real --yes` | regression test on the scoreboard |

Principles kept throughout:
- **Evidence and opinions are kept apart.** Every alert, packet and report separates what Relay can show (known) from what it infers (suspected), and both from what a person or agent wrote.
- **Nothing applies itself.** Discovery proposes, the radar warns, rehearsal checks; integration still needs an owner.
- **Viewers and editors see disabled controls with the reason.**
- **Data compatibility.** New tables are created idempotently; older databases just gain them.

## Results

Two full regression runs on 2026-10-30, all three suites each time:

| Run | Unit (`npm test`) | Browser E2E (`RELAY_E2E=1`) | VS Code extension (real VS Code, xvfb) |
|---|---|---|---|
| 1 | 149 pass; `terminal.test.ts` timed out once under full load (passes alone, 3/3) | 67/70: three regressions from the new inbox and retry behaviour | 35/36: Check Together picker slow (radar) |
| 2, after the fixes above | **149/149** | **70/70** | **36/36** |

Over the mission: the unit tests grew from 117 to 149, browser E2E from 60 to 70, and the VS Code suite from 35 to 36. The install harness (`vscode: npm run test:install`) was not rerun; the extension's packaging didn't change.

Relay Arena (simulated agents; ground truth measured): broken changes that reached the project were 1 without Relay and 0 with Relay, with 0 false alarms, over 4 scenarios.

Screenshots: `docs/evidence/{radar-2026-10-29,proof-2026-10-30,recorder-2026-10-30,handoff-2026-10-30,setup-2026-10-30}/`.

## After the report (2026-10-31)

- **Relevant-test selection.** The test files that reach a change through imports, with their chains; changed code that no test reaches is named.
- **Opt-in automatic rechecks.** An owner turns them on; when edits go quiet, a person's stale task is checked again.

## What is not proven

- **Every agent result above is from the simulated agent** (deterministic, scripted edits). The only real-agent evidence is still the one designed scenario of 2026-10-27 (3 + 3 trials with Claude Code).
- **The Arena has four simulated scenarios.** That is not a benchmark across many real tasks, and the base rate of real conflicts is unknown.
- **Static interface analysis covers JS/TS only.** Dynamic access isn't seen; those findings stay "suspected".
- **Reproduction depends on git keeping the recorded trees.** Unreachable trees can be pruned (about two weeks), and the bundle then says it can't rebuild. Dependencies come from the project's `node_modules`.
- **A changeset's digest detects edits but is not a signature,** so it doesn't prove who made the file.
- **Nobody outside this work has used any of it.**

## Needs the owner

1. **An OpenAI API key**, for a second real agent (Codex): the "two different real agents" milestone.
2. **Spend approval for real-agent trials.** `relay arena --real --yes --trials N` was measured on 2026-10-27 at about $0.45 per trial; the recommended next step is 20 or more trials over non-designed task pairs.
3. **Independent users**: a small team using it for a week, to see whether the radar, inbox and handoffs help or add noise.
4. **Publishing the VS Code extension** to the Marketplace (publisher account).
5. **A Cursor desktop test** on a real machine.
