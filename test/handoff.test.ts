/**
 * Handoff packets through the server's HTTP API: assembled from evidence, frozen, addressed, acknowledged or declined,
 * and delivered once to the next agent's briefing. SIMULATED agents; everything else is real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HUMAN } from "./helpers.ts";
import { api, join as joinAs, until } from "./collab-helpers.ts";
import { COMPATIBLE, twoAgentTasks } from "./together-fixture.ts";

test("a handoff carries what is known (checks on this change, failures, contracts) apart from the giver's words; the recipient takes it over", async () => {
  // T-ui follows a rename T-api hasn't made in its worktree: T-ui's own check fails there.
  const s = await twoAgentTasks(COMPATIBLE);
  try {
    const ola = await joinAs(s.server, "Ola", "owner");
    const ed = await joinAs(s.server, "Ed", "editor");
    const bo = await joinAs(s.server, "Bo", "editor");
    const vi = await joinAs(s.server, "Vi", "viewer");
    assert.equal((await api(s.server, ola.cookie, "POST", "/api/handoffs", { task: "T-ui", to: vi.id, note: "x" })).status, 400, "viewers can't take work");
    assert.equal((await api(s.server, ola.cookie, "POST", "/api/handoffs", { task: "T-ui", to: ed.id, note: "  " })).status, 400, "a note is required");
    const made = await api(s.server, ola.cookie, "POST", "/api/handoffs", { task: "T-ui", to: ed.id, note: "UI follows the fullName rename; it fails until T-api lands.", questions: ["Should greet() fall back to name?"], nextSteps: ["Check together with T-api"] });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const h = made.body;
    const p = h.packet;
    assert.deepEqual(p.work.files, ["src/ui.js"]);
    assert.match(p.work.source, /agent work .* not yet in the project/);
    assert.deepEqual(p.checks, [{ command: "node --test src/ui.test.js", exitCode: 1, onThisChange: true, recordedAt: p.checks[0].recordedAt }]);
    assert.deepEqual(p.failures, [{ command: "node --test src/ui.test.js", reproducibility: "not-attempted", failingTests: ["greets the user by name"] }]);
    assert.deepEqual(p.contracts, [{ id: "user-api", planned: 1, current: 1 }]);
    assert.equal(p.fromGiver.note, "UI follows the fullName rename; it fails until T-api lands.");
    assert.equal(p.work.changesetDigest.length, 64, "points at the exact changeset");
    const text = (await api(s.server, ed.cookie, "GET", `/api/handoffs/${h.id}`)).body.text;
    assert.match(text, /FAIL {2}node --test src\/ui\.test\.js {2}on exactly this change/);
    assert.match(text, /From Ola:\n {2}UI follows/);
    assert.equal((await api(s.server, ola.cookie, "POST", "/api/handoffs", { task: "T-ui", to: bo.id, note: "again" })).status, 409, "one open handoff per task");

    // Ed sees it in their inbox; Bo can't answer for Ed.
    const inbox = (await api(s.server, ed.cookie, "GET", "/api/attention")).body.items as { key: string; title: string }[];
    assert.ok(inbox.some((i) => i.title === "Ola handed you T-ui"));
    assert.equal((await api(s.server, bo.cookie, "POST", `/api/handoffs/${h.id}/respond`, { status: "acknowledged" })).status, 403);
    const ack = await api(s.server, ed.cookie, "POST", `/api/handoffs/${h.id}/respond`, { status: "acknowledged" });
    assert.equal(ack.body.status, "acknowledged");
    assert.equal(s.server.relay.requireTask("T-ui").owner, ed.id, "Ed owns T-ui now");
    assert.ok(!((await api(s.server, ed.cookie, "GET", "/api/attention")).body.items as { title: string }[]).some((i) => i.title === "Ola handed you T-ui"));
    assert.equal((await api(s.server, ed.cookie, "POST", `/api/handoffs/${h.id}/respond`, { status: "declined", reply: "no" })).status, 409);

    // Declining needs a reason, and the reason reaches the giver; only the giver withdraws.
    const h2 = (await api(s.server, ed.cookie, "POST", "/api/handoffs", { task: "T-api", to: bo.id, note: "API side is done." })).body;
    assert.equal((await api(s.server, bo.cookie, "POST", `/api/handoffs/${h2.id}/respond`, { status: "declined" })).status, 400);
    assert.equal((await api(s.server, ola.cookie, "POST", `/api/handoffs/${h2.id}/withdraw`)).status, 403);
    await api(s.server, bo.cookie, "POST", `/api/handoffs/${h2.id}/respond`, { status: "declined", reply: "I'm on the billing work this week" });
    const edInbox = (await api(s.server, ed.cookie, "GET", "/api/attention")).body.items as { title: string; why: string }[];
    assert.ok(edInbox.some((i) => i.title === "Bo declined T-api" && i.why === "I'm on the billing work this week"));
  } finally {
    await s.server.close();
  }
});

test("a handoff to the next agent is in that agent's briefing once, labelled as a person's words", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-prompt-"));
  process.env.RELAY_SIM_PROMPT_OUT = join(dir, "prompt.txt");
  const s = await twoAgentTasks(COMPATIBLE);
  try {
    const ola = await joinAs(s.server, "Ola", "owner");
    s.server.relay.createTask({ id: "T-next", objective: "Copy", scope: ["src/ui.js"], baseCommit: s.server.relay.requireTask("T-ui").baseCommit! }, HUMAN);
    s.server.relay.transition("T-next", "queued", HUMAN);
    const h = (await api(s.server, ola.cookie, "POST", "/api/handoffs", { task: "T-next", to: "next-agent", note: "Keep the footer under 20 characters." })).body;
    assert.equal(h.toName, "the next agent");
    rmSync(process.env.RELAY_SIM_PROMPT_OUT, { force: true });
    await s.server.runs.start("T-next", s.owner);
    await until(() => { try { return readFileSync(process.env.RELAY_SIM_PROMPT_OUT!, "utf8").length > 0; } catch { return false; } }, 15_000, "prompt");
    const prompt = readFileSync(process.env.RELAY_SIM_PROMPT_OUT, "utf8");
    assert.match(prompt, /Handoff from Ola \(their words, not verified by Relay; check before relying on them\):/);
    assert.match(prompt, /Keep the footer under 20 characters\./);
    const after = (await api(s.server, ola.cookie, "GET", `/api/handoffs/${h.id}`)).body;
    assert.equal(after.status, "delivered");
    assert.match(after.response, /^delivered to agent run /);
  } finally {
    delete process.env.RELAY_SIM_PROMPT_OUT;
    await s.server.close();
  }
});
