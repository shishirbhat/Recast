/**
 * Proof-carrying changesets and reproduction from failure evidence, through the server's HTTP API. Agents are
 * SIMULATED (scripted edits); git, the checks, the rebuild of recorded trees and the server are real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HUMAN } from "./helpers.ts";
import { api, join as joinAs, testServer } from "./collab-helpers.ts";
import { BREAKING, COMPATIBLE, FILES, twoAgentTasks } from "./together-fixture.ts";
import { digestOf, verifyChangeset } from "../src/analysis/changeset.ts";
import type { Changeset } from "../src/analysis/changeset.ts";

const head = (repo: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

test("an agent's changeset carries its base, patch and checks; it verifies here and in a fresh clone; edits are caught", async () => {
  const s = await twoAgentTasks(BREAKING);
  try {
    const { cookie } = await joinAs(s.server, "Vi", "viewer");
    const cs = (await api(s.server, cookie, "GET", "/api/tasks/T-ui/changeset")).body as Changeset;
    assert.equal(cs.format, "relay.changeset/1");
    assert.equal(cs.source, "agent-worktree");
    assert.equal(cs.base.kind, "relay-snapshot", "agents start from a snapshot of the shared project");
    assert.ok(cs.base.parent && cs.base.patch !== null);
    assert.deepEqual(cs.change.files, [{ path: "src/ui.js", status: "modified", inScope: true }]);
    assert.match(cs.change.patch, /-export const footer = 'bye';\n\+export const footer = 'see you soon';/);
    const test = cs.evidence.filter((e) => e.command === "node --test src/ui.test.js").at(-1)!;
    assert.equal(test.exitCode, 0);
    assert.equal(test.coversThisChange, true, "Relay's check ran in the agent's worktree: exactly this change");
    assert.equal(cs.digest, digestOf(cs));
    assert.match((await api(s.server, cookie, "GET", "/api/tasks/T-ui/changeset?format=text")).body.text, /PASS {2}node --test src\/ui\.test\.js .* on exactly this change/);

    // Verified against the server's repository.
    const here = (await api(s.server, cookie, "POST", "/api/changesets/verify", cs)).body;
    assert.equal(here.check.verdict, "verified", here.text);
    assert.equal(here.check.base, "ok");

    // A fresh clone doesn't have Relay's snapshot commit: the base is rebuilt from its parent and the carried patch.
    const clone = join(mkdtempSync(join(tmpdir(), "relay-clone-")), "c");
    execFileSync("git", ["clone", "-q", `file://${s.repo}`, clone]);
    const there = verifyChangeset(cs, clone);
    assert.equal(there.base, "rebuilt-from-parent");
    assert.equal(there.tree, "matches");
    assert.equal(there.verdict, "verified", there.reasons.join("; "));

    // Editing the file is caught by the digest; a forged patch with a recomputed digest no longer gives the tree.
    const forged = { ...cs, evidence: cs.evidence.map((e) => ({ ...e, exitCode: 0 })) };
    forged.evidence[0] = { ...forged.evidence[0]!, exitCode: 1 };
    assert.equal(verifyChangeset(forged, s.repo).digest, "mismatch");
    const swapped = { ...cs, change: { ...cs.change, patch: cs.change.patch.replace("see you soon", "see you later") } };
    const resigned = { ...swapped, digest: digestOf(swapped) };
    const r = verifyChangeset(resigned, s.repo);
    assert.equal(r.digest, "ok");
    assert.equal(r.tree, "differs");
    assert.equal(r.verdict, "not-verified");
    assert.ok(r.evidence.every((e) => !e.coversThisChange), "no check is credited to files it didn't run on");
    assert.equal((await api(s.server, cookie, "POST", "/api/changesets/verify", { hello: 1 })).status, 400);
  } finally {
    await s.server.close();
  }
});

test("a person's changeset: checks on the shared project cover it only while nothing else in the project has changed", async () => {
  const t = await testServer(FILES);
  try {
    const r = t.server.relay;
    r.createTask({ id: "T-p", objective: "Friendlier footer", scope: ["src/ui.js"], verify: ["node --test src/ui.test.js"], baseCommit: head(t.repo) }, HUMAN);
    r.transition("T-p", "queued", HUMAN);
    r.transition("T-p", "running", HUMAN);
    writeFileSync(join(t.repo, "src/ui.js"), FILES["src/ui.js"].replace("'bye'", "'see you'"));
    r.transition("T-p", "review_required", HUMAN);
    const ed = await joinAs(t.server, "Ed", "editor");
    assert.equal((await api(t.server, ed.cookie, "POST", "/api/tasks/T-p/check")).status, 200);
    const cs = (await api(t.server, ed.cookie, "GET", "/api/tasks/T-p/changeset")).body as Changeset;
    assert.equal(cs.source, "shared-project");
    assert.equal(cs.base.kind, "commit");
    assert.equal(cs.evidence.filter((e) => e.kind === "command").at(-1)!.coversThisChange, true);
    assert.equal(verifyChangeset(cs, t.repo).verdict, "verified");

    // Someone else, on another task, changes their file: the check now runs on the project with that change too.
    r.createTask({ id: "T-q", objective: "other work", scope: ["src/server.js"], baseCommit: head(t.repo) }, HUMAN);
    r.transition("T-q", "queued", HUMAN);
    r.transition("T-q", "running", HUMAN);
    writeFileSync(join(t.repo, "src/server.js"), FILES["src/server.js"] + "// unrelated\n");
    assert.equal((await api(t.server, ed.cookie, "POST", "/api/tasks/T-p/check")).status, 200);
    const later = (await api(t.server, ed.cookie, "GET", "/api/tasks/T-p/changeset")).body as Changeset;
    assert.deepEqual(later.change.files.map((f) => f.path), ["src/ui.js"], "only this task's file is in the change");
    assert.equal(later.evidence.filter((e) => e.kind === "command").at(-1)!.coversThisChange, false);
    assert.ok(later.warnings.some((w) => /latest run of node --test src\/ui\.test\.js was on different files/.test(w)), later.warnings.join("\n"));
    assert.equal(verifyChangeset(later, t.repo).verdict, "not-verified");
  } finally {
    await t.server.close();
  }
});

test("reproduction: a failing check is rebuilt from its recorded tree and run again; reproduced, and an investigation starts from it", async () => {
  // T-ui alone follows a rename T-api hasn't made in its worktree: its own test fails there.
  const s = await twoAgentTasks(COMPATIBLE);
  try {
    const ed = await joinAs(s.server, "Ed", "editor");
    const failing = s.server.relay.evidence("T-ui").filter((e) => e.kind === "command" && e.exitCode !== 0).at(-1)!;
    assert.ok(failing, "T-ui's check failed in its worktree");
    const b = (await api(s.server, ed.cookie, "GET", `/api/repro?evidence=${failing.id}`)).body;
    assert.equal(b.rebuildable.ok, true);
    assert.equal(b.reproducibility, "not-attempted");
    assert.deepEqual(b.failingTests.map((x: { name: string }) => x.name), ["greets the user by name"]);
    assert.match(b.script, /git read-tree [0-9a-f]{40}\n.*checkout-index -a/);
    const run = await api(s.server, ed.cookie, "POST", "/api/repro/run", { evidence: failing.id });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(run.body.outcome, "reproduced");
    assert.deepEqual(run.body.failingTests, ["greets the user by name"]);
    assert.equal((await api(s.server, ed.cookie, "GET", `/api/repro?evidence=${failing.id}`)).body.reproducibility, "reproduced");

    const inv = await api(s.server, ed.cookie, "POST", "/api/repro/investigate", { evidence: failing.id });
    assert.equal(inv.status, 201);
    const full = (await api(s.server, ed.cookie, "GET", `/api/investigations/${inv.body.id}`)).body;
    const kinds = full.entries.map((e: { kind: string }) => e.kind);
    assert.deepEqual(kinds.slice(0, 2), ["repro", "failing_test"]);
    assert.ok(full.entries[0].sources.some((x: { type: string; ref: string }) => x.type === "evidence" && x.ref === failing.id));
    assert.match(full.entries[0].body, /Reproducibility: reproduced/);

    // A passing check has nothing to reproduce; a viewer can read a bundle but not rerun it.
    const passing = s.server.relay.evidence("T-api").filter((e) => e.kind === "command" && e.exitCode === 0).at(-1)!;
    assert.equal((await api(s.server, ed.cookie, "GET", `/api/repro?evidence=${passing.id}`)).status, 400);
    const vi = await joinAs(s.server, "Vi", "viewer");
    assert.equal((await api(s.server, vi.cookie, "POST", "/api/repro/run", { evidence: failing.id })).status, 403);
  } finally {
    await s.server.close();
  }
});

test("reproduction of a blocked Check Together; a failure that doesn't recur is reported as not reproduced", async () => {
  const s = await twoAgentTasks(BREAKING);
  try {
    const own = await joinAs(s.server, "Ola", "owner");
    const integ = (await api(s.server, own.cookie, "POST", "/api/integrations/check", { tasks: ["T-api", "T-ui"] })).body;
    assert.equal(integ.status, "blocked");
    const run = await api(s.server, own.cookie, "POST", "/api/repro/run", { integration: integ.id, command: "node --test src/ui.test.js" });
    assert.equal(run.body.outcome, "reproduced", JSON.stringify(run.body));
  } finally {
    await s.server.close();
  }

  // A check that fails once and then passes: rerunning it on the same files says it did not reproduce.
  const mark = join(mkdtempSync(join(tmpdir(), "relay-flaky-")), "seen");
  const t = await testServer(FILES);
  try {
    const r = t.server.relay;
    r.createTask({ id: "T-f", objective: "flaky", scope: ["src/ui.js"], verify: [`[ -f ${mark} ] || { touch ${mark}; exit 1; }`], baseCommit: head(t.repo) }, HUMAN);
    for (const st of ["queued", "running", "review_required"] as const) r.transition("T-f", st, HUMAN);
    const ed = await joinAs(t.server, "Ed", "editor");
    await api(t.server, ed.cookie, "POST", "/api/tasks/T-f/check");
    const ev = r.evidence("T-f").filter((e) => e.kind === "command").at(-1)!;
    assert.equal(ev.exitCode, 1);
    const again = await api(t.server, ed.cookie, "POST", "/api/repro/run", { evidence: ev.id });
    assert.equal(again.body.outcome, "did-not-reproduce");
    assert.match((await api(t.server, ed.cookie, "GET", `/api/repro?evidence=${ev.id}`)).body.text, /Reproducibility: did not reproduce/);
  } finally {
    await t.server.close();
  }
});
