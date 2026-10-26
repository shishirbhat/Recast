/**
 * The Relay claim, as a reproducible experiment:
 *   two independently produced changes each pass their own checks, but break the project when combined.
 *
 * Same scenario, two workflows, on a fresh repository every run:
 *   A. Without Relay: each task is verified alone, then both diffs are merged into the shared project.
 *   B. With Relay: the same two runs go through Relay's integration rehearsal before anything is applied.
 *
 * Agents are the SIMULATED agent (test/fixtures/simulated-agent): deterministic edits, so anyone can rerun this and
 * get the same result. Everything else is real: git worktrees, real test commands, Relay's engine and server.
 *
 *   node scripts/prove-integration.ts [report.md]
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testServer, until } from "../test/collab-helpers.ts";
import { HUMAN } from "../test/helpers.ts";

const SIM = resolve(import.meta.dirname, "../test/fixtures/simulated-agent");
const FILES = {
  "package.json": JSON.stringify({ name: "shop", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
  "src/server.js": "export function getUser(id) {\n  return { id, name: 'Ada' };\n}\n",
  "src/ui.js": "import { getUser } from './server.js';\n\nexport function greet(id) {\n  return 'Hello ' + getUser(id).name;\n}\n\nexport const footer = 'bye';\n",
  // The project's own test, already in the repository before either task starts.
  "src/ui.test.js": "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from './ui.js';\ntest('greets the user by name', () => assert.equal(greet(1), 'Hello Ada'));\n",
};
// Task A (API): renames the field. Task B (UI): an unrelated UI edit, written against the old field.
process.env.RELAY_SIM_EDITS = JSON.stringify({
  "T-api": { "src/server.js": [["name: 'Ada'", "fullName: 'Ada'"]] },
  "T-ui": { "src/ui.js": [["export const footer = 'bye';", "export const footer = 'see you soon';"]] },
});
const OWN_CHECK: Record<string, string> = { "T-api": "node --check src/server.js", "T-ui": "node --test" };
const PROJECT_TESTS = "node --test";

const sh = (cwd: string, cmd: string) => {
  const t0 = Date.now();
  try {
    const out = execFileSync("sh", ["-c", cmd], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("NODE_TEST"))) });
    return { ok: true, ms: Date.now() - t0, out };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, ms: Date.now() - t0, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const failLine = (out: string) => out.split("\n").find((l) => /AssertionError|actual|expected|not ok/.test(l))?.trim() ?? "(see output)";

const { server, repo } = await testServer(FILES, { claudeBin: SIM });
const lines: string[] = [];
try {
  const owner = server.members.invite("Olu", "owner").member;
  const r = server.relay;
  r.proposeContract("user-api", "getUser(id) -> { id, fullName }", HUMAN);
  r.acceptContract("user-api", 1, HUMAN);
  r.createTask({ id: "T-api", objective: "API returns fullName", scope: ["src/server.js"], contracts: { "user-api": 1 }, verify: [OWN_CHECK["T-api"]!] }, HUMAN);
  r.createTask({ id: "T-ui", objective: "Friendlier footer", scope: ["src/ui.js"], contracts: { "user-api": 1 }, verify: [OWN_CHECK["T-ui"]!] }, HUMAN);
  for (const t of ["T-api", "T-ui"]) r.transition(t, "queued", HUMAN);
  await server.runs.start(["T-api", "T-ui"], owner);
  await until(() => ["T-api", "T-ui"].every((t) => ["finished", "failed"].includes(server.runs.forTask(t).at(-1)?.status ?? "")), 30_000, "both runs");
  const runs = Object.fromEntries(["T-api", "T-ui"].map((t) => [t, server.runs.forTask(t).at(-1)!]));

  // ---- A. Without Relay: verify each change alone, then merge both into the shared project.
  const own = Object.fromEntries(Object.entries(runs).map(([t, run]) => [t, sh(run.worktree, OWN_CHECK[t]!)]));
  const naive = join(mkdtempSync(join(tmpdir(), "relay-naive-")), "repo");
  git(tmpdir(), "clone", "-q", repo, naive);
  for (const run of Object.values(runs)) {
    const patch = git(run.worktree, "diff", run.snapshot);
    writeFileSync(join(naive, "change.patch"), patch);
    git(naive, "apply", "change.patch");
  }
  const merged = sh(naive, PROJECT_TESTS);

  // ---- B. With Relay: rehearse the combined change before anything reaches the project.
  const t0 = Date.now();
  const integ = server.runs.checkTogether(["T-api", "T-ui"], [PROJECT_TESTS]);
  const rehearsalMs = Date.now() - t0;
  const shared = readFileSync(join(repo, "src/server.js"), "utf8");
  const untouched = shared.includes("name: 'Ada'");

  const row = (a: string, b: string, c: string) => `| ${a} | ${b} | ${c} |`;
  lines.push(
    "# Integration proof: individually green, combined red",
    "",
    `Generated ${new Date().toISOString()} by \`node scripts/prove-integration.ts\`. Agents are simulated (deterministic edits); git, tests and Relay are real.`,
    "",
    "**Scenario.** `T-api` renames `name` to `fullName` in `src/server.js` (the accepted `user-api` contract). `T-ui` makes an unrelated change to `src/ui.js`, whose `greet()` still reads `.name`. Different files: Git sees no conflict.",
    "",
    "## A. Without Relay",
    "",
    row("Step", "Result", "Evidence"),
    row("---", "---", "---"),
    row("T-api's own check", own["T-api"]!.ok ? "pass" : "FAIL", `\`${OWN_CHECK["T-api"]}\` in its worktree`),
    row("T-ui's own check", own["T-ui"]!.ok ? "pass" : "FAIL", `\`${OWN_CHECK["T-ui"]}\` in its worktree`),
    row("Merge both diffs", "clean", "`git apply` of both patches, no conflict"),
    row("Project tests after merge", merged.ok ? "pass" : "**FAIL**", merged.ok ? "" : `\`${failLine(merged.out)}\``),
    "",
    merged.ok ? "The combined project passed (unexpected: the scenario did not reproduce)." : "Both tasks were green, the merge was clean, and the shared project is now broken. The failure is found only after integration.",
    "",
    "## B. With Relay",
    "",
    row("Step", "Result", "Evidence"),
    row("---", "---", "---"),
    row("Integration rehearsal", integ.status === "blocked" ? "**blocked**" : integ.status, `combined worktree at tree \`${integ.tree.slice(0, 10)}\`, ${rehearsalMs} ms`),
    ...integ.results.map((x) => row(`\`${x.command}\` on the combined change`, x.exitCode === 0 ? "pass" : "FAIL", x.exitCode === 0 ? "" : `\`${failLine(x.output)}\``)),
    ...integ.gaps.map((g) => row("Gap reported", "—", g.replace(/\|/g, "/"))),
    row("Shared project", untouched ? "unchanged" : "CHANGED", "nothing applied until the combined check passes and a person approves"),
    "",
    "## Measured",
    "",
    row("", "Without Relay", "With Relay"),
    row("---", "---", "---"),
    row("Broken changes that reached the shared project", merged.ok ? "0" : "1", untouched ? "0" : "1"),
    row("When the break is found", "after merge", "before apply"),
    row("Cause shown", "a failing test, after the fact", "the failing combined test plus the tasks and contract involved"),
  );
  const out = process.argv[2] ?? resolve(import.meta.dirname, "../docs/evidence/integration-proof.md");
  writeFileSync(out, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log(`\nwrote ${out}`);
  if (merged.ok || integ.status !== "blocked" || !untouched) process.exitCode = 1;
} finally {
  await server.close();
}
