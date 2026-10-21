/**
 * Line history: who wrote each part of a line, when, and in which edit session — with real y-websocket clients, so the
 * answer comes from the same update log and authorship records the editor uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, client, join as joinAs, testServer, until } from "./collab-helpers.ts";

test("line history names each author of a line with the time and edit session that wrote it", { timeout: 30_000 }, async () => {
  const { server } = await testServer({ "src/app.js": "export const a = 1;\n" });
  const open: { close(): void }[] = [];
  try {
    const ada = await joinAs(server, "Ada", "editor");
    const bo = await joinAs(server, "Bo", "editor");
    const ca = await client(server, ada.cookie, "src/app.js");
    open.push(ca);
    ca.text.insert(ca.text.length, "export const total = price * qty;\n");
    await until(() => server.docs.get("src/app.js")!.text.toString().includes("qty"));
    const cb = await client(server, bo.cookie, "src/app.js");
    open.push(cb);
    await until(() => cb.text.toString().includes("qty"));
    // Bo changes the operator on Ada's line: the bug, if it is one, is his.
    const at = cb.text.toString().indexOf("price * qty");
    cb.text.delete(at + 6, 1);
    cb.text.insert(at + 6, "+");
    await until(() => server.docs.get("src/app.js")!.text.toString().includes("price + qty"));

    const r = await api(server, ada.cookie, "GET", "/api/attribution/line?path=src/app.js&line=2");
    assert.equal(r.status, 200);
    const origins = r.body.origins as { author: string; text: string; at: string | null; session: string | null }[];
    assert.ok(origins.some((o) => o.author === ada.id && o.text.includes("export const total")), JSON.stringify(origins));
    const plus = origins.find((o) => o.text.includes("+"))!;
    assert.equal(plus.author, bo.id, "the changed operator is Bo's");
    assert.ok(plus.at && plus.session, "with when and which session");
    const original = await api(server, ada.cookie, "GET", "/api/attribution/line?path=src/app.js&line=1");
    assert.equal(original.body.origins[0].kind, "baseline", "text that was in the file before Relay tracked it says so");

    const sides = await api(server, ada.cookie, "GET", `/api/sessions/${plus.session}/sides`);
    assert.equal(sides.status, 200);
    assert.match(sides.body.before, /price \* qty/);
    assert.match(sides.body.after, /price \+ qty/);
    assert.equal((await api(server, ada.cookie, "GET", "/api/attribution/line?path=src/app.js&line=0")).status, 400);
  } finally {
    for (const c of open) c.close();
    await server.close();
  }
});
