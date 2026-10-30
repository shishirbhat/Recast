/**
 * The flight recorder: one searchable timeline from the event log, edit sessions and git commits, keeping when
 * something happened apart from when it was recorded. SIMULATED agents; everything else is real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, client, join as joinAs, until } from "./collab-helpers.ts";
import { BREAKING, twoAgentTasks } from "./together-fixture.ts";
import type { TimelineEntry } from "../src/analysis/timeline.ts";

test("the timeline joins agent runs, checks, edits and commits; it searches and filters; occurred vs recorded is kept", async () => {
  const s = await twoAgentTasks(BREAKING);
  try {
    const own = await joinAs(s.server, "Ola", "owner");
    await api(s.server, own.cookie, "POST", "/api/integrations/check", { tasks: ["T-api", "T-ui"] });
    // A person edits; a commit written two days ago is committed now.
    const c = await client(s.server, own.cookie, "src/ui.js");
    c.text.insert(0, "Hello ");
    await until(() => s.server.docs.get("src/ui.js")?.text.toString().startsWith("Hello"), 3000, "edit");
    c.close();
    s.server.docs.closeSessions();
    writeFileSync(join(s.repo, "NOTES.md"), "notes\n");
    const env = { ...process.env, GIT_AUTHOR_DATE: "2026-10-01T09:00:00Z", GIT_AUTHOR_NAME: "Old Author", GIT_AUTHOR_EMAIL: "a@x", GIT_COMMITTER_NAME: "C", GIT_COMMITTER_EMAIL: "c@x" };
    execFileSync("git", ["add", "NOTES.md"], { cwd: s.repo });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "Add notes"], { cwd: s.repo, env, stdio: ["ignore", "pipe", "pipe"] });

    const get = async (q: string) => (await api(s.server, own.cookie, "GET", `/api/timeline${q}`)).body as { entries: TimelineEntry[]; truncated: boolean };
    const all = (await get("")).entries;
    assert.ok(all.some((e) => e.kind === "agent" && e.task === "T-api" && /Agent \(claude-code\) started from snapshot/.test(e.summary)));
    assert.ok(all.some((e) => e.kind === "integration" && e.summary === "Checked T-api, T-ui together: blocked (cause confirmed)"));
    const edit = all.find((e) => e.kind === "edit" && /^Edited src\/ui\.js: \+6/.test(e.summary));
    assert.ok(edit, JSON.stringify(all.filter((e) => e.kind === "edit")));
    assert.ok(edit.occurredAt && edit.occurredAt.from <= edit.recordedAt, "an edit session spans from its first edit to its last");
    const commit = all.find((e) => e.kind === "git" && /Add notes$/.test(e.summary))!;
    assert.equal(commit.actor, "Old Author");
    assert.equal(commit.occurredAt?.from, "2026-10-01T09:00:00.000Z", "written two days before it was committed");
    assert.ok(commit.recordedAt > commit.occurredAt!.from);
    assert.ok(all.filter((e) => e.kind !== "git" && e.kind !== "edit").every((e) => e.occurredAt === null), "for Relay's own events only the recorded time is known, and nothing is guessed");
    for (let i = 1; i < all.length; i++) assert.ok(all[i - 1]!.recordedAt >= all[i]!.recordedAt, "newest first");

    const forTask = (await get("?task=T-ui")).entries;
    assert.ok(forTask.length > 0 && forTask.every((e) => e.task === "T-ui"));
    const searched = (await get("?q=getUser")).entries;
    assert.ok(searched.length === 0 || searched.every((e) => /getuser/i.test(`${e.summary} ${e.actor} ${e.type}`)));
    const checks = (await get("?kinds=integration,check")).entries;
    assert.ok(checks.length && checks.every((e) => e.kind === "integration" || e.kind === "check"));
    const blocked = (await get("?q=blocked")).entries;
    assert.ok(blocked.some((e) => e.kind === "integration"));
    assert.equal((await get("?limit=3")).entries.length, 3);
    assert.equal((await get("?limit=3")).truncated, true);
  } finally {
    await s.server.close();
  }
});
