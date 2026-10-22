/**
 * Collaboration reliability at the protocol level, with real sockets and real Yjs clients: the server's save
 * acknowledgement, duplicate and replayed updates, and file operations that race each other.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join as pjoin } from "node:path";
import WS from "ws";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { api, client, join, sleep, testServer, until } from "./collab-helpers.ts";
import { MESSAGE_ACK } from "../src/server/collab.ts";

/** A raw y-protocols connection, so the test sees every message the server sends. */
async function rawConn(url: string, cookie: string, path: string, ack: boolean) {
  const ws = new WS(`${url.replace("http", "ws")}/collab/${encodeURIComponent(`file:${path}`)}${ack ? "?ack=1" : ""}`, { headers: { cookie } });
  const received: { type: number; body: Uint8Array }[] = [];
  ws.binaryType = "nodebuffer";
  ws.on("message", (raw: Buffer) => {
    const data = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    const dec = decoding.createDecoder(data);
    received.push({ type: decoding.readVarUint(dec), body: data.subarray(dec.pos) });
  });
  const closed = new Promise<number>((ok) => ws.on("close", (code) => ok(code)));
  await new Promise((ok, fail) => (ws.on("open", ok), ws.on("error", fail)));
  const sendUpdate = (update: Uint8Array) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, 0);
    syncProtocol.writeUpdate(enc, update);
    ws.send(encoding.toUint8Array(enc));
  };
  const acks = () => received.filter((m) => m.type === MESSAGE_ACK).map((m) => Y.decodeStateVector(decoding.readVarUint8Array(decoding.createDecoder(m.body))));
  return { ws, received, sendUpdate, acks, closed };
}

test("the server acknowledges saved edits with its state vector, only to clients that ask, coalescing bursts", async () => {
  const { server } = await testServer({ "src/a.js": "a\n" });
  try {
    const ada = await join(server, "Ada", "editor");
    const doc = new Y.Doc();
    const c = await rawConn(server.url, ada.cookie, "src/a.js", true);
    const plain = await rawConn(server.url, ada.cookie, "src/a.js", false);
    // Base our edits on the server's text so they apply (the document starts from the file's baseline).
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(server.docs.open("src/a.js").doc));
    const updates: Uint8Array[] = [];
    doc.on("update", (u: Uint8Array) => updates.push(u));
    for (let i = 0; i < 20; i++) doc.getText("content").insert(0, "x");
    for (const u of updates) c.sendUpdate(u);
    await until(() => c.acks().some((sv) => sv.get(doc.clientID) === Y.getState(doc.store, doc.clientID)), 3000, "an acknowledgement covering every edit");
    assert.ok(c.acks().length <= 3, `a burst of 20 updates is acknowledged a few times, not 20 (got ${c.acks().length})`);
    // The acknowledgement means saved: the update log already holds the edits.
    assert.ok(server.docs.open("src/a.js").text.toString().startsWith("x".repeat(20)));
    await sleep(300);
    assert.equal(plain.acks().length, 0, "a stock y-websocket client never gets a message it doesn't understand");
    c.ws.close();
    plain.ws.close();
  } finally {
    await server.close();
  }
});

test("a viewer's connection is never acknowledged for content it isn't allowed to write", async () => {
  const { server } = await testServer({ "src/a.js": "a\n" });
  try {
    const vi = await join(server, "Vi", "viewer");
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(server.docs.open("src/a.js").doc));
    const c = await rawConn(server.url, vi.cookie, "src/a.js", true);
    const before = Y.getState(doc.store, doc.clientID);
    doc.on("update", (u: Uint8Array) => c.sendUpdate(u));
    doc.getText("content").insert(0, "viewer");
    await sleep(400);
    assert.equal(server.docs.open("src/a.js").text.toString(), "a\n");
    assert.ok(c.acks().every((sv) => (sv.get(doc.clientID) ?? 0) === before), "nothing of the viewer's is ever reported as saved");
    c.ws.close();
  } finally {
    await server.close();
  }
});

