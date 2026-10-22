/**
 * Runs inside the VS Code extension host (see run.ts). Ada is this VS Code window; Bo is a second, real Yjs client
 * connected to the same Relay server, as the browser IDE would be.
 */
import * as vscode from "vscode";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WS from "ws";
import type { RelayApi } from "../src/extension.ts";

const env = (k: string) => process.env[k] ?? assert.fail(`${k} not set`);
const SERVER = env("RELAY_TEST_SERVER");
const BO_COOKIE = env("RELAY_TEST_BO_COOKIE");
const BO_ID = env("RELAY_TEST_BO_ID");
const CHECKOUT = env("RELAY_TEST_CHECKOUT");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 5000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

async function boApi<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${SERVER}/api${path}`, { method, headers: { cookie: BO_COOKIE, "x-relay": "1", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

/** Bo: a stock y-websocket client, like the browser IDE's. */
async function bo(path: string): Promise<{ doc: Y.Doc; text: Y.Text; provider: WebsocketProvider; close(): void }> {
  const doc = new Y.Doc();
  class AuthedWS extends WS {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols, { headers: { cookie: BO_COOKIE } });
    }
  }
  const provider = new WebsocketProvider(`${SERVER.replace("http", "ws")}/collab`, encodeURIComponent(`file:${path}`), doc, { WebSocketPolyfill: AuthedWS as unknown as typeof WebSocket, disableBc: true });
  provider.awareness.setLocalStateField("user", { id: BO_ID, name: "Bo", color: "#2f80ed", colorLight: "#2f80ed33" });
  await new Promise<void>((ok) => provider.on("sync", (s: boolean) => s && ok()));
  return { doc, text: doc.getText("content"), provider, close: () => (provider.destroy(), doc.destroy()) };
}

let relay: RelayApi;
const uri = (p: string) => vscode.Uri.file(join(CHECKOUT, p));
async function openShared(p: string): Promise<vscode.TextEditor> {
  const ed = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri(p)));
  await until(() => relay.syncFor(ed.document.uri)?.bound === true && relay.syncFor(ed.document.uri)?.state === "synced", 8000, `${p} to be shared`);
  return ed;
}
async function type(text: string): Promise<void> {
  for (const ch of text) await vscode.commands.executeCommand("type", { text: ch });
}
const caretAt = (ed: vscode.TextEditor, offset: number) => {
  const p = ed.document.positionAt(offset);
  ed.selection = new vscode.Selection(p, p);
};

const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

test("joining with an invite link connects this folder to the project", async () => {
  const ext = vscode.extensions.getExtension<RelayApi>("relay.relay-vscode")!;
  relay = await ext.activate();
  await vscode.commands.executeCommand("relay.join", env("RELAY_TEST_INVITE"));
  await until(() => relay.connection?.me?.name === "Ada", 5000, "the session");
  assert.equal(relay.connection!.me!.role, "owner");
  assert.match(relay.statusText(), /^Relay: /);
});

test("typing in VS Code reaches everyone, credited to the person who typed it", async () => {
  const b = await bo("src/app.js");
  try {
    const ed = await openShared("src/app.js");
    assert.equal(ed.document.getText(), b.text.toString(), "same text on both sides");
    caretAt(ed, ed.document.getText().indexOf("'Hello '") + "'Hello".length);
    await type(", dear");
    await until(() => b.text.toString().includes("'Hello, dear '"), 5000, "Ada's typing at Bo");
    const r = await boApi<{ origins: { author: string; text: string }[] }>("GET", `/attribution/line?path=src/app.js&line=2`);
    assert.ok(r.body.origins.some((o) => o.author === relay.connection!.me!.id && o.text.includes(", dear")), JSON.stringify(r.body.origins));
    await until(() => relay.statusText().startsWith("Relay: Synced"), 5000, "the server to confirm the edit");
  } finally {
    b.close();
  }
});

test("a collaborator's edits appear in VS Code, and concurrent typing converges", async () => {
  const b = await bo("src/app.js");
  try {
    const ed = await openShared("src/app.js");
    // Bo appends lines while Ada types on line 1.
    caretAt(ed, ed.document.getText().indexOf("(name)"));
    const typing = type("Person");
    for (let i = 0; i < 8; i++) {
      b.text.insert(b.text.length, `// bo ${i}\n`);
      await sleep(15);
    }
    await typing;
    await until(() => ed.document.getText() === b.text.toString() && b.text.toString().includes("greetPerson") && b.text.toString().includes("// bo 7"), 8000, `convergence (vscode: ${JSON.stringify(ed.document.getText())}, bo: ${JSON.stringify(b.text.toString())})`);
    assert.equal(ed.document.getText().match(/\/\/ bo \d/g)?.length, 8, "every line of Bo's once");
  } finally {
    b.close();
  }
});

