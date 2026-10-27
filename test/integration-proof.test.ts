/**
 * The deterministic integration proof as a regression test: two simulated tasks, each green alone, break the project
 * when combined; without Relay the break is merged, with Relay the rehearsal blocks it and the project is unchanged.
 * The script exits non-zero if any of that stops being true. It writes its report to a temp file, not to docs/.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dirname, "../scripts/prove-integration.ts");

test("integration proof: individually green, combined red; Relay blocks it and leaves the project unchanged", { timeout: 60_000 }, () => {
  const out = join(mkdtempSync(join(tmpdir(), "relay-proof-")), "proof.md");
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("NODE_TEST")));
  const r = spawnSync(process.execPath, [SCRIPT, out], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const report = readFileSync(out, "utf8");
  assert.match(report, /\| Project tests after merge \| \*\*FAIL\*\* \|/);
  assert.match(report, /\| Integration rehearsal \| \*\*blocked\*\* \|/);
  assert.match(report, /\| Shared project \| unchanged \|/);
});
