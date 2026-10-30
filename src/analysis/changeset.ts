import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Relay } from "../core/engine.ts";
import { inScope } from "../core/conflicts.ts";
import { relayOwnFiles } from "../git.ts";
import type { AgentRun } from "../server/runs.ts";
import { changeRecord } from "./change.ts";

/**
 * A proof-carrying changeset: one task's change as a portable file that carries the evidence for it, and lets anyone
 * with a clone check that the evidence is about exactly this change.
 *
 * - `base` is the commit the change starts from. When that is a Relay snapshot (an agent's view of the shared project,
 *   uncommitted work included), the changeset also carries the patch from the snapshot's parent, so a clone that has
 *   the parent commit can rebuild it.
 * - `change.patch` applied to the base gives `change.tree`, a git tree hash: the exact files.
 * - Every recorded command carries the tree it ran on. `coversThisChange` is true only when that tree IS `change.tree`.
 *   Verification rebuilds the tree from base + patch and recomputes this; it never trusts the file's own claims.
 * - `digest` is a SHA-256 over the rest of the file. It detects edits to the file; it is not a signature and says
 *   nothing about who made it.
 */

export const CHANGESET_FORMAT = "relay.changeset/1";
const OUTPUT_LIMIT = 4000;

export interface Changeset {
  format: typeof CHANGESET_FORMAT;
  generatedAt: string;
  generatedBy: string;
  task: { id: string; objective: string; state: string; scope: string[]; contracts: Record<string, number>; verify: string[] };
  source: "agent-worktree" | "shared-project";
  agent: { runId: string; provider: string; status: string; startedAt: string; endedAt: string | null } | null;
  base: { commit: string; tree: string; kind: "commit" | "relay-snapshot"; parent: string | null; patch: string | null };
  change: { tree: string; files: { path: string; status: "added" | "modified" | "deleted"; inScope: boolean }[]; patch: string };
  evidence: { id: string; kind: string; command: string | null; exitCode: number | null; source: "system" | "agent"; recordedAt: string; tree: string | null; coversThisChange: boolean; output: string }[];
  integrations: { id: string; tasks: string[]; status: string; tree: string; createdAt: string; approvedBy: string | null; gaps: string[] }[];
  contracts: { id: string; declared: number; current: number | null }[];
  history: { at: string; actor: string; type: string; detail: string }[];
  stages: { id: string; state: string; detail: string }[];
  warnings: string[];
  digest: string;
}

function git(cwd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string | Buffer } = {}): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: opts.env ?? process.env, input: opts.input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

/** Run `fn` with a throwaway index file, so nothing touches the repository's own index or working tree. */
function withIndex<T>(fn: (env: NodeJS.ProcessEnv) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "relay-cs-"));
  try {
    return fn({ ...process.env, GIT_INDEX_FILE: join(dir, "index") });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Digest over the changeset without its digest field (key order as written, which JSON.parse preserves). */
export function digestOf(cs: Omit<Changeset, "digest"> | Changeset): string {
  const { digest: _d, ...rest } = cs as Changeset;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex");
}

/**
 * Patch from `base` to `dir`'s files (all of them, or only `paths`), and the tree that results. Built in a temporary
 * index: tracked, untracked and deleted files alike, binary-safe.
 */
function diffFrom(dir: string, base: string, paths: string[] | null, exclude: string[]): { patch: string; tree: string; files: { path: string; status: "added" | "modified" | "deleted" }[] } {
  return withIndex((env) => {
    git(dir, ["read-tree", base], { env });
    if (paths === null) git(dir, ["add", "-A", "--", ":/", ...exclude.map((p) => `:(top,exclude,literal)${p}`)], { env });
    else if (paths.length) git(dir, ["add", "-A", "--", ...paths.map((p) => `:(top,literal)${p}`)], { env });
    const tree = git(dir, ["write-tree"], { env }).trim();
    const patch = git(dir, ["diff", "--cached", "--binary", "--no-renames", base], { env });
    const files = git(dir, ["diff", "--cached", "--name-status", "--no-renames", base], { env })
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [s, p] = l.split("\t");
        return { path: p!, status: s === "A" ? ("added" as const) : s === "D" ? ("deleted" as const) : ("modified" as const) };
      });
    return { patch, tree, files };
  });
}

