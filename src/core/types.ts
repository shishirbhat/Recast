export const TASK_STATES = [
  "proposed",
  "queued",
  "running",
  "blocked",
  "review_required",
  "failed",
  "cancelled",
  "completed",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** States in which a task still holds its file scope and contract dependencies. */
export const ACTIVE_STATES: readonly TaskState[] = ["queued", "running", "blocked", "review_required"];

export type ActorKind = "human" | "agent" | "system";
export interface Actor {
  kind: ActorKind;
  id: string;
}

export interface Task {
  id: string;
  objective: string;
  state: TaskState;
  owner: string | null;
  agent: string | null;
  /** Repo-relative paths. An entry ending in "/" covers everything below it. */
  scope: string[];
  /** contract id -> version the task was planned against */
  contracts: Record<string, number>;
  prerequisites: string[];
  /** Commands Relay itself must run and see pass before the task can complete. */
  verify: string[];
  baseCommit: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ContractStatus = "proposed" | "accepted" | "superseded" | "rejected";
export interface ContractVersion {
  id: string;
  version: number;
  definition: string;
  status: ContractStatus;
  author: string;
  approvedBy: string | null;
  rationale: string | null;
  createdAt: string;
}

export type IntentStatus = "active" | "proposed" | "released";
export interface Intent {
  id: string;
  taskId: string;
  files: string[];
  contracts: Record<string, number>;
  status: IntentStatus;
  createdAt: string;
}

export type EvidenceKind = "command" | "diff_check" | "agent_claim";
export interface Evidence {
  id: string;
  taskId: string;
  kind: EvidenceKind;
  command: string | null;
  exitCode: number | null;
  output: string;
  /** Who produced it. Only "system" evidence can be verified. */
  source: "system" | "agent";
  verified: boolean;
  environment: Record<string, string>;
  createdAt: string;
}

export interface RelayEvent {
  seq: number;
  id: string;
  taskId: string | null;
  type: string;
  actor: string;
  at: string;
  fromState: string | null;
  toState: string | null;
  data: Record<string, unknown>;
  idempotencyKey: string | null;
}

export interface Integration {
  id: string;
  tasks: string[];
  baseCommit: string | null;
  tree: string;
  contracts: Record<string, number>;
  status: "blocked" | "passed" | "approved";
  gaps: string[];
  results: { command: string; exitCode: number | null; output: string }[];
  /** Why combined verification failed, from evidence only; null when it passed. Never changes `status`. */
  explanation: Explanation | null;
  /** How much the checks covered, for a passing check: verified, or verified with named gaps (src/analysis/assurance.ts). */
  assurance?: { level: "verified" | "verified-with-gaps" | "not-analysed"; gaps: string[]; covering: string[] } | null;
  createdAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
}

/** A failed verification command and the failing tests Relay could read from its output. */
export interface FailedCheck {
  command: string;
  tests: { name: string; file: string | null; line: number | null; message: string }[];
  excerpt: string;
}

export interface ExplanationCause {
  confidence: "confirmed" | "likely";
  /** The change to an exported interface, and the task(s) that made it. */
  provider: { tasks: string[]; how: "changed by its run" | "in its declared scope"; file: string; symbol: string; line: number | null; change: string; removedKeys: string[]; addedKeys: string[] };
  /** The code that depends on it, and the task(s) that own that code. `read` is the property it reads that is gone. */
  consumer: { tasks: string[]; file: string; line: number; read: string | null };
  /** Contracts the involved tasks share. Only "current" ones are used as evidence. */
  contracts: { id: string; version: number | null; status: "current" | "stale" | "missing" | "unrelated"; detail: string }[];
  failing: { command: string; test: string | null; file: string | null }[];
  /** Each step of the chain, with file:line references. */
  evidence: string[];
  /** What this cause leaves unproven. Empty for a confirmed cause. */
  uncertain: string[];
}

export interface Explanation {
  verdict: "confirmed" | "likely" | "unknown";
  summary: string;
  causes: ExplanationCause[];
  failures: FailedCheck[];
  uncertain: string[];
  /** What a developer must resolve. Relay never picks which task's change wins. */
  resolve: string;
  /** The combined tree and base the explanation was computed for; it does not apply to any other state. */
  tree: string;
  base: string | null;
}

export type Severity = "block" | "warn";
export type ConflictRule =
  | "outside_scope"
  | "owned_by_other_task"
  | "shared_scope"
  | "stale_contract"
  | "protected_path"
  | "unknown_task"
  | "inactive_task";

export interface Conflict {
  rule: ConflictRule;
  severity: Severity;
  taskId: string;
  path: string | null;
  otherTasks: string[];
  contract: { id: string; plannedVersion: number; currentVersion: number; current: string } | null;
  reason: string;
  remediation: string;
}

export type EnforcementPoint = "pre_action" | "post_action" | "diff_time";

export interface Decision {
  decision: "allow" | "deny";
  conflicts: Conflict[];
  reason: string;
}

export class RelayError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "RelayError";
  }
}
