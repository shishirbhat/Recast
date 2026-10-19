import { readFileSync } from "node:fs";
import { Relay } from "../core/engine.ts";
import type { Decision } from "../core/types.ts";

/**
 * Claude Code PreToolUse adapter.
 *
 * Fails closed: any error, an unknown payload, or overrunning the internal deadline produces "deny".
 * Measured in Phase 0: Claude Code itself lets the tool run when a hook crashes or times out,
 * so this adapter must never leave without printing a decision.
 */

export const FILE_TOOLS: Record<string, string> = {
  Edit: "file_path",
  Write: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

export const HOOK_MATCHER = [...Object.keys(FILE_TOOLS), "Bash"].join("|");

const REDIRECT_SAFE = /\d?>&\d|\d?>\s*\/dev\/null/g;
const SHELL_WRITE_PATTERNS: [RegExp, string][] = [
  [/>{1,2}/, "output redirection"],
  [/\b(sed|perl)\s+(-\w*\s+)*-\w*i/, "in-place edit"],
  [/\b(tee|mv|cp|rm|touch|truncate|dd|ln|chmod|install|patch)\b/, "file-mutating command"],
  [/\bgit\s+(commit|push|reset|checkout|switch|rebase|merge|stash|clean|apply|am|restore|rm|mv|cherry-pick|revert|update-ref|config)\b/, "git state change"],
];

/**
 * A heuristic, not a boundary: interpreters (`python -c`, `node -e`), scripts, and build tools can still write.
 * The diff check is what catches those. This only steers ordinary writes onto the checked Edit/Write path.
 */
export function shellWriteReason(command: string): string | null {
  const cleaned = command.replace(REDIRECT_SAFE, "");
  for (const [re, label] of SHELL_WRITE_PATTERNS) if (re.test(cleaned)) return label;
  return null;
}

export interface HookOptions {
  db: string;
  task: string;
  root: string;
  deadlineMs?: number;
}

export interface HookOutput {
  hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "allow" | "deny"; permissionDecisionReason: string };
}

const output = (d: "allow" | "deny", reason: string): HookOutput => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: d, permissionDecisionReason: reason },
});

function render(decision: Decision): string {
  if (decision.decision === "allow") return `Relay: ${decision.reason}`;
  const fixes = [...new Set(decision.conflicts.filter((c) => c.severity === "block").map((c) => c.remediation))];
  return `Relay blocked this action. ${decision.reason}. Next step: ${fixes.join(" ")}`;
}

/** Pure decision for one hook payload. Throws on anything it cannot interpret; the caller turns that into deny. */
export function decide(relay: Relay, payload: unknown, opts: HookOptions): HookOutput {
  if (!payload || typeof payload !== "object") throw new Error("hook payload is not an object");
  const p = payload as { tool_name?: unknown; tool_input?: Record<string, unknown> };
  const tool = String(p.tool_name ?? "");
  const input = p.tool_input ?? {};
  const meta = { point: "pre_action" as const, tool, actor: `agent:claude-code:${opts.task}`, provider: "claude-code" };

  if (tool === "Bash") {
    const command = String(input.command ?? "");
    const why = shellWriteReason(command);
    if (!why) return output("allow", "Relay: read-only shell command");
    relay.recordGuardDecision(opts.task, { ...meta, command, decision: "deny", reason: `shell write (${why})` });
    return output("deny", `Relay blocked this shell command (${why}). Make file changes with the Edit or Write tools so Relay can check them against the task's scope and contracts.`);
  }

  const field = FILE_TOOLS[tool];
  if (!field) return output("allow", `Relay: ${tool} is not a write tool`);
  const path = input[field];
  if (typeof path !== "string" || !path) throw new Error(`${tool} payload has no ${field}`);
  const decision = relay.checkEdit(opts.task, path, opts.root, meta);
  return output(decision.decision, render(decision));
}

/** Entry point for `relay hook claude-code`. Always prints exactly one decision and exits 0. */
export function runHook(opts: HookOptions): void {
  let done = false;
  const emit = (o: HookOutput) => {
    if (done) return;
    done = true;
    process.stdout.write(JSON.stringify(o) + "\n");
  };
  const deadline = setTimeout(() => {
    emit(output("deny", "Relay engine did not answer within its deadline; failing closed."));
    process.exit(0);
  }, opts.deadlineMs ?? 3000);

  let relay: Relay | undefined;
  try {
    const payload = JSON.parse(readFileSync(0, "utf8"));
    relay = new Relay(opts.db);
    emit(decide(relay, payload, opts));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit(output("deny", `Relay could not evaluate this action (${msg}); failing closed.`));
    try {
      relay?.recordGuardDecision(opts.task, { point: "pre_action", provider: "claude-code", decision: "deny", reason: `fail-closed: ${msg}` });
    } catch {
      // The denial already went out; a failed audit write must not change it.
    }
  } finally {
    clearTimeout(deadline);
    relay?.close();
  }
}