export function buildChangeset(relay: Relay, root: string, dbPath: string, taskId: string, runs: AgentRun[], by: string, extraWarnings: string[] = []): Changeset {
  const task = relay.requireTask(taskId);
  const own = relayOwnFiles(root, dbPath);
  const run = runs.at(-1);
  const pending = run && run.status !== "applied" && existsSync(run.worktree) ? run : null;
  const rec = changeRecord(relay, root, dbPath, taskId, { runs });
  const warnings: string[] = [];

  let baseCommit: string;
  let change: ReturnType<typeof diffFrom>;
  if (pending) {
    baseCommit = pending.snapshot;
    change = diffFrom(pending.worktree, baseCommit, null, []);
  } else {
    baseCommit = task.baseCommit ?? git(root, ["rev-parse", "HEAD"]).trim();
    // Only this task's files: the shared project may also hold other people's unfinished work.
    change = diffFrom(root, baseCommit, rec.files.map((f) => f.path), own);
    if (run?.status === "applied") warnings.push("The agent's work was applied to the shared project; this changeset is taken from the project, so later edits to these files are included.");
    if (task.state === "completed") warnings.push("The task is completed: its files may have changed since it was integrated.");
  }
  const message = git(root, ["log", "-1", "--format=%s", baseCommit]).trim();
  const snapshot = message === "Relay snapshot of shared state";
  const parent = snapshot ? git(root, ["rev-parse", `${baseCommit}^`]).trim() : null;
  const base = {
    commit: baseCommit,
    tree: git(root, ["rev-parse", `${baseCommit}^{tree}`]).trim(),
    kind: snapshot ? ("relay-snapshot" as const) : ("commit" as const),
    parent,
    patch: parent ? git(root, ["diff", "--binary", "--no-renames", parent, baseCommit]) : null,
  };

  const evidence = relay.evidence(taskId).map((e) => {
    const tree = e.environment.tree ?? null;
    return { id: e.id, kind: e.kind, command: e.command, exitCode: e.exitCode, source: e.source, recordedAt: e.createdAt, tree, coversThisChange: tree === change.tree, output: e.output.length > OUTPUT_LIMIT ? `[first ${OUTPUT_LIMIT} characters of ${e.output.length}]\n${e.output.slice(0, OUTPUT_LIMIT)}` : e.output };
  });
  for (const cmd of task.verify) {
    const last = evidence.filter((e) => e.kind === "command" && e.command === cmd && e.source === "system").at(-1);
    if (!last) warnings.push(`${cmd} has never been run by Relay for this task.`);
    else if (!last.coversThisChange) warnings.push(`The latest run of ${cmd} was on different files than this change${last.tree?.startsWith("changed-during-run:") ? " (files changed while it ran)" : ""}.`);
    else if (last.exitCode !== 0) warnings.push(`${cmd} failed on exactly this change (exit ${last.exitCode ?? "timeout"}).`);
  }
  if (evidence.some((e) => e.source === "agent")) warnings.push("Some entries are the agent's own claims, not results Relay produced; they prove nothing on their own.");
  const outOfScope = change.files.filter((f) => !inScope(task.scope, f.path)).map((f) => f.path);
  if (outOfScope.length) warnings.push(`Changes outside the task's scope: ${outOfScope.join(", ")}.`);
  const contracts = Object.entries(task.contracts).map(([id, declared]) => ({ id, declared, current: relay.currentContract(id)?.version ?? null }));
  for (const c of contracts) if (c.current !== c.declared) warnings.push(`Built against ${c.id} v${c.declared}; ${c.current === null ? "no version is accepted now" : `v${c.current} is current`}.`);
  for (const b of rec.blockers) if (!warnings.some((w) => w.includes(b))) warnings.push(b);
  warnings.push(...extraWarnings);

  const integrations = (relay.db.prepare("SELECT id FROM integrations ORDER BY created_at").all() as { id: string }[])
    .map((r) => relay.getIntegration(r.id)!)
    .filter((i) => i.tasks.includes(taskId))
    .map((i) => ({ id: i.id, tasks: i.tasks, status: i.status, tree: i.tree, createdAt: i.createdAt, approvedBy: i.approvedBy, gaps: i.gaps }));
  const history = relay
    .events(taskId)
    .filter((e) => /^(task\.(transition|created|claimed|base_set)|agent\.(run_started|run_ended|changes_applied|run_cancelled)|integration\.)/.test(e.type) || e.type === "task.transition")
    .map((e) => ({ at: e.at, actor: e.actor, type: e.type, detail: e.toState ? `${e.fromState ?? "?"} → ${e.toState}` : "" }));

  const body: Omit<Changeset, "digest"> = {
    format: CHANGESET_FORMAT,
    generatedAt: new Date().toISOString(),
    generatedBy: by,
    task: { id: task.id, objective: task.objective, state: task.state, scope: task.scope, contracts: task.contracts, verify: task.verify },
    source: pending ? "agent-worktree" : "shared-project",
    agent: run ? { runId: run.id, provider: run.provider, status: run.status, startedAt: run.startedAt, endedAt: run.endedAt } : null,
    base,
    change: { tree: change.tree, files: change.files.map((f) => ({ ...f, inScope: inScope(task.scope, f.path) })), patch: change.patch },
    evidence,
    integrations,
    contracts,
    history,
    stages: rec.stages.map((s) => ({ id: s.id, state: s.state, detail: s.detail })),
    warnings: [...new Set(warnings)],
  };
  return { ...body, digest: digestOf(body) };
}

