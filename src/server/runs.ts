import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { verificationEnv } from "../core/engine.ts";
import type { Relay } from "../core/engine.ts";
import { inScope } from "../core/conflicts.ts";
import { RelayError } from "../core/types.ts";
import type { Integration } from "../core/types.ts";
import { changedFiles, relayOwnFiles, workspaceFingerprint } from "../git.ts";
import { claudeCode } from "../providers/claude-code.ts";
import type { ProviderAdapter } from "../providers/types.ts";
import type { Member } from "./auth.ts";
import { actorFor } from "./auth.ts";
import type { DocStore } from "./docs.ts";
import { merge3, resolveProjectPath } from "./files.ts";

const RELAY_BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../../bin/relay");
const ACTIVITY_LIMIT = 200;

export type RunStatus = "starting" | "running" | "finished" | "failed" | "cancelled" | "applied";

export interface Activity {
  at: string;
  kind: "tool" | "denied" | "text" | "result" | "error";
  tool?: string;
  target?: string;
  detail?: string;
}

export interface AgentRun {
  id: string;
  taskId: string;
  group: string;
  provider: string;
  startedBy: string;
  snapshot: string;
  worktree: string;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  costUsd: number | null;
  changedFiles: string[];
  staleInputs: { path: string; by: string; at: string }[];
  activity: Activity[];
  /** Relay is running its own checks (diff check, verification) on the finished run; it can't be applied yet. */
  checking?: boolean;
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
}

/** A commit holding the workspace exactly as it is on disk (tracked + untracked, minus ignored), parented on HEAD. */
export function snapshotCommit(root: string): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-snap-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
    git(root, ["add", "-A", "--", ":/"], env);
    const tree = git(root, ["write-tree"], env).trim();
    const head = git(root, ["rev-parse", "HEAD"]).trim();
    const commitEnv = { ...env, GIT_AUTHOR_NAME: "Relay", GIT_AUTHOR_EMAIL: "relay@localhost", GIT_COMMITTER_NAME: "Relay", GIT_COMMITTER_EMAIL: "relay@localhost" };
    return git(root, ["commit-tree", tree, "-p", head, "-m", "Relay snapshot of shared state"], commitEnv).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The tree a commit records: two commits with the same tree hold exactly the same files. */
function treeOf(root: string, commit: string): string {
  return git(root, ["rev-parse", `${commit}^{tree}`]).trim();
}

/** Content of `path` at `commit`, or null if it does not exist there. */
function showAt(root: string, commit: string, path: string): string | null {
  try {
    return git(root, ["show", `${commit}:${path}`]);
  } catch {
    return null;
  }
}

export class AgentRuns {
  private relay: Relay;
  private root: string;
  private dbPath: string;
  private adapter: ProviderAdapter;
  private docs: DocStore | null = null;
  private runs = new Map<string, AgentRun>();
  private procs = new Map<string, ChildProcess>();
  private combined = new Map<string, string>(); // integration id -> combined worktree
  private context: ((taskId: string) => string) | null = null;
  /** Set on shutdown: output and exits that arrive afterwards must not touch the (closed) database. */
  private closed = false;
  /** Runs being applied right now: a second apply of the same run is refused instead of racing the first. */
  private applying = new Set<string>();
  /** Tasks whose combined check is running: they can be neither applied nor checked again until it is recorded. */
  private rehearsing = new Set<string>();

  constructor(relay: Relay, root: string, dbPath: string, adapter: ProviderAdapter | string) {
    this.relay = relay;
    this.root = root;
    this.dbPath = dbPath;
    this.adapter = typeof adapter === "string" ? claudeCode(adapter) : adapter;
    ensureLocalExclude(root);
  }

  attachDocs(docs: DocStore): void {
    this.docs = docs;
  }

  forTask(taskId: string): AgentRun[] {
    return [...this.runs.values()].filter((r) => r.taskId === taskId).map((r) => ({ ...r, activity: r.activity.slice(-50) }));
  }

  private latest(taskId: string): AgentRun {
    const r = [...this.runs.values()].filter((x) => x.taskId === taskId).at(-1);
    if (!r) throw new RelayError("not_found", `No agent run for ${taskId}`);
    return r;
  }

