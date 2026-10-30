/**
 * Relay Arena: the same pairs of independently made changes, integrated without Relay and with it, scored.
 *
 * Each scenario is two agent tasks on one repository. Agents are SIMULATED (deterministic, scripted edits) so anyone
 * can rerun the arena and get the same scoreboard; git, the project's tests and Relay are real. The ground truth for
 * every scenario is measured, not declared: the project's tests are run on the combined change.
 *
 *   Without Relay: each change passes its own check, both diffs are applied (git decides about conflicts), and the
 *                  combined result goes in. Wrong when a broken combination reaches the project.
 *   With Relay:    the tasks are checked together (the integration rehearsal) and nothing goes in unless that passes;
 *                  a passing combination is approved and applied. Wrong when a broken combination gets in, or when a
 *                  working combination is blocked (a false alarm costs people time too).
 *
 *   node scripts/arena.ts [--json]
 *
 * Real agents: `relay arena --real` runs scripts/prove-integration-real.ts, which costs model usage.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { testServer, until } from "../test/collab-helpers.ts";
import { HUMAN } from "../test/helpers.ts";

const SIM = resolve(import.meta.dirname, "../test/fixtures/simulated-agent");
const T = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n";
const FILES = {
  "package.json": '{ "type": "module", "scripts": { "test": "node --test" } }\n',
  "src/server.js": "export function getUser(id) {\n  return { id, name: 'Ada' };\n}\n",
  "src/server.test.js": `${T}import { getUser } from './server.js';\ntest('returns the user', () => assert.equal(getUser(1).id, 1));\n`,
  "src/ui.js": "import { getUser } from './server.js';\n\nexport function greet(id) {\n  return 'Hello ' + getUser(id).name;\n}\n\nexport const footer = 'bye';\n",
  "src/ui.test.js": `${T}import { greet } from './ui.js';\ntest('greets the user by name', () => assert.equal(greet(1), 'Hello Ada'));\n`,
};
type Edits = Record<string, Record<string, [string, string][]>>;
interface Scenario {
  id: string;
  what: string;
  edits: Edits;
}
const SCENARIOS: Scenario[] = [
  { id: "interface-break", what: "T-api renames a field; T-ui edits another line of a file that still reads the old field", edits: { "T-api": { "src/server.js": [["name: 'Ada'", "fullName: 'Ada'"]] }, "T-ui": { "src/ui.js": [["'bye'", "'see you soon'"]] } } },
  { id: "compatible", what: "T-api renames a field; T-ui updates its read to the new field", edits: { "T-api": { "src/server.js": [["name: 'Ada'", "fullName: 'Ada'"]] }, "T-ui": { "src/ui.js": [["getUser(id).name", "getUser(id).fullName"]] } } },
  { id: "same-line", what: "Both change the same line of src/ui.js differently", edits: { "T-api": { "src/server.js": [["id, name", "id, name, admin: false, name: name"]], "src/ui.js": [["'bye'", "'ciao'"]] }, "T-ui": { "src/ui.js": [["'bye'", "'see you soon'"]] } } },
  { id: "unrelated", what: "Changes that don't touch each other", edits: { "T-api": { "src/server.js": [["return { id", "// returns a plain object\n  return { id"]] }, "T-ui": { "src/ui.js": [["'bye'", "'see you soon'"]] } } },
];
const PROJECT_TESTS = "node --test";
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("NODE_TEST")));
const ok = (cwd: string, cmd: string) => {
  try {
    execFileSync("sh", ["-c", cmd], { cwd, stdio: "ignore", env });
    return true;
  } catch {
    return false;
  }
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });

interface Row {
  scenario: string;
  what: string;
  /** Measured: do the project's tests pass on both changes combined (null: the changes can't be combined as text). */
  combinedWorks: boolean | null;
  without: { outcome: "merged" | "merge-conflict"; brokenInProject: boolean };
  withRelay: { outcome: "blocked" | "approved" | "refused"; brokenInProject: boolean; falseAlarm: boolean; why: string };
}