test("the same update delivered twice (a reconnect resend) is stored and applied once", async () => {
  const { server } = await testServer({ "src/a.js": "a\n" });
  try {
    const ada = await join(server, "Ada", "editor");
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(server.docs.open("src/a.js").doc));
    let update!: Uint8Array;
    doc.on("update", (u: Uint8Array) => (update = u));
    doc.getText("content").insert(0, "once ");
    const c = await rawConn(server.url, ada.cookie, "src/a.js", true);
    const rows = () => (server.relay.db.prepare("SELECT COUNT(*) AS n FROM doc_updates WHERE doc = ?").get("file:src/a.js") as { n: number }).n;
    c.sendUpdate(update);
    await until(() => server.docs.open("src/a.js").text.toString() === "once a\n", 3000, "the first delivery");
    const after1 = rows();
    c.sendUpdate(update);
    c.ws.close();
    const again = await rawConn(server.url, ada.cookie, "src/a.js", true);
    again.sendUpdate(update);
    await sleep(300);
    assert.equal(server.docs.open("src/a.js").text.toString(), "once a\n");
    assert.equal(rows(), after1, "no extra update-log rows for a duplicate");
    again.ws.close();
  } finally {
    await server.close();
  }
});

test("racing renames of one file: exactly one wins, the other is refused, and the text is in one place", async () => {
  const { server, repo } = await testServer({ "src/a.js": "a\n", "src/taken.js": "taken\n" });
  try {
    const ada = await join(server, "Ada", "editor");
    const bo = await join(server, "Bo", "editor");
    const a = await client(server, ada.cookie, "src/a.js");
    a.text.insert(0, "typed ");
    await until(() => server.docs.get("src/a.js")?.text.toString() === "typed a\n");
    const [r1, r2] = await Promise.all([
      api(server, ada.cookie, "POST", "/api/files/rename", { from: "src/a.js", to: "src/one.js" }),
      api(server, bo.cookie, "POST", "/api/files/rename", { from: "src/a.js", to: "src/two.js" }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [200, 404], "one rename succeeds; the other finds the file gone");
    const winner = r1.status === 200 ? "src/one.js" : "src/two.js";
    const loser = winner === "src/one.js" ? "src/two.js" : "src/one.js";
    assert.equal(readFileSync(pjoin(repo, winner), "utf8"), "typed a\n");
    assert.ok(!existsSync(pjoin(repo, loser)) && !existsSync(pjoin(repo, "src/a.js")));

    // Renaming onto an existing file is refused and changes nothing.
    const clash = await api(server, ada.cookie, "POST", "/api/files/rename", { from: winner, to: "src/taken.js" });
    assert.equal(clash.status, 409);
    assert.equal(readFileSync(pjoin(repo, "src/taken.js"), "utf8"), "taken\n");
    assert.equal(readFileSync(pjoin(repo, winner), "utf8"), "typed a\n");
    // A rename to itself is refused, not treated as a move that closes everyone's editor.
    assert.equal((await api(server, ada.cookie, "POST", "/api/files/rename", { from: winner, to: winner })).status, 409);
    // A case-only rename is a real rename.
    const upper = winner.replace("src/", "src/X");
    assert.equal((await api(server, ada.cookie, "POST", "/api/files/rename", { from: winner, to: upper })).status, 200);
    assert.equal(readFileSync(pjoin(repo, upper), "utf8"), "typed a\n");
    a.close();
  } finally {
    await server.close();
  }
});

test("rename and delete racing on one file: the result is one of the two, never a resurrected or split file", async () => {
  const { server, repo } = await testServer({ "src/a.js": "a\n" });
  try {
    const ada = await join(server, "Ada", "editor");
    const [ren, del] = await Promise.all([
      api(server, ada.cookie, "POST", "/api/files/rename", { from: "src/a.js", to: "src/b.js" }),
      api(server, ada.cookie, "POST", "/api/files/delete", { path: "src/a.js" }),
    ]);
    assert.ok(!existsSync(pjoin(repo, "src/a.js")), "the old path is gone either way");
    if (ren.status === 200) {
      assert.equal(del.status, 404);
      assert.equal(readFileSync(pjoin(repo, "src/b.js"), "utf8"), "a\n");
    } else {
      assert.equal(del.status, 200);
      assert.equal(ren.status, 404);
      assert.ok(!existsSync(pjoin(repo, "src/b.js")));
    }
    // A stale client of the old path can't bring it back.
    const stale = new WS(`${server.url.replace("http", "ws")}/collab/${encodeURIComponent("file:src/a.js")}`, { headers: { cookie: ada.cookie } });
    const code = await new Promise<number>((ok) => stale.on("close", (c) => ok(c)));
    assert.equal(code, 4410);
    assert.ok(!existsSync(pjoin(repo, "src/a.js")));
  } finally {
    await server.close();
  }
});
