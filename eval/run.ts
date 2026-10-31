/**
 * Relay's evaluation harness. For each scenario and trial, the same two requests go through two workflows, with the
 * same agent, configuration and starting repository:
 *
 *   baseline  Each request is done in its own clone. Each branch must pass its own check AND the project's full test
 *             suite on its own (as CI on a pull request would). Branches that are green and merge without conflict
 *             are merged. This is a fair, careful team without Relay, not a strawman.
 *   relay     The requests become Relay tasks run by Relay's agent runner (worktrees, scope enforcement where the agent
 *             supports it, Relay's own checks). Then Check Together runs the project's full suite on the combined change
 *             and reports passed (verified or with named coverage gaps), blocked, or refused (the changes don't merge).
 *
 * Ground truth comes from hidden oracle tests (eval/scenarios.ts) run on the combination of each workflow's own patches.
 * Agents and Relay never see them. Every trial is kept, including agent failures and errors.
 *
 *   node eval/run.ts --agent sim                                   simulated agent: deterministic, free
 *   node eval/run.ts --agent claude-code --trials 1 --yes          real Claude Code: costs model usage
 *   node eval/run.ts --agent codex --yes                           needs OPENAI_API_KEY and the codex CLI
 *     [--scenarios s01-independent,s03-renamed-field] [--out DIR] [--parallel N]
 *
 * Results: DIR/results.json (machine-readable, every trial), DIR/<scenario>/trial-<n>/ (patches, agent output, check
 * output, oracle output). Summarise with eval/report.ts.
 */
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BASE, BASE_VERSION, SCENARIOS } from "./scenarios.ts";
import type { Scenario, TaskDef } from "./scenarios.ts";
import { testServer, until } from "../test/collab-helpers.ts";
import { HUMAN, makeRepo } from "../test/helpers.ts";
import type { Integration } from "../src/core/types.ts";
import { parseFailures } from "../src/analysis/explain.ts";
import { codex } from "../src/providers/codex.ts";

export const RESULTS_FORMAT = "relay.eval/1";
const arg = (k: string, d = "") => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? (process.argv[i + 1] ?? d) : d;
};
const flag = (k: string) => process.argv.includes(`--${k}`);
const AGENT = arg("agent", "sim") as "sim" | "claude-code" | "codex";
const TRIALS = Number(arg("trials", "1"));
const ONLY = arg("scenarios") ? arg("scenarios").split(",") : null;
const PARALLEL = Number(arg("parallel", AGENT === "sim" ? "1" : "2"));
const OUT = resolve(arg("out", join(import.meta.dirname, "results", `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}-${AGENT}`)));
const SIM = resolve(import.meta.dirname, "../test/fixtures/simulated-agent");
const PROJECT_SUITE = "node --test";
const AGENT_TIMEOUT_MS = 15 * 60_000;

if (!["sim", "claude-code", "codex"].includes(AGENT)) throw new Error(`--agent is sim, claude-code or codex`);
if (AGENT !== "sim" && !flag("yes")) {
  console.error(`--agent ${AGENT} runs real agents: 4 agent sessions per scenario per trial (2 baseline, 2 with Relay). It costs model usage. Add --yes to run.`);
  process.exit(2);
}
if (AGENT === "codex") {
  // Codex needs its CLI and an OpenAI key. Neither is assumed; the run stops here and says what is missing.
  const missing = [!process.env.OPENAI_API_KEY && "the OPENAI_API_KEY environment variable", (() => { try { execFileSync("codex", ["--version"], { stdio: "ignore" }); return false; } catch { return "the codex CLI on PATH"; } })()].filter(Boolean);
  if (missing.length) {
    console.error(`Codex can't run here: missing ${missing.join(" and ")}. Nothing was run.`);
    process.exit(3);
  }
}

