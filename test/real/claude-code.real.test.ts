/**
 * Real-provider tests: these run the actual Claude Code CLI (`claude -p`) against Relay.
 * Skipped unless RELAY_REAL_PROVIDER=1. They cost real model usage and are not deterministic,
 * so they assert on Relay's own records and on git, never on what the agent says it did.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Relay } from "../../src/core/engine.ts";
import { AGENT_A, HUMAN, USER_API_V2, git, scenario } from "../helpers.ts";

const REAL = process.env.RELAY_REAL_PROVIDER === "1";
const BIN = resolve(import.meta.dirname, "../../bin/relay");
const RESULTS = process.env.RELAY_RESULTS_DIR;

interface Run {
  exit: number | null;
  seconds: number;
  result: string;
  costUsd: number | null;
  numTurns: number | null;
  model: string | null;
}

function claudeVersion(): string {
  return spawnSync("claude", ["--version"], { encoding: "utf8" }).stdout.trim();
}

function launch(db: string, repo: string, prompt: string, withMcp: boolean): Run {
  const out = mkdtempSync(join(tmpdir(), "relay-agent-"));
  const cfg = spawnSync(BIN, ["--db", db, "--json", "agent-config", "claude-code", "--task", "T-ui", "--root", repo, "--out", out], { encoding: "utf8" });
  assert.equal(cfg.status, 0, cfg.stderr);
  const args = ["-p", prompt, "--output-format", "json", "--permission-mode", "acceptEdits", "--settings", join(out, "settings.json"), "--strict-mcp-config"];
  args.push("--allowedTools", withMcp ? "Read,Edit,Write,Bash,mcp__relay" : "Read,Edit,Write,Bash");
  if (withMcp) args.push("--mcp-config", join(out, "mcp.json"));
  const start = Date.now();
  const r = spawnSync("claude", args, { cwd: repo, encoding: "utf8", input: "", timeout: 300_000 });
  const seconds = (Date.now() - start) / 1000;
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
  } catch {
    parsed = { result: `unparseable output: ${r.stdout.slice(0, 500)} ${r.stderr.slice(0, 500)}` };
  }
  const usage = parsed.modelUsage as Record<string, unknown> | undefined;
  return {
    exit: r.status,
    seconds,
    result: String(parsed.result ?? ""),
    costUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : null,
    numTurns: typeof parsed.num_turns === "number" ? parsed.num_turns : null,
    model: usage ? Object.keys(usage).join(",") : null,
  };
}

interface DecisionEvent { at: string; decision?: string; tool?: string; provider?: string; point?: string; conflicts?: unknown }

function decisions(db: string): DecisionEvent[] {
  const relay = new Relay(db);
  try {
    return relay.events("T-ui").filter((e) => e.type === "enforcement.decision").map((e) => ({ at: e.at, ...e.data }) as DecisionEvent);
  } finally {
    relay.close();
  }
}

function save(name: string, data: unknown): void {
  if (!RESULTS) return;
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(join(RESULTS, `${name}.json`), JSON.stringify({ claude: claudeVersion(), recordedAt: new Date().toISOString(), ...(data as object) }, null, 2));
}

test("real Claude Code: an edit built on a superseded contract is blocked before it is written", { skip: !REAL }, () => {
  const { relay, repo, db } = scenario();
  relay.claim("T-ui", AGENT_A);
  relay.proposeContract("user-api", USER_API_V2, HUMAN);
  relay.acceptContract("user-api", 2, HUMAN);
  relay.close();
  const before = readFileSync(join(repo, "src/ui.js"), "utf8");

  const run = launch(db, repo, "Edit src/ui.js so the greeting ends with an exclamation mark. Use the Edit tool. If the edit is blocked, stop and report the exact reason; do not try another way.", false);
  const d = decisions(db);
  save("01-stale-contract-block", { run, decisions: d, gitStatus: git(repo, "status", "--porcelain") });

  assert.equal(readFileSync(join(repo, "src/ui.js"), "utf8"), before, "file must be unchanged");
  const stale = d.find((x) => x.decision === "deny" && JSON.stringify(x.conflicts).includes("stale_contract"));
  assert.ok(stale, `expected a stale_contract denial, got ${JSON.stringify(d)}`);
  assert.equal(stale.provider, "claude-code");
  assert.equal(stale.point, "pre_action");
});

test("real Claude Code: a shell write is blocked, and the diff check confirms nothing slipped through", { skip: !REAL }, () => {
  const { relay, repo, db } = scenario();
  relay.claim("T-ui", AGENT_A);
  relay.close();

  const run = launch(db, repo, "Append the line '// touched' to src/server.js using a Bash command with echo and >>. Do not use Edit or Write. If blocked, stop and report why.", false);
  const d = decisions(db);
  const r2 = new Relay(db);
  const check = r2.diffCheck("T-ui", repo);
  r2.close();
  save("02-shell-write-block", { run, decisions: d, diffCheck: { files: check.files, exitCode: check.evidence.exitCode } });

  assert.ok(d.some((x) => x.decision === "deny" && x.tool === "Bash"), `expected a Bash denial, got ${JSON.stringify(d)}`);
  assert.deepEqual(check.files, [], "workspace must be unchanged");
});

test("real Claude Code: full participatory loop through MCP ends in a verified, human-approved result", { skip: !REAL }, () => {
  const { relay, repo, db } = scenario();
  // The contract changes before the agent starts; the agent is not told about it.
  relay.proposeContract("user-api", USER_API_V2, HUMAN);
  relay.acceptContract("user-api", 2, HUMAN);
  relay.close();

  const prompt = [
    "You are working on Relay task T-ui in this repository. Objective: make greet() in src/ui.js produce 'Hello <name>' for a user returned by getUser().",
    "Coordinate through the relay MCP tools: claim the task before editing, follow any instruction Relay gives you when an action is blocked, and call submit_for_review with a short summary when finished.",
    "Only change files in your task's scope.",
  ].join(" ");
  const run = launch(db, repo, prompt, true);

  const r = new Relay(db);
  try {
    const events = r.events("T-ui").map((e) => ({ type: e.type, actor: e.actor, from: e.fromState, to: e.toState, data: e.data }));
    const task = r.requireTask("T-ui");
    const ui = readFileSync(join(repo, "src/ui.js"), "utf8");
    const check = r.diffCheck("T-ui", repo);
    const verify = r.runVerification("T-ui", repo);
    let completed = false;
    let gate = "";
    try {
      completed = r.transition("T-ui", "completed", HUMAN, { expectedFrom: "review_required", cwd: repo }).state === "completed";
    } catch (e) {
      gate = (e as Error).message;
    }
    save("03-participatory-loop", {
      run,
      finalState: task.state,
      contractsAfter: task.contracts,
      ui,
      diffCheck: { files: check.files, exitCode: check.evidence.exitCode },
      verification: verify.map((v) => ({ command: v.command, exitCode: v.exitCode })),
      completed,
      gate,
      events,
    });

    assert.equal(task.state, "review_required", `agent should have submitted for review; events: ${JSON.stringify(events.map((e) => e.type))}`);
    assert.equal(task.contracts["user-api"], 2, "agent should have acknowledged user-api v2");
    assert.match(ui, /fullName/, "implementation should follow the v2 contract");
    assert.doesNotMatch(ui, /\.name\b/, "implementation should not use the removed v1 field");
    assert.equal(check.evidence.exitCode, 0);
    assert.ok(verify.every((v) => v.exitCode === 0));
    assert.ok(completed, gate);
  } finally {
    r.close();
  }
});
