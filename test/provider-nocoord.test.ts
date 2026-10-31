/**
 * An agent without coordination tools (like the Codex adapter): the runner claims the task for it, submits it for
 * review when it exits cleanly, and Relay's own checks still run. The "agent" here is a plain shell command, so this
 * tests the runner's path, not any provider.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HUMAN } from "./helpers.ts";
import { testServer, until } from "./collab-helpers.ts";
import type { ProviderAdapter } from "../src/providers/types.ts";
import { codex } from "../src/providers/codex.ts";

const shellAgent = (script: string): ProviderAdapter => ({
  id: "shell",
  displayName: "Shell",
  capabilities: { preEditEnforcement: "none", coordination: "none", costReporting: false, allowedTools: [] },
  available: async () => ({ ok: true }),
  launch: () => ({ command: "sh", args: ["-c", script] }),
  parse: () => [],
});

test("no coordination tools: claimed and submitted by the runner; out-of-scope edits still caught by Relay's check", async () => {
  const t = await testServer({ "src/app.js": "export const a = 1;\n", "README.md": "# x\n" }, { provider: shellAgent("echo 'export const b = 2;' >> src/app.js && echo extra >> README.md") });
  try {
    const r = t.server.relay;
    r.createTask({ id: "T-1", objective: "add b", scope: ["src/app.js"], verify: ["node --check src/app.js"] }, HUMAN);
    r.transition("T-1", "queued", HUMAN);
    const owner = t.server.members.invite("O", "owner").member;
    await t.server.runs.start("T-1", owner);
    await until(() => { const x = t.server.runs.forTask("T-1").at(-1); return !!x && x.status === "finished" && !x.checking; }, 15_000, "run");
    assert.equal(r.requireTask("T-1").state, "review_required");
    const sub = r.events("T-1").find((e) => e.toState === "review_required")!;
    assert.equal(sub.actor, "agent:shell");
    assert.match(String((sub.data as { reason?: string }).reason), /submitted by Relay's runner \(the agent has no coordination tools\)/);
    const diff = r.evidence("T-1").find((e) => e.kind === "diff_check")!;
    assert.notEqual(diff.exitCode, 0, "README.md is outside the task's scope: the diff check fails");
  } finally {
    await t.server.close();
  }
});

test("a failed run is not submitted for review", async () => {
  const t = await testServer(undefined, { provider: shellAgent("exit 4") });
  try {
    t.server.relay.createTask({ id: "T-2", objective: "x", scope: ["src/app.js"] }, HUMAN);
    t.server.relay.transition("T-2", "queued", HUMAN);
    await t.server.runs.start("T-2", t.server.members.invite("O", "owner").member);
    await until(() => t.server.runs.forTask("T-2").at(-1)?.status === "failed", 15_000, "run");
    assert.equal(t.server.relay.requireTask("T-2").state, "running");
  } finally {
    await t.server.close();
  }
});

test("the Codex adapter says why it can't run instead of failing silently", async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.deepEqual(await codex().available(), { ok: false, reason: "OPENAI_API_KEY isn't set" });
    assert.equal(codex().capabilities.preEditEnforcement, "none");
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  }
});
