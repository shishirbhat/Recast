#!/usr/bin/env node
/**
 * SIMULATED AGENT, for orchestration tests only. It is NOT a provider integration and never counts as one.
 *
 * Invoked by the agent runner in place of `claude`, with the same arguments. It reads the task binding from the
 * --mcp-config file the runner wrote, then behaves like a well-behaved agent: claims the task as an agent,
 * applies scripted edits in its worktree, submits for review, and prints Claude-Code-shaped stream-json lines.
 *
 * Scripted with RELAY_SIM_EDITS = {"<task>": {"<path>": [["find", "replace"], ...]}} and RELAY_SIM_MODE=sleep
 * (hang until killed, for cancellation tests).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Relay } from "../../src/core/engine.ts";

const args = process.argv.slice(2);
const mcpPath = args[args.indexOf("--mcp-config") + 1]!;
const server = JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers.relay as { args: string[] };
const arg = (name: string) => server.args[server.args.indexOf(name) + 1]!;
const db = arg("--db");
const task = arg("--task");
const root = arg("--root");
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
// RELAY_SIM_PROMPT_OUT: record the prompt the runner gave us, so tests can check what context an agent receives.
if (process.env.RELAY_SIM_PROMPT_OUT) writeFileSync(process.env.RELAY_SIM_PROMPT_OUT, args[args.indexOf("-p") + 1] ?? "");
// RELAY_SIM_ENV_OUT: record the environment keys the runner gave us (to check runner context doesn't leak into agents).
if (process.env.RELAY_SIM_ENV_OUT) writeFileSync(process.env.RELAY_SIM_ENV_OUT, JSON.stringify(Object.keys(process.env)));

if (process.env.RELAY_SIM_MODE === "sleep") {
  out({ type: "assistant", message: { content: [{ type: "text", text: "thinking for a long time" }] } });
  setInterval(() => {}, 1000);
} else {
  // RELAY_SIM_DELAY_MS: stay "working" this long first, so a person can keep editing while agents run.
  // RELAY_SIM_FAIL: comma-separated task ids whose run fails with an error after one tool call.
  const delay = Number(process.env.RELAY_SIM_DELAY_MS ?? 0);
  if (delay > 0) {
    out({ type: "assistant", message: { content: [{ type: "text", text: `Reading the code for ${task}.` }] } });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  }
  if ((process.env.RELAY_SIM_FAIL ?? "").split(",").includes(task)) {
    out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm run build" } }] } });
    out({ type: "result", is_error: true, result: "simulated failure: the build step exited with code 2 (src/server.js:3 Unexpected token)", total_cost_usd: 0 });
    process.exit(2);
  }
  const relay = new Relay(db);
  const agent = { kind: "agent" as const, id: "simulated-agent" };
  relay.claim(task, agent);
  out({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__relay__claim_task", input: {} }] } });
  for (const [cid] of Object.entries(relay.requireTask(task).contracts)) {
    const cur = relay.currentContract(cid)!;
    relay.acknowledgeContract(task, cid, cur.version, agent);
  }
  const edits = (JSON.parse(process.env.RELAY_SIM_EDITS ?? "{}") as Record<string, Record<string, [string, string][]>>)[task] ?? {};
  for (const [path, pairs] of Object.entries(edits)) {
    const abs = join(root, path);
    let text = readFileSync(abs, "utf8");
    for (const [a, b] of pairs) text = text.replace(a, b);
    writeFileSync(abs, text);
    out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: abs } }] } });
  }
  relay.transition(task, "review_required", agent, { reason: "simulated agent done" });
  relay.close();
  out({ type: "result", result: `simulated agent finished ${task}`, total_cost_usd: 0 });
}
