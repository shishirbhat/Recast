import { relative } from "node:path";
import type { Relay } from "../core/engine.ts";
import { inScope } from "../core/conflicts.ts";
import type { Task, TaskState } from "../core/types.ts";
import type { AgentRun } from "../server/runs.ts";
import { changeRecord } from "./change.ts";
import type { ChangeRecord, StageState } from "./change.ts";
import type { ProjectImpact } from "./impact.ts";

/**
 * The project's coordination at a glance: every task with a status derived only from the engine's state and its change
 * record, the dependencies between tasks, files that more than one task touches, and the answers a person needs
 * ("what's running, what blocks what, what's safe next"). Read-only: nothing here changes a task.
 */

/** One status vocabulary for the whole UI. Each value maps to engine facts; see `statusOf`. */
export type Status =
  | "proposed" // engine: proposed (waiting for an owner to approve the plan)
  | "waiting" // engine: queued with unmet prerequisites
  | "queued" // engine: queued, free to start
  | "running" // engine: running and an agent run is live, or a person is working on it
  | "stopped" // engine: running, but its last agent run ended without finishing (failed or cancelled)
  | "checking" // engine: running; the agent run finished and Relay is still checking it
  | "blocked" // engine: blocked
  | "verification_failed" // engine: review_required; the tested stage failed
  | "verification_required" // engine: review_required; tests not run, out of date, or contracts not checked
  | "review" // engine: review_required; checks done, other blockers remain (scope, approval, partners)
  | "ready" // engine: review_required and the change record says safe to integrate
  | "failed" // engine: failed
  | "cancelled" // engine: cancelled
  | "done"; // engine: completed

export interface CoordTask {
  id: string;
  objective: string;
  state: TaskState;
  status: Status;
  /** One line on why it has this status, from the record or the engine. */
  why: string;
  owner: string | null;
  agent: string | null;
  scope: string[];
  contracts: Record<string, number>;
  run: {
    id: string;
    status: AgentRun["status"];
    provider: string;
    /** Relative to the project, so people see which checkout the work lives in. */
    worktree: string;
    startedAt: string;
    endedAt: string | null;
    last: { at: string; text: string } | null;
    staleInputs: number;
  } | null;
  /** Files this task has changed (agent run worktree, or the shared workspace since its base). */
  files: string[];
  outOfScope: string[];
  stages: { id: string; state: StageState }[] | null;
  blockers: string[];
  safeToIntegrate: boolean;
  /** Unfinished prerequisites. */
  waitingOn: string[];
  /** Unfinished tasks that list this one as a prerequisite. */
  blocks: string[];
  /** Tasks on the same contract: they integrate together. */
  partners: string[];
  /** Other tasks touching the same files: both changed it, or this one changed a file in their scope. */
  overlaps: { task: string; files: string[]; kind: "both-changed" | "in-their-scope" }[];
}

export interface Coordination {
  computedAt: string;
  tasks: CoordTask[];
  answers: {
    running: string[];
    blocking: string[];
    related: { a: string; b: string; files: string[]; why: string }[];
    unverified: string[];
    review: string[];
    safeNext: string[];
  };
}

const LIVE: readonly TaskState[] = ["proposed", "queued", "running", "blocked", "review_required"];

function activityText(a: AgentRun["activity"][number]): string {
  if (a.kind === "tool") return `${a.tool ?? "tool"}${a.target ? ` ${a.target}` : ""}`;
  if (a.kind === "denied") return `denied ${a.tool ?? ""} ${a.target ?? ""}`.trim();
  return (a.detail ?? a.kind).slice(0, 160);
}

/** The status for a task, from its engine state, its latest run and its change record. Never optimistic. */
export function statusOf(task: Task, run: AgentRun | null, rec: Pick<ChangeRecord, "stages" | "blockers" | "safeToIntegrate"> | null, waitingOn: string[]): { status: Status; why: string } {
  const stage = (id: string) => rec?.stages.find((s) => s.id === id);
  switch (task.state) {
    case "proposed":
      return { status: "proposed", why: "Waiting for an owner to approve the plan" };
    case "queued":
      return waitingOn.length ? { status: "waiting", why: `Waiting on ${waitingOn.join(", ")}` } : { status: "queued", why: "Ready to start" };
    case "running":
      if (!run || run.status === "applied") return { status: "running", why: "In progress in the shared workspace" };
      if (run.status === "starting" || run.status === "running") return { status: "running", why: `${run.provider} is working in its worktree` };
      if (run.status === "finished") return { status: "checking", why: "The agent finished; Relay is checking its work" };
      return { status: "stopped", why: run.status === "failed" ? "The agent run failed" : "The agent run was cancelled" };
    case "blocked":
      return { status: "blocked", why: rec?.blockers[0] ?? "Blocked; the task shows why" };
    case "review_required": {
      const tested = stage("tested");
      const contracts = stage("contracts");
      if (tested?.state === "failed") return { status: "verification_failed", why: tested.detail ?? "Verification failed" };
      if (contracts?.state === "failed") return { status: "verification_failed", why: contracts.detail ?? "Contract check failed" };
      if (rec?.safeToIntegrate) return { status: "ready", why: "Verified on the current workspace; nothing blocks integration" };
      if (tested && ["missing", "stale"].includes(tested.state)) return { status: "verification_required", why: tested.detail ?? "Verification hasn't run on the current changes" };
      if (contracts && ["missing", "stale"].includes(contracts.state)) return { status: "verification_required", why: contracts.detail ?? "Contract partners haven't been checked together" };
      return { status: "review", why: rec?.blockers[0] ?? "Needs a person's review" };
    }
    case "failed":
      return { status: "failed", why: run?.activity.filter((a) => a.kind === "error").at(-1)?.detail ?? "The task failed; its log shows why" };
    case "cancelled":
      return { status: "cancelled", why: "Cancelled" };
    case "completed":
      return { status: "done", why: "Completed and approved" };
  }
}

