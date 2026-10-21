import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeRepo } from "./helpers.ts";
import { workspaceSymbols } from "../src/server/files.ts";

test("workspace symbols: declarations across languages, exact matches first, secrets and junk queries excluded", () => {
  const root = makeRepo({
    "src/user.ts": "export interface User { id: string }\nexport async function getUser(id: string) {}\nconst userCache = new Map();\n// function notAUser() {}\n",
    "tools/report.py": "def user_report(rows):\n    pass\nclass UserTable:\n    pass\n",
    "docs/guide.md": "# Users\n\n## Adding a user\n",
  });
  writeFileSync(join(root, ".env"), "export const userSecret = 1\n");
  const names = (q: string) => workspaceSymbols(root, q).symbols.map((s) => `${s.kind}:${s.name}@${s.path}:${s.line}`);
  const user = names("user");
  assert.equal(user[0], "interface:User@src/user.ts:1", "exact match first");
  for (const want of ["function:getUser@src/user.ts:2", "const:userCache@src/user.ts:3", "def:user_report@tools/report.py:1", "class:UserTable@tools/report.py:3", "heading:Users@docs/guide.md:1", "heading:Adding a user@docs/guide.md:3"]) assert.ok(user.includes(want), `${want} in ${user.join(", ")}`);
  assert.ok(!user.some((s) => s.includes("notAUser")), "commented-out code isn't a declaration");
  assert.ok(!user.some((s) => s.includes(".env")), "secret files are never searched");
  assert.deepEqual(workspaceSymbols(root, "a|b").symbols, [], "only identifier characters are accepted");
  assert.deepEqual(workspaceSymbols(root, "").symbols, []);
});