// Nested `node --test` must not inherit a parent test runner's context.
const cleanEnv = (extra: Record<string, string> = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("NODE_TEST") && k !== "VITEST" && k !== "JEST_WORKER_ID")), ...extra }) as NodeJS.ProcessEnv;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
const sh = (cwd: string, cmd: string, timeout = 120_000) => {
  const t0 = Date.now();
  try {
    return { ok: true, ms: Date.now() - t0, out: execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: cleanEnv(), timeout }) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, ms: Date.now() - t0, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
};
const clip = (s: string, n = 4000) => (s.length > n ? `[last ${n} of ${s.length} characters]\n${s.slice(-n)}` : s);
const diskState = (repo: string) => execFileSync("sh", ["-c", "find . -path ./.git -prune -o -path ./.relay -prune -o -type f -print | sort | xargs sha1sum"], { cwd: repo, encoding: "utf8" });
const clone = (base: string, tag: string) => {
  const dir = join(mkdtempSync(join(tmpdir(), `relay-eval-${tag}-`)), "repo");
  git(tmpdir(), "clone", "-q", base, dir);
  git(dir, "config", "user.email", "eval@relay.local");
  git(dir, "config", "user.name", "Relay eval");
  return dir;
};
function patchOf(dir: string, base: string): { files: string[]; patch: string } {
  git(dir, "add", "-A");
  const files = git(dir, "diff", "--cached", "--name-only", base).split("\n").filter(Boolean);
  const patch = git(dir, "diff", "--cached", "--binary", base);
  git(dir, "reset", "-q");
  return { files, patch };
}

/** The request as an agent receives it in both workflows: the same words, the same check to run. */
const request = (t: TaskDef) => `${t.request} Only change files in: ${t.scope.join(", ")}. When you're done, run \`${t.check}\` and make sure it passes.`;

interface AgentRun {
  ok: boolean;
  exit: number | null;
  seconds: number;
  costUsd: number | null;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number } | null;
  model: string | null;
  error: string | null;
  result: string;
}

