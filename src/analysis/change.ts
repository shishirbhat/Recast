import type { Relay } from "../core/engine.ts";
import { inScope } from "../core/conflicts.ts";
import type { Evidence, Task } from "../core/types.ts";
import { changedFiles, relayOwnFiles, workspaceFingerprint } from "../git.ts";
import type { AgentRun } from "../server/runs.ts";
import type { ProjectImpact } from "./impact.ts";

/**
 * One record per task that answers "is this change safe to integrate, and why?". It is derived entirely from what the
 * engine already stores (task, evidence, events, integrations, agent runs) plus the live dependency map, so it can't
 * drift from the gates that actually enforce the rules. Six stages are kept apart on purpose:
 *
 *   claimed     an agent or person said it's done          (a claim, never proof)
 *   executed    Relay itself ran commands for this task     (something ran; says nothing about passing)
 *   tested      every verification command passed on the current workspace
 *   contracts   the task is on the accepted contract versions, and any contract partner was checked together
 *   approved    a person with authority approved it         (enforced by the engine, not the client)
 *   integrated  the change is in the shared project         (agent work applied, or an approved integration)
 */

export type StageState = "done" | "missing" | "failed" | "stale" | "n/a";
export interface Stage {
  id: "claimed" | "executed" | "tested" | "contracts" | "approved" | "integrated";
  label: string;
  state: StageState;
  detail: string;
  evidence: string[];
}

export interface ChangeRecord {
  task: Pick<Task, "id" | "objective" | "state" | "owner" | "agent" | "scope" | "contracts" | "baseCommit">;
  files: { path: string; inScope: boolean }[];
  stages: Stage[];
  tests: { command: string; exitCode: number | null; fresh: boolean; at: string; evidenceId: string }[];
  security: { at: string; actor: string; detail: string }[];
  blockers: string[];
  approvals: { required: string; by: string | null; at: string | null }[];
  rollback: string[];
  safeToIntegrate: boolean;
}

