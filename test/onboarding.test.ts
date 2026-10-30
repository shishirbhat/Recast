/**
 * Project onboarding: discovery from the repository as cited proposals; trying a command on a copy of the current
 * files; owners accepting or dismissing. The repository, commands and server are real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, join as joinAs, testServer } from "./collab-helpers.ts";

const FILES = {
  "package.json": JSON.stringify({ name: "shop", type: "module", scripts: { test: "node --test", lint: "test ! -f .env && node --check src/a.js", check: "exit 3" }, engines: { node: ">=22" } }, null, 2) + "\n",
  "package-lock.json": "{}\n",
  ".nvmrc": `${process.versions.node.split(".")[0]}\n`,
  ".github/workflows/ci.yml": "name: ci\non: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm ci\n      - run: npm test\n",
  ".env": "TOKEN=secret\n",
  "src/a.js": "export const a = 1;\n",
  "src/a.test.js": "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { a } from './a.js';\ntest('a', () => assert.equal(a, 1));\n",
};

type P = { id: string; kind: string; title: string; value: string; evidence: { file: string; line: number | null }[]; status: string; trial: { exitCode: number | null } | null };

test("discovery cites where each proposal comes from; commands are tried on a copy without secrets; owners decide", async () => {
  const t = await testServer(FILES);
  try {
    const own = await joinAs(t.server, "Ola", "owner");
    const ed = await joinAs(t.server, "Ed", "editor");
    const get = async () => (await api(t.server, ed.cookie, "GET", "/api/onboarding")).body as { proposals: P[]; defaultVerify: string[] };
    const { proposals, defaultVerify } = await get();
    const by = (value: string) => proposals.find((p) => p.value === value)!;
    assert.deepEqual(defaultVerify, [], "nothing is applied by discovery");
    const npmTest = by("npm test");
    assert.equal(npmTest.kind, "verify-command");
    assert.deepEqual(npmTest.evidence.map((e) => [e.file, e.line]), [["package.json", 5], [".github/workflows/ci.yml", 8]], "found in package.json and in CI");
    assert.ok(by("npm run lint"));
    assert.deepEqual(by("npm ci").evidence.map((e) => e.file).sort(), [".github/workflows/ci.yml", "package-lock.json"]);
    assert.match(proposals.find((p) => p.kind === "runtime")!.title, /matches/);
    assert.ok(proposals.some((p) => p.kind === "scope-area" && p.value === "src/"));
    const secret = proposals.find((p) => p.kind === "note" && p.value === ".env")!;
    assert.match(secret.title, /1 file that may hold secrets is never shared/);

    // Trying: on a copy of the current files, without the secret file; a failing command is recorded as failing.
    const tried = (await api(t.server, ed.cookie, "POST", `/api/onboarding/${encodeURIComponent(by("npm run lint").id)}/try`)).body as P;
    assert.equal(tried.trial!.exitCode, 0, "the copy has no .env");
    assert.equal(((await api(t.server, ed.cookie, "POST", `/api/onboarding/${encodeURIComponent(by("npm run check").id)}/try`)).body as P).trial!.exitCode, 3);
    assert.equal(((await api(t.server, ed.cookie, "POST", `/api/onboarding/${encodeURIComponent(npmTest.id)}/try`)).body as P).trial!.exitCode, 0);

    // Deciding is for owners; information can't be "accepted".
    assert.equal((await api(t.server, ed.cookie, "POST", `/api/onboarding/${encodeURIComponent(npmTest.id)}/decide`, { status: "accepted" })).status, 403);
    assert.equal((await api(t.server, own.cookie, "POST", `/api/onboarding/${encodeURIComponent(secret.id)}/decide`, { status: "accepted" })).status, 400);
    await api(t.server, own.cookie, "POST", `/api/onboarding/${encodeURIComponent(npmTest.id)}/decide`, { status: "accepted" });
    await api(t.server, own.cookie, "POST", `/api/onboarding/${encodeURIComponent(by("npm run check").id)}/decide`, { status: "dismissed" });
    const after = await get();
    assert.deepEqual(after.defaultVerify, ["npm test"]);
    assert.equal(after.proposals.find((p) => p.value === "npm run check")!.status, "dismissed");
    assert.equal(after.proposals.find((p) => p.value === "npm test")!.trial!.exitCode, 0, "the trial is kept with the decision");
  } finally {
    await t.server.close();
  }
});
