import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { shellWriteReason } from "../src/hooks/claude-code.ts";
import { buildServer } from "../src/mcp/server.ts";
import { HUMAN, USER_API_V2, scenario } from "./helpers.ts";

const BIN = resolve(import.meta.dirname, "../bin/relay");

function hook(db: string, root: string, stdin: string, env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync(BIN, ["--db", db, "hook", "claude-code", "--task", "T-ui", "--root", root], { input: stdin, encoding: "utf8", env });
  return { status: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null, stderr: r.stderr };
}

const editPayload = (root: string, file: string) => JSON.stringify({ tool_name: "Edit", cwd: root, tool_input: { file_path: join(root, file), old_string: "a", new_string: "b" } });

test("hook process: stale contract is denied with the authoritative contract in the reason", () => {
  const { relay, repo, db } = scenario();
  relay.claim("T-ui", { kind: "agent", id: "claude-code" });
  relay.proposeContract("user-api", USER_API_V2, HUMAN);
  relay.acceptContract("user-api", 2, HUMAN);
  relay.close();
  const r = hook(db, repo, editPayload(repo, "src/ui.js"));
  assert.equal(r.status, 0);
  assert.equal(r.out.permissionDecision, "deny");
  assert.match(r.out.permissionDecisionReason, /fullName/);
  assert.match(r.out.permissionDecisionReason, /acknowledge_contract/);
});

test("hook process: allowed edit", () => {
  const { relay, repo, db } = scenario();
  relay.claim("T-ui", { kind: "agent", id: "claude-code" });
  relay.close();
  assert.equal(hook(db, repo, editPayload(repo, "src/ui.js")).out.permissionDecision, "allow");
});

test("hook process fails closed: malformed payload, missing field, unusable database", () => {
  const { repo, db } = scenario();
  assert.equal(hook(db, repo, "not json").out.permissionDecision, "deny");
  assert.equal(hook(db, repo, JSON.stringify({ tool_name: "Write", tool_input: {} })).out.permissionDecision, "deny");
  const dirAsDb = mkdtempSync(join(tmpdir(), "relay-bad-"));
  const r = hook(dirAsDb, repo, editPayload(repo, "src/ui.js"));
  assert.equal(r.out.permissionDecision, "deny");
  assert.match(r.out.permissionDecisionReason, /failing closed/);
});

test("generated Claude Code settings deny when the hook process cannot start at all", () => {
  const { repo, db } = scenario();
  const out = mkdtempSync(join(tmpdir(), "relay-cfg-"));
  const cfg = spawnSync(BIN, ["--db", db, "agent-config", "claude-code", "--task", "T-ui", "--root", repo, "--out", out], { encoding: "utf8" });
  assert.equal(cfg.status, 0, cfg.stderr);
  const settings = JSON.parse(readFileSync(join(out, "settings.json"), "utf8"));
  const command: string = settings.hooks.PreToolUse[0].hooks[0].command;
  // An empty PATH means `node` cannot be found: the shell-level fallback must still deny.
  const r = spawnSync("/bin/sh", ["-c", command], { input: editPayload(repo, "src/ui.js"), encoding: "utf8", env: { PATH: "" } });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(settings.hooks.PreToolUse[0].matcher, "Edit|Write|MultiEdit|NotebookEdit|Bash");
});

test("shell write heuristic", () => {
  for (const c of ["echo x > a.js", "echo x >> a.js", "sed -i 's/a/b/' f", "tee f", "rm -rf src", "git commit -am x", "git push", "cp a b"]) {
    assert.ok(shellWriteReason(c), c);
  }
  for (const c of ["ls -la", "cat src/ui.js", "npm test 2>&1", "node --check a.js 2>/dev/null", "git diff", "git status", "grep -rn foo src"]) {
    assert.equal(shellWriteReason(c), null, c);
  }
});

async function mcpClient() {
  const s = scenario();
  const server = buildServer(s.relay, { db: s.db, task: "T-ui", root: s.repo, agent: "claude-code" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { error: r.isError === true, body: JSON.parse(r.content[0]!.text) };
  };
  return { ...s, client, call };
}

test("MCP: exposes only coordination tools, nothing that touches files, shell, merge or approval", async () => {
  const { client } = await mcpClient();
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["acknowledge_contract", "claim_task", "declare_intent", "get_contract", "get_task", "report_blocker", "report_evidence", "request_contract_change", "submit_for_review"]);
});

test("MCP: the participatory loop — claim, see stale contract, read it, acknowledge, declare intent, submit", async () => {
  const { relay, call } = await mcpClient();
  assert.equal((await call("claim_task")).body.state, "running");
  relay.proposeContract("user-api", USER_API_V2, HUMAN);
  relay.acceptContract("user-api", 2, HUMAN);

  const view = (await call("get_task")).body;
  assert.deepEqual(view.contracts[0], { id: "user-api", plannedVersion: 1, currentVersion: 2, stale: true });
  assert.match((await call("get_contract", { contract_id: "user-api" })).body.contract.definition, /fullName/);
  assert.equal((await call("acknowledge_contract", { contract_id: "user-api", version: 2 })).body.contracts["user-api"], 2);
  assert.equal((await call("declare_intent", { files: ["src/ui.js"] })).body.intent.status, "active");

  const ev = (await call("report_evidence", { summary: "tests pass", command: "npm test", exit_code: 0 })).body;
  assert.equal(ev.verified, false);
  assert.equal(ev.kind, "agent_claim");
  assert.equal((await call("submit_for_review", { summary: "done" })).body.state, "review_required");
});

test("MCP: agent cannot accept its own contract change or move the task past review", async () => {
  const { relay, call } = await mcpClient();
  await call("claim_task");
  const proposed = (await call("request_contract_change", { contract_id: "user-api", definition: "anything", rationale: "x" })).body;
  assert.equal(proposed.status, "proposed");
  assert.equal(relay.currentContract("user-api")!.version, 1);
  const bad = await call("acknowledge_contract", { contract_id: "user-api", version: 2 });
  assert.equal(bad.error, true);
  assert.equal(bad.body.error, "stale_state");
  const invalid = await call("declare_intent", { files: ["../../etc/passwd"] });
  assert.equal(invalid.error, true);
});