async function run(s: Scenario): Promise<Row> {
  process.env.RELAY_SIM_EDITS = JSON.stringify(s.edits);
  const t = await testServer(FILES, { claudeBin: SIM });
  try {
    const r = t.server.relay;
    r.proposeContract("user-api", "getUser(id) -> user", HUMAN);
    r.acceptContract("user-api", 1, HUMAN);
    r.createTask({ id: "T-api", objective: "api", scope: ["src/server.js"], contracts: { "user-api": 1 }, verify: ["node --test src/server.test.js"] }, HUMAN);
    r.createTask({ id: "T-ui", objective: "ui", scope: ["src/ui.js"], contracts: { "user-api": 1 }, verify: ["node --check src/ui.js"] }, HUMAN);
    for (const id of ["T-api", "T-ui"]) r.transition(id, "queued", HUMAN);
    const owner = t.server.members.invite("Arena", "owner").member;
    await t.server.runs.start(["T-api", "T-ui"], owner);
    await until(() => ["T-api", "T-ui"].every((id) => { const x = t.server.runs.forTask(id).at(-1); return !!x && ["finished", "failed"].includes(x.status) && !x.checking; }), 30_000, "runs");
    const runs = ["T-api", "T-ui"].map((id) => t.server.runs.forTask(id).at(-1)!);

    // Without Relay: both diffs applied to a clone, as a person merging two green branches would.
    const naive = join(mkdtempSync(join(tmpdir(), "relay-arena-")), "repo");
    git(tmpdir(), "clone", "-q", t.repo, naive);
    let conflict = false;
    for (const x of runs) {
      writeFileSync(join(naive, "change.patch"), git(x.worktree, "diff", x.snapshot));
      try {
        git(naive, "apply", "change.patch");
      } catch {
        conflict = true;
      }
    }
    const combinedWorks = conflict ? null : ok(naive, PROJECT_TESTS);

    // With Relay: check together; approve and apply only if it passed.
    let outcome: Row["withRelay"]["outcome"];
    let why: string;
    try {
      const integ = await t.server.runs.checkTogether(["T-api", "T-ui"], [PROJECT_TESTS]);
      if (integ.status === "passed") {
        t.server.runs.approveTogether(integ.id, owner);
        outcome = "approved";
        why = "the combined change passed every check";
      } else {
        outcome = "blocked";
        why = integ.explanation?.summary ?? integ.gaps[0] ?? "blocked";
      }
    } catch (e) {
      outcome = "refused";
      why = (e as Error).message;
    }
    t.server.docs.flushAll();
    const projectBroken = !ok(t.repo, PROJECT_TESTS) || readFileSync(join(t.repo, "src/ui.js"), "utf8").includes("<<<<<<<");
    return {
      scenario: s.id,
      what: s.what,
      combinedWorks,
      without: { outcome: conflict ? "merge-conflict" : "merged", brokenInProject: !conflict && combinedWorks === false },
      withRelay: { outcome, brokenInProject: projectBroken, falseAlarm: outcome !== "approved" && combinedWorks === true, why },
    };
  } finally {
    await t.server.close();
  }
}

const rows: Row[] = [];
for (const s of SCENARIOS) rows.push(await run(s));
const score = {
  without: { brokenInProject: rows.filter((r) => r.without.brokenInProject).length },
  withRelay: { brokenInProject: rows.filter((r) => r.withRelay.brokenInProject).length, falseAlarms: rows.filter((r) => r.withRelay.falseAlarm).length },
};
if (process.argv.includes("--json")) console.log(JSON.stringify({ scenarios: rows, score, agents: "simulated" }, null, 2));
else {
  const yes = (b: boolean) => (b ? "YES" : "no");
  console.log("Relay Arena (simulated agents; git, tests and Relay are real)\n");
  for (const r of rows) {
    console.log(`${r.scenario}: ${r.what}`);
    console.log(`  combined change works (measured): ${r.combinedWorks === null ? "can't be combined as text" : r.combinedWorks ? "yes" : "NO"}`);
    console.log(`  without Relay: ${r.without.outcome}; broken change in the project: ${yes(r.without.brokenInProject)}`);
    console.log(`  with Relay:    ${r.withRelay.outcome}; broken change in the project: ${yes(r.withRelay.brokenInProject)}; false alarm: ${yes(r.withRelay.falseAlarm)}`);
    console.log(`                 ${r.withRelay.why.split("\n")[0]!.slice(0, 160)}\n`);
  }
  console.log(`Score: broken changes that reached the project: without Relay ${score.without.brokenInProject}, with Relay ${score.withRelay.brokenInProject}. False alarms with Relay: ${score.withRelay.falseAlarms}.`);
}
if (score.withRelay.brokenInProject || score.withRelay.falseAlarms) process.exitCode = 1;
