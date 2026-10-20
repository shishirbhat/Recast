import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join as pjoin } from "node:path";
import WS from "ws";
import { api, client, join, sleep, testServer, until } from "./collab-helpers.ts";
import type { Client } from "./collab-helpers.ts";
import * as Y from "yjs";
import { restorePresenceOnReconnect } from "../ide/web/lib/presence.ts";

test("two real clients edit one file concurrently and converge; disk follows", async () => {
  const { server, repo } = await testServer();
  try {
    const a = await join(server, "Ada");
    const b = await join(server, "Bo");
    const ca = await client(server, a.cookie, "src/app.js");
    const cb = await client(server, b.cookie, "src/app.js");
    assert.equal(ca.text.toString(), "export const greeting = 'hi';\n");
    // Concurrent: both type before seeing each other.
    ca.text.insert(0, "// from Ada\n");
    cb.text.insert(cb.text.length, "// from Bo\n");
    await until(() => ca.text.toString() === cb.text.toString() && ca.text.toString().includes("Bo") && ca.text.toString().includes("Ada"), 3000, "convergence");
    const expected = "// from Ada\nexport const greeting = 'hi';\n// from Bo\n";
    assert.equal(ca.text.toString(), expected);
    await until(() => readFileSync(pjoin(repo, "src/app.js"), "utf8") === expected, 3000, "disk flush");
    ca.close();
    cb.close();
  } finally {
    await server.close();
  }
});

test("five clients, randomized concurrent edits: all replicas and the server converge, no accepted insert lost", async () => {
  const { server } = await testServer({ "notes.txt": "start\n" });
  try {
    const clients: Client[] = [];
    try {
    for (const name of ["Ana", "Ben", "Cy", "Dee", "Eli"]) clients.push(await client(server, (await join(server, name)).cookie, "notes.txt"));
    // Phase 1: only inserts, each with a unique marker, so "nothing lost" is checkable.
    const markers: string[] = [];
    for (let round = 0; round < 40; round++) {
      for (const [i, c] of clients.entries()) {
        const m = `<${i}:${round}>`;
        markers.push(m);
        // Insert only at marker boundaries so markers stay intact; positions still interleave across clients.
        const s = c.text.toString();
        const bounds = [0, s.length, ...[...s.matchAll(/>/g)].map((x) => x.index! + 1)];
        c.text.insert(bounds[Math.floor(Math.random() * bounds.length)]!, m);
      }
    }
    await until(() => clients.every((c) => c.text.toString() === clients[0]!.text.toString()) && markers.every((m) => clients[0]!.text.toString().includes(m)), 8000, "insert convergence");
    // Phase 2: mixed inserts and deletes; check convergence (deletes may legitimately remove text).
    for (let round = 0; round < 60; round++) {
      for (const c of clients) {
        const len = c.text.length;
        if (len > 10 && Math.random() < 0.4) c.text.delete(Math.floor(Math.random() * (len - 5)), 1 + Math.floor(Math.random() * 4));
        else c.text.insert(Math.floor(Math.random() * (len + 1)), "x");
      }
    }
    await until(() => clients.every((c) => c.text.toString() === clients[0]!.text.toString()), 8000, "mixed convergence");
    assert.equal(server.docs.get("notes.txt")!.text.toString(), clients[0]!.text.toString());
    } finally {
      for (const c of clients) c.close();
    }
  } finally {
    await server.close();
  }
});

test("presence: live cursor/selection is shared; a forged identity is refused", async () => {
  const { server } = await testServer();
  try {
    const a = await join(server, "Ada");
    const b = await join(server, "Bo");
    const ca = await client(server, a.cookie, "src/app.js");
    const cb = await client(server, b.cookie, "src/app.js");
    ca.provider.awareness.setLocalStateField("user", { id: a.id, name: "Ada", color: "#8b5cf6" });
    ca.provider.awareness.setLocalStateField("cursor", { anchor: 3, head: 9 });
    await until(() => [...cb.provider.awareness.getStates().values()].some((s) => s.user?.id === a.id && s.cursor?.head === 9), 3000, "presence");
    // Bo pretends to be Ada: the server must not relay it.
    cb.provider.awareness.setLocalStateField("user", { id: a.id, name: "Ada (fake)", color: "#000" });
    await sleep(300);
    const seen = [...ca.provider.awareness.getStates().entries()].filter(([cid]) => cid !== ca.doc.clientID).map(([, s]) => s);
    assert.ok(!seen.some((s) => s.user?.name === "Ada (fake)"), "forged presence must not reach other clients");
    ca.close();
    cb.close();
  } finally {
    await server.close();
  }
});

