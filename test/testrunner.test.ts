/**
 * The integrated test runner runs the project's real tests: per-test results with source lines from Node's TAP output,
 * failures with their messages, rerun of only the failed tests, stopping a hung run, stale detection after edits,
 * owner-only execution, and an honest fallback for other runners (exit code only).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { join as joinAs, testServer } from "./collab-helpers.ts";

const FILES = {
  "package.json": '{ "type": "module", "scripts": { "test": "node --test" } }\n',
  "src/math.js": "export const add = (a, b) => a + b;\n",
  "src/math.test.js": [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { add } from "./math.js";',
    'test("adds", () => assert.equal(add(1, 2), 3));',
    'test("adds negatives", () => assert.equal(add(-1, -2), -4));',
    "",
  ].join("\n"),
};

test("runner: real per-test results with locations, rerun failed, stale after edits, owner-only", async () => {
  const { server, repo } = await testServer(FILES);
  try {
    const owner = (await joinAs(server, "Olu", "owner")).cookie;
    const editor = (await joinAs(server, "Ed", "editor")).cookie;
    const call = (cookie: string) => async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${server.url}/api${path}`, { method, headers: { cookie, "x-relay": "1", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, data: (await res.json()) as any };
    };
    const O = call(owner);
    const E = call(editor);
    const info = (await E("GET", "/tests")).data;
    assert.deepEqual([info.discover.runner, info.discover.perTest, info.discover.testFiles], ["node-test", true, ["src/math.test.js"]]);
    assert.equal((await E("POST", "/tests/run", {})).status, 403, "running project code is owner-only");

    const started = await O("POST", "/tests/run", {});
    assert.equal(started.status, 202);
    let latest: any;
    for (let i = 0; i < 100; i++) {
      latest = (await E("GET", "/tests")).data.latest;
      if (latest.status !== "running") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(latest.status, "failed");
    const byName = Object.fromEntries(latest.results.map((r: { name: string }) => [r.name, r]));
    assert.deepEqual([byName.adds.status, byName.adds.file, byName.adds.line], ["pass", "src/math.test.js", 4]);
    assert.deepEqual([byName["adds negatives"].status, byName["adds negatives"].line], ["fail", 5]);
    assert.match(byName["adds negatives"].error, /-3/);
    assert.equal(latest.stale, false);

    // Fix the code and rerun only what failed.
    writeFileSync(join(repo, "src/math.js"), "export const add = (a, b) => a + b - 0;\n");
    assert.equal((await E("GET", "/tests")).data.latest.stale, true, "results from before the edit are stale");
    writeFileSync(join(repo, "src/math.test.js"), FILES["src/math.test.js"].replace("-4", "-3"));
    await O("POST", "/tests/run", { names: ["adds negatives"] });
    for (let i = 0; i < 100; i++) {
      latest = (await E("GET", "/tests")).data.latest;
      if (latest.status !== "running") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(latest.status, "passed");
    assert.deepEqual(latest.results.filter((r: { status: string }) => r.status === "pass").map((r: { name: string }) => r.name), ["adds negatives"]);
    assert.ok(server.relay.events().some((e) => e.type === "tests.started"));
  } finally {
    await server.close();
  }
});

test("runner: a hung run can be stopped; other runners are reported by exit code only", async () => {
  const { server, repo } = await testServer({ ...FILES, "src/slow.test.js": 'import { test } from "node:test";\ntest("hangs", () => new Promise((r) => setTimeout(r, 60000)));\n' });
  try {
    const owner = (await joinAs(server, "Olu", "owner")).cookie;
    const O = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${server.url}/api${path}`, { method, headers: { cookie: owner, "x-relay": "1", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, data: (await res.json()) as any };
    };
    await O("POST", "/tests/run", { files: ["src/slow.test.js"] });
    assert.equal((await O("POST", "/tests/run", {})).status, 409, "one run at a time");
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await O("POST", "/tests/stop")).data.stopped, true);
    let latest: any;
    for (let i = 0; i < 50; i++) {
      latest = (await O("GET", "/tests")).data.latest;
      if (latest.status !== "running") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(latest.status, "stopped");

    writeFileSync(join(repo, "package.json"), '{ "type": "module", "scripts": { "test": "echo custom-runner && exit 3" } }\n');
    const d = (await O("GET", "/tests")).data.discover;
    assert.deepEqual([d.runner, d.perTest], ["npm-script", false]);
    assert.match(d.reason, /exit code/);
  } finally {
    await server.close();
  }
});
