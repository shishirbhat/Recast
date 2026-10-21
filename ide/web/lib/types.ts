// Shapes returned by the Relay server (src/core/types.ts, src/server/*). Kept minimal and read-only here.
export type TaskState = "proposed" | "queued" | "running" | "blocked" | "review_required" | "failed" | "cancelled" | "completed";
export type Role = "owner" | "editor" | "viewer";

export interface Member {
  id: string;
  name: string;
  role: Role;
  color: string;
}

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
  provider: string;
  /** Absolute path of the run's git worktree on the Relay host. */
  worktree?: string;
  status: "starting" | "running" | "finished" | "failed" | "cancelled" | "applied";
  startedAt: string;
  endedAt: string | null;
  costUsd: number | null;
  changedFiles: string[];
  staleInputs: { path: string; by: string; at: string }[];
  activity: Activity[];
}

export interface Task {
  id: string;
  objective: string;
  state: TaskState;
  owner: string | null;
  agent: string | null;
  scope: string[];
  contracts: Record<string, number>;
  prerequisites: string[];
  verify: string[];
  baseCommit: string | null;
  createdAt: string;
  updatedAt: string;
  runs: AgentRun[];
}

export interface ContractVersion {
  id: string;
  version: number;
  definition: string;
  status: "proposed" | "accepted" | "superseded" | "rejected";
  author: string;
  approvedBy: string | null;
  createdAt: string;
}

export interface ProjectState {
  me: Member;
  project: { name: string; head: string | null };
  members: Member[];
  presence: { path: string; members: string[] }[];
  tasks: Task[];
  contracts: { id: string; history: ContractVersion[] }[];
  conflicts: { id: string; doc: string; createdAt: string }[];
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
}

export interface Integration {
  id: string;
  tasks: string[];
  status: "blocked" | "passed" | "approved";
  gaps: string[];
  results: { command: string; exitCode: number | null; output: string }[];
  contracts: Record<string, number>;
  tree: string;
}

export interface Why {
  task: Task;
  ladder: { agentClaimed: boolean; relayVerified: boolean; humanApproved: boolean };
  gaps: string[];
}
