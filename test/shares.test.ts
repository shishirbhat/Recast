/**
 * Shareable run reports: owner-made, read-only links to frozen reports, without sign-in, expiring and revocable.
 * SIMULATED agents; the server, database and HTTP are real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, join as joinAs } from "./collab-helpers.ts";
import { BREAKING, COMPATIBLE, twoAgentTasks } from "./together-fixture.ts";

const fetchShare = async (server: { url: string }, path: string) => {
  const r = await fetch(`${server.url}${path}`);
  return { status: r.status, text: await r.text(), headers: r.headers };
};

test("an owner shares a changeset: readable without signing in, frozen, without source by default; revocable", async () => {
  const s = await twoAgentTasks(COMPATIBLE);
  try {
    const own = await joinAs(s.server, "Ola", "owner");
    const ed = await joinAs(s.server, "Ed", "editor");
    assert.equal((await api(s.server, ed.cookie, "POST", "/api/shares", { kind: "changeset", ref: "T-api" })).status, 403, "only owners share");
    assert.equal((await api(s.server, own.cookie, "POST", "/api/shares", { kind: "changeset", ref: "T-api", days: 0 })).status, 400);
    const made = await api(s.server, own.cookie, "POST", "/api/shares", { kind: "changeset", ref: "T-api" });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const { url, share } = made.body;
    assert.match(url, /^\/share\/[A-Za-z0-9_-]{32}$/);

    const page = await fetchShare(s.server, url);
    assert.equal(page.status, 200);
    assert.match(page.text, /<h1>Changeset for T-api: API returns fullName<\/h1>/);
    assert.match(page.text, /by Ola on .* A snapshot as of then, not live\. Source code isn't included\./);
    assert.match(page.text, /PASS {2}node --test src\/server\.test\.js/);
    assert.ok(!page.text.includes("fullName: &#39;Ada&#39;"), "the patch isn't in the page");
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.match(page.headers.get("content-security-policy")!, /default-src 'none'/);
    assert.ok(!page.text.includes("<script"), "no scripts");
    const asJson = JSON.parse((await fetchShare(s.server, `${url}.json`)).text);
    assert.equal(asJson.report.change.patch, null);
    assert.ok(asJson.report.evidence.every((e: { output: string }) => e.output === ""));

    // The link's secret is never stored or logged; views are counted.
    const token = url.split("/").pop()!;
    assert.ok(!JSON.stringify(s.server.relay.events()).includes(token));
    assert.ok(!JSON.stringify(s.server.relay.db.prepare("SELECT * FROM shares").all()).includes(token));
    const list = (await api(s.server, own.cookie, "GET", "/api/shares")).body.shares;
    assert.equal(list[0].views, 2);

    // With source, by choice: the patch is there.
    const withSrc = (await api(s.server, own.cookie, "POST", "/api/shares", { kind: "changeset", ref: "T-api", includeSource: true, days: 1 })).body;
    assert.match((await fetchShare(s.server, withSrc.url)).text, /Includes source changes\.[\s\S]*fullName: &#39;Ada&#39;/);

    // Revoked and expired links say so; unknown ones are not found.
    await api(s.server, own.cookie, "POST", `/api/shares/${share.id}/revoke`);
    const gone = await fetchShare(s.server, url);
    assert.equal(gone.status, 410);
    assert.match(gone.text, /This link was revoked on/);
    s.server.relay.db.prepare("UPDATE shares SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(withSrc.share.id);
    assert.match((await fetchShare(s.server, withSrc.url)).text, /This link expired on 2000-01-01/);
    assert.equal((await fetchShare(s.server, "/share/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).status, 404);
  } finally {
    await s.server.close();
  }
});

test("shared check results and reproductions are frozen when shared", async () => {
  const s = await twoAgentTasks(BREAKING);
  try {
    const own = await joinAs(s.server, "Ola", "owner");
    const integ = (await api(s.server, own.cookie, "POST", "/api/integrations/check", { tasks: ["T-api", "T-ui"] })).body;
    const shared = (await api(s.server, own.cookie, "POST", "/api/shares", { kind: "integration", ref: integ.id })).body;
    const page = (await fetchShare(s.server, shared.url)).text;
    assert.match(page, /<h1>Check of T-api \+ T-ui together: blocked<\/h1>/);
    assert.match(page, /T-ui still reads `name` from getUser\(\)/);
    assert.equal((await api(s.server, own.cookie, "POST", "/api/shares", { kind: "nope", ref: "x" })).status, 400);
  } finally {
    await s.server.close();
  }
});