test("heavy interleaving: both type fast on the same line and elsewhere; nothing is lost or duplicated", async () => {
  const b = await bo("src/app.js");
  try {
    const ed = await openShared("src/app.js");
    const line = "// race: \n";
    b.text.insert(0, line);
    await until(() => ed.document.getText().startsWith(line), 5000, "the race line in VS Code");
    caretAt(ed, "// race: ".length);
    const ada = "abcdefghijklmnopqrstuvwxyz0123456789";
    const typing = type(ada);
    const boText = "BO-WAS-HERE";
    for (let i = 0; i < boText.length; i++) {
      // Bo types at the start of the same line's comment text, and adds a line at the end of the file each time.
      b.text.insert(3 + i, boText[i]!);
      b.text.insert(b.text.length, `// tail ${i}\n`);
      await sleep(7);
    }
    await typing;
    await until(() => ed.document.getText() === b.text.toString(), 10000, `convergence (vscode: ${JSON.stringify(ed.document.getText().slice(0, 120))}, bo: ${JSON.stringify(b.text.toString().slice(0, 120))})`);
    const final = b.text.toString();
    assert.ok(final.includes(ada), `Ada's typing is intact and in order: ${JSON.stringify(final)}`);
    assert.ok(final.includes(boText), `Bo's typing is intact and in order: ${JSON.stringify(final.split("\n")[0])}`);
    assert.equal(final.match(/\/\/ tail \d+/g)?.length, boText.length, "every tail line once");
  } finally {
    b.close();
  }
});

test("undo in a shared file reverts only your own edits, never a collaborator's", async () => {
  const b = await bo("src/undo.js");
  try {
    const ed = await openShared("src/undo.js");
    caretAt(ed, ed.document.getText().length);
    await type("mine");
    await until(() => b.text.toString().includes("mine"), 5000, "Ada's edit at Bo");
    b.text.insert(0, "// Bo's line\n");
    await until(() => ed.document.getText().startsWith("// Bo's line"), 5000, "Bo's edit in VS Code");
    // Ctrl+Z in a shared file runs relay.undo (keybinding); call the command as the key would.
    await vscode.commands.executeCommand("relay.undo");
    await until(() => !b.text.toString().includes("mine"), 5000, "the undo to reach Bo");
    assert.ok(b.text.toString().startsWith("// Bo's line"), "Bo's text survives Ada's undo");
    await until(() => ed.document.getText() === b.text.toString(), 5000, "the editor to match");
    await vscode.commands.executeCommand("relay.redo");
    await until(() => b.text.toString().includes("mine"), 5000, "redo");
  } finally {
    b.close();
  }
});

test("carets are shared in the browser IDE's format, both ways", async () => {
  const b = await bo("src/presence.js");
  try {
    const ed = await openShared("src/presence.js");
    // Bo puts his caret before "b" on line 2, as y-codemirror does (relative positions).
    const at = b.text.toString().indexOf("b =");
    b.provider.awareness.setLocalStateField("cursor", { anchor: Y.createRelativePositionFromTypeIndex(b.text, at), head: Y.createRelativePositionFromTypeIndex(b.text, at) });
    const sync = relay.syncFor(ed.document.uri)!;
    await until(() => sync.peers().some((p) => p.member.id === BO_ID && p.head === at), 5000, "Bo's caret in VS Code");
    assert.match(relay.statusText(), /2 here/);
    // Ada moves her caret; Bo resolves it to the same place.
    caretAt(ed, ed.document.getText().indexOf("a ="));
    const want = b.text.toString().indexOf("a =");
    await until(() => {
      for (const [cid, s] of b.provider.awareness.getStates()) {
        if (cid === b.doc.clientID || !s.cursor?.head) continue;
        const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(s.cursor.head), b.doc);
        if (s.user?.name === "Ada" && abs?.index === want) return true;
      }
      return false;
    }, 5000, "Ada's caret at Bo");
  } finally {
    b.close();
  }
});

