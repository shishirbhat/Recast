/**
 * The integration proof with REAL Claude Code agents instead of simulated ones.
 *
 * Each trial starts two independent `claude -p` sessions per workflow, each in its own isolated copy of the same fixture
 * repository (created in a temp directory, never inside this project):
 *   T-api  renames the API field `name` to `fullName` and updates its own test.
 *   T-ui   changes the footer in a different file and adds its own test.
 * Neither agent is asked to break anything or to skip its checks.
 *
 *   A. Without Relay: plain `claude -p` in two clones; each task's own check is run in its clone; both diffs are merged
 *      into a third clone; the project's full test suite runs on the result.
 *   B. With Relay: the same task definitions run through Relay's agent runner (worktrees, hook, MCP, Relay's own
 *      verification); then the integration rehearsal (`checkTogether`) runs the full suite on the combined change.
 *      Nothing is ever approved or applied by this script; it checks the shared project is byte-for-byte unchanged.
 *
 * Agents vary run to run, so every trial is recorded and classified, including failed and different outcomes. Agent
 * output is never edited. Costs real model usage. Requires a signed-in `claude` CLI.
 *
 *   node scripts/prove-integration-real.ts --trials 3 --out <dir outside the repo> [--report docs/evidence/integration-proof.md]
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testServer, until } from "../test/collab-helpers.ts";
import { HUMAN, makeRepo } from "../test/helpers.ts";
import { writeSection } from "./evidence-section.ts";

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1]! : d;
};
const TRIALS = Number(arg("trials", "3"));
const OUT = resolve(arg("out", mkdtempSync(join(tmpdir(), "relay-real-proof-"))));
const REPORT = arg("report", "");
const ONLY = arg("only", "AB");
const CLAUDE = process.env.CLAUDE_BIN ?? "claude";
const AGENT_TIMEOUT_MS = 15 * 60_000;
mkdirSync(OUT, { recursive: true });

const FILES = {
  "package.json": JSON.stringify({ name: "shop", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
  "src/server.js": "export function getUser(id) {\n  return { id, name: 'Ada' };\n}\n",
  "src/server.test.js": "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { getUser } from './server.js';\ntest('returns the user', () => assert.deepEqual(getUser(1), { id: 1, name: 'Ada' }));\n",
  "src/ui.js": "import { getUser } from './server.js';\n\nexport function greet(id) {\n  return 'Hello ' + getUser(id).name;\n}\n\nexport const footer = 'bye';\n",
  "src/ui.test.js": "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from './ui.js';\ntest('greets the user by name', () => assert.equal(greet(1), 'Hello Ada'));\n",
};
interface TaskDef {
  id: string;
  objective: string;
  scope: string[];
  check: string;
}
const TASKS: TaskDef[] = [
  {
    id: "T-api",
    objective: "Rename the `name` field returned by getUser in src/server.js to `fullName`, and update src/server.test.js to match. Then run `node --test src/server.test.js` and make sure it passes.",
    scope: ["src/server.js", "src/server.test.js"],
    check: "node --test src/server.test.js",
  },
  {
    id: "T-ui",
    objective: "Change the footer text exported from src/ui.js from 'bye' to 'see you soon', and add a test for the footer in src/footer.test.js. Then run `node --test src/ui.test.js src/footer.test.js` and make sure it passes.",
    scope: ["src/ui.js", "src/footer.test.js"],
    check: "node --test src/ui.test.js src/footer.test.js",
  },
];
const PROJECT_TESTS = "node --test";
// Workflow A's prompt: the same objective and scope Relay's runner gives its agent, without Relay's coordination lines.
const plainPrompt = (t: TaskDef) => `${t.objective} Files in scope: ${t.scope.join(", ")}. Only change files in your scope.`;

// Nested `node --test` must not inherit a parent test runner's context (it would report nothing and exit 0).
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("NODE_TEST") && k !== "VITEST" && k !== "JEST_WORKER_ID")) as NodeJS.ProcessEnv;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
const sh = (cwd: string, cmd: string) => {
  try {
    return { ok: true, out: execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: cleanEnv(), timeout: 120_000 }) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
};
const failLine = (out: string) => out.split("\n").find((l) => /^not ok|ERR_|Error:/.test(l.trim()))?.trim() ?? "";
const tree = (repo: string) => git(repo, "rev-parse", "HEAD^{tree}").trim();
// Everything on disk except .git and Relay's own state, so "unchanged" means unchanged files, not just an unchanged HEAD.
const diskState = (repo: string) => execFileSync("sh", ["-c", "find . -path ./.git -prune -o -path ./.relay -prune -o -type f -print | sort | xargs sha1sum"], { cwd: repo, encoding: "utf8" });
/** All changes in a checkout against a commit, untracked files included, as one patch. */
function patchOf(dir: string, base: string): { files: string[]; patch: string } {
  git(dir, "add", "-A");
  const files = git(dir, "diff", "--cached", "--name-only", base).split("\n").filter(Boolean);
  const patch = git(dir, "diff", "--cached", "--binary", base);
  git(dir, "reset", "-q");
  return { files, patch };
}

