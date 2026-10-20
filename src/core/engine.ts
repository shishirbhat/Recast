import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { openDb, tx } from "./db.ts";
import { canTransition } from "./statemachine.ts";
import { evaluateEdit, inScope, isProtected, normalizePath } from "./conflicts.ts";

/**
 * Environment for commands Relay runs as verification. Runner-context variables inherited from whatever started Relay must
 * not leak in: e.g. NODE_TEST_CONTEXT makes a nested `node --test` skip every file and exit 0, which would be a false pass.
 */
function verificationEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("NODE_TEST_") || k === "VITEST" || k === "JEST_WORKER_ID") delete env[k];
  return env;
}
import { changedFiles, repoRoot, workspaceFingerprint } from "../git.ts";
import type {
  Actor,
  ContractVersion,
  Decision,
  EnforcementPoint,
  Evidence,
  Integration,
  Intent,
  RelayEvent,
  Task,
  TaskState,
} from "./types.ts";
import { ACTIVE_STATES, RelayError, TASK_STATES } from "./types.ts";

type Row = Record<string, unknown>;
const OUTPUT_LIMIT = 16_000;

const actorString = (a: Actor) => `${a.kind}:${a.id}`;
const now = () => new Date().toISOString();

function toTask(r: Row): Task {
  return {
    id: r.id as string,
    objective: r.objective as string,
    state: r.state as TaskState,
    owner: (r.owner as string | null) ?? null,
    agent: (r.agent as string | null) ?? null,
    scope: JSON.parse(r.scope as string),
    contracts: JSON.parse(r.contracts as string),
    prerequisites: JSON.parse(r.prerequisites as string),
    verify: JSON.parse(r.verify as string),
    baseCommit: (r.base_commit as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function toContract(r: Row): ContractVersion {
  return {
    id: r.id as string,
    version: Number(r.version),
    definition: r.definition as string,
    status: r.status as ContractVersion["status"],
    author: r.author as string,
    approvedBy: (r.approved_by as string | null) ?? null,
    rationale: (r.rationale as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

function toEvidence(r: Row): Evidence {
  return {
    id: r.id as string,
    taskId: r.task_id as string,
    kind: r.kind as Evidence["kind"],
    command: (r.command as string | null) ?? null,
    exitCode: r.exit_code === null ? null : Number(r.exit_code),
    output: r.output as string,
    source: r.source as Evidence["source"],
    verified: Number(r.verified) === 1,
    environment: JSON.parse(r.environment as string),
    createdAt: r.created_at as string,
  };
}

function toEvent(r: Row): RelayEvent {
  return {
    seq: Number(r.seq),
    id: r.id as string,
    taskId: (r.task_id as string | null) ?? null,
    type: r.type as string,
    actor: r.actor as string,
    at: r.at as string,
    fromState: (r.from_state as string | null) ?? null,
    toState: (r.to_state as string | null) ?? null,
    data: JSON.parse(r.data as string),
    idempotencyKey: (r.idempotency_key as string | null) ?? null,
  };
}

function requireHuman(actor: Actor, what: string): void {
  if (actor.kind !== "human") throw new RelayError("forbidden", `${what} requires a human actor (got ${actorString(actor)})`);
}

export interface NewTask {
  id: string;
  objective: string;
  scope: string[];
  contracts?: Record<string, number>;
  prerequisites?: string[];
  verify?: string[];
  owner?: string;
  baseCommit?: string;
}

export interface TransitionOptions {
  expectedFrom?: TaskState;
  idempotencyKey?: string;
  reason?: string;
  /** Workspace to check the completion gate against. Required for completed. */
  cwd?: string;
}

export class Relay {
  readonly db: DatabaseSync;
  readonly dbPath: string;

  constructor(dbPath: string) {
    this.db = openDb(dbPath);
    this.dbPath = dbPath === ":memory:" ? dbPath : join(realpathSync(dirname(resolve(dbPath))), basename(dbPath));
  }

  /**
   * Relay's own database files when they live inside the workspace's repository. Relay writes them on every
   * decision, so they must not count as workspace changes. Every other path under .relay/ stays protected.
   */
  private ownFiles(cwd: string): string[] {
    if (this.dbPath === ":memory:") return [];
    const rel = relative(realpathSync(repoRoot(cwd)), this.dbPath);
    if (rel.startsWith("..") || isAbsolute(rel)) return [];
    const p = rel.split(sep).join("/");
    return [p, `${p}-wal`, `${p}-shm`, `${p}-journal`];
  }

  close(): void {
    this.db.close();
  }

  // ---------- events ----------

  private emit(e: { taskId?: string | null; type: string; actor: Actor | string; from?: string | null; to?: string | null; data?: Record<string, unknown>; idempotencyKey?: string | null }): void {
    this.db
      .prepare("INSERT INTO events (id, task_id, type, actor, at, from_state, to_state, data, idempotency_key) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(
        randomUUID(),
        e.taskId ?? null,
        e.type,
        typeof e.actor === "string" ? e.actor : actorString(e.actor),
        now(),
        e.from ?? null,
        e.to ?? null,
        JSON.stringify(e.data ?? {}),
        e.idempotencyKey ?? null,
      );
  }

  private seen(idempotencyKey: string | undefined): boolean {
    if (!idempotencyKey) return false;
    return this.db.prepare("SELECT 1 FROM events WHERE idempotency_key = ?").get(idempotencyKey) !== undefined;
  }

  events(taskId?: string): RelayEvent[] {
    const rows = taskId
      ? this.db.prepare("SELECT * FROM events WHERE task_id = ? ORDER BY seq").all(taskId)
      : this.db.prepare("SELECT * FROM events ORDER BY seq").all();
    return rows.map((r) => toEvent(r as Row));
  }

  // ---------- tasks ----------

  getTask(id: string): Task | undefined {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return r ? toTask(r as Row) : undefined;
  }

  requireTask(id: string): Task {
    const t = this.getTask(id);
    if (!t) throw new RelayError("not_found", `Unknown task ${id}`);
    return t;
  }

  listTasks(): Task[] {
    return this.db.prepare("SELECT * FROM tasks ORDER BY created_at, id").all().map((r) => toTask(r as Row));
  }

  /** Every task starts as proposed, whoever creates it. Only a human can queue it. */
  createTask(input: NewTask, actor: Actor): Task {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(input.id)) throw new RelayError("invalid", `Invalid task id ${JSON.stringify(input.id)}`);
    return tx(this.db, () => {
      if (this.getTask(input.id)) throw new RelayError("conflict", `Task ${input.id} already exists`);
      for (const p of input.prerequisites ?? []) if (!this.getTask(p)) throw new RelayError("invalid", `Unknown prerequisite ${p}`);
      for (const [cid, v] of Object.entries(input.contracts ?? {})) {
        if (!this.getContract(cid, v)) throw new RelayError("invalid", `Unknown contract ${cid} v${v}`);
      }
      const t = now();
      this.db
        .prepare("INSERT INTO tasks (id, objective, state, owner, agent, scope, contracts, prerequisites, verify, base_commit, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(input.id, input.objective, "proposed", input.owner ?? null, null, JSON.stringify(input.scope), JSON.stringify(input.contracts ?? {}), JSON.stringify(input.prerequisites ?? []), JSON.stringify(input.verify ?? []), input.baseCommit ?? null, t, t);
      this.emit({ taskId: input.id, type: "task.created", actor, to: "proposed", data: { input } });
      return this.requireTask(input.id);
    });
  }

  transition(taskId: string, to: TaskState, actor: Actor, opts: TransitionOptions = {}): Task {
    if (!TASK_STATES.includes(to)) throw new RelayError("invalid", `Unknown state ${to}`);
    return tx(this.db, () => {
      if (this.seen(opts.idempotencyKey)) return this.requireTask(taskId);
      const task = this.requireTask(taskId);
      if (opts.expectedFrom && task.state !== opts.expectedFrom) {
        throw new RelayError("stale_state", `Task ${taskId} is ${task.state}, expected ${opts.expectedFrom}`);
      }
      if (!canTransition(task.state, to, actor.kind)) {
        throw new RelayError("illegal_transition", `${actor.kind} cannot move ${taskId} from ${task.state} to ${to}`);
      }
      if (to === "running" && task.state === "queued") {
        const pending = task.prerequisites.filter((p) => this.getTask(p)?.state !== "completed");
        if (pending.length) throw new RelayError("blocked", `Prerequisites not completed: ${pending.join(", ")}`);
      }
      if (to === "completed") {
        if (!opts.cwd) throw new RelayError("invalid", "Completing a task needs the workspace path to verify against");
        const gaps = this.completionGaps(task, opts.cwd);
        if (gaps.length) throw new RelayError("unverified", `Cannot complete ${taskId}: ${gaps.join("; ")}`);
      }
      const agent = to === "running" && actor.kind === "agent" ? actor.id : task.agent;
      this.db.prepare("UPDATE tasks SET state = ?, agent = ?, updated_at = ? WHERE id = ?").run(to, agent, now(), taskId);
      this.emit({ taskId, type: "task.transition", actor, from: task.state, to, data: { reason: opts.reason ?? null }, idempotencyKey: opts.idempotencyKey ?? null });
      return this.requireTask(taskId);
    });
  }

  /** Pin the commit a task works from. Only before work starts, so evidence and diffs stay comparable. */
  setBaseCommit(taskId: string, commit: string, actor: Actor): Task {
    return tx(this.db, () => {
      const task = this.requireTask(taskId);
      if (task.state !== "queued" && task.state !== "proposed") throw new RelayError("illegal_transition", `${taskId} is ${task.state}; its base can only change before work starts`);
      this.db.prepare("UPDATE tasks SET base_commit = ?, updated_at = ? WHERE id = ?").run(commit, now(), taskId);
      this.emit({ taskId, type: "task.base_changed", actor, data: { from: task.baseCommit, to: commit } });
      return this.requireTask(taskId);
    });
  }

  /** An agent takes a queued task. Two concurrent claims cannot both succeed. */
  claim(taskId: string, actor: Actor, idempotencyKey?: string): Task {
    const t = this.getTask(taskId);
    if (t && t.state === "running" && t.agent === actor.id) return t; // re-claim by the same agent is a no-op
    return this.transition(taskId, "running", actor, { expectedFrom: "queued", idempotencyKey });
  }

  /**
   * What still stands between a task and completion. Empty means the gate passes.
   * Every piece of evidence must have been produced by Relay against the workspace exactly as it is now.
   */
  completionGaps(task: Task, cwd: string): string[] {
    const gaps: string[] = [];
    const tree = workspaceFingerprint(cwd, this.ownFiles(cwd));
    const ev = this.evidence(task.id).filter((e) => e.source === "system");
    const lastDiff = ev.filter((e) => e.kind === "diff_check").at(-1);
    if (!lastDiff) gaps.push("no diff check recorded");
    else if (lastDiff.environment.tree !== tree) gaps.push("workspace changed since the latest diff check");
    else if (lastDiff.exitCode !== 0) gaps.push("latest diff check found blocking conflicts");
    for (const cmd of task.verify) {
      const last = ev.filter((e) => e.kind === "command" && e.command === cmd).at(-1);
      if (!last) gaps.push(`verification not run: ${cmd}`);
      else if (last.environment.tree !== tree) gaps.push(`workspace changed since verification ran: ${cmd}`);
      else if (last.exitCode !== 0) gaps.push(`verification failed: ${cmd} (exit ${last.exitCode ?? "timeout"})`);
    }
    const partners = this.contractPartners([task.id]);
    if (partners.length) gaps.push(`shares a contract with unfinished task(s) ${partners.join(", ")}; complete them together with relay integrate`);
    return gaps;
  }

  /** Non-terminal tasks outside `ids` that depend on a contract some task in `ids` depends on. */
  private contractPartners(ids: readonly string[]): string[] {
    const set = new Set(ids);
    const contracts = new Set(ids.flatMap((id) => Object.keys(this.requireTask(id).contracts)));
    return this.listTasks()
      .filter((t) => !set.has(t.id) && t.state !== "completed" && t.state !== "cancelled" && Object.keys(t.contracts).some((c) => contracts.has(c)))
      .map((t) => t.id);
  }

  // ---------- contracts ----------

  getContract(id: string, version: number): ContractVersion | undefined {
    const r = this.db.prepare("SELECT * FROM contracts WHERE id = ? AND version = ?").get(id, version);
    return r ? toContract(r as Row) : undefined;
  }

  contractHistory(id: string): ContractVersion[] {
    return this.db.prepare("SELECT * FROM contracts WHERE id = ? ORDER BY version").all(id).map((r) => toContract(r as Row));
  }

  currentContract(id: string): ContractVersion | undefined {
    const r = this.db.prepare("SELECT * FROM contracts WHERE id = ? AND status = 'accepted' ORDER BY version DESC LIMIT 1").get(id);
    return r ? toContract(r as Row) : undefined;
  }

  currentContracts(): Map<string, ContractVersion> {
    const rows = this.db.prepare("SELECT c.* FROM contracts c WHERE status = 'accepted' AND version = (SELECT MAX(version) FROM contracts d WHERE d.id = c.id AND d.status = 'accepted')").all();
    return new Map(rows.map((r) => { const c = toContract(r as Row); return [c.id, c] as const; }));
  }

  /** Anyone may propose a version. It has no authority until a human accepts it. */
  proposeContract(id: string, definition: string, actor: Actor, rationale?: string): ContractVersion {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new RelayError("invalid", `Invalid contract id ${JSON.stringify(id)}`);
    return tx(this.db, () => {
      const max = this.db.prepare("SELECT MAX(version) AS v FROM contracts WHERE id = ?").get(id) as { v: number | null };
      const version = (max.v ?? 0) + 1;
      this.db
        .prepare("INSERT INTO contracts (id, version, definition, status, author, approved_by, rationale, created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(id, version, definition, "proposed", actorString(actor), null, rationale ?? null, now());
      this.emit({ type: "contract.proposed", actor, data: { contract: id, version, rationale: rationale ?? null } });
      return this.getContract(id, version)!;
    });
  }

  /** Accepting supersedes the previous accepted version and reports which active tasks are now stale. */
  acceptContract(id: string, version: number, actor: Actor): { contract: ContractVersion; affectedTasks: string[] } {
    requireHuman(actor, "Accepting a contract");
    return tx(this.db, () => {
      const c = this.getContract(id, version);
      if (!c) throw new RelayError("not_found", `Unknown contract ${id} v${version}`);
      if (c.status !== "proposed") throw new RelayError("illegal_transition", `${id} v${version} is ${c.status}, not proposed`);
      const prev = this.currentContract(id);
      if (prev && prev.version > version) throw new RelayError("stale_state", `${id} v${prev.version} is already accepted`);
      if (prev) this.db.prepare("UPDATE contracts SET status = 'superseded' WHERE id = ? AND version = ?").run(id, prev.version);
      this.db.prepare("UPDATE contracts SET status = 'accepted', approved_by = ? WHERE id = ? AND version = ?").run(actorString(actor), id, version);
      const affected = this.listTasks().filter((t) => ACTIVE_STATES.includes(t.state) && (t.contracts[id] ?? Infinity) < version).map((t) => t.id);
      this.emit({ type: "contract.accepted", actor, data: { contract: id, version, superseded: prev?.version ?? null, affectedTasks: affected } });
      for (const t of affected) this.emit({ taskId: t, type: "task.contract_stale", actor: "system:relay", data: { contract: id, version } });
      return { contract: this.getContract(id, version)!, affectedTasks: affected };
    });
  }

  rejectContract(id: string, version: number, actor: Actor, reason?: string): ContractVersion {
    requireHuman(actor, "Rejecting a contract");
    return tx(this.db, () => {
      const c = this.getContract(id, version);
      if (!c || c.status !== "proposed") throw new RelayError("illegal_transition", `${id} v${version} is not a proposed contract`);
      this.db.prepare("UPDATE contracts SET status = 'rejected', approved_by = ? WHERE id = ? AND version = ?").run(actorString(actor), id, version);
      this.emit({ type: "contract.rejected", actor, data: { contract: id, version, reason: reason ?? null } });
      return this.getContract(id, version)!;
    });
  }

  /** The adaptation step: the task declares it now works against the current accepted version. */
  acknowledgeContract(taskId: string, id: string, version: number, actor: Actor): Task {
    return tx(this.db, () => {
      const task = this.requireTask(taskId);
      if (!(id in task.contracts)) throw new RelayError("invalid", `Task ${taskId} does not depend on ${id}`);
      const cur = this.currentContract(id);
      if (!cur || cur.version !== version) throw new RelayError("stale_state", `${id} v${version} is not the current accepted version (current: ${cur?.version ?? "none"})`);
      const contracts = { ...task.contracts, [id]: version };
      this.db.prepare("UPDATE tasks SET contracts = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(contracts), now(), taskId);
      this.emit({ taskId, type: "task.contract_acknowledged", actor, data: { contract: id, from: task.contracts[id], to: version } });
      return this.requireTask(taskId);
    });
  }

  // ---------- intents ----------

  /** Files inside the approved scope become an active intent; anything outside is only a proposal. */
  declareIntent(taskId: string, files: string[], root: string, actor: Actor): { intent: Intent; outsideScope: string[]; decisions: Record<string, Decision> } {
    return tx(this.db, () => {
      const task = this.requireTask(taskId);
      const normalized: string[] = [];
      for (const f of files) {
        const n = normalizePath(root, f);
        if (n === null) throw new RelayError("invalid", `${f} resolves outside the repository`);
        normalized.push(n);
      }
      const decisions: Record<string, Decision> = {};
      for (const f of normalized) decisions[f] = this.evaluate(task.id, f, f, ["queued", "running"]);
      const outside = normalized.filter((f) => decisions[f]!.conflicts.some((c) => c.rule === "outside_scope" || c.rule === "owned_by_other_task"));
      const status = outside.length ? "proposed" : "active";
      const intent: Intent = { id: randomUUID(), taskId, files: normalized, contracts: task.contracts, status, createdAt: now() };
      this.db.prepare("INSERT INTO intents (id, task_id, files, contracts, status, created_at) VALUES (?,?,?,?,?,?)").run(intent.id, taskId, JSON.stringify(intent.files), JSON.stringify(intent.contracts), status, intent.createdAt);
      this.emit({ taskId, type: "intent.declared", actor, data: { intentId: intent.id, files: normalized, status, outsideScope: outside } });
      return { intent, outsideScope: outside, decisions };
    });
  }

  /** A human widens the task's scope to cover a proposed intent. */
  approveIntent(intentId: string, actor: Actor): Task {
    requireHuman(actor, "Approving a scope expansion");
    return tx(this.db, () => {
      const r = this.db.prepare("SELECT * FROM intents WHERE id = ?").get(intentId) as Row | undefined;
      if (!r || r.status !== "proposed") throw new RelayError("invalid", `Intent ${intentId} is not a proposed intent`);
      const task = this.requireTask(r.task_id as string);
      const scope = [...new Set([...task.scope, ...(JSON.parse(r.files as string) as string[])])];
      this.db.prepare("UPDATE tasks SET scope = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(scope), now(), task.id);
      this.db.prepare("UPDATE intents SET status = 'active' WHERE id = ?").run(intentId);
      this.emit({ taskId: task.id, type: "intent.approved", actor, data: { intentId, scope } });
      return this.requireTask(task.id);
    });
  }

  intents(taskId: string): Intent[] {
    return this.db.prepare("SELECT * FROM intents WHERE task_id = ? ORDER BY created_at").all(taskId).map((r) => {
      const x = r as Row;
      return { id: x.id as string, taskId: x.task_id as string, files: JSON.parse(x.files as string), contracts: JSON.parse(x.contracts as string), status: x.status as Intent["status"], createdAt: x.created_at as string };
    });
  }

  // ---------- enforcement ----------

  private evaluate(taskId: string, path: string | null, rawPath: string, writableStates: readonly TaskState[]): Decision {
    return evaluateEdit({ task: this.getTask(taskId), taskId, path, rawPath, allTasks: this.listTasks(), current: this.currentContracts(), writableStates });
  }

  /** Pre- or post-action check of one file write. Every decision is recorded. */
  checkEdit(taskId: string, rawPath: string, root: string, meta: { point: EnforcementPoint; tool: string; actor: string; provider: string }): Decision {
    const decision = this.evaluate(taskId, normalizePath(root, rawPath), rawPath, ["running"]);
    this.emit({ taskId: this.getTask(taskId) ? taskId : null, type: "enforcement.decision", actor: meta.actor, data: { ...meta, path: rawPath, decision: decision.decision, conflicts: decision.conflicts } });
    return decision;
  }

  /** Record an event raised outside the engine (collaboration, agent runs). */
  record(type: string, actor: Actor | string, data: Record<string, unknown> = {}, taskId: string | null = null): void {
    this.emit({ taskId: taskId && this.getTask(taskId) ? taskId : null, type, actor, data });
  }

  /** Events after a sequence number, for live feeds. */
  eventsSince(seq: number, limit = 500): RelayEvent[] {
    return this.db.prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?").all(seq, limit).map((r) => toEvent(r as Row));
  }

  /** Record a denial that happened without an engine decision (for example a guard failing closed). */
  recordGuardDecision(taskId: string | null, data: Record<string, unknown>): void {
    this.emit({ taskId: taskId && this.getTask(taskId) ? taskId : null, type: "enforcement.decision", actor: "system:guard", data });
  }

  /**
   * The backstop that sees every write regardless of tool: compares the workspace with the task's base commit.
   * Records system evidence; exit code 0 means no blocking conflicts.
   */
  diffCheck(taskId: string, cwd: string): { files: string[]; decisions: Record<string, Decision>; evidence: Evidence } {
    const task = this.requireTask(taskId);
    if (!task.baseCommit) throw new RelayError("invalid", `Task ${taskId} has no base commit`);
    const root = repoRoot(cwd);
    const files = changedFiles(cwd, task.baseCommit, this.ownFiles(cwd));
    const decisions: Record<string, Decision> = {};
    for (const f of files) decisions[f] = this.evaluate(taskId, normalizePath(root, f), f, ["running", "review_required", "blocked"]);
    const blocking = Object.entries(decisions).filter(([, d]) => d.decision === "deny");
    const evidence = this.recordEvidence({
      taskId,
      kind: "diff_check",
      command: `git diff --name-only ${task.baseCommit} + untracked`,
      exitCode: blocking.length ? 1 : 0,
      output: JSON.stringify({ files, blocking: blocking.map(([f, d]) => ({ file: f, conflicts: d.conflicts })) }),
      source: "system",
      environment: { cwd, tree: workspaceFingerprint(cwd, this.ownFiles(cwd)) },
    });
    this.emit({ taskId, type: "enforcement.diff_check", actor: "system:relay", data: { files, blocking: blocking.map(([f]) => f), evidenceId: evidence.id } });
    return { files, decisions, evidence };
  }

  // ---------- integration ----------

  /**
   * Checks a set of tasks as one integrated change in one workspace and records the result.
   * Relay runs every task's verification plus the integration commands itself, on this exact tree.
   */
  checkIntegration(taskIds: string[], cwd: string, integrationVerify: string[] = [], timeoutMs = 300_000): Integration {
    if (!taskIds.length) throw new RelayError("invalid", "An integration needs at least one task");
    const tasks = [...new Set(taskIds)].map((id) => this.requireTask(id));
    const gaps: string[] = [];

    for (const t of tasks) if (t.state !== "review_required") gaps.push(`${t.id} is ${t.state}, not review_required`);
    const missing = this.contractPartners(tasks.map((t) => t.id));
    if (missing.length) gaps.push(`task(s) ${missing.join(", ")} depend on the same contract(s) and must be integrated in the same change`);

    const agreed: Record<string, number> = {};
    for (const cid of new Set(tasks.flatMap((t) => Object.keys(t.contracts)))) {
      const cur = this.currentContract(cid);
      if (!cur) { gaps.push(`contract ${cid} has no accepted version`); continue; }
      agreed[cid] = cur.version;
      for (const t of tasks) {
        const v = t.contracts[cid];
        if (v !== undefined && v !== cur.version) gaps.push(`${t.id} was built against ${cid} v${v}; current is v${cur.version}`);
      }
    }

    const bases = [...new Set(tasks.map((t) => t.baseCommit))];
    if (bases.length !== 1 || !bases[0]) gaps.push(`tasks do not share one base commit (${bases.join(", ")})`);
    const base = bases.length === 1 ? bases[0]! : null;

    const own = this.ownFiles(cwd);
    if (base) {
      const root = repoRoot(cwd);
      const scope = tasks.flatMap((t) => t.scope);
      for (const f of changedFiles(cwd, base, own)) {
        const p = normalizePath(root, f);
        if (p === null || isProtected(p)) gaps.push(`${f} is a protected path`);
        else if (!inScope(scope, p)) gaps.push(`${f} changed but belongs to none of ${tasks.map((t) => t.id).join(", ")}`);
      }
    }

    const tree = workspaceFingerprint(cwd, own);
    const commands = [...new Set([...tasks.flatMap((t) => t.verify), ...integrationVerify])];
    const results = commands.map((command) => {
      const r = spawnSync(command, { cwd, shell: true, encoding: "utf8", timeout: timeoutMs, env: verificationEnv() });
      const timedOut = r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
      const output = (timedOut ? "[timed out]\n" : "") + (r.stdout ?? "") + (r.stderr ?? "");
      return { command, exitCode: timedOut ? null : (r.status ?? null), output: output.slice(0, OUTPUT_LIMIT) };
    });
    for (const r of results) if (r.exitCode !== 0) gaps.push(`verification failed: ${r.command} (exit ${r.exitCode ?? "timeout"})`);
    if (!commands.length) gaps.push("no verification commands: an integration needs at least one");
    if (workspaceFingerprint(cwd, own) !== tree) gaps.push("workspace changed while verification ran (commands must not modify tracked or untracked files)");

    const integration: Integration = {
      id: randomUUID(),
      tasks: tasks.map((t) => t.id),
      baseCommit: base,
      tree,
      contracts: agreed,
      status: gaps.length ? "blocked" : "passed",
      gaps,
      results,
      createdAt: now(),
      approvedBy: null,
      approvedAt: null,
    };
    this.db
      .prepare("INSERT INTO integrations (id, tasks, base_commit, tree, contracts, status, gaps, results, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(integration.id, JSON.stringify(integration.tasks), base, tree, JSON.stringify(agreed), integration.status, JSON.stringify(gaps), JSON.stringify(results), integration.createdAt);
    this.emit({ type: "integration.checked", actor: "system:relay", data: { integrationId: integration.id, tasks: integration.tasks, status: integration.status, gaps, tree } });
    return integration;
  }

  getIntegration(id: string): Integration | undefined {
    const r = this.db.prepare("SELECT * FROM integrations WHERE id = ?").get(id) as Row | undefined;
    if (!r) return undefined;
    return {
      id: r.id as string,
      tasks: JSON.parse(r.tasks as string),
      baseCommit: (r.base_commit as string | null) ?? null,
      tree: r.tree as string,
      contracts: JSON.parse(r.contracts as string),
      status: r.status as Integration["status"],
      gaps: JSON.parse(r.gaps as string),
      results: JSON.parse(r.results as string),
      createdAt: r.created_at as string,
      approvedBy: (r.approved_by as string | null) ?? null,
      approvedAt: (r.approved_at as string | null) ?? null,
    };
  }

  /**
   * A human approves exactly what was checked: same workspace tree, same task states, same contract versions.
   * Anything that moved since the check requires a fresh check. Completes every task in the integration.
   */
  approveIntegration(id: string, actor: Actor, cwd: string): Integration {
    requireHuman(actor, "Approving an integration");
    const tree = workspaceFingerprint(cwd, this.ownFiles(cwd));
    return tx(this.db, () => {
      const integ = this.getIntegration(id);
      if (!integ) throw new RelayError("not_found", `Unknown integration ${id}`);
      if (integ.status !== "passed") throw new RelayError("unverified", `Integration ${id} is ${integ.status}: ${integ.gaps.join("; ")}`);
      if (integ.tree !== tree) throw new RelayError("stale_state", "Workspace changed since the integration check; run it again");
      for (const [cid, v] of Object.entries(integ.contracts)) {
        if (this.currentContract(cid)?.version !== v) throw new RelayError("stale_state", `${cid} changed since the integration check; run it again`);
      }
      for (const tid of integ.tasks) {
        const t = this.requireTask(tid);
        if (t.state !== "review_required") throw new RelayError("stale_state", `${tid} is ${t.state} now; run the check again`);
      }
      const at = now();
      this.db.prepare("UPDATE integrations SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?").run(actorString(actor), at, id);
      for (const tid of integ.tasks) {
        this.db.prepare("UPDATE tasks SET state = 'completed', updated_at = ? WHERE id = ?").run(at, tid);
        this.emit({ taskId: tid, type: "task.transition", actor, from: "review_required", to: "completed", data: { integrationId: id } });
      }
      this.emit({ type: "integration.approved", actor, data: { integrationId: id, tasks: integ.tasks, tree } });
      return this.getIntegration(id)!;
    });
  }

  // ---------- evidence ----------

  recordEvidence(e: { taskId: string; kind: Evidence["kind"]; command: string | null; exitCode: number | null; output: string; source: Evidence["source"]; environment?: Record<string, string> }): Evidence {
    this.requireTask(e.taskId);
    // Agent-supplied evidence is a claim. It is stored, shown, and never counts toward the completion gate.
    const kind = e.source === "agent" ? "agent_claim" : e.kind;
    const verified = e.source === "system";
    const ev: Evidence = {
      id: randomUUID(),
      taskId: e.taskId,
      kind,
      command: e.command,
      exitCode: e.exitCode,
      output: e.output.length > OUTPUT_LIMIT ? e.output.slice(0, OUTPUT_LIMIT) + "\n[truncated]" : e.output,
      source: e.source,
      verified,
      environment: e.environment ?? {},
      createdAt: now(),
    };
    this.db
      .prepare("INSERT INTO evidence (id, task_id, kind, command, exit_code, output, source, verified, environment, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(ev.id, ev.taskId, ev.kind, ev.command, ev.exitCode, ev.output, ev.source, verified ? 1 : 0, JSON.stringify(ev.environment), ev.createdAt);
    this.emit({ taskId: e.taskId, type: "evidence.recorded", actor: e.source === "system" ? "system:relay" : "agent", data: { evidenceId: ev.id, kind, command: ev.command, exitCode: ev.exitCode, verified } });
    return ev;
  }

  evidence(taskId: string): Evidence[] {
    return this.db.prepare("SELECT * FROM evidence WHERE task_id = ? ORDER BY created_at, rowid").all(taskId).map((r) => toEvidence(r as Row));
  }

  /** Relay runs the task's verification commands itself. Only these results can satisfy the completion gate. */
  runVerification(taskId: string, cwd: string, timeoutMs = 300_000): Evidence[] {
    const task = this.requireTask(taskId);
    const tree = workspaceFingerprint(cwd, this.ownFiles(cwd));
    return task.verify.map((cmd) => {
      const r = spawnSync(cmd, { cwd, shell: true, encoding: "utf8", timeout: timeoutMs, env: verificationEnv() });
      const timedOut = r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
      return this.recordEvidence({
        taskId,
        kind: "command",
        command: cmd,
        exitCode: timedOut ? null : (r.status ?? null),
        output: (timedOut ? "[timed out]\n" : "") + (r.stdout ?? "") + (r.stderr ?? ""),
        source: "system",
        environment: { cwd, tree, node: process.version, platform: process.platform },
      });
    });
  }
}
