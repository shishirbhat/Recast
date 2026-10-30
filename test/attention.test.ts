/**
 * The attention inbox on the server: whose it is, why, and seen marks that hold for that exact situation only.
 * SIMULATED agents for the radar case; the engine, server and database are real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HUMAN } from "./helpers.ts";
import { api, join as joinAs, testServer } from "./collab-helpers.ts";
import { BREAKING, twoAgentTasks } from "./together-fixture.ts";

type Item = { key: string; level: string; title: string; forYou: string; seen: boolean; target: { kind: string; id?: string } };
const inbox = async (server: Parameters<typeof api>[0], cookie: string) => (await api(server, cookie, "GET", "/api/attention")).body.items as Item[];

test("each person gets what is theirs, with why; seen hides that situation for them only, and a change brings it back", async () => {
  const t = await testServer();
  try {
    const r = t.server.relay;
    const own = await joinAs(t.server, "Ola", "owner");
    const ed = await joinAs(t.server, "Ed", "editor");
    r.createTask({ id: "T-plan", objective: "Plan", scope: ["README.md"] }, HUMAN);
    r.createTask({ id: "T-mine", objective: "Mine", scope: ["src/app.js"], owner: ed.id }, HUMAN);
    for (const st of ["queued", "running", "review_required"] as const) r.transition("T-mine", st, HUMAN);

    const o = await inbox(t.server, own.cookie);
    assert.deepEqual(o.map((i) => i.title).sort(), ["T-mine is ready for review", "T-plan is waiting for approval to start"]);
    assert.equal(o.find((i) => i.title.startsWith("T-plan"))!.forYou, "Owners approve plans");
    const e = await inbox(t.server, ed.cookie);
    assert.deepEqual(e.map((i) => i.title), ["T-mine is ready for review"], "editors don't approve plans");
    assert.equal(e[0]!.forYou, "You own this task");
    assert.deepEqual(e[0]!.target, { kind: "task", id: "T-mine" });

    // Seen: hidden for Ed (kept, marked), still new for Ola.
    await api(t.server, ed.cookie, "POST", "/api/attention/seen", { keys: [e[0]!.key] });
    assert.equal((await inbox(t.server, ed.cookie))[0]!.seen, true);
    assert.equal((await inbox(t.server, own.cookie)).find((i) => i.title.startsWith("T-mine"))!.seen, false);
    // The situation changes (sent back, then submitted again): it is a new item, new to Ed.
    r.transition("T-mine", "running", HUMAN);
    r.transition("T-mine", "review_required", HUMAN);
    const again = (await inbox(t.server, ed.cookie)).find((i) => i.title.startsWith("T-mine"))!;
    assert.notEqual(again.key, e[0]!.key);
    assert.equal(again.seen, false);
    // Unmarking works too; viewers see nothing that needs them.
    await api(t.server, ed.cookie, "POST", "/api/attention/seen", { keys: [again.key], seen: false });
    const vi = await joinAs(t.server, "Vi", "viewer");
    assert.deepEqual(await inbox(t.server, vi.cookie), []);
    assert.equal((await api(t.server, "", "GET", "/api/attention")).status, 401);
  } finally {
    await t.server.close();
  }
});

test("high Conflict Radar alerts reach owners and the people whose work they concern, marked suspected or known", async () => {
  const s = await twoAgentTasks(BREAKING);
  try {
    const own = await joinAs(s.server, "Ola", "owner");
    const items = await inbox(s.server, own.cookie);
    const radar = items.find((i) => i.key.startsWith("radar:interface-changed"))!;
    assert.ok(radar, JSON.stringify(items.map((i) => i.key)));
    assert.equal(radar.level, "review", "suspected: someone should look, nothing proven broken");
    assert.match(radar.title, /T-api changed getUser\(\)/);
    assert.deepEqual(radar.target, { kind: "coordination" });
    const ed = await joinAs(s.server, "Ed", "editor");
    assert.ok(!(await inbox(s.server, ed.cookie)).some((i) => i.key.startsWith("radar:")), "not Ed's work, and Ed doesn't integrate");
  } finally {
    await s.server.close();
  }
});
