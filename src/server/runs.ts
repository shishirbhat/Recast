import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Relay } from "../core/engine.ts";
import { inScope } from "../core/conflicts.ts";
import { RelayError } from "../core/types.ts";
import type { Integration } from "../core/types.ts";
import { changedFiles } from "../git.ts";
import { HOOK_MATCHER } from "../hooks/claude-code.ts";
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
  provider: "claude-code";
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
  private claudeBin: string;
  private docs: DocStore | null = null;
  private runs = new Map<string, AgentRun>();
  private procs = new Map<string, ChildProcess>();
  private combined = new Map<string, string>(); // integration id -> combined worktree

  constructor(relay: Relay, root: string, dbPath: string, claudeBin: string) {
    this.relay = relay;
    this.root = root;
    this.dbPath = dbPath;
    this.claudeBin = claudeBin;
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
        id: runId, taskId: id, group, provider: "claude-code", startedBy: by.id, snapshot, worktree, status: "starting",
        startedAt: new Date().toISOString(), endedAt: null, exitCode: null, costUsd: null, changedFiles: [], staleInputs: [], activity: [],
      };
      this.runs.set(runId, run);
      this.relay.record("agent.run_started", actorFor(by), { runId, group, provider: run.provider, snapshot }, id);
      this.spawnClaude(run);
      started.push(run);
    }
    return started;
  }

  private spawnClaude(run: AgentRun): void {
    const task = this.relay.requireTask(run.taskId);
    const cfgDir = join(this.root, ".relay", "agents", run.id);
    mkdirSync(cfgDir, { recursive: true });
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const failClosed = `printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Relay hook failed to start; failing closed."}}'`;
    writeFileSync(join(cfgDir, "settings.json"), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: HOOK_MATCHER, hooks: [{ type: "command", command: `${q(RELAY_BIN)} --db ${q(this.dbPath)} hook claude-code --task ${q(run.taskId)} --root ${q(run.worktree)} || ${failClosed}`, timeout: 10 }] }] },
    }));
    writeFileSync(join(cfgDir, "mcp.json"), JSON.stringify({ mcpServers: { relay: { command: RELAY_BIN, args: ["--db", this.dbPath, "mcp", "--task", run.taskId, "--root", run.worktree, "--agent", "claude-code"] } } }));
    const prompt = [
      `You are working on Relay task ${task.id}: ${task.objective}`,
      `Files in scope: ${task.scope.join(", ")}.`,
      "Coordinate through the relay MCP tools: call claim_task first, read get_task and any contract you depend on, follow Relay's instructions whenever an action is blocked, and finish with submit_for_review and a short summary.",
      "Only change files in your scope. Make file changes with the Edit or Write tools.",
    ].join(" ");
    const child = spawn(this.claudeBin, ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits",
      "--settings", join(cfgDir, "settings.json"), "--mcp-config", join(cfgDir, "mcp.json"), "--strict-mcp-config",
      "--allowedTools", "Read,Edit,Write,Bash,Glob,Grep,mcp__relay"], { cwd: run.worktree, stdio: ["ignore", "pipe", "pipe"], detached: true });
    this.procs.set(run.id, child);
    run.status = "running";
    let buf = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this.onStreamLine(run, line);
      }
    });
    let stderr = "";
    child.stderr!.on("data", (c: Buffer) => (stderr = (stderr + c.toString()).slice(-4000)));
    child.on("error", (err) => this.push(run, { kind: "error", detail: `Could not start ${this.claudeBin}: ${err.message}` }));
    child.on("close", (code) => {
      this.procs.delete(run.id);
      run.exitCode = code;
      run.endedAt = new Date().toISOString();
      if (run.status === "cancelled") return;
      run.status = code === 0 ? "finished" : "failed";
      if (code !== 0 && stderr) this.push(run, { kind: "error", detail: stderr.slice(-500) });
      this.afterRun(run);
    });
  }

  /** Claude Code's stream-json output is structured; we record tool calls, not prose. */
  private onStreamLine(run: AgentRun, line: string): void {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === "assistant") {
      const content = ((ev.message as { content?: unknown[] })?.content ?? []) as Record<string, unknown>[];
      for (const c of content) {
        if (c.type === "tool_use") {
          const input = (c.input ?? {}) as Record<string, unknown>;
          const target = String(input.file_path ?? input.notebook_path ?? input.command ?? input.pattern ?? "").replace(run.worktree + "/", "").slice(0, 200);
          this.push(run, { kind: "tool", tool: String(c.name), target });
        } else if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
          this.push(run, { kind: "text", detail: c.text.trim().slice(0, 300) });
        }
      }
    } else if (ev.type === "user") {
      const content = ((ev.message as { content?: unknown[] })?.content ?? []) as Record<string, unknown>[];
      for (const c of content) {
        const text = typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? "");
        if (c.type === "tool_result" && c.is_error && /Relay blocked/.test(text)) this.push(run, { kind: "denied", detail: text.slice(0, 300) });
      }
    } else if (ev.type === "result") {
      run.costUsd = typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : null;
      this.push(run, { kind: "result", detail: String(ev.result ?? "").slice(0, 600) });
    }
  }

  private push(run: AgentRun, a: Omit<Activity, "at">): void {
    const item = { at: new Date().toISOString(), ...a };
    run.activity.push(item);
    if (run.activity.length > ACTIVITY_LIMIT) run.activity.shift();
    if (a.kind !== "text") this.relay.record(`agent.${a.kind}`, `agent:claude-code`, { runId: run.id, ...a }, run.taskId);
  }

  /** Relay's own checks on what the agent produced, in its worktree. Never the agent's word. */
  private afterRun(run: AgentRun): void {
    try {
      run.changedFiles = changedFiles(run.worktree, run.snapshot);
      const task = this.relay.requireTask(run.taskId);
      if (task.state === "review_required") {
        this.relay.diffCheck(run.taskId, run.worktree);
        this.relay.runVerification(run.taskId, run.worktree);
      }
      this.relay.record("agent.run_ended", "system:runner", { runId: run.id, status: run.status, exitCode: run.exitCode, changedFiles: run.changedFiles, costUsd: run.costUsd, taskState: task.state }, run.taskId);
    } catch (err) {
      this.push(run, { kind: "error", detail: `post-run checks failed: ${(err as Error).message}` });
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
  private mergeInto(worktree: string, snapshot: string, files: string[]): { applied: string[]; conflicts: { path: string; text: string }[]; skipped: string[] } {
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
    for (const p of plans) this.docs.applyText(p.path, p.text, "agent");
    this.docs.flushAll();
    return { applied: plans.map((p) => p.path), conflicts: [], skipped };
  }

  /**
   * Approve one agent task and bring its changes into the shared project.
   * Order: dry-run merge (refuse on conflict) → engine completion gate in the agent's worktree → apply.
   */
  apply(taskId: string, by: Member): { applied: string[]; conflicts: { path: string; text: string }[]; skipped: string[] } {
    const run = this.latest(taskId);
    if (run.status !== "finished") throw new RelayError("illegal_transition", `The agent run on ${taskId} is ${run.status}`);
    const files = changedFiles(run.worktree, run.snapshot);
    const dry = this.dryRun(run.worktree, run.snapshot, files);
    if (dry.length) return { applied: [], conflicts: dry, skipped: [] };
    this.relay.transition(taskId, "completed", actorFor(by), { expectedFrom: "review_required", cwd: run.worktree });
    const result = this.mergeInto(run.worktree, run.snapshot, files);
    run.status = "applied";
    this.relay.record("agent.changes_applied", actorFor(by), { runId: run.id, ...result, conflicts: result.conflicts.map((c) => c.path) }, taskId);
    return result;
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
  checkTogether(taskIds: string[], verify: string[]): Integration {
    const runs = taskIds.map((id) => this.latest(id));
    const snaps = new Set(runs.map((r) => r.snapshot));
    if (snaps.size !== 1) throw new RelayError("invalid", "These tasks were started from different snapshots; start them together to integrate them");
    const snapshot = runs[0]!.snapshot;
    const dir = join(this.root, ".relay", "worktrees", `integration-${randomUUID().slice(0, 8)}`);
    git(this.root, ["worktree", "add", "--detach", dir, snapshot]);
    for (const r of runs) {
      const patch = git(r.worktree, ["diff", "--binary", snapshot]);
      const untracked = git(r.worktree, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
      if (patch.trim()) execFileSync("git", ["apply", "--3way", "--whitespace=nowarn"], { cwd: dir, input: patch });
      for (const u of untracked) {
        mkdirSync(dirname(join(dir, u)), { recursive: true });
        writeFileSync(join(dir, u), readFileSync(join(r.worktree, u)));
      }
    }
    const integ = this.relay.checkIntegration(taskIds, dir, verify);
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
    const snapshot = integ.baseCommit!;
    const files = changedFiles(dir, snapshot);
    const dry = this.dryRun(dir, snapshot, files);
    if (dry.length) return { integration: integ, applied: [], conflicts: dry, skipped: [] };
    const approved = this.relay.approveIntegration(integrationId, actorFor(by), dir);
    const result = this.mergeInto(dir, snapshot, files);
    for (const id of integ.tasks) for (const r of this.runs.values()) if (r.taskId === id && r.status === "finished") r.status = "applied";
    this.relay.record("agent.changes_applied", actorFor(by), { integrationId, ...result, conflicts: [] });
    return { integration: approved, ...result };
  }

  close(): void {
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
