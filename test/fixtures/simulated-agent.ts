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

if (process.env.RELAY_SIM_MODE === "sleep") {
  out({ type: "assistant", message: { content: [{ type: "text", text: "thinking for a long time" }] } });
  setInterval(() => {}, 1000);
} else {
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