export interface ChangesetCheck {
  digest: "ok" | "mismatch";
  base: "ok" | "rebuilt-from-parent" | "missing" | "mismatch";
  patch: "applies" | "does-not-apply" | "not-checked";
  tree: "matches" | "differs" | "not-checked";
  evidence: { id: string; command: string | null; exitCode: number | null; coversThisChange: boolean; claimed: boolean }[];
  verdict: "verified" | "not-verified";
  reasons: string[];
}

const hasObject = (repo: string, rev: string) => {
  try {
    git(repo, ["cat-file", "-e", `${rev}^{commit}`]);
    return true;
  } catch {
    return false;
  }
};

/**
 * Check a changeset against a clone (`repo`): the digest, that the base exists (or can be rebuilt from its parent and
 * the carried patch), that the patch applies, and that base + patch is exactly the tree the evidence claims. Which
 * recorded commands ran on this change is recomputed here from the rebuilt tree. Touches no working tree or index.
 */
export function verifyChangeset(cs: Changeset, repo: string): ChangesetCheck {
  const reasons: string[] = [];
  const digest = digestOf(cs) === cs.digest ? "ok" : "mismatch";
  if (digest === "mismatch") reasons.push("The file was edited after Relay wrote it (digest mismatch).");
  let tree: ChangesetCheck["tree"] = "not-checked";
  let patch: ChangesetCheck["patch"] = "not-checked";
  let base: ChangesetCheck["base"] = "missing";
  let built: string | null = null;
  withIndex((env) => {
    if (hasObject(repo, cs.base.commit)) {
      git(repo, ["read-tree", cs.base.commit], { env });
      base = "ok";
    } else if (cs.base.parent && cs.base.patch !== null && hasObject(repo, cs.base.parent)) {
      git(repo, ["read-tree", cs.base.parent], { env });
      try {
        if (cs.base.patch) git(repo, ["apply", "--cached", "--binary", "-"], { env, input: cs.base.patch });
        base = "rebuilt-from-parent";
      } catch {
        base = "mismatch";
      }
    }
    if (base === "missing") return void reasons.push(`The base commit ${cs.base.commit.slice(0, 12)}${cs.base.parent ? ` and its parent ${cs.base.parent.slice(0, 12)} are` : " is"} not in this repository; fetch it first.`);
    if (git(repo, ["write-tree"], { env }).trim() !== cs.base.tree) {
      base = "mismatch";
      return void reasons.push("The rebuilt base doesn't match the base tree the changeset names.");
    }
    try {
      if (cs.change.patch) git(repo, ["apply", "--cached", "--binary", "-"], { env, input: cs.change.patch });
      patch = "applies";
    } catch (e) {
      patch = "does-not-apply";
      return void reasons.push(`The patch doesn't apply to the base: ${String((e as { stderr?: string }).stderr ?? "").trim().split("\n")[0]}`);
    }
    built = git(repo, ["write-tree"], { env }).trim();
    tree = built === cs.change.tree ? "matches" : "differs";
    if (tree === "differs") reasons.push("Base + patch doesn't give the tree the changeset claims.");
  });
  const evidence = cs.evidence.map((e) => ({ id: e.id, command: e.command, exitCode: e.exitCode, coversThisChange: built !== null && e.tree === built && e.source === "system", claimed: e.source === "agent" }));
  for (const cmd of cs.task.verify) {
    const last = evidence.filter((e) => e.command === cmd && !e.claimed).at(-1);
    if (!last?.coversThisChange) reasons.push(`No result of ${cmd} recorded on exactly this change.`);
    else if (last.exitCode !== 0) reasons.push(`${cmd} failed on exactly this change.`);
  }
  if (!cs.task.verify.length) reasons.push("The task has no verification commands, so nothing proves the change works.");
  return { digest, base, patch, tree, evidence, verdict: reasons.length ? "not-verified" : "verified", reasons };
}

