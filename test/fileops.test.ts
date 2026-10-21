/**
 * Replace in Files, rename, delete and new folder through the real server and real Yjs clients: edits reach open
 * editors live and are credited to the person; renamed files keep their history; deleted files are never revived by a
 * client that still had them open.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { api, client, join as joinAs, testServer, until, sleep } from "./collab-helpers.ts";
import { lineAuthors } from "../src/server/attribution.ts";

const FILES = {
  "src/a.js": "const user = getUser();\nlog(user);\n",
  "src/b.js": "// getUser returns the user\nexport function getUser() {}\n",
  "src/keep.js": "nothing to see\n",
  "README.md": "# demo\n",
};

test("replace in files: dry run counts; the real run edits shared documents live, credited to the person, and nothing else", async () => {
  const { server, repo } = await testServer(FILES);
  try {
    const ada = await joinAs(server, "Ada", "editor");
    const bo = await joinAs(server, "Bo", "editor");
    const boA = await client(server, bo.cookie, "src/a.js");
    const paths = ["src/a.js", "src/b.js", "src/keep.js"];
    const dry = await api(server, ada.cookie, "POST", "/api/replace", { query: "getUser", replacement: "loadUser", paths, dryRun: true });
    assert.equal(dry.status, 200);
    assert.deepEqual(dry.body.files, [{ path: "src/a.js", count: 1 }, { path: "src/b.js", count: 2 }]);
    assert.equal(boA.text.toString(), FILES["src/a.js"], "a dry run changes nothing");

    const run = await api(server, ada.cookie, "POST", "/api/replace", { query: "getUser", replacement: "loadUser", paths, matchCase: true });
    assert.equal(run.body.replacements, 3);
    await until(() => boA.text.toString().includes("loadUser"), 3000, "Bo's open editor to update");
    assert.equal(boA.text.toString(), "const user = loadUser();\nlog(user);\n");
    server.docs.flushAll();
    assert.equal(readFileSync(join(repo, "src/b.js"), "utf8"), "// loadUser returns the user\nexport function loadUser() {}\n");
    // Only the replaced text is Ada's: line 2 of a.js, untouched, keeps its original author.
    const lines = lineAuthors(server.docs, "src/a.js");
    assert.ok(lines[0]!.authors.includes(ada.id), `the replaced word on line 1 is Ada's: ${JSON.stringify(lines[0])}`);
    assert.ok(lines[0]!.authors.includes("relay:baseline"), "the rest of line 1 keeps its author");
    assert.ok(!lines[1]!.authors.includes(ada.id), "line 2 was not touched");

    const viewer = await joinAs(server, "Vi", "viewer");
    assert.equal((await api(server, viewer.cookie, "POST", "/api/replace", { query: "user", replacement: "x", paths })).status, 403);
    boA.close();
  } finally {
    await server.close();
  }
});

test("replace in files: regex with groups, whole word, invalid patterns and secrets refused", async () => {
  const { server } = await testServer(FILES);
  try {
    const ada = await joinAs(server, "Ada", "editor");
    const r = await api(server, ada.cookie, "POST", "/api/replace", { query: "(\\w+)\\(user\\)", replacement: "$1(person)", regex: true, paths: ["src/a.js"] });
    assert.equal(r.body.replacements, 1);
    assert.equal(server.docs.get("src/a.js")!.text.toString(), "const user = getUser();\nlog(person);\n");
    const w = await api(server, ada.cookie, "POST", "/api/replace", { query: "user", replacement: "U", wholeWord: true, paths: ["src/b.js"], dryRun: true });
    assert.deepEqual(w.body.files, [{ path: "src/b.js", count: 1 }], "getUser isn't the word user");
    assert.equal((await api(server, ada.cookie, "POST", "/api/replace", { query: "(", replacement: "", regex: true, paths: ["src/a.js"] })).status, 400);
    assert.equal((await api(server, ada.cookie, "POST", "/api/replace", { query: "x", replacement: "", paths: [".env"] })).status, 403);
    const s = await api(server, ada.cookie, "GET", "/api/search?q=USER&case=1");
    assert.equal(s.body.hits.length, 0, "match case");
    const s2 = await api(server, ada.cookie, "GET", "/api/search?q=get%5Cw%2B&regex=1");
    assert.ok(s2.body.hits.length >= 2, "regex search");
  } finally {
    await server.close();
  }
});

test("rename keeps history and moves open editors off the old path; delete can't be undone by a stale client", async () => {
  const { server, repo } = await testServer(FILES);
  try {
    const ada = await joinAs(server, "Ada", "editor");
    const a = await client(server, ada.cookie, "src/a.js");
    a.text.insert(0, "// Ada was here\n");
    await until(() => server.docs.get("src/a.js")?.text.toString().startsWith("// Ada") ?? false);
    let closedWith = 0;
    a.provider.on("connection-close", (e: CloseEvent | null) => (closedWith = e?.code ?? closedWith));

    const r = await api(server, ada.cookie, "POST", "/api/files/rename", { from: "src/a.js", to: "lib/app.js" });
    assert.equal(r.status, 200);
    await until(() => closedWith === 4410, 3000, "the old document's connection to close with 4410");
    a.close();
    assert.ok(!existsSync(join(repo, "src/a.js")));
    assert.equal(readFileSync(join(repo, "lib/app.js"), "utf8"), "// Ada was here\nconst user = getUser();\nlog(user);\n");
    const moved = await client(server, ada.cookie, "lib/app.js");
    assert.equal(moved.text.toString(), "// Ada was here\nconst user = getUser();\nlog(user);\n");
    assert.deepEqual(lineAuthors(server.docs, "lib/app.js")[0]!.authors, [ada.id], "authorship moved with the file");
    moved.close();
    assert.equal((await api(server, ada.cookie, "POST", "/api/files/rename", { from: "src/b.js", to: "README.md" })).status, 409);

    // Delete while someone still has the file open: their client is told, and reconnecting never writes it back.
    const b = await client(server, ada.cookie, "src/b.js");
    const d = await api(server, ada.cookie, "POST", "/api/files/delete", { path: "src/b.js" });
    assert.deepEqual(d.body.files, ["src/b.js"]);
    b.text.insert(0, "zombie edit\n");
    await sleep(600);
    server.docs.flushAll();
    assert.ok(!existsSync(join(repo, "src/b.js")), "the deleted file stays deleted");
    b.close();
    // A new file at the same path starts empty, not with the old history.
    assert.equal((await api(server, ada.cookie, "POST", "/api/files", { path: "src/b.js" })).status, 201);
    assert.equal(server.docs.get("src/b.js")!.text.toString(), "");
    assert.equal(readFileSync(join(repo, "src/b.js"), "utf8"), "", "a new empty file is on disk straight away");
    assert.ok((await api(server, ada.cookie, "GET", "/api/files")).body.files.includes("src/b.js"));

    assert.equal((await api(server, ada.cookie, "POST", "/api/folders", { path: "empty/inner" })).status, 201);
    const files = await api(server, ada.cookie, "GET", "/api/files");
    assert.ok(files.body.folders.includes("empty/inner"), JSON.stringify(files.body.folders));
    assert.equal((await api(server, ada.cookie, "POST", "/api/files/delete", { path: "empty" })).status, 200);
    assert.ok(!existsSync(join(repo, "empty")));
    const viewer = await joinAs(server, "Vi", "viewer");
    assert.equal((await api(server, viewer.cookie, "POST", "/api/files/delete", { path: "README.md" })).status, 403);
  } finally {
    await server.close();
  }
});
