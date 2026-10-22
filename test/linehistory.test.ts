/**
 * Line history: who wrote each part of a line, when, and in which edit session — with real y-websocket clients, so the
 * answer comes from the same update log and authorship records the editor uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { api, client, join as joinAs, testServer, until } from "./collab-helpers.ts";
import { startServer } from "../src/server/server.ts";
import { request as httpRequest } from "node:http";

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

type Origin = { author: string; kind: string; text: string; at: string | null; seq: number | null; session: string | null };
/** GET over a fresh connection, so a request right after a server restart never reuses a socket the old server closed. */
const fresh = (url: string, cookie: string, body?: unknown) =>
  new Promise<{ status: number; body: { origins: Origin[] } }>((ok, fail) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(url, { method: payload ? "POST" : "GET", agent: false, headers: { cookie, "x-relay": "1", ...(payload ? { "content-type": "application/json" } : {}) } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null }));
    });
    req.on("error", fail);
    req.end(payload);
  });
const origins = async (server: Awaited<ReturnType<typeof testServer>>["server"], cookie: string, path: string, line: number) => {
  const r = await fresh(`${server.url}/api/attribution/line?path=${encodeURIComponent(path)}&line=${line}`, cookie);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.origins as Origin[];
};

test("line history stays right through splits, joins, undo, outside edits and agent edits", { timeout: 30_000 }, async () => {
  const { server, repo } = await testServer({ "src/app.js": "const base = 0;\n" });
  const open: { close(): void }[] = [];
  try {
    const ada = await joinAs(server, "Ada", "editor");
    const bo = await joinAs(server, "Bo", "editor");
    const ca = await client(server, ada.cookie, "src/app.js");
    const cb = await client(server, bo.cookie, "src/app.js");
    open.push(ca, cb);
    ca.text.insert(ca.text.length, "const adaValue = 1;\n");
    await until(() => cb.text.toString().includes("adaValue"));
    cb.text.insert(cb.text.length, "const boValue = 2;\n");
    await until(() => server.docs.get("src/app.js")!.text.toString().includes("boValue") && ca.text.toString().includes("boValue"));

    // Split: Bo breaks Ada's line in two. Both halves are still Ada's words; the line break isn't text anyone "wrote".
    const at = cb.text.toString().indexOf("= 1;");
    cb.text.insert(at, "\n  ");
    await until(() => server.docs.get("src/app.js")!.text.toString().includes("adaValue \n  = 1;"));
    const top = await origins(server, ada.cookie, "src/app.js", 2);
    const bottom = await origins(server, ada.cookie, "src/app.js", 3);
    assert.deepEqual(top.map((o) => o.author), [ada.id], JSON.stringify(top));
    assert.deepEqual(bottom.map((o) => o.author), [ada.id], "indentation is whitespace: not counted as Bo's writing");
    assert.equal(bottom[0]!.text.trim(), "= 1;");

    // Join: Ada removes the break between her line and Bo's. The joined line names both, in order.
    await until(() => ca.text.toString().includes("adaValue \n  = 1;"));
    const nl = ca.text.toString().indexOf("1;\n") + 2;
    ca.text.delete(nl, 1);
    await until(() => server.docs.get("src/app.js")!.text.toString().includes("= 1;const boValue"));
    const joined = await origins(server, ada.cookie, "src/app.js", 3);
    assert.deepEqual(joined.map((o) => o.author), [ada.id, bo.id], JSON.stringify(joined));
    assert.ok(joined.every((o) => o.at && o.seq && o.session), "each part has its time, update and session");

    // Undo: Ada types and undoes; nothing of hers remains on Bo's text, and no history points at removed text.
    const undo = new (await import("yjs")).UndoManager(ca.text);
    ca.text.insert(ca.text.length, "const tmp = 3;\n");
    await until(() => server.docs.get("src/app.js")!.text.toString().includes("tmp"));
    undo.undo();
    await until(() => !server.docs.get("src/app.js")!.text.toString().includes("tmp"));
    const lines = server.docs.get("src/app.js")!.text.toString().split("\n");
    assert.equal(lines.length, 4, JSON.stringify(lines));
    assert.deepEqual(await origins(server, ada.cookie, "src/app.js", 4), [], "the undone line is gone from history's view of the file");

    // Outside edit on disk: credited to "changed outside Relay", never to a person.
    server.docs.flushAll();
    const { writeFileSync, readFileSync } = await import("node:fs");
    const file = `${repo}/src/app.js`;
    writeFileSync(file, readFileSync(file, "utf8").replace("const base = 0;", "const base = 10; // tuned"));
    await until(() => server.docs.get("src/app.js")!.text.toString().includes("// tuned"), 5000, "the outside edit merged");
    const disk = await origins(server, ada.cookie, "src/app.js", 1);
    assert.ok(disk.some((o) => o.kind === "disk" && o.text.includes("// tuned")), JSON.stringify(disk));
    assert.ok(!disk.some((o) => o.author === ada.id || o.author === bo.id));

    // An applied agent run: credited to the agent.
    server.docs.applyText("src/app.js", server.docs.get("src/app.js")!.text.toString() + "export const fromAgent = true;\n", "agent:claude-code");
    const agent = await origins(server, ada.cookie, "src/app.js", 4);
    assert.deepEqual(agent.map((o) => [o.kind, o.author]), [["agent", "agent:claude-code"]]);
  } finally {
    for (const c of open) c.close();
    await server.close();
  }
});