  /**
   * Start Claude Code on one or more queued tasks from ONE snapshot of the shared state, each in its own worktree.
   * Tasks started together share a base commit, which the integration gate requires.
   */
  async start(taskIds: string | string[], by: Member): Promise<AgentRun[]> {
    const ids = Array.isArray(taskIds) ? taskIds : [taskIds];
    for (const id of ids) {
      const t = this.relay.requireTask(id);
      if (t.state !== "queued") throw new RelayError("illegal_transition", `${id} is ${t.state}; an agent can only start on a queued task`);
      if ([...this.runs.values()].some((r) => r.taskId === id && (r.status === "running" || r.status === "starting"))) throw new RelayError("conflict", `${id} already has a running agent`);
    }
    this.docs?.flushAll();
    const snapshot = snapshotCommit(this.root);
    const group = randomUUID().slice(0, 8);
    const started: AgentRun[] = [];
    for (const id of ids) {
      this.relay.setBaseCommit(id, snapshot, actorFor(by));
      const runId = randomUUID().slice(0, 8);
      const worktree = join(this.root, ".relay", "worktrees", `${id}-${runId}`);
      git(this.root, ["worktree", "add", "--detach", worktree, snapshot]);
      const run: AgentRun = {
        id: runId, taskId: id, group, provider: this.adapter.id, startedBy: by.id, snapshot, worktree, status: "starting",
        startedAt: new Date().toISOString(), endedAt: null, exitCode: null, costUsd: null, changedFiles: [], staleInputs: [], activity: [],
      };
      this.runs.set(runId, run);
      this.relay.record("agent.run_started", actorFor(by), { runId, group, provider: run.provider, snapshot }, id);
      this.spawnAgent(run);
      started.push(run);
    }
    return started;
  }

  /** Supplies the task's reference context (accepted decisions, current contracts, warnings) for agent prompts. */
  attachContext(fn: (taskId: string) => string): void {
    this.context = fn;
  }

  /** The provider this runner uses, with its declared capabilities. */
  get provider(): Pick<ProviderAdapter, "id" | "displayName" | "capabilities" | "available"> {
    return this.adapter;
  }

