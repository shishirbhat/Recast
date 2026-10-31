/**
 * Relay Arena through the CLI (eval/run.ts + eval/report.ts), simulated agents. The ground truth is measured by hidden
 * oracle tests, so these assertions check the harness and Relay against it, not against the scenario's intent.
 * Also: real agents never start without --yes.
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
    execFile(BIN, ["--db", join(mkdtempSync(join(tmpdir(), "relay-arena-db-")), "r.db"), ...argv], { env, encoding: "utf8", timeout: 280_000, maxBuffer: 32 * 1024 * 1024 }, (e, out, err) => done({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err }));
  });

test("relay arena: a break the careful baseline merges is blocked by Relay; compatible work passes; a conflict is refused", { timeout: 300_000 }, async () => {
  const r = await run("arena", "--json", "--scenario", "s03-renamed-field", "--scenario", "s09-looks-conflicting", "--scenario", "s07-shared-file", "--scenario", "s10-uncertain");
  assert.equal(r.code, 0, r.err);
  const res = JSON.parse(r.out) as { format: string; agent: { real: boolean }; trials: { scenario: string; baseline: { outcome: string; truth: string }; relay: { outcome: string; rehearsal: string; assurance: { level: string; gaps: string[] } | null; unchangedAfterReject: boolean | null; error: string | null } }[] };
  assert.equal(res.format, "relay.eval/1");
  assert.equal(res.agent.real, false);
  const by = Object.fromEntries(res.trials.map((t) => [t.scenario, t]));
  assert.equal(by["s03-renamed-field"]!.baseline.outcome, "missed-break", "both branches green alone: the baseline merges a broken combination");
  assert.equal(by["s03-renamed-field"]!.relay.outcome, "correct-block");
  assert.equal(by["s03-renamed-field"]!.relay.unchangedAfterReject, true);
  assert.equal(by["s09-looks-conflicting"]!.relay.outcome, "correct-pass");
  assert.equal(by["s07-shared-file"]!.relay.outcome, "correct-conflict");
  assert.match(by["s07-shared-file"]!.relay.error!, /changed the same lines of src\/config\.js in different ways/);
  // The interaction Relay can't see: it passes, but says what it can't vouch for instead of claiming "verified".
  assert.equal(by["s10-uncertain"]!.relay.outcome, "inconclusive-was-broken");
  assert.match(by["s10-uncertain"]!.relay.assurance!.gaps.join("\n"), /reads config\[key\] from config: which keys it uses can't be determined/);
});

test("relay arena with a real agent refuses to start without --yes", async () => {
  const r = await run("arena", "--agent", "claude-code");
  assert.equal(r.code, 2);
  assert.match(r.err, /runs real agents: 4 agent sessions per scenario per trial .* It costs model usage\. Add --yes to run\./);
});