test("line history survives a rename and a server restart, and edits made offline are credited on arrival", { timeout: 30_000 }, async () => {
  const first = await testServer({ "src/old.js": "const kept = 1;\n" });
  let server = first.server;
  const open: { close(): void }[] = [];
  try {
    const ada = await joinAs(server, "Ada", "editor");
    const bo = await joinAs(server, "Bo", "editor");
    const ca = await client(server, ada.cookie, "src/old.js");
    open.push(ca);
    ca.text.insert(ca.text.length, "const fromAda = 2;\n");
    await until(() => server.docs.get("src/old.js")?.text.toString().includes("fromAda") ?? false);
    const before = await origins(server, ada.cookie, "src/old.js", 2);
    assert.equal(before[0]!.author, ada.id);

    // Bo edits offline, then reconnects.
    const cb = await client(server, bo.cookie, "src/old.js");
    open.push(cb);
    cb.provider.disconnect();
    cb.text.insert(cb.text.length, "const offline = 3;\n");
    const t0 = Date.now();
    cb.provider.connect();
    await until(() => server.docs.get("src/old.js")!.text.toString().includes("offline"), 5000, "Bo's offline edit");
    const off = await origins(server, ada.cookie, "src/old.js", 3);
    assert.equal(off[0]!.author, bo.id);
    assert.ok(off[0]!.session, "an offline edit still belongs to an edit session");
    assert.ok(Date.parse(off[0]!.at!) >= t0 - 1000, "the time shown is when the server received it");

    // Rename: same authors, updates and sessions under the new name.
    const ren = await api(server, ada.cookie, "POST", "/api/files/rename", { from: "src/old.js", to: "src/new.js" });
    assert.equal(ren.status, 200);
    for (const c of open.splice(0)) c.close();
    const renamed = await origins(server, ada.cookie, "src/new.js", 2);
    assert.deepEqual(renamed, before, "history moved with the file, unchanged");
    const sides = await api(server, ada.cookie, "GET", `/api/sessions/${renamed[0]!.session}/sides`);
    assert.equal(sides.status, 200);
    assert.equal(sides.body.path, "src/new.js");
    assert.match(sides.body.after, /fromAda/);
    const all = [1, 2, 3].map((l) => origins(server, ada.cookie, "src/new.js", l));
    const snapshot = await Promise.all(all);

    // Restart on the same database: identical answers.
    const port = Number(new URL(server.url).port);
    await server.close();
    server = await startServer({ root: first.repo, dbPath: first.dbPath, port, flushMs: 30 });
    const again = await Promise.all([1, 2, 3].map((l) => origins(server, ada.cookie, "src/new.js", l)));
    assert.deepEqual(again, snapshot, "line history is the same after a restart");
    // And a new file at the old path starts with a clean history.
    assert.equal((await fresh(`${server.url}/api/files`, ada.cookie, { path: "src/old.js" })).status, 201);
    assert.deepEqual(await origins(server, ada.cookie, "src/old.js", 2), []);
  } finally {
    for (const c of open) c.close();
    await server.close();
  }
});