test("offline edits merge on reconnect without losing either side", async () => {
  const { server } = await testServer();
  try {
    const ca = await client(server, (await join(server, "Ada")).cookie, "src/app.js");
    const cb = await client(server, (await join(server, "Bo")).cookie, "src/app.js");
    cb.provider.disconnect();
    cb.text.insert(0, "/* offline Bo */\n");
    ca.text.insert(ca.text.length, "/* online Ada */\n");
    await sleep(100);
    cb.provider.connect();
    await until(() => ca.text.toString() === cb.text.toString() && ca.text.toString().includes("offline Bo") && ca.text.toString().includes("online Ada"), 4000, "reconnect merge");
    ca.close();
    cb.close();
  } finally {
    await server.close();
  }
});

test("server restart: the shared document comes back from the update log, disk matches", async () => {
  const first = await testServer();
  const a = await join(first.server, "Ada");
  const ca = await client(first.server, a.cookie, "src/app.js");
  ca.text.insert(0, "// survives restart\n");
  await until(() => first.server.docs.get("src/app.js")?.text.toString().startsWith("// survives") ?? false, 2000, "server applied");
  ca.close();
  await first.server.close();
  const second = await testServer({}, { root: first.repo, dbPath: first.dbPath });
  try {
    const b = await join(second.server, "Bo");
    const cb = await client(second.server, b.cookie, "src/app.js");
    assert.equal(cb.text.toString(), "// survives restart\nexport const greeting = 'hi';\n");
    assert.equal(readFileSync(pjoin(first.repo, "src/app.js"), "utf8"), cb.text.toString());
    cb.close();
  } finally {
    await second.server.close();
  }
});

test("an external change on disk merges into the live document with a concurrent edit kept", async () => {
  const { server, repo } = await testServer({ "a.txt": "one\ntwo\nthree\n" });
  try {
    const ca = await client(server, (await join(server, "Ada")).cookie, "a.txt");
    await sleep(100);
    // Someone edits outside Relay (another editor, a formatter) while Ada edits line 1.
    ca.text.insert(0, "zero\n");
    writeFileSync(pjoin(repo, "a.txt"), "one\ntwo\nthree\nfour\n");
    server.docs.checkDisk(server.docs.get("a.txt")!); // what the watcher does; called directly to avoid timing flakiness
    await until(() => ca.text.toString() === "zero\none\ntwo\nthree\nfour\n", 3000, "external merge");
    assert.ok(server.relay.events().some((e) => e.type === "doc.external_change_merged"));
    ca.close();
  } finally {
    await server.close();
  }
});

test("an external change that conflicts is kept in doc_conflicts, never silently dropped", async () => {
  const { server, repo } = await testServer({ "a.txt": "same line\n" });
  try {
    const ca = await client(server, (await join(server, "Ada")).cookie, "a.txt");
    ca.text.delete(0, ca.text.length);
    ca.text.insert(0, "Ada's line\n");
    await until(() => server.docs.get("a.txt")!.text.toString() === "Ada's line\n", 2000, "server applied");
    // Before Relay flushes, the disk changes the same line differently.
    writeFileSync(pjoin(repo, "a.txt"), "Disk's line\n");
    const result = server.docs.reconcile(server.docs.get("a.txt")!, "Disk's line\n");
    assert.equal(result, "conflict");
    const conflicts = server.docs.conflicts("a.txt");
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]!.theirs, "Disk's line\n");
    assert.equal(ca.text.toString(), "Ada's line\n");
    ca.close();
  } finally {
    await server.close();
  }
});

