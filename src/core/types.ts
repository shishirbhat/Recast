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
