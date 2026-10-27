/**
 * Shared fixture for Check Together tests (API and CLI): two agent tasks, run by the SIMULATED agent, whose changes
 * each pass their own check. BREAKING: T-api renames a field T-ui's code still reads. COMPATIBLE: T-ui follows it.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { HUMAN } from "./helpers.ts";
import { testServer, until } from "./collab-helpers.ts";
import type { ServerOptions } from "../src/server/server.ts";

export const SIM = resolve(import.meta.dirname, "fixtures/simulated-agent");
const T = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n";
export const FILES = {
  "package.json": '{ "type": "module" }\n',
  "src/server.js": "export function getUser(id) {\n  return { id, name: 'Ada' };\n}\n",
  "src/server.test.js": `${T}import { getUser } from './server.js';\ntest('returns the user', () => assert.equal(getUser(1).id, 1));\n`,
  "src/ui.js": "import { getUser } from './server.js';\n\nexport function greet(id) {\n  return 'Hello ' + getUser(id).name;\n}\n\nexport const footer = 'bye';\n",
  "src/ui.test.js": `${T}import { greet } from './ui.js';\ntest('greets the user by name', () => assert.equal(greet(1), 'Hello Ada'));\n`,
};
type Edits = Record<string, Record<string, [string, string][]>>;
export const BREAKING: Edits = {
  "T-api": { "src/server.js": [["name: 'Ada'", "fullName: 'Ada'"]] },
  "T-ui": { "src/ui.js": [["'bye'", "'see you soon'"]] },
};
export const COMPATIBLE: Edits = {
  "T-api": { "src/server.js": [["name: 'Ada'", "fullName: 'Ada'"]] },
  "T-ui": { "src/ui.js": [["getUser(id).name", "getUser(id).fullName"]] },
};

/** Two agent tasks on one contract, run by the simulated agent until Relay has finished checking each. */
export async function twoAgentTasks(edits: Edits, verifyCmd = "node --test src/ui.test.js", opts: Partial<ServerOptions> = {}) {
  process.env.RELAY_SIM_EDITS = JSON.stringify(edits);
  const t = await testServer(FILES, { claudeBin: SIM, ...opts });
  const r = t.server.relay;
  r.proposeContract("user-api", "getUser(id) -> { id, fullName }", HUMAN);
  r.acceptContract("user-api", 1, HUMAN);
  r.createTask({ id: "T-api", objective: "API returns fullName", scope: ["src/server.js"], contracts: { "user-api": 1 }, verify: ["node --test src/server.test.js"] }, HUMAN);
  r.createTask({ id: "T-ui", objective: "Friendlier footer", scope: ["src/ui.js"], contracts: { "user-api": 1 }, verify: [verifyCmd] }, HUMAN);
  for (const id of ["T-api", "T-ui"]) r.transition(id, "queued", HUMAN);
  const owner = t.server.members.invite("Olu", "owner").member;
  await t.server.runs.start(["T-api", "T-ui"], owner);
  await until(() => ["T-api", "T-ui"].every((id) => { const run = t.server.runs.forTask(id).at(-1); return !!run && run.status === "finished" && !run.checking; }), 20_000, "both runs");
  return { ...t, owner };
}

/** Hash of every file in the shared project (not .git or Relay's own state): "unchanged" means byte for byte. */
export function projectState(repo: string): string {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8" }).split("\n").filter((f) => f && !f.startsWith(".relay/")).sort();
  const h = createHash("sha256");
  for (const f of files) h.update(`${f}\0${readFileSync(join(repo, f))}\0`);
  return h.digest("hex");
}