/** Apply a simulated agent's scripted edits in a checkout (the same edits the simulated agent makes under Relay). */
function simEdits(dir: string, t: TaskDef): AgentRun {
  for (const [path, pairs] of Object.entries(t.sim)) {
    const abs = join(dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    let text = existsSync(abs) ? readFileSync(abs, "utf8") : "";
    for (const [a, b] of pairs) text = text.replace(a, () => b); // a function: "$" in b is literal
    writeFileSync(abs, text);
  }
  return { ok: true, exit: 0, seconds: 0, costUsd: 0, tokens: null, model: "simulated", error: null, result: "scripted edits applied" };
}

function runCli(cmd: string, args: string[], cwd: string): Promise<{ code: number | null; out: string; err: string; seconds: number }> {
  const t0 = Date.now();
  return new Promise((done) => {
    const p = spawn(cmd, args, { cwd, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => p.kill("SIGTERM"), AGENT_TIMEOUT_MS);
    p.on("close", (code) => (clearTimeout(timer), done({ code, out, err, seconds: Math.round((Date.now() - t0) / 1000) })));
  });
}

/** The baseline's agent: the same CLI, tools and permission mode as Relay's runner uses, minus Relay's hook and MCP. */
async function baselineAgent(dir: string, t: TaskDef): Promise<AgentRun> {
  if (AGENT === "sim") return simEdits(dir, t);
  if (AGENT === "claude-code") {
    const r = await runCli("claude", ["-p", request(t), "--output-format", "json", "--permission-mode", "acceptEdits", "--allowedTools", "Read,Edit,Write,Bash,Glob,Grep"], dir);
    try {
      const j = JSON.parse(r.out) as { total_cost_usd?: number; is_error?: boolean; result?: string; usage?: Record<string, number>; modelUsage?: Record<string, unknown> };
      const u = j.usage;
      return { ok: !j.is_error && r.code === 0, exit: r.code, seconds: r.seconds, costUsd: j.total_cost_usd ?? null, tokens: u ? { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheCreation: u.cache_creation_input_tokens ?? 0 } : null, model: Object.keys(j.modelUsage ?? {}).join(",") || null, error: j.is_error ? (j.result ?? "error").slice(0, 500) : null, result: (j.result ?? "").slice(0, 1500) };
    } catch {
      return { ok: false, exit: r.code, seconds: r.seconds, costUsd: null, tokens: null, model: null, error: (r.err || r.out).slice(0, 800), result: "" };
    }
  }
  const r = await runCli("codex", ["exec", "--full-auto", "--skip-git-repo-check", request(t)], dir);
  return { ok: r.code === 0, exit: r.code, seconds: r.seconds, costUsd: null, tokens: null, model: null, error: r.code === 0 ? null : (r.err || r.out).slice(-800), result: r.out.slice(-1500) };
}

type Truth = "works" | "broken" | "text-conflict" | "unknown";
/** Ground truth for a pair of patches: combine them on the base and run the hidden oracle there. */
function groundTruth(base: string, s: Scenario, patches: string[], dir: string): { truth: Truth; oracle: string; conflict: boolean } {
  const c = clone(base, "oracle");
  try {
    for (const [i, p] of patches.entries()) {
      if (!p.trim()) continue;
      writeFileSync(join(dir, `combined-${i}.patch`), p);
      try {
        git(c, "apply", "--3way", join(dir, `combined-${i}.patch`));
      } catch {
        return { truth: "text-conflict", oracle: "the two patches don't apply together", conflict: true };
      }
    }
    for (const [p, text] of Object.entries(s.oracle)) (mkdirSync(dirname(join(c, p)), { recursive: true }), writeFileSync(join(c, p), text));
    const r = sh(c, `node --test ${Object.keys(s.oracle).join(" ")}`);
    return { truth: r.ok ? "works" : "broken", oracle: clip(r.out, 3000), conflict: false };
  } finally {
    rmSync(dirname(c), { recursive: true, force: true });
  }
}

/** Correct or not, against ground truth. "integrate" means the workflow would put both changes into the project. */
function judge(decision: "integrate" | "stop" | "refused" | "inconclusive" | "not-compared", truth: Truth): string {
  if (decision === "not-compared" || truth === "unknown") return "not-compared";
  if (truth === "text-conflict") return decision === "refused" || decision === "stop" ? "correct-conflict" : "missed-conflict";
  if (decision === "inconclusive") return truth === "works" ? "inconclusive-was-fine" : "inconclusive-was-broken";
  if (truth === "broken") return decision === "integrate" ? "missed-break" : "correct-block";
  return decision === "integrate" ? "correct-pass" : "false-block";
}

async function baseline(s: Scenario, base: string, dir: string) {
  const t0 = Date.now();
  const head = git(base, "rev-parse", "HEAD").trim();
  const clones = s.tasks.map((t) => clone(base, `base-${t.id}`));
  const agents = await Promise.all(s.tasks.map((t, i) => baselineAgent(clones[i]!, t)));
  const tasks = s.tasks.map((t, i) => {
    const { files, patch } = patchOf(clones[i]!, head);
    writeFileSync(join(dir, `baseline-${t.id}.patch`), patch);
    const own = sh(clones[i]!, t.check);
    const ci = sh(clones[i]!, PROJECT_SUITE);
    writeFileSync(join(dir, `baseline-${t.id}-checks.txt`), `$ ${t.check}\n${own.out}\n\n$ ${PROJECT_SUITE}\n${ci.out}`);
    return { id: t.id, agent: agents[i]!, changedFiles: files, outOfScope: files.filter((f) => !t.scope.includes(f)), ownCheck: own.ok, projectSuiteAlone: ci.ok, patch };
  });
  const gt = groundTruth(base, s, tasks.map((t) => t.patch), dir);
  writeFileSync(join(dir, "baseline-oracle.txt"), gt.oracle);
  const agentFailed = tasks.some((t) => !t.agent.ok);
  const green = tasks.every((t) => t.ownCheck && t.projectSuiteAlone);
  const decision = agentFailed ? "not-compared" : gt.conflict ? "refused" : green ? "integrate" : "stop";
  for (const c of clones) rmSync(dirname(c), { recursive: true, force: true });
  return {
    tasks: tasks.map(({ patch: _p, ...t }) => t),
    mergeConflict: gt.conflict,
    decision,
    why: agentFailed ? "an agent didn't finish" : gt.conflict ? "git couldn't merge the branches" : green ? "both branches green on their own; merged" : `not merged: ${tasks.filter((t) => !(t.ownCheck && t.projectSuiteAlone)).map((t) => `${t.id} ${!t.ownCheck ? "own check" : "project suite"} failed`).join(", ")}`,
    truth: gt.truth,
    outcome: judge(decision as never, gt.truth),
    brokenIntoProject: decision === "integrate" && gt.truth === "broken",
    seconds: Math.round((Date.now() - t0) / 1000),
    costUsd: sumCost(tasks.map((t) => t.agent.costUsd)),
  };
}

function sumCost(xs: (number | null)[]): number | null {
  return xs.some((x) => x === null) ? null : Math.round(xs.reduce<number>((a, b) => a + (b ?? 0), 0) * 10000) / 10000;
}

async function relay(s: Scenario, base: string, dir: string) {
  const t0 = Date.now();
  if (AGENT === "sim") process.env.RELAY_SIM_EDITS = JSON.stringify(Object.fromEntries(s.tasks.map((t) => [t.id, t.sim])));
  const root = clone(base, "relay");
  const { server, repo } = await testServer(undefined, { root, ...(AGENT === "codex" ? { provider: codex() } : { claudeBin: AGENT === "sim" ? SIM : "claude" }) });
  const before = diskState(repo);
  const head = git(repo, "rev-parse", "HEAD").trim();
  try {
    const owner = server.members.invite("Eval owner", "owner").member;
    const r = server.relay;
    for (const c of s.contracts ?? []) (r.proposeContract(c.id, c.definition, HUMAN), r.acceptContract(c.id, 1, HUMAN));
    const contracts = Object.fromEntries((s.contracts ?? []).map((c) => [c.id, 1]));
    for (const t of s.tasks) (r.createTask({ id: t.id, objective: request(t), scope: t.scope, contracts, verify: [t.check], baseCommit: head }, HUMAN), r.transition(t.id, "queued", HUMAN));
    await server.runs.start(s.tasks.map((t) => t.id), owner);
    const done = () => s.tasks.every((t) => { const x = server.runs.forTask(t.id).at(-1); return !!x && ["finished", "failed", "cancelled"].includes(x.status) && !x.checking; });
    await until(done, AGENT_TIMEOUT_MS + 120_000, "Relay agent runs");
    const tasks = s.tasks.map((t) => {
      const run = server.runs.forTask(t.id).at(-1)!;
      const { files, patch } = patchOf(run.worktree, run.snapshot);
      writeFileSync(join(dir, `relay-${t.id}.patch`), patch);
      writeFileSync(join(dir, `relay-${t.id}-activity.json`), JSON.stringify(run.activity, null, 2));
      const sys = r.evidence(t.id).filter((e) => e.kind === "command" && e.source === "system").at(-1);
      return {
        id: t.id,
        agent: { ok: run.status === "finished", exit: run.exitCode, seconds: run.endedAt ? Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000) : null, costUsd: run.costUsd, tokens: run.tokens ?? null, model: AGENT === "sim" ? "simulated" : (run.model ?? null), error: run.status === "finished" ? null : (run.activity.filter((a) => a.kind === "error").at(-1)?.detail ?? run.status) },
        changedFiles: files,
        outOfScope: files.filter((f) => !t.scope.includes(f)),
        relayState: r.requireTask(t.id).state,
        ownCheck: sys ? sys.exitCode === 0 : null,
        guardDenials: run.activity.filter((a) => a.kind === "denied").length,
        patch,
      };
    });
    const gt = groundTruth(base, s, tasks.map((t) => t.patch), dir);
    writeFileSync(join(dir, "relay-oracle.txt"), gt.oracle);
    const agentFailed = tasks.some((t) => !t.agent.ok);
    let integ: Integration | null = null;
    let rehearsal: "passed" | "blocked" | "refused" | "error" | "not-run" = "not-run";
    let error: string | null = null;
    if (!agentFailed) {
      try {
        integ = await server.runs.checkTogether(s.tasks.map((t) => t.id), [PROJECT_SUITE]);
        rehearsal = integ.status === "passed" ? "passed" : "blocked";
      } catch (e) {
        error = (e as Error).message;
        rehearsal = (e as { code?: string }).code === "conflict" ? "refused" : "error";
      }
    }
    if (integ) writeFileSync(join(dir, "relay-integration.json"), JSON.stringify(integ, null, 2));
    const decision = agentFailed || rehearsal === "error" ? "not-compared" : rehearsal === "refused" ? "refused" : rehearsal === "blocked" ? "stop" : integ?.assurance?.level === "verified" ? "integrate" : "inconclusive";
    // A rejected integration must leave the project as it was.
    const unchangedAfterReject = rehearsal === "blocked" || rehearsal === "refused" ? diskState(repo) === before : null;
    // Evidence must go stale when the project moves: edit the project, then approval must be refused.
    let staleRefused: boolean | null = null;
    let appliedMatchesTruth: boolean | null = null;
    if (integ && integ.status === "passed") {
      writeFileSync(join(repo, "README.md"), readFileSync(join(repo, "README.md"), "utf8") + "\nEdited during review.\n");
      try {
        server.runs.approveTogether(integ.id, owner);
        staleRefused = false;
      } catch (e) {
        staleRefused = /changed since this check/.test((e as Error).message);
      }
      // Integrate what is verified (as an owner would), then check the project itself with the oracle.
      if (decision === "integrate" && staleRefused) {
        const again = await server.runs.checkTogether(s.tasks.map((t) => t.id), [PROJECT_SUITE]);
        if (again.status === "passed") {
          server.runs.approveTogether(again.id, owner);
          server.docs.flushAll();
          const copy = mkdtempSync(join(tmpdir(), "relay-eval-applied-"));
          cpSync(repo, copy, { recursive: true, filter: (p) => !p.includes("/.git") && !p.includes("/.relay") });
          for (const [p, text] of Object.entries(s.oracle)) (mkdirSync(dirname(join(copy, p)), { recursive: true }), writeFileSync(join(copy, p), text));
          const o = sh(copy, `node --test ${Object.keys(s.oracle).join(" ")}`);
          appliedMatchesTruth = (o.ok ? "works" : "broken") === gt.truth;
          rmSync(copy, { recursive: true, force: true });
        }
      }
    }
    return {
      tasks: tasks.map(({ patch: _p, ...t }) => t),
      rehearsal,
      assurance: integ?.assurance ?? null,
      explanation: integ?.explanation ? { verdict: integ.explanation.verdict, summary: integ.explanation.summary, failingCited: integ.explanation.failures.flatMap((f) => f.tests.map((x) => x.name)) } : null,
      explanationCitesRealFailures: integ?.explanation && integ.status === "blocked" ? citesReal(integ) : null,
      error,
      decision,
      truth: gt.truth,
      outcome: judge(decision as never, gt.truth),
      brokenIntoProject: decision === "integrate" && gt.truth === "broken",
      unchangedAfterReject,
      staleRefused,
      appliedMatchesTruth,
      seconds: Math.round((Date.now() - t0) / 1000),
      costUsd: sumCost(tasks.map((t) => t.agent.costUsd)),
    };
  } finally {
    await server.close();
    rmSync(dirname(root), { recursive: true, force: true });
  }
}

/** Do the failing tests the explanation cites actually fail in the combined check's own output? */
function citesReal(integ: Integration): boolean {
  const cited = integ.explanation!.failures.flatMap((f) => f.tests.map((t) => t.name));
  if (!cited.length) return false;
  const failing = new Set(integ.results.flatMap((r) => parseFailures(r.command, r.output, "/").tests.map((t) => t.name)));
  return cited.every((c) => failing.has(c));
}

const agentVersion = AGENT === "sim" ? "simulated agent (test/fixtures/simulated-agent.ts)" : AGENT === "claude-code" ? execFileSync("claude", ["--version"], { encoding: "utf8" }).trim() : execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
const relayCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: import.meta.dirname, encoding: "utf8" }).trim();
// Results must name the exact code that produced them: uncommitted changes are flagged, and real runs refuse them.
const relayDirty = execFileSync("git", ["status", "--porcelain", "--", "src", "eval", "test/fixtures"], { cwd: join(import.meta.dirname, ".."), encoding: "utf8" }).trim() !== "";
if (relayDirty && AGENT !== "sim") {
  console.error("Real-agent runs must use committed code (src/, eval/ and test/fixtures/ have uncommitted changes). Commit first, so the results name the code that produced them.");
  process.exit(2);
}
const scenarios = SCENARIOS.filter((s) => !ONLY || ONLY.includes(s.id));
mkdirSync(OUT, { recursive: true });
const trials: unknown[] = [];
const save = () =>
  writeFileSync(
    join(OUT, "results.json"),
    JSON.stringify(
      {
        format: RESULTS_FORMAT,
        agent: { kind: AGENT, real: AGENT !== "sim", version: agentVersion, baselineConfig: AGENT === "claude-code" ? "claude -p --output-format json --permission-mode acceptEdits --allowedTools Read,Edit,Write,Bash,Glob,Grep" : AGENT === "codex" ? "codex exec --full-auto" : "scripted edits", relayConfig: AGENT === "sim" ? "simulated agent via Relay's runner" : "Relay's runner (src/providers), same tools plus Relay's hook and MCP" },
        relayCommit,
        relayDirty,
        node: process.version,
        base: { version: BASE_VERSION },
        projectSuite: PROJECT_SUITE,
        scenarios: scenarios.map((s) => ({ id: s.id, version: s.version, designed: s.designed, title: s.title })),
        startedAt,
        trials,
      },
      null,
      2,
    ),
  );