interface AgentResult {
  exit: number | null;
  seconds: number;
  costUsd: number | null;
  turns: number | null;
  isError: boolean;
  result: string;
  error?: string;
}
function runClaude(cwd: string, prompt: string): Promise<AgentResult> {
  const t0 = Date.now();
  return new Promise((done) => {
    const p = spawn(CLAUDE, ["-p", prompt, "--output-format", "json", "--permission-mode", "acceptEdits", "--allowedTools", "Read,Edit,Write,Bash,Glob,Grep"], { cwd, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => p.kill("SIGTERM"), AGENT_TIMEOUT_MS);
    p.on("close", (code) => {
      clearTimeout(timer);
      const seconds = Math.round((Date.now() - t0) / 1000);
      try {
        const j = JSON.parse(out) as { total_cost_usd?: number; num_turns?: number; is_error?: boolean; result?: string };
        done({ exit: code, seconds, costUsd: j.total_cost_usd ?? null, turns: j.num_turns ?? null, isError: !!j.is_error, result: (j.result ?? "").slice(0, 1500) });
      } catch {
        done({ exit: code, seconds, costUsd: null, turns: null, isError: true, result: "", error: (err || out).slice(0, 800) });
      }
    });
  });
}

interface TaskOutcome {
  id: string;
  agent: AgentResult;
  changedFiles: string[];
  outOfScope: string[];
  ownCheck: { ok: boolean; fail: string };
  relayState?: string;
  guardDenials?: number;
}
interface WorkflowOutcome {
  startTree: string;
  tasks: TaskOutcome[];
  combined: { ok: boolean; fail: string } | null;
  mergeConflict: boolean | null;
  relayStatus?: string;
  relayGaps?: string[];
  projectUnchanged?: boolean;
  error?: string;
  seconds: number;
  costUsd: number;
}
function classify(w: WorkflowOutcome): string {
  if (w.error) return "inconclusive: harness or agent error";
  const failed = w.tasks.filter((t) => t.agent.isError || t.agent.exit !== 0);
  if (failed.length) return `agent failure: ${failed.map((t) => t.id).join(", ")} did not finish`;
  const red = w.tasks.filter((t) => !t.ownCheck.ok);
  if (red.length) return `agent failure: ${red.map((t) => t.id).join(", ")} own check failed`;
  if (w.mergeConflict) return "different outcome: merge conflict";
  if (w.combined?.ok) return "different outcome: combined change passed";
  return "reproduced: both green, combined red";
}
const sum = (xs: (number | null)[]) => Math.round(xs.reduce<number>((a, b) => a + (b ?? 0), 0) * 1000) / 1000;

async function workflowA(trialDir: string): Promise<WorkflowOutcome> {
  const t0 = Date.now();
  const base = makeRepo(FILES);
  const head = git(base, "rev-parse", "HEAD").trim();
  const clones = TASKS.map((t) => {
    const dir = join(mkdtempSync(join(tmpdir(), `relay-a-${t.id}-`)), "repo");
    git(tmpdir(), "clone", "-q", base, dir);
    return dir;
  });
  const agents = await Promise.all(TASKS.map((t, i) => runClaude(clones[i]!, plainPrompt(t))));
  const tasks: TaskOutcome[] = [];
  const patches: string[] = [];
  TASKS.forEach((t, i) => {
    const { files, patch } = patchOf(clones[i]!, head);
    writeFileSync(join(trialDir, `A-${t.id}.patch`), patch);
    patches.push(patch);
    const own = sh(clones[i]!, t.check);
    tasks.push({ id: t.id, agent: agents[i]!, changedFiles: files, outOfScope: files.filter((f) => !t.scope.includes(f)), ownCheck: { ok: own.ok, fail: own.ok ? "" : failLine(own.out) } });
  });
  const merged = join(mkdtempSync(join(tmpdir(), "relay-a-merged-")), "repo");
  git(tmpdir(), "clone", "-q", base, merged);
  let mergeConflict = false;
  for (const [i, p] of patches.entries()) {
    if (!p.trim()) continue;
    const f = join(trialDir, `A-${TASKS[i]!.id}.patch`);
    try {
      git(merged, "apply", "--3way", f);
    } catch {
      mergeConflict = true;
    }
  }
  const combined = mergeConflict ? null : sh(merged, PROJECT_TESTS);
  return {
    startTree: tree(base),
    tasks,
    combined: combined && { ok: combined.ok, fail: combined.ok ? "" : failLine(combined.out) },
    mergeConflict,
    seconds: Math.round((Date.now() - t0) / 1000),
    costUsd: sum(agents.map((a) => a.costUsd)),
  };
}

async function workflowB(trialDir: string): Promise<WorkflowOutcome> {
  const t0 = Date.now();
  const { server, repo } = await testServer(FILES, { claudeBin: CLAUDE });
  const startTree = tree(repo);
  const before = diskState(repo);
  try {
    const owner = server.members.invite("Olu", "owner").member;
    const r = server.relay;
    r.proposeContract("user-api", "getUser(id) -> { id, fullName }", HUMAN);
    r.acceptContract("user-api", 1, HUMAN);
    for (const t of TASKS) {
      r.createTask({ id: t.id, objective: t.objective, scope: t.scope, contracts: { "user-api": 1 }, verify: [t.check] }, HUMAN);
      r.transition(t.id, "queued", HUMAN);
    }
    await server.runs.start(TASKS.map((t) => t.id), owner);
    const ids = TASKS.map((t) => t.id);
    const done = () => ids.every((t) => {
      const run = server.runs.forTask(t).at(-1);
      return !!run && ["finished", "failed", "cancelled"].includes(run.status) && !run.checking;
    });
    await until(done, AGENT_TIMEOUT_MS + 120_000, "both Relay agent runs");
    const tasks: TaskOutcome[] = TASKS.map((t) => {
      const run = server.runs.forTask(t.id).at(-1)!;
      const { files, patch } = patchOf(run.worktree, run.snapshot);
      writeFileSync(join(trialDir, `B-${t.id}.patch`), patch);
      const own = sh(run.worktree, t.check);
      const acts = run.activity as { kind: string; detail?: string }[];
      const last = [...acts].reverse().find((a) => a.kind === "result" || a.kind === "text");
      return {
        id: t.id,
        agent: { exit: run.exitCode, seconds: Math.round((Date.parse(run.endedAt ?? new Date().toISOString()) - Date.parse(run.startedAt)) / 1000), costUsd: run.costUsd, turns: null, isError: run.status !== "finished", result: (last?.detail ?? "").slice(0, 1500) },
        changedFiles: files,
        outOfScope: files.filter((f) => !t.scope.includes(f)),
        ownCheck: { ok: own.ok, fail: own.ok ? "" : failLine(own.out) },
        relayState: r.requireTask(t.id).state,
        guardDenials: acts.filter((a) => a.kind === "denied").length,
      };
    });
    // The rehearsal: never skipped, never followed by an approval here.
    let integ;
    let mergeConflict = false;
    try {
      integ = await server.runs.checkTogether(ids, [PROJECT_TESTS]);
    } catch (e) {
      if ((e as { code?: string }).code !== "conflict") throw e;
      mergeConflict = true;
    }
    const failed = integ?.results.find((x) => x.exitCode !== 0);
    return {
      startTree,
      tasks,
      combined: integ ? { ok: !failed, fail: failed ? failLine(failed.output) : "" } : null,
      mergeConflict,
      relayStatus: integ?.status ?? "refused (conflict)",
      relayGaps: integ?.gaps ?? [],
      projectUnchanged: diskState(repo) === before && tree(repo) === startTree,
      seconds: Math.round((Date.now() - t0) / 1000),
      costUsd: sum(tasks.map((t) => t.agent.costUsd)),
    };
  } finally {
    await server.close();
  }
}

const claudeVersion = execFileSync(CLAUDE, ["--version"], { encoding: "utf8" }).trim();
const trials: { n: number; at: string; A?: WorkflowOutcome; B?: WorkflowOutcome; classA?: string; classB?: string }[] = [];
for (let n = 1; n <= TRIALS; n++) {
  const trialDir = join(OUT, `trial-${n}`);
  mkdirSync(trialDir, { recursive: true });
  const trial: (typeof trials)[number] = { n, at: new Date().toISOString() };
  console.error(`trial ${n}: starting (${ONLY})`);
  const run = async (w: "A" | "B") => {
    try {
      return await (w === "A" ? workflowA(trialDir) : workflowB(trialDir));
    } catch (e) {
      return { startTree: "", tasks: [], combined: null, mergeConflict: null, error: String((e as Error).message ?? e).slice(0, 800), seconds: 0, costUsd: 0 } satisfies WorkflowOutcome;
    }
  };
  // A and B run at the same time: four independent agents per trial, each in its own copy.
  const [A, B] = await Promise.all([ONLY.includes("A") ? run("A") : undefined, ONLY.includes("B") ? run("B") : undefined]);
  if (A) (trial.A = A), (trial.classA = classify(A));
  if (B) (trial.B = B), (trial.classB = classify(B));
  trials.push(trial);
  writeFileSync(join(trialDir, "trial.json"), JSON.stringify(trial, null, 2));
  console.error(`trial ${n}: A ${trial.classA ?? "-"} | B ${trial.classB ?? "-"}${B ? ` (Relay ${B.relayStatus}, project ${B.projectUnchanged ? "unchanged" : "CHANGED"})` : ""}`);
}
const results = { claudeVersion, prompts: { A: TASKS.map((t) => ({ id: t.id, prompt: plainPrompt(t) })), B: TASKS.map((t) => ({ id: t.id, objective: t.objective, scope: t.scope, verify: t.check })) }, checks: Object.fromEntries(TASKS.map((t) => [t.id, t.check])), projectTests: PROJECT_TESTS, trials };
writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
console.log(`wrote ${join(OUT, "results.json")}`);

if (REPORT) {
  const yes = (b: boolean | null | undefined) => (b == null ? "—" : b ? "yes" : "no");
  const pf = (c: { ok: boolean; fail: string } | null | undefined) => (!c ? "not run" : c.ok ? "pass" : `**FAIL** \`${c.fail.replace(/\|/g, "/")}\``);
  const row = (...c: string[]) => `| ${c.join(" | ")} |`;
  const lines = [
    "## Real-agent trials (Claude Code)",
    "",
    `Generated ${new Date().toISOString()} by \`node scripts/prove-integration-real.ts --trials ${TRIALS}\`. Agent: ${claudeVersion}, headless (\`claude -p\`). Every trial is listed, including failed and different outcomes; agent output was not edited.`,
    "",
    `Starting revision: the same fixture (tree \`${trials.find((t) => t.A?.startTree)?.A?.startTree.slice(0, 12) ?? trials.find((t) => t.B?.startTree)?.B?.startTree.slice(0, 12)}\`) in a fresh temp repository for every workflow and trial. Own checks: T-api \`${TASKS[0]!.check}\`, T-ui \`${TASKS[1]!.check}\`. Combined check: \`${PROJECT_TESTS}\`.`,
    "",
    "### A. Without Relay (plain `claude -p` in two clones, then merge)",
    "",
    row("Trial", "T-api files", "T-api own check", "T-ui files", "T-ui own check", "Merge conflict", "Combined tests", "Agent time / cost", "Outcome"),
    row("---", "---", "---", "---", "---", "---", "---", "---", "---"),
    ...trials.filter((t) => t.A).map((t) => {
      const a = t.A!;
      if (a.error) return row(String(t.n), "—", "—", "—", "—", "—", "—", "—", `inconclusive: \`${a.error.slice(0, 120).replace(/\|/g, "/")}\``);
      const [x, y] = a.tasks;
      return row(String(t.n), x!.changedFiles.join(", ") || "none", pf(x!.ownCheck), y!.changedFiles.join(", ") || "none", pf(y!.ownCheck), yes(a.mergeConflict), pf(a.combined), `${Math.max(x!.agent.seconds, y!.agent.seconds)} s / $${a.costUsd}`, t.classA!);
    }),
    "",
    "### B. With Relay (Relay's agent runner, then the integration rehearsal)",
    "",
    row("Trial", "T-api files", "T-api own check", "T-ui files", "T-ui own check", "Rehearsal", "Combined tests", "Project unchanged", "Agent time / cost", "Outcome"),
    row("---", "---", "---", "---", "---", "---", "---", "---", "---", "---"),
    ...trials.filter((t) => t.B).map((t) => {
      const b = t.B!;
      if (b.error) return row(String(t.n), "—", "—", "—", "—", "—", "—", "—", "—", `inconclusive: \`${b.error.slice(0, 120).replace(/\|/g, "/")}\``);
      const [x, y] = b.tasks;
      return row(String(t.n), x!.changedFiles.join(", ") || "none", pf(x!.ownCheck), y!.changedFiles.join(", ") || "none", pf(y!.ownCheck), b.relayStatus === "blocked" ? "**blocked**" : b.relayStatus!, pf(b.combined), yes(b.projectUnchanged), `${Math.max(x!.agent.seconds, y!.agent.seconds)} s / $${b.costUsd}`, t.classB!);
    }),
  ];
  writeSection(REPORT, "real-agent", lines.join("\n"));
  console.log(`wrote real-agent section of ${REPORT}`);
}