export function changeRecord(relay: Relay, root: string, dbPath: string, taskId: string, opts: { runs?: AgentRun[]; impact?: ProjectImpact } = {}): ChangeRecord {
  const task = relay.requireTask(taskId);
  const own = relayOwnFiles(root, dbPath);
  const tree = workspaceFingerprint(root, own);
  const events = relay.events(taskId);
  const evidence = relay.evidence(taskId);
  const runs = opts.runs ?? [];
  const lastRun = runs.at(-1);
  // An agent's changes live in its worktree until applied; a person's are in the shared workspace.
  const filesSource = lastRun && lastRun.status !== "applied" ? lastRun.changedFiles : task.baseCommit ? changedFiles(root, task.baseCommit, own) : [];
  // In the shared workspace, a change also contains other active tasks' files: those belong to them, not to this record.
  const others = relay.listTasks().filter((t) => t.id !== task.id && !["completed", "cancelled"].includes(t.state));
  const files = filesSource
    .filter((p) => inScope(task.scope, p) || (lastRun && lastRun.status !== "applied") || !others.some((t) => inScope(t.scope, p)))
    .map((p) => ({ path: p, inScope: inScope(task.scope, p) }));

  const sys = evidence.filter((e) => e.source === "system");
  const partners = relay.listTasks().filter((t) => t.id !== task.id && Object.keys(t.contracts).some((c) => c in task.contracts) && !["cancelled"].includes(t.state));
  const integrations = (relay.db.prepare("SELECT id, tasks, status, tree, gaps, results, created_at, approved_by, approved_at FROM integrations ORDER BY created_at DESC").all() as { id: string; tasks: string; status: string; tree: string; gaps: string; results: string; created_at: string; approved_by: string | null; approved_at: string | null }[])
    .map((i) => ({ ...i, tasks: JSON.parse(i.tasks) as string[], gaps: JSON.parse(i.gaps) as string[], results: JSON.parse(i.results) as { command: string; exitCode: number | null }[] }))
    .filter((i) => i.tasks.includes(task.id));
  const lastInteg = integrations[0];
  // Which workspace the evidence must match: agent work lives in its worktree until applied; with contract partners
  // the only meaningful test is the combined one, so a combined check made after the latest runs is what counts.
  const pending = lastRun && lastRun.status !== "applied" ? lastRun : null;
  const latestRunStart = runs.at(-1)?.startedAt ?? "";
  const integFresh = !!lastInteg && (pending ? lastInteg.created_at >= latestRunStart : lastInteg.tree === tree || !!lastInteg.approved_at);
  const evidenceTree = pending ? workspaceFingerprint(pending.worktree, []) : tree;
  const latest = new Map<string, Evidence>();
  for (const e of sys) if (e.kind === "command") latest.set(e.command ?? "", e);
  const tests = task.verify.map((cmd) => {
    const combined = pending && partners.length && lastInteg && integFresh ? lastInteg.results.find((r) => r.command === cmd) : undefined;
    if (combined) return { command: cmd, exitCode: combined.exitCode, fresh: true, at: lastInteg!.created_at, evidenceId: lastInteg!.id };
    const e = latest.get(cmd);
    return e ? { command: cmd, exitCode: e.exitCode, fresh: e.environment.tree === evidenceTree, at: e.createdAt, evidenceId: e.id } : { command: cmd, exitCode: null, fresh: false, at: "", evidenceId: "" };
  });

  const stages: Stage[] = [];
  const claim = events.filter((e) => e.type === "task.transition" && e.toState === "review_required").at(-1);
  const agentEvidence = evidence.filter((e) => e.source === "agent");
  stages.push({
    id: "claimed",
    label: "Agent or person says done",
    state: claim || agentEvidence.length ? "done" : "missing",
    detail: claim ? `${claim.actor} moved it to review` : agentEvidence.length ? `${agentEvidence.length} agent-reported item(s), not verified` : "nobody has claimed it's done",
    evidence: agentEvidence.map((e) => e.id),
  });
  stages.push({
    id: "executed",
    label: "Relay ran commands",
    state: sys.length ? "done" : "missing",
    detail: sys.length ? `${sys.length} command(s) and check(s) run by Relay` : "Relay hasn't run anything for this task",
    evidence: sys.map((e) => e.id),
  });
  const failing = tests.filter((t) => t.exitCode !== null && t.exitCode !== 0);
  const unrun = tests.filter((t) => t.exitCode === null);
  const stale = tests.filter((t) => t.exitCode === 0 && !t.fresh);
  stages.push({
    id: "tested",
    label: "Tests passed on the current workspace",
    state: !task.verify.length ? "n/a" : failing.length ? "failed" : unrun.length ? "missing" : stale.length ? "stale" : "done",
    detail: !task.verify.length ? "the task has no verification commands" : failing.length ? `failing: ${failing.map((t) => `${t.command} (exit ${t.exitCode})`).join(", ")}` : unrun.length ? `not run: ${unrun.map((t) => t.command).join(", ")}` : stale.length ? `passed on an older workspace: ${stale.map((t) => t.command).join(", ")}` : `${tests.length} passed on this exact workspace`,
    evidence: tests.map((t) => t.evidenceId).filter(Boolean),
  });

  const contractIssues: string[] = [];
  for (const [cid, v] of Object.entries(task.contracts)) {
    const cur = relay.currentContract(cid);
    if (cur && cur.version !== v) contractIssues.push(`planned on ${cid} v${v}, accepted is v${cur.version}`);
  }
  const partnersChecked = !partners.length || (lastInteg && partners.every((p) => lastInteg.tasks.includes(p.id)) && lastInteg.status !== "blocked");
  stages.push({
    id: "contracts",
    label: "Contracts verified",
    state: !Object.keys(task.contracts).length ? "n/a" : contractIssues.length ? "failed" : !partnersChecked ? (lastInteg?.status === "blocked" ? "failed" : "missing") : lastInteg && !integFresh ? "stale" : "done",
    detail: !Object.keys(task.contracts).length
      ? "the task depends on no contracts"
      : contractIssues.length
        ? contractIssues.join("; ")
        : partners.length && !lastInteg
          ? `shares contracts with ${partners.map((p) => p.id).join(", ")}; they haven't been checked together`
          : lastInteg?.status === "blocked"
            ? `integration ${lastInteg.id.slice(0, 8)} blocked`
            : partners.length
              ? `checked together with ${partners.map((p) => p.id).join(", ")} in ${lastInteg!.id.slice(0, 8)}`
              : "on the accepted versions; no partner tasks",
    evidence: lastInteg ? [lastInteg.id] : [],
  });
  const approval = events.filter((e) => e.type === "task.transition" && e.toState === "completed").at(-1);
  stages.push({
    id: "approved",
    label: "Approved by a person",
    state: approval ? "done" : "missing",
    detail: approval ? `${approval.actor}${(approval.data as { integrationId?: string }).integrationId ? " through the integration gate" : ""}` : "awaiting a person with approval rights",
    evidence: approval ? [approval.id] : [],
  });
  const applied = runs.find((r) => r.status === "applied");
  stages.push({
    id: "integrated",
    label: "In the shared project",
    state: lastRun ? (applied ? "done" : "missing") : approval ? "done" : "missing",
    detail: lastRun ? (applied ? `agent run ${applied.id.slice(0, 8)} applied with a 3-way merge` : `agent changes are still in ${lastRun.worktree}`) : approval ? "a person's edits, made in the shared workspace and approved" : "not yet",
    evidence: applied ? [applied.id] : [],
  });

  const security = events
    .filter((e) => (e.type === "enforcement.decision" && (e.data as { decision?: string }).decision === "deny") || (e.type === "intent.declared" && (e.data as { outsideScope?: string[] }).outsideScope?.length) || e.type === "investigation.command")
    .map((e) => {
      const d = e.data as { path?: string; tool?: string; reason?: string; conflicts?: { kind: string }[]; outsideScope?: string[]; command?: string };
      const detail = e.type === "intent.declared" ? `asked to change files outside scope: ${d.outsideScope!.join(", ")}` : e.type === "investigation.command" ? `ran \`${d.command}\`` : `denied ${d.tool ?? "edit"} on ${d.path ?? "?"}${d.conflicts?.length ? ` (${d.conflicts.map((c) => c.kind).join(", ")})` : ""}`;
      return { at: e.at, actor: e.actor, detail };
    });
  for (const cmd of task.verify) security.push({ at: task.createdAt, actor: "owner", detail: `verification runs \`${cmd}\` on the Relay machine` });

  // The gate that applies: tasks sharing a contract complete together through the integration gate; others alone.
  const blockers: string[] = [];
  if (task.state !== "completed") {
    // The same workspace the completion gate will check: an unapplied agent run is completed from its worktree
    // (runs.apply), a person's work from the shared workspace.
    if (!partners.length) blockers.push(...relay.completionGaps(task, pending ? pending.worktree : root));
    else if (!lastInteg) blockers.push(`check together with ${partners.map((p) => p.id).join(", ")} (relay integrate check)`);
    else if (lastInteg.status !== "passed") blockers.push(...lastInteg.gaps);
    else if (!integFresh) blockers.push(`the changes moved on since integration ${lastInteg.id.slice(0, 8)} passed; check again`);
    // Apply re-checks agent work on the project as it is now when the project has moved since the agent's snapshot.
    // If that check failed and the project is still in the state it judged, the failure stands.
    const merged = pending ? events.filter((e) => e.type === "agent.merged_check" && (e.data as { runId?: string }).runId === pending.id).at(-1) : undefined;
    const md = merged?.data as { status?: string; gaps?: string[]; projectTree?: string } | undefined;
    if (md && md.status !== "passed" && md.projectTree === tree) blockers.push(`merged with the project as it is now, it didn't pass: ${(md.gaps ?? []).join("; ")}`);
  }
  for (const f of files) if (!f.inScope) blockers.push(`${f.path} is outside the task's scope`);
  for (const c of opts.impact?.consumers ?? []) for (const b of c.breaks) if (inScope(task.scope, c.file)) blockers.push(`${c.file}:${b.line} ${b.reason}`);

  const rollback: string[] = [];
  if (task.baseCommit) rollback.push(`Base revision ${task.baseCommit.slice(0, 7)}: \`git diff ${task.baseCommit.slice(0, 7)} -- ${files.map((f) => f.path).join(" ") || "<files>"}\` shows the change; \`git checkout ${task.baseCommit.slice(0, 7)} -- <file>\` restores a file`);
  for (const r of runs) rollback.push(`Agent run ${r.id.slice(0, 8)} started from snapshot ${r.snapshot.slice(0, 7)}${r.status === "applied" ? " (the shared state before it was applied)" : `; its work is in ${r.worktree}`}`);

  const approvals = [{ required: "a project owner moves it to completed (or approves its integration)", by: approval?.actor ?? null, at: approval?.at ?? null }];
  if (partners.length) approvals.push({ required: `integration approval together with ${partners.map((p) => p.id).join(", ")}`, by: lastInteg?.approved_by ?? null, at: lastInteg?.approved_at ?? null });

  const byId = Object.fromEntries(stages.map((s) => [s.id, s.state]));
  const safeToIntegrate = blockers.length === 0 && byId.tested !== "failed" && byId.tested !== "stale" && byId.tested !== "missing" && byId.contracts !== "failed" && byId.contracts !== "missing" && byId.contracts !== "stale";
  return {
    task: { id: task.id, objective: task.objective, state: task.state, owner: task.owner, agent: task.agent, scope: task.scope, contracts: task.contracts, baseCommit: task.baseCommit },
    files,
    stages,
    tests,
    security,
    blockers: [...new Set(blockers)],
    approvals,
    rollback,
    safeToIntegrate,
  };
}
