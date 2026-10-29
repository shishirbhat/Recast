/**
 * `relay integrate together` and `relay remote`, run as the real CLI binary against a real server whose agent tasks
 * were run by the SIMULATED agent. Asserts on exit codes, what is printed, the stored session, and the shared project.
 * The CLI is spawned asynchronously: the server under test lives in this process and must keep answering.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { api, join as joinAs } from "./collab-helpers.ts";
import { BREAKING, COMPATIBLE, projectState, twoAgentTasks } from "./together-fixture.ts";

const BIN = resolve(import.meta.dirname, "../bin/relay");

/** Run the CLI with its own database directory (where its server session is kept). */
function cli(db: string, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("NODE_TEST") && k !== "RELAY_SERVER" && k !== "RELAY_SESSION"));
  return new Promise((done) => {
    execFile(BIN, ["--db", db, ...argv], { env, encoding: "utf8", timeout: 120_000 }, (e, out, err) => done({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err }));
  });
}
const freshDb = () => join(mkdtempSync(join(tmpdir(), "relay-cli-")), "relay.db");

test("CLI: usage errors exit 2, not signed in exits 3; joining stores an owner-only session and prints no secret", async () => {
  const db = freshDb();
  assert.equal((await cli(db, "integrate", "together")).code, 2);
  const one = await cli(db, "integrate", "together", "T-api");
  assert.equal(one.code, 2);
  assert.match(one.err, /at least two tasks/);
  const anon = await cli(db, "integrate", "together", "T-api,T-ui");
  assert.equal(anon.code, 3);
  assert.match(anon.err, /not signed in to a Relay server/);
  assert.equal((await cli(db, "remote", "join", "not a link")).code, 2);

  const s = await twoAgentTasks(BREAKING);
  try {
    const { token } = s.server.members.invite("Cli", "editor");
    const joined = await cli(db, "remote", "join", `${s.server.url}/join#${token}`);
    assert.equal(joined.code, 0, joined.err);
    assert.equal(joined.out.trim(), `Signed in to ${s.server.url} as Cli (editor).`);
    assert.ok(!joined.out.includes(token) && !joined.out.includes("relay_session"), "no invite or session in the output");
    assert.equal(statSync(join(db, "..", "remote-session.json")).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(db, "..", ".gitignore"), "utf8"), "remote-session.json\n", "the session is never committed");
    assert.match((await cli(db, "remote", "status")).out, /as Cli \(editor\)/);
    // The invite was one-time.
    assert.equal((await cli(freshDb(), "remote", "join", `${s.server.url}/join#${token}`)).code, 3);
    assert.equal((await cli(db, "remote", "leave")).code, 0);
    assert.match((await cli(db, "remote", "status")).out, /Not signed in/);
  } finally {
    await s.server.close();
  }
});

test("CLI: a blocked rehearsal exits 1 and prints the same report the server gives every client; nothing is applied", async () => {
  const s = await twoAgentTasks(BREAKING);
  const db = freshDb();
  try {
    const before = projectState(s.repo);
    await cli(db, "remote", "join", `${s.server.url}/join#${s.server.members.invite("Cli", "editor").token}`);
    const r = await cli(db, "integrate", "together", "T-api,T-ui");
    assert.equal(r.code, 1, r.err);
    assert.match(r.out, /^BLOCKED {2}T-api \+ T-ui/);
    assert.match(r.out, /Cause \(confirmed\): Confirmed cause: T-api changed getUser in src\/server\.js/);
    assert.match(r.out, /Nothing was applied/);
    assert.equal(projectState(s.repo), before);
    // The browser IDE and VS Code read this same record through the API: identical report.
    const id = /\(integration ([0-9a-f-]+)\)/.exec(r.out)![1]!;
    const viewer = await joinAs(s.server, "Vi", "viewer");
    assert.equal((await api(s.server, viewer.cookie, "GET", `/api/integrations/${id}`)).body.report, r.out.trimEnd());
    // --json: the structured result, explanation included.
    const j = await cli(db, "--json", "integrate", "together", "T-api,T-ui");
    assert.equal(j.code, 1);
    const integ = JSON.parse(j.out);
    assert.equal(integ.status, "blocked");
    assert.equal(integ.explanation.verdict, "confirmed");
  } finally {
    await s.server.close();
  }
});

test("CLI: a passing rehearsal exits 0 and applies nothing; refusals and an unreachable server exit 3", async () => {
  const s = await twoAgentTasks(COMPATIBLE);
  const db = freshDb();
  const viewerDb = freshDb();
  try {
    const before = projectState(s.repo);
    await cli(db, "remote", "join", `${s.server.url}/join#${s.server.members.invite("Cli", "editor").token}`);
    const ok = await cli(db, "integrate", "together", "T-ui,T-api");
    assert.equal(ok.code, 0, ok.err + ok.out);
    assert.match(ok.out, /^PASSED {2}T-ui \+ T-api/);
    assert.match(ok.out, /Nothing has been applied\. A project owner must approve/);
    assert.equal(projectState(s.repo), before, "passing is not applying");
    assert.equal(s.server.relay.requireTask("T-api").state, "review_required");

    const missing = await cli(db, "integrate", "together", "T-api,T-nope");
    assert.equal(missing.code, 3);
    assert.match(missing.err, /refused the check \(HTTP 404\)/);
    const extra = await cli(db, "integrate", "together", "T-api,T-ui", "--verify", "true");
    assert.equal(extra.code, 3);
    assert.match(extra.err, /HTTP 403/);
    await cli(viewerDb, "remote", "join", `${s.server.url}/join#${s.server.members.invite("Vi", "viewer").token}`);
    const viewer = await cli(viewerDb, "integrate", "together", "T-api,T-ui");
    assert.equal(viewer.code, 3);
    assert.match(viewer.err, /HTTP 403/);
  } finally {
    await s.server.close();
  }
  const down = await cli(db, "integrate", "together", "T-api,T-ui");
  assert.equal(down.code, 3);
  assert.match(down.err, /can't reach http:\/\/127\.0\.0\.1:\d+/);
});

test("CLI: relay radar prints the alerts with known/suspected and evidence, exit 1 on high; relay ownership lists changed files", async () => {
  const db = freshDb();
  const s = await twoAgentTasks(BREAKING);
  try {
    const { token } = s.server.members.invite("Cli", "viewer");
    assert.equal((await cli(db, "remote", "join", `${s.server.url}/join#${token}`)).code, 0);
    const r = await cli(db, "radar");
    assert.equal(r.code, 1, r.err);
    assert.match(r.out, /^HIGH {2}suspected {2}T-api changed getUser\(\); T-ui's src\/ui\.js still reads \.name$/m);
    assert.match(r.out, /- static-analysis: src\/ui\.js:\d+ reads \.name from getUser\(\)/);
    const j = JSON.parse((await cli(db, "radar", "--json")).out);
    assert.equal(j.alerts[0].kind, "interface-changed");
    const own = await cli(db, "ownership");
    assert.equal(own.code, 0, own.err);
    assert.match(own.out, /^src\/server\.js\n {2}owned by: T-api\n {2}changed by agent:claude-code for T-api in \.relay\/worktrees\//m);
  } finally {
    await s.server.close();
  }
  const none = await twoAgentTasks(COMPATIBLE);
  try {
    const { token } = none.server.members.invite("Cli2", "viewer");
    const db2 = freshDb();
    await cli(db2, "remote", "join", `${none.server.url}/join#${token}`);
    const r = await cli(db2, "radar");
    assert.equal(r.code, 0, r.out);
  } finally {
    await none.server.close();
  }
});
