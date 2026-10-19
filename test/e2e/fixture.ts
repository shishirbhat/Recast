import type { RelayServer } from "../../src/server/server.ts";
import { HUMAN } from "../helpers.ts";

/** A small two-sided app: a server returning users and a UI that greets them. */
export const SHOP_FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "corner-shop", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
  "src/server.js": [
    "// Users come from the account service. Shape is fixed by the user-api contract.",
    "export function getUser(id) {",
    "  return { id, name: 'Ada Lovelace', plan: 'pro' };",
    "}",
    "",
  ].join("\n"),
  "src/ui.js": [
    "import { getUser } from './server.js';",
    "",
    "/* Greets the signed-in user on the home screen. */",
    "export function greet(id) {",
    "  const user = getUser(id);",
    "  return `Welcome back, ${user.name}`;",
    "}",
    "",
    "export function badge(user) {",
    "  // Pro users get a small violet badge next to their name.",
    "  return user.plan === 'pro' ? '◆ Pro' : '';",
    "}",
    "",
  ].join("\n"),
  "src/ui.test.js": "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { greet } from './ui.js';\ntest('greets', () => assert.match(greet(1), /Welcome back, Ada/));\n",
  "README.md": "# Corner Shop\n\nA tiny shop used to demo Relay.\n",
};

/** Contracts and tasks so the coordination panel has something real in it. */
export function seed(server: RelayServer): void {
  const r = server.relay;
  r.proposeContract("user-api", "getUser(id) -> { id, name, plan }", HUMAN);
  r.acceptContract("user-api", 1, HUMAN);
  r.createTask({ id: "T-api", objective: "Return the user's full name from the account service", scope: ["src/server.js"], contracts: { "user-api": 1 } }, HUMAN);
  r.createTask({ id: "T-ui", objective: "Greeting shows the full name", scope: ["src/ui.js"], contracts: { "user-api": 1 }, verify: ["node --test"] }, HUMAN);
  r.createTask({ id: "T-docs", objective: "Document the new user shape in the README", scope: ["README.md"] }, HUMAN);
  for (const t of ["T-api", "T-ui"]) r.transition(t, "queued", HUMAN);
  r.transition("T-api", "running", { kind: "agent", id: "claude-code" });
  r.proposeContract("user-api", "getUser(id) -> { id, fullName, plan }  (`name` removed)", { kind: "agent", id: "claude-code" }, "One field for display names");
  r.acceptContract("user-api", 2, HUMAN);
}
