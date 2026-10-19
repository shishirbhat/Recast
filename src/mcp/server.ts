import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Relay } from "../core/engine.ts";
import { RelayError } from "../core/types.ts";
import type { Actor } from "../core/types.ts";

export interface McpOptions {
  db: string;
  /** The one task this server speaks for. Agents cannot address other tasks. */
  task: string;
  root: string;
  agent: string;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const fail = (err: unknown): ToolResult => {
  const code = err instanceof RelayError ? err.code : "internal";
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: JSON.stringify({ error: code, message }) }], isError: true };
};

export function buildServer(relay: Relay, opts: McpOptions): McpServer {
  const server = new McpServer({ name: "relay", version: "0.0.1" });
  const actor: Actor = { kind: "agent", id: opts.agent };
  const guard = (fn: () => unknown): ToolResult => {
    try {
      return ok(fn());
    } catch (err) {
      return fail(err);
    }
  };

  const taskView = () => {
    const task = relay.requireTask(opts.task);
    const contracts = Object.entries(task.contracts).map(([id, planned]) => {
      const cur = relay.currentContract(id);
      return { id, plannedVersion: planned, currentVersion: cur?.version ?? null, stale: !!cur && cur.version > planned };
    });
    return { task, contracts, intents: relay.intents(task.id) };
  };

  server.registerTool(
    "get_task",
    {
      description: "Read your Relay task: objective, state, file scope, contract versions (and whether they are stale), and declared intents. Read-only.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => guard(taskView),
  );

  server.registerTool(
    "get_contract",
    {
      description: "Read the authoritative (latest accepted) version of a contract, or a specific version. Read-only.",
      inputSchema: { contract_id: z.string().min(1).max(64), version: z.number().int().positive().optional() },
      annotations: { readOnlyHint: true },
    },
    ({ contract_id, version }) =>
      guard(() => {
        const c = version ? relay.getContract(contract_id, version) : relay.currentContract(contract_id);
        if (!c) throw new RelayError("not_found", `No ${version ? `version ${version} of` : "accepted version of"} ${contract_id}`);
        return { contract: c, history: relay.contractHistory(contract_id).map((h) => ({ version: h.version, status: h.status })) };
      }),
  );

  server.registerTool(
    "claim_task",
    {
      description: "Start work on your task (queued -> running). Required before any edit is allowed. Idempotent for the same agent.",
      inputSchema: { idempotency_key: z.string().max(128).optional() },
    },
    ({ idempotency_key }) => guard(() => relay.claim(opts.task, actor, idempotency_key)),
  );

  server.registerTool(
    "acknowledge_contract",
    {
      description: "Declare that your task now works against the current accepted version of a contract. Do this only after reading that version and adapting your plan; stale contracts block edits until acknowledged.",
      inputSchema: { contract_id: z.string().min(1).max(64), version: z.number().int().positive() },
    },
    ({ contract_id, version }) => guard(() => relay.acknowledgeContract(opts.task, contract_id, version, actor)),
  );

  server.registerTool(
    "declare_intent",
    {
      description: "Declare the files you intend to change. Files inside your scope become an active intent; anything outside is recorded as a proposal that a human must approve.",
      inputSchema: { files: z.array(z.string().min(1).max(512)).min(1).max(200) },
    },
    ({ files }) => guard(() => relay.declareIntent(opts.task, files, opts.root, actor)),
  );

  server.registerTool(
    "report_evidence",
    {
      description: "Report what you ran and observed. Stored as an unverified agent claim; Relay runs its own verification before integration.",
      inputSchema: { summary: z.string().min(1).max(8000), command: z.string().max(1000).optional(), exit_code: z.number().int().optional() },
    },
    ({ summary, command, exit_code }) =>
      guard(() => relay.recordEvidence({ taskId: opts.task, kind: "agent_claim", command: command ?? null, exitCode: exit_code ?? null, output: summary, source: "agent" })),
  );

  server.registerTool(
    "report_blocker",
    {
      description: "Stop and mark your task blocked, with the reason a human needs to resolve.",
      inputSchema: { reason: z.string().min(1).max(4000) },
    },
    ({ reason }) => guard(() => relay.transition(opts.task, "blocked", actor, { reason })),
  );

  server.registerTool(
    "request_contract_change",
    {
      description: "Propose a new version of a contract. It has no effect on anyone until a human accepts it.",
      inputSchema: { contract_id: z.string().min(1).max(64), definition: z.string().min(1).max(20000), rationale: z.string().min(1).max(4000) },
    },
    ({ contract_id, definition, rationale }) => guard(() => relay.proposeContract(contract_id, definition, actor, rationale)),
  );

  server.registerTool(
    "submit_for_review",
    {
      description: "Mark your execution finished (running -> review_required). This does not complete the task: Relay verifies and a human approves integration.",
      inputSchema: { summary: z.string().min(1).max(8000) },
    },
    ({ summary }) => guard(() => relay.transition(opts.task, "review_required", actor, { reason: summary })),
  );

  return server;
}

export async function runMcp(opts: McpOptions): Promise<void> {
  const relay = new Relay(opts.db);
  const server = buildServer(relay, opts);
  await server.connect(new StdioServerTransport());
}