export function changesetText(cs: Changeset, check?: ChangesetCheck): string {
  const lines = [
    `Relay changeset for ${cs.task.id}: ${cs.task.objective}`,
    `Generated ${cs.generatedAt} by ${cs.generatedBy} · task ${cs.task.state} · ${cs.source === "agent-worktree" ? `agent work (${cs.agent?.provider}, run ${cs.agent?.runId}), not applied` : "work in the shared project"}`,
    `Base ${cs.base.commit.slice(0, 12)}${cs.base.kind === "relay-snapshot" ? ` (Relay snapshot of the shared project on ${cs.base.parent?.slice(0, 12)}; patch carried)` : ""} → tree ${cs.change.tree.slice(0, 12)}`,
    "",
    "Files:",
    ...cs.change.files.map((f) => `  ${f.status.padEnd(8)} ${f.path}${f.inScope ? "" : "  (outside scope)"}`),
    "",
    "Checks Relay ran:",
    ...(cs.evidence.filter((e) => e.kind === "command").map((e) => `  ${e.exitCode === 0 ? "PASS" : "FAIL"}  ${e.command}  ${e.recordedAt}  ${e.coversThisChange ? "on exactly this change" : "on other files"}${e.source === "agent" ? "  (agent's claim)" : ""}`) || []),
    ...(cs.evidence.some((e) => e.kind === "command") ? [] : ["  none"]),
    ...(cs.contracts.length ? ["", "Contracts:", ...cs.contracts.map((c) => `  ${c.id} v${c.declared}${c.current === c.declared ? " (current)" : ` (current: ${c.current === null ? "none" : `v${c.current}`})`}`)] : []),
    ...(cs.integrations.length ? ["", "Checked together:", ...cs.integrations.map((i) => `  ${i.status.padEnd(8)} ${i.tasks.join(" + ")}  ${i.createdAt}${i.approvedBy ? `  approved by ${i.approvedBy}` : ""}`)] : []),
    "",
    "Stages:",
    ...cs.stages.map((s) => `  ${s.id.padEnd(10)} ${s.state.padEnd(7)} ${s.detail}`),
    "",
    cs.warnings.length ? "Warnings:" : "Warnings: none",
    ...cs.warnings.map((w) => `  - ${w}`),
  ];
  if (check)
    lines.push("", `Verification against this repository: ${check.verdict === "verified" ? "VERIFIED" : "NOT VERIFIED"}`, `  digest ${check.digest} · base ${check.base} · patch ${check.patch} · tree ${check.tree}`, ...check.reasons.map((r) => `  - ${r}`));
  lines.push("", `digest sha256:${cs.digest}`);
  return lines.join("\n");
}
