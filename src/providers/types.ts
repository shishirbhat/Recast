/**
 * The provider adapter contract. Everything provider-specific about running a coding agent lives behind this interface;
 * the runner (src/server/runs.ts) owns what is provider-neutral: snapshots and worktrees, process lifetime and
 * cancellation, Relay's own diff checks and verification after the run, and the 3-way apply.
 *
 * Capabilities are declared, not assumed: the IDE and CLI show what an adapter actually enforces, and an adapter that
 * can't enforce something must say so instead of pretending.
 */

export interface ProviderCapabilities {
  /** How Relay stops out-of-scope or stale-contract edits before they happen. "none": only the post-run diff check. */
  preEditEnforcement: "pre-tool-hook" | "none";
  /** How the agent coordinates (claim, read contracts, submit for review). */
  coordination: "mcp" | "none";
  /** Whether the provider reports the run's cost. */
  costReporting: boolean;
  /** Tools the agent may use, as the provider names them. */
  allowedTools: string[];
}

export interface LaunchContext {
  runId: string;
  taskId: string;
  worktree: string;
  /** Directory for this run's provider config files. */
  configDir: string;
  prompt: string;
  relayBin: string;
  dbPath: string;
}

export interface LaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** One thing the agent did, as Relay records it: tool calls and outcomes, not prose. */
export type AgentActivity =
  | { kind: "tool"; tool: string; target: string }
  | { kind: "denied"; detail: string }
  | { kind: "text"; detail: string }
  | { kind: "result"; detail: string; costUsd: number | null }
  | { kind: "error"; detail: string };

export interface ProviderAdapter {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;
  /** Whether this provider can run here (binary present, credentials configured), with a reason when it can't. */
  available(): Promise<{ ok: boolean; reason?: string }>;
  /** Writes any config into ctx.configDir and returns how to start the agent. The runner spawns it in ctx.worktree. */
  launch(ctx: LaunchContext): LaunchSpec;
  /** Turns one line of the agent's stdout into activity. Unknown lines yield nothing. */
  parse(line: string, worktree: string): AgentActivity[];
}
