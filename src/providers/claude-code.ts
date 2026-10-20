import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOOK_MATCHER } from "../hooks/claude-code.ts";
import type { AgentActivity, LaunchContext, LaunchSpec, ProviderAdapter } from "./types.ts";

const ALLOWED = ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "mcp__relay"];

/**
 * Claude Code, run headless (`claude -p`). Relay enforces scope and contracts with a PreToolUse hook that fails closed,
 * and the agent coordinates through Relay's MCP server. Tested against the real CLI in test/real/.
 */
export function claudeCode(bin = "claude"): ProviderAdapter {
  return {
    id: "claude-code",
    displayName: "Claude Code",
    capabilities: { preEditEnforcement: "pre-tool-hook", coordination: "mcp", costReporting: true, allowedTools: ALLOWED },
    available: () =>
      new Promise((ok) => execFile(bin, ["--version"], { timeout: 5000 }, (err) => ok(err ? { ok: false, reason: `${bin} isn't installed or didn't start` } : { ok: true }))),
    launch(ctx: LaunchContext): LaunchSpec {
      const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
      // `|| printf deny`: if the hook process can't even start, the edit is still denied.
      const failClosed = `printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Relay hook failed to start; failing closed."}}'`;
      writeFileSync(join(ctx.configDir, "settings.json"), JSON.stringify({
        hooks: { PreToolUse: [{ matcher: HOOK_MATCHER, hooks: [{ type: "command", command: `${q(ctx.relayBin)} --db ${q(ctx.dbPath)} hook claude-code --task ${q(ctx.taskId)} --root ${q(ctx.worktree)} || ${failClosed}`, timeout: 10 }] }] },
      }));
      writeFileSync(join(ctx.configDir, "mcp.json"), JSON.stringify({ mcpServers: { relay: { command: ctx.relayBin, args: ["--db", ctx.dbPath, "mcp", "--task", ctx.taskId, "--root", ctx.worktree, "--agent", "claude-code"] } } }));
      return {
        command: bin,
        args: ["-p", ctx.prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--settings", join(ctx.configDir, "settings.json"), "--mcp-config", join(ctx.configDir, "mcp.json"), "--strict-mcp-config", "--allowedTools", ALLOWED.join(",")],
      };
    },
    /** Claude Code's stream-json output is structured; we record tool calls, not prose. */
    parse(line: string, worktree: string): AgentActivity[] {
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line);
      } catch {
        return [];
      }
      const out: AgentActivity[] = [];
      if (ev.type === "assistant") {
        for (const c of ((ev.message as { content?: unknown[] })?.content ?? []) as Record<string, unknown>[]) {
          if (c.type === "tool_use") {
            const input = (c.input ?? {}) as Record<string, unknown>;
            out.push({ kind: "tool", tool: String(c.name), target: String(input.file_path ?? input.notebook_path ?? input.command ?? input.pattern ?? "").replace(worktree + "/", "").slice(0, 200) });
          } else if (c.type === "text" && typeof c.text === "string" && c.text.trim()) out.push({ kind: "text", detail: c.text.trim().slice(0, 300) });
        }
      } else if (ev.type === "user") {
        for (const c of ((ev.message as { content?: unknown[] })?.content ?? []) as Record<string, unknown>[]) {
          const text = typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? "");
          if (c.type === "tool_result" && c.is_error && /Relay blocked/.test(text)) out.push({ kind: "denied", detail: text.slice(0, 300) });
        }
      } else if (ev.type === "result") {
        out.push({ kind: "result", detail: String(ev.result ?? "").slice(0, 600), costUsd: typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : null });
      }
      return out;
    },
  };
}