  private spawnAgent(run: AgentRun): void {
    const task = this.relay.requireTask(run.taskId);
    const configDir = join(this.root, ".relay", "agents", run.id);
    mkdirSync(configDir, { recursive: true });
    const prompt = [
      `You are working on Relay task ${task.id}: ${task.objective}`,
      `Files in scope: ${task.scope.join(", ")}.`,
      "Coordinate through the relay MCP tools: call claim_task first, read get_task and any contract you depend on, follow Relay's instructions whenever an action is blocked, and finish with submit_for_review and a short summary.",
      "Only change files in your scope. Make file changes with the Edit or Write tools.",
    ].join(" ");
    let reference = "";
    try {
      reference = this.context?.(run.taskId) ?? "";
    } catch {
      reference = "";
    }
    const spec = this.adapter.launch({ runId: run.id, taskId: run.taskId, worktree: run.worktree, configDir, prompt: reference ? `${prompt}\n\n${reference}` : prompt, relayBin: RELAY_BIN, dbPath: this.dbPath });
    const child = spawn(spec.command, spec.args, { cwd: run.worktree, stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...verificationEnv(), ...spec.env } });
    this.procs.set(run.id, child);
    run.status = "running";
    let buf = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line && !this.closed) this.onStreamLine(run, line);
      }
    });
    let stderr = "";
    child.stderr!.on("data", (c: Buffer) => (stderr = (stderr + c.toString()).slice(-4000)));
    child.on("error", (err) => !this.closed && this.push(run, { kind: "error", detail: `Could not start ${this.adapter.displayName}: ${err.message}` }));
    child.on("close", (code) => {
      this.procs.delete(run.id);
      if (this.closed) return;
      run.exitCode = code;
      run.endedAt = new Date().toISOString();
      if (run.status === "cancelled") return;
      run.status = code === 0 ? "finished" : "failed";
      if (code !== 0 && stderr) this.push(run, { kind: "error", detail: stderr.slice(-500) });
      void this.afterRun(run);
    });
  }

  private onStreamLine(run: AgentRun, line: string): void {
    for (const a of this.adapter.parse(line, run.worktree)) {
      if (a.kind === "result") {
        run.costUsd = a.costUsd;
        this.push(run, { kind: "result", detail: a.detail });
      } else this.push(run, a);
    }
  }

  private push(run: AgentRun, a: Omit<Activity, "at">): void {
    const item = { at: new Date().toISOString(), ...a };
    run.activity.push(item);
    if (run.activity.length > ACTIVITY_LIMIT) run.activity.shift();
    if (a.kind !== "text") this.relay.record(`agent.${a.kind}`, `agent:${this.adapter.id}`, { runId: run.id, ...a }, run.taskId);
  }

  /**
   * Relay's own checks on what the agent produced, in its worktree. Never the agent's word. The verification commands
   * run without blocking the server, so people keep editing together while an agent's tests run.
   */
  private async afterRun(run: AgentRun): Promise<void> {
    run.checking = true;
    try {
      run.changedFiles = changedFiles(run.worktree, run.snapshot);
      const task = this.relay.requireTask(run.taskId);
      if (task.state === "review_required") {
        this.relay.diffCheck(run.taskId, run.worktree);
        await this.relay.runVerificationAsync(run.taskId, run.worktree);
      }
      if (this.closed) return;
      this.relay.record("agent.run_ended", "system:runner", { runId: run.id, status: run.status, exitCode: run.exitCode, changedFiles: run.changedFiles, costUsd: run.costUsd, taskState: task.state }, run.taskId);
    } catch (err) {
      if (!this.closed) this.push(run, { kind: "error", detail: `post-run checks failed: ${(err as Error).message}` });
    } finally {
      run.checking = false;
    }
  }

  cancel(taskId: string): AgentRun {
    const run = this.latest(taskId);
    const proc = this.procs.get(run.id);
    if (!proc) throw new RelayError("illegal_transition", `The agent on ${taskId} is not running`);
    run.status = "cancelled";
    try {
      process.kill(-proc.pid!, "SIGTERM"); // the whole process group: claude and its tool subprocesses
    } catch {
      proc.kill("SIGTERM");
    }
    const t = this.relay.getTask(taskId);
    if (t?.state === "running") this.relay.transition(taskId, "failed", { kind: "system", id: "runner" }, { reason: "agent run cancelled" });
    this.relay.record("agent.run_cancelled", "system:runner", { runId: run.id }, taskId);
    return run;
  }

  /** A human edited a file while an agent works from an older snapshot of it: record it, never hide it. */
  noteHumanEdit(path: string, by: string): void {
    for (const run of this.runs.values()) {
      if (run.status !== "running" && run.status !== "finished") continue;
      const task = this.relay.getTask(run.taskId);
      if (!task || !inScope(task.scope, path) || run.staleInputs.some((s) => s.path === path)) continue;
      const item = { path, by, at: new Date().toISOString() };
      run.staleInputs.push(item);
      this.relay.record("task.input_changed", "system:collab", { runId: run.id, path, by }, run.taskId);
    }
  }

  /**
   * Merge a worktree's changes (relative to `snapshot`) into the shared documents with a 3-way merge per file.
   * All-or-nothing: if any file conflicts, nothing is applied and the conflicts are returned.
   */
  private mergeInto(worktree: string, snapshot: string, files: string[], label: string): { applied: string[]; conflicts: { path: string; text: string }[]; skipped: string[] } {
    if (!this.docs) throw new RelayError("invalid", "No document store attached");
    const plans: { path: string; text: string }[] = [];
    const conflicts: { path: string; text: string }[] = [];
    const skipped: string[] = [];
    for (const f of files) {
      const path = resolveProjectPath(this.root, f);
      const theirsPath = join(worktree, path);
      if (!existsSync(theirsPath)) {
        skipped.push(`${path} (deleted by the agent; deletions are not applied automatically yet)`);
        continue;
      }
      const base = showAt(this.root, snapshot, path) ?? "";
      const theirs = readFileSync(theirsPath, "utf8");
      const ours = this.docs.open(path).text.toString();
      const m = merge3(base, ours, theirs);
      (m.clean ? plans : conflicts).push({ path, text: m.text });
    }
    if (conflicts.length) return { applied: [], conflicts, skipped };
    for (const p of plans) this.docs.applyText(p.path, p.text, `agent:${label}`);
    this.docs.flushAll();
    return { applied: plans.map((p) => p.path), conflicts: [], skipped };
  }

  /**
   * Approve one agent task and bring its changes into the shared project.
   * Order: refuse if a file it changed was renamed or deleted meanwhile → dry-run merge (refuse on conflict) → engine
   * gate → apply. If the shared project is exactly as the agent's snapshot, the gate is judged in the agent's worktree.
   * If people changed anything since (in any file), the agent's verification no longer describes the result, so Relay
   * rebuilds the change on the project as it is now, in a temporary worktree, and runs the engine's integration check
   * there (every verify command, recorded); the task completes only if that exact tree passed.
   */
  async apply(taskId: string, by: Member): Promise<{ applied: string[]; conflicts: { path: string; text: string }[]; skipped: string[]; reverified: boolean; integrationId: string | null }> {
    const run = this.latest(taskId);
    if (this.rehearsing.has(taskId)) throw new RelayError("illegal_transition", `${taskId} is being checked together with other tasks; nothing can be applied until that check finishes`);
    if (run.status !== "finished") throw new RelayError("illegal_transition", `The agent run on ${taskId} is ${run.status}`);
    if (run.checking) throw new RelayError("illegal_transition", `Relay is still checking the agent's work on ${taskId}; apply once its verification has run`);
    if (this.applying.has(run.id)) throw new RelayError("illegal_transition", `${taskId} is already being applied`);
    this.applying.add(run.id);
    try {
      const files = changedFiles(run.worktree, run.snapshot);
      const gone = files.filter((f) => showAt(this.root, run.snapshot, f) !== null && !existsSync(join(this.root, resolveProjectPath(this.root, f))));
      if (gone.length) throw new RelayError("stale_state", `${gone.join(", ")} ${gone.length === 1 ? "was" : "were"} renamed or deleted in the project while the agent worked; nothing was applied. Rerun the task on the current files.`);
      const dry = this.dryRun(run.worktree, run.snapshot, files);
      if (dry.length) return { applied: [], conflicts: dry, skipped: [], reverified: false, integrationId: null };
      this.docs!.flushAll();
      const now = snapshotCommit(this.root);
      let integrationId: string | null = null;
      // Nothing to re-run without verify commands; the gate in the worktree (diff check) is all there is.
      if (!this.relay.requireTask(taskId).verify.length || treeOf(this.root, now) === treeOf(this.root, run.snapshot)) {
        this.relay.transition(taskId, "completed", actorFor(by), { expectedFrom: "review_required", cwd: run.worktree });
      } else {
        integrationId = await this.verifyOnCurrent(run, taskId, files, now, by);
      }
      const result = this.mergeInto(run.worktree, run.snapshot, files, `${run.provider}:${run.taskId}`);
      run.status = "applied";
      this.relay.record("agent.changes_applied", actorFor(by), { runId: run.id, ...result, conflicts: result.conflicts.map((c) => c.path), integrationId }, taskId);
      return { ...result, reverified: integrationId !== null, integrationId };
    } finally {
      this.applying.delete(run.id);
    }
  }

  /**
   * The project changed since the agent's snapshot: build what applying would produce (the project at `base` with the
   * agent's change merged 3-way into it) in a temporary worktree, run the integration check there, and complete the task
   * by approving that check. Refuses if the check fails or the project moved again while it ran. Returns the
   * integration id.
   */
  private async verifyOnCurrent(run: AgentRun, taskId: string, files: string[], base: string, by: Member): Promise<string> {
    const dir = join(this.root, ".relay", "worktrees", `verify-${taskId}-${randomUUID().slice(0, 8)}`);
    git(this.root, ["worktree", "add", "--detach", dir, base]);
    try {
      for (const f of files) {
        const path = resolveProjectPath(this.root, f);
        if (!existsSync(join(run.worktree, path))) continue;
        const m = merge3(showAt(this.root, run.snapshot, path) ?? "", showAt(this.root, base, path) ?? "", readFileSync(join(run.worktree, path), "utf8"));
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), m.text);
      }
      const integ = await this.relay.checkIntegrationAsync([taskId], dir, [], undefined, { rebasedOnto: base });
      // Which project state this judged, so the task's row can show a failure for as long as the project stays so.
      this.relay.record("agent.merged_check", "system:runner", { runId: run.id, integrationId: integ.id, status: integ.status, gaps: integ.gaps, projectTree: workspaceFingerprint(this.root, relayOwnFiles(this.root, this.dbPath)) }, taskId);
      if (integ.status !== "passed") throw new RelayError("unverified", `The project changed since the agent's snapshot, and its change merged with the project as it is now didn't pass: ${integ.gaps.join("; ")}. Nothing was applied.`);
      // People may have kept editing while the check ran: apply only what was checked.
      this.docs!.flushAll();
      if (treeOf(this.root, snapshotCommit(this.root)) !== treeOf(this.root, base)) throw new RelayError("stale_state", "The project changed again while Relay checked the merged result; nothing was applied. Apply again to check the current state.");
      this.relay.approveIntegration(integ.id, actorFor(by), dir);
      return integ.id;
    } finally {
      try {
        git(this.root, ["worktree", "remove", "--force", dir]);
      } catch {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  private dryRun(worktree: string, snapshot: string, files: string[]): { path: string; text: string }[] {
    const out: { path: string; text: string }[] = [];
    for (const f of files) {
      const path = resolveProjectPath(this.root, f);
      const theirsPath = join(worktree, path);
      if (!existsSync(theirsPath)) continue;
      const m = merge3(showAt(this.root, snapshot, path) ?? "", this.docs!.open(path).text.toString(), readFileSync(theirsPath, "utf8"));
      if (!m.clean) out.push({ path, text: m.text });
    }
    return out;
  }

  /**
   * Check coupled agent tasks together: build one worktree from their shared snapshot with every task's
   * changes, then run the engine's integration gate there.
   */
  async checkTogether(taskIds: string[], verify: string[]): Promise<Integration> {
    const runs = taskIds.map((id) => this.latest(id));
    const busy = taskIds.filter((id) => this.rehearsing.has(id));
    if (busy.length) throw new RelayError("illegal_transition", `${busy.join(", ")} ${busy.length === 1 ? "is" : "are"} already being checked together; wait for that result`);
    const unfinished = runs.filter((r) => r.status !== "finished" || r.checking);
    if (unfinished.length) throw new RelayError("illegal_transition", unfinished.map((r) => `${r.taskId}'s agent run is ${r.checking ? "still being checked by Relay" : r.status}`).join("; "));
    for (const id of taskIds) this.rehearsing.add(id);
    try {
      return await this.rehearse(taskIds, runs, verify);
    } finally {
      for (const id of taskIds) this.rehearsing.delete(id);
    }
  }

  /** True while a combined check runs for the task; applying or approving it waits until the result is recorded. */
  isRehearsing(taskId: string): boolean {
    return this.rehearsing.has(taskId);
  }

  private async rehearse(taskIds: string[], runs: AgentRun[], verify: string[]): Promise<Integration> {
    // Runs started together share a snapshot. After one task is rerun (e.g. to fix a mismatch the gate found), its
    // partners' work is rebased 3-way onto the newest snapshot instead of being thrown away; a real conflict refuses.
    // If the shared project itself moved since then, the check is made on top of the project as it is now, because
    // that is what approving would apply onto.
    const newest = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]!.snapshot;
    this.docs?.flushAll();
    const now = snapshotCommit(this.root);
    const snapshot = treeOf(this.root, now) === treeOf(this.root, newest) ? newest : now;
    const rebased = runs.some((r) => r.snapshot !== snapshot);
    const dir = join(this.root, ".relay", "worktrees", `integration-${randomUUID().slice(0, 8)}`);
    git(this.root, ["worktree", "add", "--detach", dir, snapshot]);
    for (const r of runs) {
      const patch = git(r.worktree, ["diff", "--binary", r.snapshot]);
      const untracked = git(r.worktree, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
      if (patch.trim()) {
        try {
          execFileSync("git", ["apply", "--3way", "--whitespace=nowarn"], { cwd: dir, input: patch, stdio: ["pipe", "pipe", "pipe"] });
        } catch (e) {
          git(this.root, ["worktree", "remove", "--force", dir]);
          throw new RelayError("conflict", `${r.taskId}'s changes don't apply cleanly on the newer shared state (${String((e as { stderr?: Buffer }).stderr ?? "").trim().split("\n").at(-1)}); rerun ${taskIds.join(", ")} together`);
        }
      }
      for (const u of untracked) {
        mkdirSync(dirname(join(dir, u)), { recursive: true });
        writeFileSync(join(dir, u), readFileSync(join(r.worktree, u)));
      }
    }
    const changedBy = Object.fromEntries(runs.map((r) => [r.taskId, changedFiles(r.worktree, r.snapshot)]));
    const integ = await this.relay.checkIntegrationAsync(taskIds, dir, verify, undefined, { ...(rebased ? { rebasedOnto: snapshot } : {}), changedBy });
    this.combined.set(integ.id, dir);
    return integ;
  }

  hasCombined(integrationId: string): boolean {
    return this.combined.has(integrationId);
  }

  hasRuns(taskId: string): boolean {
    return [...this.runs.values()].some((r) => r.taskId === taskId);
  }

  /** Approve a combined integration (engine gate, bound to the checked tree) and apply it to the shared project. */
  approveTogether(integrationId: string, by: Member) {
    const dir = this.combined.get(integrationId);
    if (!dir) throw new RelayError("not_found", "This integration was not prepared by the agent runner");
    const integ = this.relay.getIntegration(integrationId)!;
    const busy = integ.tasks.filter((id) => this.rehearsing.has(id));
    if (busy.length) throw new RelayError("illegal_transition", `${busy.join(", ")} ${busy.length === 1 ? "is" : "are"} being checked together again; approve once that check finishes`);
    const snapshot = integ.baseCommit!;
    // The check judged the change on top of the project as it was at `snapshot`. If the project moved since, that
    // result no longer covers what applying would produce: require a new check (which rebases onto the new state).
    this.docs?.flushAll();
    if (treeOf(this.root, snapshotCommit(this.root)) !== treeOf(this.root, snapshot)) throw new RelayError("stale_state", "The shared project changed since this check; check these tasks together again before approving");
    const files = changedFiles(dir, snapshot);
    const dry = this.dryRun(dir, snapshot, files);
    if (dry.length) return { integration: integ, applied: [], conflicts: dry, skipped: [] };
    const approved = this.relay.approveIntegration(integrationId, actorFor(by), dir);
    const result = this.mergeInto(dir, snapshot, files, `${this.adapter.id}:${integ.tasks.join("+")}`);
    for (const id of integ.tasks) for (const r of this.runs.values()) if (r.taskId === id && r.status === "finished") r.status = "applied";
    this.relay.record("agent.changes_applied", actorFor(by), { integrationId, ...result, conflicts: [] });
    return { integration: approved, ...result };
  }

  close(): void {
    this.closed = true;
    for (const [id, p] of this.procs) {
      const run = this.runs.get(id);
      if (run) run.status = "cancelled";
      try {
        process.kill(-p.pid!, "SIGTERM");
      } catch {
        p.kill("SIGTERM");
      }
    }
  }
}

/** Keep Relay's own state (database, worktrees, agent configs) out of git status, once, without touching .gitignore. */
export function ensureLocalExclude(root: string): void {
  const gitDir = git(root, ["rev-parse", "--git-common-dir"]).trim();
  const file = resolve(root, gitDir, "info", "exclude");
  mkdirSync(dirname(file), { recursive: true });
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (!/^\/?\.relay\/?$/m.test(cur)) writeFileSync(file, cur + (cur.endsWith("\n") || !cur ? "" : "\n") + ".relay/\n");
}
