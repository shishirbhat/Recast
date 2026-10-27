/**
 * The VS Code-style Explorer, search and symbol operations on a real server: rename and delete keep what
 * collaborators typed and stop stale tabs from recreating files; delete is recoverable; search honours Match Case,
 * Whole Word, Regex and include/exclude; Replace in Files edits the shared documents as the person's own edit;
 * symbols come from the TypeScript parser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { api, client, join as joinAs, testServer, until } from "./collab-helpers.ts";

const FILES = {
  "src/app.js": "export function greet(name) {\n  return 'Hello ' + name;\n}\n\nexport const VERSION = 1;\nclass Shop {\n  open() {}\n}\n",
  "src/util.ts": "export interface User { id: string }\nexport type Id = string;\nexport const greetAll = (xs: string[]) => xs.map((x) => 'hello ' + x);\n",
  "docs/guide.md": "# Guide\n\n## Install\n\nSay Hello.\n",
  "notes.txt": "hello Hello HELLO\n",
};

test("explorer: new folder, rename with an open collaborator, delete to trash; stale tabs can't recreate files", async () => {
  const { server, repo } = await testServer(FILES);
  try {
    const ed = await joinAs(server, "Ed", "editor");
    const vi = await joinAs(server, "Vi", "viewer");
    const P = (path: string, body: unknown, who = ed) => api(server, who.cookie, "POST", path, body);

    assert.equal((await P("/api/files/folder", { path: "src/lib" })).status, 201);
    assert.ok(existsSync(join(repo, "src/lib")));
    assert.equal((await P("/api/files/folder", { path: "src/lib" })).status, 409);
    assert.equal((await P("/api/files/rename", { path: "src/app.js", to: "src/main.js" }, vi)).status, 403, "viewers can't rename");

    // A collaborator has the file open and types; renaming keeps the typing and closes their old editor (4404).
    const c = await client(server, ed.cookie, "src/app.js");
    c.text.insert(0, "// typed before the rename\n");
    await until(() => !!server.docs.get("src/app.js")?.text.toString().startsWith("// typed"), 3000, "edit synced");
    let closed: number | null = null;
    c.provider.on("connection-close", (e: { code: number } | null) => (closed ??= e?.code ?? null));
    const r = await P("/api/files/rename", { path: "src/app.js", to: "src/main.js" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(readFileSync(join(repo, "src/main.js"), "utf8").startsWith("// typed before the rename"), "nothing typed was lost");
    assert.equal(existsSync(join(repo, "src/app.js")), false);
    await until(() => closed === 4404, 3000, "old editor told the file moved");
    // The stale tab keeps typing into the old path: it must not come back.
    c.text.insert(0, "x");
    await new Promise((ok) => setTimeout(ok, 300));
    assert.equal(existsSync(join(repo, "src/app.js")), false, "a stale tab didn't recreate the old file");
    c.close();
    assert.equal((await P("/api/files/rename", { path: "src/main.js", to: "src/util.ts" })).status, 409, "won't overwrite");

    // Folder rename moves everything under it.
    const fr = await P("/api/files/rename", { path: "docs", to: "handbook" });
    assert.deepEqual(fr.body.moved, [["docs/guide.md", "handbook/guide.md"]]);

    // Delete goes to a recoverable trash outside Git and the file list.
    const d = await P("/api/files/delete", { path: "notes.txt" });
    assert.equal(d.status, 200);
    assert.equal(existsSync(join(repo, "notes.txt")), false);
    assert.equal(readFileSync(join(repo, d.body.trash), "utf8"), "hello Hello HELLO\n");
    const files = (await api(server, ed.cookie, "GET", "/api/files")).body.files as string[];
    assert.ok(!files.some((f) => f.startsWith(".relay")), "trash isn't listed");
    assert.equal((await P("/api/files/delete", { path: ".env" })).status, 403, "protected paths stay protected");
    for (const t of ["file.folder_created", "file.renamed", "file.deleted"]) assert.ok(server.relay.events().some((e) => e.type === t), t);
  } finally {
    await server.close();
  }
});

test("search options, Replace in Files as the person's edit, and parser-based symbols", async () => {
  const { server } = await testServer(FILES);
  try {
    const ed = await joinAs(server, "Ed", "editor");
    const G = async (q: string) => (await api(server, ed.cookie, "GET", q)).body;
    const paths = (r: { hits: { path: string }[] }) => [...new Set(r.hits.map((h) => h.path))].sort();
    assert.deepEqual(paths(await G("/api/search?q=hello")), ["docs/guide.md", "notes.txt", "src/app.js", "src/util.ts"]);
    assert.deepEqual(paths(await G("/api/search?q=Hello&case=1")), ["docs/guide.md", "notes.txt", "src/app.js"]);
    assert.deepEqual(paths(await G("/api/search?q=greet&word=1")), ["src/app.js"], "greetAll isn't a whole-word match");
    assert.deepEqual(paths(await G("/api/search?q=" + encodeURIComponent("H[A-Z]+O") + "&regex=1&case=1")), ["notes.txt"]);
    assert.deepEqual(paths(await G("/api/search?q=hello&include=*.md")), ["docs/guide.md"]);
    assert.deepEqual(paths(await G("/api/search?q=hello&exclude=src/**,*.txt")), ["docs/guide.md"]);
    const hit = (await G("/api/search?q=HELLO&case=1")).hits[0];
    assert.deepEqual([hit.col, hit.length], [13, 5]);
    assert.equal((await api(server, ed.cookie, "GET", "/api/search?q=" + encodeURIComponent("(") + "&regex=1")).status, 400);

    // Replace in Files: regex with a capture group, only the chosen files, credited to Ed.
    const r = await api(server, ed.cookie, "POST", "/api/replace", { query: "hello (\\w+)", replacement: "hi $1", regex: true, paths: ["notes.txt", "src/util.ts"] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.files, [{ path: "notes.txt", replaced: 1 }]);
    assert.equal(server.docs.get("notes.txt")!.text.toString(), "hi Hello HELLO\n");
    const owners = new Set([...server.docs.clientAuthors("notes.txt").values()]);
    assert.ok(owners.has(ed.id), "the replacement is Ed's edit");
    const r2 = await api(server, ed.cookie, "POST", "/api/replace", { query: "hello", replacement: "hey", paths: ["src/app.js", "docs/guide.md"] });
    assert.deepEqual(r2.body.files, [{ path: "src/app.js", replaced: 1 }, { path: "docs/guide.md", replaced: 1 }]);
    assert.equal(server.docs.get("src/app.js")!.text.toString().split("\n")[1], "  return 'hey ' + name;");

    // Symbols: one file (Outline) and the workspace (Go to Symbol / Definition).
    const app = (await G("/api/symbols?path=src/app.js")).symbols.map((s: { name: string; kind: string; depth: number; line: number }) => [s.name, s.kind, s.depth, s.line]);
    assert.deepEqual(app, [["greet", "function", 0, 1], ["VERSION", "constant", 0, 5], ["Shop", "class", 0, 6], ["open", "method", 1, 7]]);
    const util = (await G("/api/symbols?path=src/util.ts")).symbols.map((s: { name: string; kind: string }) => `${s.kind}:${s.name}`);
    assert.deepEqual(util, ["interface:User", "property:id", "type:Id", "function:greetAll"]);
    const md = (await G("/api/symbols?path=docs/guide.md")).symbols.map((s: { name: string; depth: number }) => `${s.depth}:${s.name}`);
    assert.deepEqual(md, ["0:Guide", "1:Install"]);
    const ws = (await G("/api/symbols?q=greet")).symbols.map((s: { name: string; path: string }) => `${s.name}@${s.path}`);
    assert.deepEqual(ws, ["greet@src/app.js", "greetAll@src/util.ts"]);
    const def = (await G("/api/symbols?q=Shop&exact=1")).symbols;
    assert.deepEqual(def.map((s: { path: string; line: number }) => [s.path, s.line]), [["src/app.js", 6]]);
  } finally {
    await server.close();
  }
});
