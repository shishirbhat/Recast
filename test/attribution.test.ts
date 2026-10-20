/**
 * Contribution attribution and collaboration security with real y-websocket clients against the real server:
 * historical sessions, surviving per-line authorship (member, shared, baseline, disk, agent), exact session diffs,
 * historical revisions, forged-authorship rejection, and revocation that ends live access.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Y from "yjs";
import WS from "ws";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import { client, join as joinAs, sleep, testServer, until } from "./collab-helpers.ts";
import type { RelayServer } from "../src/server/server.ts";

const BASE = "const a = 1;\nconst b = 2;\n";

async function get(server: RelayServer, cookie: string, path: string) {
  const res = await fetch(`${server.url}/api${path}`, { headers: { cookie } });
  return { status: res.status, data: (await res.json()) as any };
}

test("attribution: who wrote what survives as per-line authorship; history keeps each person's sessions and exact diffs", async () => {
  const { server, repo } = await testServer({ "src/app.js": BASE });
  try {
    const ada = await joinAs(server, "Ada", "editor");
    const bo = await joinAs(server, "Bo", "editor");
    const ca = await client(server, ada.cookie, "src/app.js");
    const cb = await client(server, bo.cookie, "src/app.js");

    // Ada appends a line; Bo appends another; then Bo edits Ada's line (making it shared).
    ca.text.insert(ca.text.length, "const ada = 'hello';\n");
    await until(() => cb.text.toString().includes("ada ="), 3000, "ada's line reaches bo");
    cb.text.insert(cb.text.length, "const bo = 'hi';\n");
    await until(() => ca.text.toString().includes("bo ="), 3000, "bo's line reaches ada");
    const at = cb.text.toString().indexOf("'hello'");
    cb.text.insert(at + 6, " world");
    await until(() => server.docs.get("src/app.js")!.text.toString().includes("hello world"), 3000, "server has it");

    const attr = (await get(server, ada.cookie, "/attribution?path=src/app.js")).data.lines as { line: number; kind: string; authors: string[] }[];
    assert.deepEqual(attr.map((l) => [l.line, l.kind, l.authors]), [
      [1, "baseline", ["relay:baseline"]],
      [2, "baseline", ["relay:baseline"]],
      [3, "shared", [ada.id, bo.id].sort()],
      [4, "member", [bo.id]],
    ]);

    // Historical view: Ada inserted 21 characters in one session, Bo 17 + 6 in his; separate from what survives.
    server.docs.closeSessions();
    const pa = (await get(server, bo.cookie, `/people/${encodeURIComponent(ada.id)}`)).data;
    assert.equal(pa.sessions.length, 1);
    assert.equal(pa.sessions[0].inserted, "const ada = 'hello';\n".length);
    assert.equal(pa.sessions[0].deleted, 0);
    assert.deepEqual(pa.surviving, [{ path: "src/app.js", exists: true, lines: [], shared: [3] }], "Ada's only line is now shared with Bo");
    const pb = (await get(server, ada.cookie, `/people/${encodeURIComponent(bo.id)}`)).data;
    assert.equal(pb.files[0].inserted, "const bo = 'hi';\n".length + " world".length);
    assert.deepEqual(pb.surviving[0].lines, [4]);

    // Exact diff of Ada's session, with Bo listed as concurrent if his session overlapped it.
    const d = (await get(server, bo.cookie, `/sessions/${pa.sessions[0].id}/diff`)).data;
    assert.equal(d.available, true);
    assert.deepEqual(d.diff.filter((l: { kind: string }) => l.kind === "add").map((l: { text: string }) => l.text), ["const ada = 'hello';"]);
    // The revision before her session is the baseline text exactly.
    const rev = (await get(server, bo.cookie, `/history?path=src/app.js&seq=${pa.sessions[0].baseSeq}`)).data;
    assert.equal(rev.text, BASE);

    // One durable timeline event per session, not per keystroke.
    const sessionEvents = server.relay.events().filter((e) => e.type === "doc.edit_session");
    assert.equal(sessionEvents.length, 2);

    // Edits from outside (disk) and applied agent work are never attributed to a person.
    server.docs.applyText("src/app.js", server.docs.get("src/app.js")!.text.toString() + "const agent = true;\n", "agent:simulated:T-1");
    // An outside tool changes line 2 (from the version on disk, which doesn't have the agent's line yet).
    await until(() => readFileSync(join(repo, "src/app.js"), "utf8").includes("agent = true"), 3000, "agent line flushed");
    writeFileSync(join(repo, "src/app.js"), readFileSync(join(repo, "src/app.js"), "utf8").replace("const b = 2;", "const b = 20;"));
    await until(() => server.docs.get("src/app.js")!.text.toString().includes("b = 20"), 4000, "disk change merged");
    const after = (await get(server, ada.cookie, "/attribution?path=src/app.js")).data.lines as { line: number; kind: string; authors: string[] }[];
    // "2" -> "20" is a one-character insert, so line 2 now mixes baseline and disk characters: shared, by the rules.
    assert.deepEqual([after[1]!.kind, after[1]!.authors], ["shared", ["relay:baseline", "relay:disk"]]);
    assert.deepEqual([after[4]!.kind, after[4]!.authors[0]], ["agent", "agent:simulated:T-1"]);
    const people = (await get(server, ada.cookie, "/people")).data;
    assert.ok(people.people.some((p: { id: string; kind: string }) => p.id === "agent:simulated:T-1" && p.kind === "agent"), "agents are listed as agents, not people");
    ca.close();
    cb.close();
  } finally {
    await server.close();
  }
});

test("security: an update claiming another participant's edits is refused before it touches the document", async () => {
  const { server } = await testServer({ "src/app.js": BASE });
  try {
    const ada = await joinAs(server, "Ada", "editor");
    const bo = await joinAs(server, "Bo", "editor");
    const ca = await client(server, ada.cookie, "src/app.js");
    ca.text.insert(0, "// ada\n");
    await until(() => server.docs.get("src/app.js")!.text.toString().startsWith("// ada"), 3000, "ada's edit");

    // Bo builds an update that pretends to come from Ada's Yjs client.
    // (Loading Ada's state first would make Yjs pick a fresh client ID, so the forger writes blind with hers.)
    const fake = new Y.Doc();
    fake.clientID = ca.doc.clientID;
    let forged: Uint8Array | null = null;
    fake.on("update", (u: Uint8Array) => (forged = u));
    fake.getText("content").insert(0, "FORGED ".repeat(4));
    const ws = new WS(`${server.url.replace("http", "ws")}/collab/${encodeURIComponent("file:src/app.js")}`, { headers: { cookie: bo.cookie } });
    await new Promise((ok) => ws.once("open", ok));
    const closed = new Promise<number>((ok) => ws.once("close", (code) => ok(code)));
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeUpdate(enc, forged!);
    ws.send(encoding.toUint8Array(enc));
    assert.equal(await closed, 4403);
    await sleep(100);
    assert.ok(!server.docs.get("src/app.js")!.text.toString().includes("FORGED"));
    assert.ok(server.relay.events().some((e) => e.type === "doc.update_rejected" && (e.data as { member: string }).member === bo.id));
    ca.close();
  } finally {
    await server.close();
  }
});

test("security: revoking a member ends their live document connection, event feed, session cookie and invite", async () => {
  const { server } = await testServer({ "src/app.js": BASE });
  try {
    const owner = await joinAs(server, "Olu", "owner");
    const bo = await joinAs(server, "Bo", "editor");
    const cb = await client(server, bo.cookie, "src/app.js");
    const ev = new WS(`${server.url.replace("http", "ws")}/events`, { headers: { cookie: bo.cookie } });
    await new Promise((ok) => ev.once("open", ok));
    const evClosed = new Promise<number>((ok) => ev.once("close", (c) => ok(c)));
    const docClosed = new Promise<void>((ok) => cb.provider.on("connection-close", () => ok()));
    cb.provider.shouldConnect = false; // don't auto-reconnect in the test

    const editorTries = await fetch(`${server.url}/api/members/${encodeURIComponent(owner.id)}/revoke`, { method: "POST", headers: { cookie: bo.cookie, "x-relay": "1" } });
    assert.equal(editorTries.status, 403, "only owners revoke");
    const r = await fetch(`${server.url}/api/members/${encodeURIComponent(bo.id)}/revoke`, { method: "POST", headers: { cookie: owner.cookie, "x-relay": "1" } });
    assert.equal(r.status, 200);
    assert.equal(await evClosed, 4401);
    await docClosed;
    assert.equal((await fetch(`${server.url}/api/state`, { headers: { cookie: bo.cookie } })).status, 401, "old cookie is dead");
    const retry = new WS(`${server.url.replace("http", "ws")}/collab/${encodeURIComponent("file:src/app.js")}`, { headers: { cookie: bo.cookie } });
    const err = await new Promise<string>((ok) => (retry.once("unexpected-response", (_q, res) => ok(String(res.statusCode))), retry.once("open", () => ok("opened"))));
    assert.equal(err, "401", "reconnecting is refused");
    assert.ok(server.relay.events().some((e) => e.type === "member.revoked"));
    cb.close();
  } finally {
    await server.close();
  }
});

test("an outside edit made inside the flush window is never silently overwritten (regression)", async () => {
  const { server, repo } = await testServer({ "src/app.js": "a\nb\n" });
  try {
    const ada = await joinAs(server, "Ada", "editor");
    const ca = await client(server, ada.cookie, "src/app.js");
    ca.text.insert(0, "top\n");
    await until(() => server.docs.get("src/app.js")!.text.toString().startsWith("top"), 3000, "edit");
    // Before the shared edit is flushed, a tool rewrites the file on disk (non-overlapping change).
    writeFileSync(join(repo, "src/app.js"), "a\nB\n");
    await sleep(400);
    await until(() => server.docs.get("src/app.js")!.text.toString() === "top\na\nB\n", 3000, "both edits kept");
    assert.equal(readFileSync(join(repo, "src/app.js"), "utf8"), "top\na\nB\n");
    ca.close();
  } finally {
    await server.close();
  }
});
