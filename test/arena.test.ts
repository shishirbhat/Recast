/**
 * Relay Arena as a regression test: the scoreboard must keep saying that with Relay no broken combination reaches the
 * project and no working one is blocked, while without Relay the interface break gets in. Ground truth is measured by
 * the arena itself (the project's tests on the combined change). Also: --real never spends money without --yes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN = resolve(import.meta.dirname, "../bin/relay");
const run = (...argv: string[]) =>
  new Promise<{ code: number; out: string; err: string }>((done) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("NODE_TEST")));
    execFile(BIN, ["--db", join(mkdtempSync(join(tmpdir(), "relay-arena-db-")), "r.db"), ...argv], { env, encoding: "utf8", timeout: 240_000 }, (e, out, err) => done({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err }));
  });

test("relay arena: without Relay the interface break gets in; with Relay nothing broken does, and nothing working is blocked", { timeout: 300_000 }, async () => {
  const r = await run("arena", "--json");
  assert.equal(r.code, 0, r.err + r.out);
  const a = JSON.parse(r.out) as { scenarios: { scenario: string; combinedWorks: boolean | null; without: { brokenInProject: boolean }; withRelay: { outcome: string; brokenInProject: boolean; falseAlarm: boolean; why: string } }[]; score: { without: { brokenInProject: number }; withRelay: { brokenInProject: number; falseAlarms: number } } };
  const by = Object.fromEntries(a.scenarios.map((s) => [s.scenario, s]));
  assert.equal(by["interface-break"]!.combinedWorks, false);
  assert.equal(by["interface-break"]!.without.brokenInProject, true);
  assert.equal(by["interface-break"]!.withRelay.outcome, "blocked");
  assert.equal(by["compatible"]!.withRelay.outcome, "approved");
  assert.equal(by["unrelated"]!.withRelay.outcome, "approved");
  assert.equal(by["same-line"]!.combinedWorks, null);
  assert.match(by["same-line"]!.withRelay.why, /T-ui and T-api changed the same lines of src\/ui\.js in different ways/);
  assert.deepEqual(a.score, { without: { brokenInProject: 1 }, withRelay: { brokenInProject: 0, falseAlarms: 0 } });
});

test("relay arena --real refuses to start paid agent runs without --yes, and says what it would cost", async () => {
  const r = await run("arena", "--real", "--trials", "2");
  assert.equal(r.code, 2);
  assert.match(r.err, /4 agent sessions per trial .* 2 trial\(s\)\. Measured on 2026-10-27 at about \$0\.45 per trial\. .* Add --yes to run it\./);
});
