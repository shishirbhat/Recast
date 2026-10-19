import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Conflict, ContractVersion, Decision, Task, TaskState } from "./types.ts";
import { ACTIVE_STATES } from "./types.ts";

/** Paths no task may write: Relay's own state and the agent configs that carry its hooks. */
export const PROTECTED_PREFIXES = [".relay/", ".git/", ".claude/", ".codex/", ".cursor/", ".mcp.json"];

/** Resolves p against root, following symlinks of existing ancestors. null means it escapes root. */
export function normalizePath(root: string, p: string): string | null {
  const realRoot = realpathSync(root);
  let abs = resolve(root, p);
  // Walk up to the nearest existing ancestor so new files and symlinked dirs both resolve.
  const tail: string[] = [];
  while (!existsSync(abs)) {
    const parent = dirname(abs);
    if (parent === abs) break;
    tail.unshift(basename(abs));
    abs = parent;
  }
  const real = join(realpathSync(abs), ...tail);
  const rel = relative(realRoot, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

export function inScope(scope: readonly string[], path: string): boolean {
  return scope.some((s) => (s.endsWith("/") ? path.startsWith(s) : path === s));
}

export function isProtected(path: string): boolean {
  return PROTECTED_PREFIXES.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
}

export interface EditContext {
  task: Task | undefined;
  taskId: string;
  /** Repo-relative path, or null when it resolved outside the repository. */
  path: string | null;
  rawPath: string;
  allTasks: readonly Task[];
  /** contract id -> latest accepted version */
  current: ReadonlyMap<string, ContractVersion>;
  /** States in which this task may write. Pre-action checks require running. */
  writableStates: readonly TaskState[];
}

export function evaluateEdit(ctx: EditContext): Decision {
  const { task, taskId, path } = ctx;
  const conflicts: Conflict[] = [];
  const base = { taskId, path, otherTasks: [] as string[], contract: null };

  if (!task) {
    conflicts.push({ ...base, rule: "unknown_task", severity: "block", reason: `Unknown task ${taskId}`, remediation: "Bind the agent to an existing Relay task." });
    return finish(conflicts);
  }
  if (!ctx.writableStates.includes(task.state)) {
    conflicts.push({
      ...base,
      rule: "inactive_task",
      severity: "block",
      reason: `Task ${taskId} is ${task.state}; edits need it to be ${ctx.writableStates.join(" or ")}`,
      remediation: "Claim the task (claim_task) before editing.",
    });
    return finish(conflicts);
  }
  if (path === null) {
    conflicts.push({ ...base, path: ctx.rawPath, rule: "protected_path", severity: "block", reason: `${ctx.rawPath} resolves outside the repository`, remediation: "Edit files inside the task's repository only." });
    return finish(conflicts);
  }
  if (isProtected(path)) {
    conflicts.push({ ...base, rule: "protected_path", severity: "block", reason: `${path} is a protected Relay/agent configuration path`, remediation: "Ask a human to change it." });
    return finish(conflicts);
  }

  const others = ctx.allTasks
    .filter((t) => t.id !== taskId && ACTIVE_STATES.includes(t.state) && inScope(t.scope, path))
    .map((t) => t.id);

  if (!inScope(task.scope, path)) {
    conflicts.push(
      others.length
        ? { ...base, otherTasks: others, rule: "owned_by_other_task", severity: "block", reason: `${path} belongs to active task(s) ${others.join(", ")}, not ${taskId}`, remediation: "Report a blocker or ask the owning task to make this change." }
        : { ...base, rule: "outside_scope", severity: "block", reason: `${path} is outside task ${taskId} scope [${task.scope.join(", ")}]`, remediation: "Declare intent for this file; a human must approve the scope expansion." },
    );
  } else if (others.length) {
    conflicts.push({ ...base, otherTasks: others, rule: "shared_scope", severity: "warn", reason: `${path} is also in scope of active task(s) ${others.join(", ")}`, remediation: "Coordinate the change; integration review will show both changesets." });
  }

  for (const [cid, planned] of Object.entries(task.contracts)) {
    const cur = ctx.current.get(cid);
    if (cur && cur.version > planned) {
      conflicts.push({
        ...base,
        rule: "stale_contract",
        severity: "block",
        contract: { id: cid, plannedVersion: planned, currentVersion: cur.version, current: cur.definition },
        reason: `Task ${taskId} was planned against ${cid} v${planned}, superseded by v${cur.version}. Authoritative contract v${cur.version}: ${cur.definition}`,
        remediation: `Read ${cid} v${cur.version}, adapt the plan, then acknowledge_contract(${cid}, ${cur.version}) before editing.`,
      });
    }
  }
  return finish(conflicts);
}

function finish(conflicts: Conflict[]): Decision {
  const blocking = conflicts.filter((c) => c.severity === "block");
  if (blocking.length) return { decision: "deny", conflicts, reason: blocking.map((c) => c.reason).join(" | ") };
  return { decision: "allow", conflicts, reason: conflicts.length ? conflicts.map((c) => c.reason).join(" | ") : "in scope, contracts current" };
}