test("security: no session, wrong role, forged origin, traversal, secrets, missing CSRF header", async () => {
  const { server, repo } = await testServer({ "src/app.js": "x\n", ".env": "SECRET=1\n", ".gitignore": "ignored.txt\n", "ignored.txt": "no\n" });
  try {
    writeFileSync(pjoin(repo, ".env"), "SECRET=1\n");
    const viewer = await join(server, "Vi", "viewer");
    const editor = await join(server, "Ed", "editor");
    assert.equal((await api(server, null, "GET", "/api/state")).status, 401);
    assert.equal((await api(server, "relay_session=forged", "GET", "/api/state")).status, 401);
    const files = (await api(server, viewer.cookie, "GET", "/api/files")).body.files as string[];
    assert.ok(files.includes("src/app.js"));
    assert.ok(!files.includes(".env") && !files.includes("ignored.txt"), "secrets and ignored files are not listed");

    const wsStatus = (path: string, cookie?: string, origin?: string) =>
      new Promise<number>((ok) => {
        const ws = new WS(server.url.replace("http", "ws") + path, { headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) } });
        ws.on("open", () => (ws.close(), ok(101)));
        ws.on("unexpected-response", (_req, res) => ok(res.statusCode ?? 0));
        ws.on("error", () => ok(0));
      });
    assert.equal(await wsStatus(`/collab/${encodeURIComponent("file:src/app.js")}`), 401);
    assert.equal(await wsStatus(`/collab/${encodeURIComponent("file:src/app.js")}`, editor.cookie, "http://evil.example"), 403);
    assert.equal(await wsStatus(`/collab/${encodeURIComponent("file:../../etc/passwd")}`, editor.cookie), 403);
    assert.equal(await wsStatus(`/collab/${encodeURIComponent("file:.env")}`, editor.cookie), 403);
    assert.equal(await wsStatus(`/collab/${encodeURIComponent("file:ignored.txt")}`, editor.cookie), 403);

    // A viewer can read but its edits never reach the shared document.
    const cv = await client(server, viewer.cookie, "src/app.js");
    cv.text.insert(0, "viewer was here");
    await sleep(300);
    assert.equal(server.docs.get("src/app.js")!.text.toString(), "x\n");
    cv.close();

    // Role checks and CSRF header.
    const created = await api(server, editor.cookie, "POST", "/api/tasks", { id: "T1", objective: "x", scope: ["src/app.js"] });
    assert.equal(created.status, 201);
    assert.equal((await api(server, editor.cookie, "POST", "/api/tasks/T1/transition", { to: "queued" })).status, 403, "editors cannot approve");
    assert.equal((await api(server, editor.cookie, "POST", "/api/tasks", { id: "T2", objective: "x", scope: ["src/app.js"], verify: ["rm -rf /"] })).status, 403, "editors cannot define commands");
    assert.equal((await api(server, editor.cookie, "POST", "/api/tasks", { id: "T3", objective: "x", scope: [".env"] })).status, 403);
    assert.equal((await api(server, editor.cookie, "POST", "/api/tasks", { id: "T4", objective: "x", scope: ["src/app.js"] }, {})).status, 403, "missing x-relay header");
    const viewerOut = await api(server, viewer.cookie, "POST", "/api/logout");
    assert.equal(viewerOut.status, 200);
    assert.equal((await api(server, viewer.cookie, "GET", "/api/state")).status, 401, "signing out ends the session server-side");
    server.members.revoke(editor.id);
    assert.equal((await api(server, editor.cookie, "GET", "/api/state")).status, 401, "revoked members lose access");
  } finally {
    await server.close();
  }
});

test("the IDE API goes through the engine: the integration gate cannot be bypassed", async () => {
  const { server, repo } = await testServer({ "src/server.js": "export const u = {name:'a'};\n", "src/ui.js": "export const g = (u) => u.name;\n" });
  try {
    const owner = await join(server, "Olu", "owner");
    const editor = await join(server, "Ed", "editor");
    await api(server, owner.cookie, "POST", "/api/contracts", { id: "user-api", definition: "{name}" });
    await api(server, owner.cookie, "POST", "/api/contracts/user-api/1/accept");
    for (const [id, file] of [["T-api", "src/server.js"], ["T-ui", "src/ui.js"]]) {
      assert.equal((await api(server, editor.cookie, "POST", "/api/tasks", { id, objective: id, scope: [file], contracts: ["user-api"] })).status, 201);
      assert.equal((await api(server, owner.cookie, "POST", `/api/tasks/${id}/transition`, { to: "queued" })).status, 200);
      assert.equal((await api(server, editor.cookie, "POST", `/api/tasks/${id}/transition`, { to: "running" })).status, 200);
    }
    writeFileSync(pjoin(repo, "src/ui.js"), "export const g = (u) => u.fullName;\n");
    await api(server, editor.cookie, "POST", "/api/tasks/T-ui/transition", { to: "review_required" });
    await api(server, editor.cookie, "POST", "/api/tasks/T-ui/check");
    const done = await api(server, owner.cookie, "POST", "/api/tasks/T-ui/transition", { to: "completed" });
    assert.equal(done.status, 409);
    assert.match(done.body.message, /shares a contract with unfinished task\(s\) T-api/);
    const why = await api(server, editor.cookie, "GET", "/api/tasks/T-ui/why");
    assert.ok(why.body.gaps.some((g: string) => /T-api/.test(g)));
    assert.equal(why.body.ladder.humanApproved, false);
  } finally {
    await server.close();
  }
});