const startedAt = new Date().toISOString();
const jobs = scenarios.flatMap((s) => Array.from({ length: TRIALS }, (_, i) => ({ s, n: i + 1 })));
const runJob = async ({ s, n }: { s: Scenario; n: number }) => {
  const dir = join(OUT, s.id, `trial-${n}`);
  mkdirSync(dir, { recursive: true });
  const base = makeRepo({ ...BASE, ...(s.overlay ?? {}) });
  const record: Record<string, unknown> = { scenario: s.id, version: s.version, designed: s.designed, trial: n, startedAt: new Date().toISOString(), baseCommit: git(base, "rev-parse", "HEAD").trim(), baseTree: git(base, "rev-parse", "HEAD^{tree}").trim() };
  console.error(`${s.id} trial ${n}: running`);
  const safe = async <T>(f: () => Promise<T>) => {
    try {
      return await f();
    } catch (e) {
      return { error: String((e as Error).message ?? e).slice(0, 1000), outcome: "not-compared" } as unknown as T;
    }
  };
  // Simulated runs share one process-wide script variable, so their two workflows run one after the other.
  if (AGENT === "sim") {
    record.baseline = await safe(() => baseline(s, base, dir));
    record.relay = await safe(() => relay(s, base, dir));
  } else [record.baseline, record.relay] = await Promise.all([safe(() => baseline(s, base, dir)), safe(() => relay(s, base, dir))]);
  writeFileSync(join(dir, "trial.json"), JSON.stringify(record, null, 2));
  trials.push(record);
  save();
  const b = record.baseline as { outcome: string };
  const r = record.relay as { outcome: string; rehearsal?: string };
  console.error(`${s.id} trial ${n}: baseline ${b.outcome} | relay ${r.outcome} (${r.rehearsal ?? "-"})`);
  rmSync(base, { recursive: true, force: true });
};
const queue = [...jobs];
await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
  while (queue.length) await runJob(queue.shift()!);
}));
save();
console.log(`wrote ${join(OUT, "results.json")}`);
