import { execFile } from "node:child_process";
import type { AgentActivity, LaunchContext, LaunchSpec, ProviderAdapter } from "./types.ts";

/**
 * OpenAI Codex CLI, run headless (`codex exec`). UNVERIFIED: written against the CLI's documented `exec` mode and not yet
 * run against a real Codex (no OpenAI key in this environment). Capabilities are declared conservatively:
 * - no pre-edit enforcement: Codex has no pre-tool hook Relay can use, so scope is enforced after the run by Relay's
 *   diff check, and anything out of scope blocks integration;
 * - no coordination tools: the runner claims the task when the run starts and submits it for review when the agent
 *   exits cleanly, and says so in the task's history.
 * Output is recorded as text; tool calls aren't parsed until the format is checked against a real run.
 */
export function codex(bin = "codex"): ProviderAdapter {
  return {
    id: "codex",
    displayName: "Codex",
    capabilities: { preEditEnforcement: "none", coordination: "none", costReporting: false, allowedTools: ["(codex defaults, --full-auto)"] },
    available: () =>
      new Promise((ok) => {
        if (!process.env.OPENAI_API_KEY) return ok({ ok: false, reason: "OPENAI_API_KEY isn't set" });
        execFile(bin, ["--version"], { timeout: 5000 }, (err) => ok(err ? { ok: false, reason: `${bin} isn't installed or didn't start` } : { ok: true }));
      }),
    launch(ctx: LaunchContext): LaunchSpec {
      return { command: bin, args: ["exec", "--full-auto", "--skip-git-repo-check", ctx.prompt] };
    },
    parse(line: string): AgentActivity[] {
      const t = line.trim();
      return t ? [{ kind: "text", detail: t.slice(0, 300) }] : [];
    },
  };
}