test("search and source-control endpoints see shared edits and never leak secrets", async () => {
  const { server, repo } = await testServer({ "src/app.js": "const token = readToken();\n", ".env": "TOKEN=hunter2\n" });
  try {
    writeFileSync(pjoin(repo, ".env"), "TOKEN=hunter2 token\n");
    const ed = await join(server, "Ed");
    const c = await client(server, ed.cookie, "src/app.js");
    after(() => c.close());
    c.text.insert(0, "// rotate the token weekly\n");
    await until(() => server.docs.get("src/app.js")!.text.toString().startsWith("// rotate"), 2000, "applied");
    const found = (await api(server, ed.cookie, "GET", "/api/search?q=TOKEN")).body;
    assert.deepEqual(found.hits.map((h: { path: string; line: number }) => `${h.path}:${h.line}`), ["src/app.js:1", "src/app.js:2"]);
    const git = (await api(server, ed.cookie, "GET", "/api/git")).body;
    assert.deepEqual(git.changes, [{ path: "src/app.js", status: "modified" }], ".env is never reported");
    assert.equal(git.branch, "main");
    assert.equal((await api(server, null, "GET", "/api/search?q=x")).status, 401);
  } finally {
    await server.close();
  }
});

test("remote carets and selections stay on the same text while others insert and delete before them", async () => {
  const { server } = await testServer({ "src/app.js": "export const greeting = 'hi';\n" });
  try {
    const a = await join(server, "Ada");
    const b = await join(server, "Bo");
    const c = await join(server, "Cy");
    const ca = await client(server, a.cookie, "src/app.js");
    const cb = await client(server, b.cookie, "src/app.js");
    const cc = await client(server, c.cookie, "src/app.js");
    // Ada selects the word "greeting", encoded the way y-codemirror does: Yjs relative positions.
    const start = ca.text.toString().indexOf("greeting");
    const rel = (i: number) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ca.text, i));
    ca.provider.awareness.setLocalStateField("user", { id: a.id, name: "Ada", color: "#8b5cf6" });
    ca.provider.awareness.setLocalStateField("cursor", { anchor: rel(start), head: rel(start + "greeting".length) });
    // Bo and Cy edit before the selection, concurrently: inserts, a deletion, and an overlapping insert at the same spot.
    cb.text.insert(0, "// header from Bo\n");
    cc.text.insert(0, "/* Cy */ ");
    cc.text.delete(cc.text.toString().indexOf("const"), "const ".length);
    cc.text.insert(cc.text.toString().indexOf("greeting"), "let ");
    await until(() => ca.text.toString() === cb.text.toString() && cb.text.toString() === cc.text.toString(), 3000, "convergence");
    const resolveOn = (cl: Client) => {
      const s = [...cl.provider.awareness.getStates().values()].find((x) => x.user?.id === a.id)?.cursor;
      if (!s) return null;
      const abs = (j: unknown) => Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(j), cl.doc)!.index;
      return cl.text.toString().slice(abs(s.anchor), abs(s.head));
    };
    await until(() => resolveOn(cb) !== null && resolveOn(cc) !== null, 3000, "presence");
    assert.equal(resolveOn(cb), "greeting");
    assert.equal(resolveOn(cc), "greeting");
    // After Bo drops and reconnects, Ada's selection comes back at once (not at the next 15 s renewal) on the same text.
    restorePresenceOnReconnect(cb.provider); // what the IDE's DocSession does
    cb.provider.disconnect();
    cc.text.insert(0, "\n");
    cb.provider.connect();
    await until(() => cb.text.toString() === cc.text.toString() && resolveOn(cb) === "greeting", 3000, "reconnect");
    for (const x of [ca, cb, cc]) x.close();
  } finally {
    await server.close();
  }
});

test("events recorded by the server are pushed to /events subscribers at once, not on the next poll", async () => {
  const { server } = await testServer();
  try {
    const { cookie } = await join(server, "Ev");
    const ws = new WS(`${server.url.replace("http", "ws")}/events`, { headers: { cookie } });
    await new Promise((ok) => ws.once("open", ok));
    const lat: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      const got = new Promise<void>((ok) => {
        const f = (raw: WS.RawData) => (JSON.parse(String(raw)) as { events: { type: string; data: { i: number } }[] }).events.some((e) => e.type === "test.ping" && e.data.i === i) && (ws.off("message", f), ok());
        ws.on("message", f);
      });
      server.relay.record("test.ping", "system:test", { i });
      await got;
      lat.push(performance.now() - t0);
    }
    ws.close();
    lat.sort((a, b) => a - b);
    assert.ok(lat[3]! < 100, `median ${lat[3]!.toFixed(1)} ms; the poll interval is 200 ms`);
  } finally {
    await server.close();
  }
});