test("a file that differs from the shared copy is never overwritten without a choice; the setting decides", async () => {
  const cfg = vscode.workspace.getConfiguration("relay");
  // The developer edited src/other.js locally before joining.
  writeFileSync(join(CHECKOUT, "src/other.js"), "export const other = 2; // local change\n");
  await cfg.update("whenFilesDiffer", "shareMine", vscode.ConfigurationTarget.Workspace);
  try {
    const b = await bo("src/other.js");
    try {
      const ed = await openShared("src/other.js");
      await until(() => b.text.toString() === "export const other = 2; // local change\n", 5000, "the local version shared");
      assert.equal(ed.document.getText(), b.text.toString());
    } finally {
      b.close();
    }
    // And the opposite choice, on a file someone changed in Relay while this checkout stayed behind.
    const b2 = await bo("README.md");
    b2.text.insert(b2.text.length, "Shared since you cloned.\n");
    await sleep(200);
    await cfg.update("whenFilesDiffer", "useShared", vscode.ConfigurationTarget.Workspace);
    const ed2 = await openShared("README.md");
    assert.equal(ed2.document.getText(), "# Demo\nShared since you cloned.\n");
    assert.equal(readFileSync(join(CHECKOUT, "README.md"), "utf8"), "# Demo\n", "the local file on disk is only changed when you save");
    b2.close();
  } finally {
    await cfg.update("whenFilesDiffer", undefined, vscode.ConfigurationTarget.Workspace);
  }
});

test("line history: an edit session opens as a read-only diff from Relay", async () => {
  const r = await boApi<{ origins: { author: string; session: string | null; text: string }[] }>("GET", `/attribution/line?path=src/app.js&line=2`);
  const mine = r.body.origins.find((o) => o.author === relay.connection!.me!.id && o.session)!;
  assert.ok(mine, JSON.stringify(r.body.origins));
  const after = await vscode.workspace.openTextDocument(vscode.Uri.parse(`relay-session:/${mine.session}/after/src/app.js`));
  const before = await vscode.workspace.openTextDocument(vscode.Uri.parse(`relay-session:/${mine.session}/before/src/app.js`));
  assert.match(after.getText(), /Hello, dear/);
  assert.doesNotMatch(before.getText(), /Hello, dear/);
});

test("the Coordination view shows the project's tasks with the server's status", async () => {
  await relay.refreshCoordination();
  const tasks = (await relay.connection!.request<{ tasks: { id: string; status: string }[] }>("GET", "/coordination")).tasks;
  assert.ok(tasks.some((t) => t.id === "T-docs" && t.status === "proposed"));
  await vscode.commands.executeCommand("workbench.view.extension.relay");
});

test("a file renamed in Relay stops being shared under its old name, and says so", async () => {
  const ed = await openShared("src/rename.js");
  const sync = relay.syncFor(ed.document.uri)!;
  const r = await boApi("POST", "/files/rename", { from: "src/rename.js", to: "src/renamed.js" });
  assert.equal(r.status, 200);
  await until(() => sync.state === "gone", 5000, "the old document to close");
  await vscode.window.showTextDocument(ed.document);
  assert.match(relay.statusText(), /Moved or deleted in Relay/);
});

export async function run(): Promise<void> {
  const failures: string[] = [];
  for (const [name, fn] of tests) {
    const t0 = Date.now();
    try {
      await fn();
      console.log(`ok - ${name} (${Date.now() - t0} ms)`);
    } catch (e) {
      failures.push(name);
      console.log(`not ok - ${name}\n  ${(e as Error).stack?.split("\n").slice(0, 4).join("\n  ")}`);
    }
  }
  console.log(`# pass ${tests.length - failures.length}\n# fail ${failures.length}`);
  if (failures.length) throw new Error(`${failures.length} test(s) failed`);
}