export function coordination(relay: Relay, root: string, dbPath: string, runsFor: (taskId: string) => AgentRun[], impact?: ProjectImpact): Coordination {
  const tasks = relay.listTasks().filter((t) => t.state !== "cancelled");
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const unfinished = (id: string) => byId.get(id)?.state !== "completed";
  const out: CoordTask[] = tasks.map((t) => {
    const runs = runsFor(t.id);
    const run = runs.at(-1) ?? null;
    // The change record runs git; only live tasks need it.
    const rec = LIVE.includes(t.state) ? changeRecord(relay, root, dbPath, t.id, { runs, impact }) : null;
    const waitingOn = t.prerequisites.filter(unfinished);
    const st = statusOf(t, run, rec, waitingOn);
    const files = rec ? rec.files.map((f) => f.path) : run && run.status !== "applied" ? run.changedFiles : [];
    return {
      id: t.id,
      objective: t.objective,
      state: t.state,
      ...st,
      owner: t.owner,
      agent: t.agent,
      scope: t.scope,
      contracts: t.contracts,
      run: run
        ? {
            id: run.id,
            status: run.status,
            provider: run.provider,
            worktree: relative(root, run.worktree) || run.worktree,
            startedAt: run.startedAt,
            endedAt: run.endedAt,
            last: run.activity.length ? { at: run.activity.at(-1)!.at, text: activityText(run.activity.at(-1)!) } : null,
            staleInputs: run.staleInputs.length,
          }
        : null,
      files,
      outOfScope: rec ? rec.files.filter((f) => !f.inScope).map((f) => f.path) : files.filter((f) => !inScope(t.scope, f)),
      stages: rec ? rec.stages.map((s) => ({ id: s.id, state: s.state })) : null,
      blockers: rec?.blockers ?? [],
      safeToIntegrate: rec?.safeToIntegrate ?? false,
      waitingOn,
      blocks: tasks.filter((o) => o.prerequisites.includes(t.id) && o.state !== "completed").map((o) => o.id),
      partners: tasks.filter((o) => o.id !== t.id && LIVE.includes(o.state) && Object.keys(o.contracts).some((c) => c in t.contracts)).map((o) => o.id),
      overlaps: [],
    };
  });

  // Overlaps among live tasks: files both changed, or files one changed inside the other's scope.
  const live = out.filter((t) => LIVE.includes(t.state));
  const related: Coordination["answers"]["related"] = [];
  for (const a of live) {
    for (const b of live) {
      if (a.id === b.id) continue;
      const both = a.files.filter((f) => b.files.includes(f));
      const theirs = a.files.filter((f) => !both.includes(f) && inScope(b.scope, f));
      if (both.length) a.overlaps.push({ task: b.id, files: both, kind: "both-changed" });
      if (theirs.length) a.overlaps.push({ task: b.id, files: theirs, kind: "in-their-scope" });
      if (a.id < b.id && (both.length || theirs.length || b.files.some((f) => inScope(a.scope, f)))) {
        const files = [...new Set([...both, ...theirs, ...b.files.filter((f) => inScope(a.scope, f))])];
        related.push({ a: a.id, b: b.id, files, why: both.length ? "both changed the same files" : "one changed files in the other's scope" });
      }
    }
  }
  for (const a of live) for (const p of a.partners) if (a.id < p && !related.some((r) => r.a === a.id && r.b === p)) related.push({ a: a.id, b: p, files: [], why: "share a contract and must integrate together" });

  const order = (ids: CoordTask[]) => ids.sort((x, y) => y.blocks.length - x.blocks.length || x.id.localeCompare(y.id)).map((t) => t.id);
  return {
    computedAt: new Date().toISOString(),
    tasks: out,
    answers: {
      running: out.filter((t) => t.status === "running" || t.status === "checking").map((t) => t.id),
      blocking: order(out.filter((t) => t.blocks.length && t.state !== "completed")),
      related,
      unverified: out.filter((t) => ["checking", "verification_required", "verification_failed"].includes(t.status)).map((t) => t.id),
      review: out.filter((t) => t.state === "review_required").map((t) => t.id),
      safeNext: order(out.filter((t) => t.status === "ready")),
    },
  };
}
