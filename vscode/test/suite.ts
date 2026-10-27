/**
 * Runs inside the VS Code extension host (see run.ts). Ada is this VS Code window; Bo is a second, real Yjs client
 * connected to the same Relay server, as the browser IDE would be.
 */
import * as vscode from "vscode";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WS from "ws";
import type { RelayApi } from "../src/extension.ts";
import type { Connection } from "../src/connection.ts";
import { RelayError } from "../src/connection.ts";
import { failureMessage, outcome, pendingTasks, preselected } from "../src/checkTogether.ts";

const env = (k: string) => process.env[k] ?? assert.fail(`${k} not set`);
const SERVER = env("RELAY_TEST_SERVER");
const BO_COOKIE = env("RELAY_TEST_BO_COOKIE");
const BO_ID = env("RELAY_TEST_BO_ID");
const CHECKOUT = env("RELAY_TEST_CHECKOUT");
const SIGNALS = env("RELAY_TEST_SIGNALS");

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

test("the browser IDE and VS Code see each other: text and carets both ways", async () => {
  const ed = await openShared("src/interop.js");
  const sync = relay.syncFor(ed.document.uri)!;
  caretAt(ed, ed.document.lineAt(0).text.length);
  await type(" — hello from VS Code");
  // Bea, in a real browser (run.mts), sees it, then types on line 2.
  await until(() => ed.document.getText().includes("hello from the browser"), 120_000, "Bea's typing from the browser");
  await until(() => sync.peers().some((p) => p.member.name === "Bea" && p.head !== null), 5000, "Bea's caret in VS Code");
  caretAt(ed, ed.document.lineAt(0).text.length);
  await sleep(500);
  writeFileSync(join(SIGNALS, "vscode-shot"), "");
  await until(() => existsSync(join(SIGNALS, "vscode-shot-done")), 30_000, "the VS Code screenshot");
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

// ---------- Check Together ----------

/** Hash of every file in the shared project (the server's repository), so "unchanged" means byte for byte. */
function sharedProject(): string {
  const repo = env("RELAY_TEST_REPO");
  const files = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8" }).stdout.split("\n").filter((f) => f && !f.startsWith(".relay/")).sort();
  return files.map((f) => `${f}\0${readFileSync(join(repo, f), "utf8")}`).join("\0");
}
type Coord = { id: string; status: string; partners: string[]; objective: string; why: string; blockers: string[]; files: string[]; run: { status: string; provider: string; worktree: string } | null };

test("Check Together: the view's selection plus its contract partners are preselected; a blocked result is explained and nothing is applied", async () => {
  await relay.refreshCoordination();
  const tasks = (await relay.connection!.request<{ tasks: Coord[] }>("GET", "/coordination")).tasks;
  const ui = tasks.find((t) => t.id === "T-ct-ui")!;
  assert.deepEqual(ui.partners, ["T-ct-api"]);
  // Selecting tasks: only finished work that isn't in the project is offered; partners come preselected.
  assert.deepEqual(pendingTasks(tasks).map((t) => t.id).filter((id) => id.startsWith("T-ct")).sort(), ["T-ct-api", "T-ct-copy", "T-ct-ui"]);
  assert.ok(!pendingTasks(tasks).some((t) => t.id === "T-docs"), "a proposed task isn't offered");
  assert.deepEqual(preselected([ui], pendingTasks(tasks)).sort(), ["T-ct-api", "T-ct-ui"]);

  const before = sharedProject();
  // The real command, as the view's context menu invokes it (clicked node + selection); the picker is accepted as shown.
  const done = vscode.commands.executeCommand("relay.checkTogether", { kind: "task", task: ui }, [{ kind: "task", task: ui }]);
  await sleep(800);
  await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
  await done;
  const last = relay.lastCheck();
  assert.ok(last, "a result was recorded");
  assert.deepEqual([...last.result.tasks].sort(), ["T-ct-api", "T-ct-ui"]);
  assert.equal(last.result.status, "blocked");
  assert.equal(last.result.explanation?.verdict, "confirmed");
  assert.match(last.result.report, /FAIL {2}node --test ct\/ui\.test\.js/);
  assert.match(last.result.report, /ct\/ui\.js:4 reads \.name, which getUser\(\) no longer returns/);
  assert.equal(last.outcome.severity, "error");
  assert.match(last.outcome.message, /^Relay blocked T-ct-api \+ T-ct-ui\. Confirmed cause: T-ct-api changed getUser in ct\/server\.js .* T-ct-ui still reads `name` from getUser\(\) at ct\/ui\.js:4\. .* Nothing was applied\.$/);
  // Blocked: the person can read the report or go back to either task; approving isn't offered.
  assert.deepEqual(last.outcome.actions, ["Show Report", ...last.result.tasks.map((t) => `Show ${t}`)]);
  assert.equal(sharedProject(), before, "the shared project is unchanged");
  const after = (await relay.connection!.request<{ tasks: Coord[] }>("GET", "/coordination")).tasks;
  assert.equal(after.find((t) => t.id === "T-ct-api")!.run?.status, "finished", "the agent work is still pending, not applied");
});

test("Check Together: an unexplained failure says the cause is unknown; an unknown task is refused; approval is offered to owners only", async () => {
  const before = sharedProject();
  const r = await relay.checkTogether(["T-ct-ui", "T-ct-copy"]);
  assert.ok(r);
  assert.equal(r.status, "blocked");
  assert.equal(r.explanation?.verdict, "unknown");
  assert.match(relay.lastCheck()!.outcome.message, /^Relay blocked T-ct-ui \+ T-ct-copy\. \(unknown\) Cause unknown\./);
  assert.match(r.report, /not ok {2}"title" \(ct\/copy\.test\.js:4\): expected 'Shop', got 'Store'/);
  assert.equal(sharedProject(), before);

  // A task that doesn't exist: refused by the server, reported, nothing recorded as a result.
  assert.equal(await relay.checkTogether(["T-ct-api", "T-nope"]), null);
  assert.equal(relay.lastCheck(), null);
  assert.match(failureMessage(new RelayError(404, "Unknown task T-nope"), ["T-ct-api", "T-nope"]), /Refresh the Coordination view/);
  assert.match(failureMessage(new RelayError(403, "Your role (viewer) can't do this."), ["T-ct-api"]), /^You can't check T-ct-api together/);
  // A passing result offers approval to owners only, and never applies by itself.
  const passed = { id: "i", tasks: ["A", "B"], status: "passed" as const, gaps: [], baseCommit: null, tree: "t", explanation: null, report: "" };
  assert.deepEqual(outcome(passed, true).actions, ["Approve and Apply…", "Show Report"]);
  assert.deepEqual(outcome(passed, false).actions, ["Show Report"]);
  assert.match(outcome(passed, false).message, /Nothing has been applied; a project owner must approve it/);
});

// ---------- undo from every entry point ----------

/** The whole (virtual) screen, for evidence and diagnosis. */
function screenshot(name: string): void {
  const dir = join(__dirname, "..", "..", "docs", "evidence", "vscode-extension-2026-10-22");
  spawnSync("mkdir", ["-p", dir]);
  spawnSync("import", ["-window", "root", join(dir, name)]);
}

/** Real keystrokes into the VS Code window, through X's XTEST extension (test/keys.py). */
function keys(...actions: string[]): void {
  const r = spawnSync("python3", [join(__dirname, "..", "test", "keys.py"), ...actions], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`keys.py failed: ${r.stderr || r.error?.message}`);
}
async function focusEditor(ed: vscode.TextEditor): Promise<void> {
  await vscode.window.showTextDocument(ed.document, { preserveFocus: false });
  await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
  keys("move:640,400"); // without a window manager, keyboard focus follows the pointer
}

/** Ada types "mine" at the end, then Bo adds a line at the start: VS Code's own history now ends with Bo's edit. */
async function mineThenBos(path: string): Promise<{ ed: vscode.TextEditor; b: Awaited<ReturnType<typeof bo>>; base: string }> {
  const b = await bo(path);
  const ed = await openShared(path);
  const base = ed.document.getText();
  caretAt(ed, base.length);
  await type("mine");
  await until(() => b.text.toString() === `${base}mine`, 5000, "Ada's edit at Bo");
  b.text.insert(0, "// Bo\n");
  await until(() => ed.document.getText() === `// Bo\n${base}mine`, 5000, "Bo's edit in VS Code");
  return { ed, b, base };
}

test("VS Code's own Undo (Edit menu, Command Palette) reverts only your edit, never the collaborator's last one", async () => {
  const { ed, b, base } = await mineThenBos("src/u1.js");
  try {
    // The command the Edit menu and the palette run. Natively it would undo Bo's line (the latest edit in VS Code's history).
    await vscode.commands.executeCommand("undo");
    await until(() => b.text.toString() === `// Bo\n${base}`, 5000, `Ada's edit undone, Bo's kept (Bo sees ${JSON.stringify(b.text.toString())})`);
    await until(() => ed.document.getText() === b.text.toString(), 5000, "the editor to match");
    // Redo through Relay restores exactly Ada's edit.
    await vscode.commands.executeCommand("relay.redo");
    await until(() => b.text.toString() === `// Bo\n${base}mine`, 5000, "redo");
  } finally {
    b.close();
  }
});

test("Ctrl+Z and Ctrl+Shift+Z pressed on the keyboard follow the same rule", async () => {
  const { ed, b, base } = await mineThenBos("src/u2.js");
  try {
    await focusEditor(ed);
    keys("ctrl+z");
    await until(() => b.text.toString() === `// Bo\n${base}`, 5000, `Ctrl+Z (Bo sees ${JSON.stringify(b.text.toString())})`);
    keys("ctrl+shift+z");
    await until(() => b.text.toString() === `// Bo\n${base}mine`, 5000, "Ctrl+Shift+Z");
    await until(() => ed.document.getText() === b.text.toString(), 5000, "the editor to match");
  } finally {
    b.close();
  }
});

test("Edit › Undo chosen from the menu with the keyboard follows the same rule", async () => {
  const { ed, b, base } = await mineThenBos("src/u3.js");
  try {
    await focusEditor(ed);
    keys("alt+e", "wait:400", "Return"); // open the Edit menu; its first item is Undo
    await until(() => b.text.toString() === `// Bo\n${base}`, 5000, `Edit › Undo (Bo sees ${JSON.stringify(b.text.toString())})`);
    await until(() => ed.document.getText() === b.text.toString(), 5000, "the editor to match");
  } finally {
    keys("Escape");
    b.close();
  }
});

test("with nothing of yours to undo, undo changes nothing (never a collaborator's text)", async () => {
  const b = await bo("src/u4.js");
  try {
    const ed = await openShared("src/u4.js");
    b.text.insert(0, "// only Bo typed here\n");
    await until(() => ed.document.getText().startsWith("// only Bo typed here"), 5000, "Bo's edit");
    const before = b.text.toString();
    await vscode.commands.executeCommand("undo");
    await vscode.commands.executeCommand("relay.undo");
    await sleep(300);
    assert.equal(b.text.toString(), before);
    await until(() => ed.document.getText() === before, 5000, "the editor unchanged");
  } finally {
    b.close();
  }
});

test("undo across a line split and repeated characters removes exactly your edit", async () => {
  const b = await bo("src/u5.js");
  try {
    const ed = await openShared("src/u5.js");
    const base = ed.document.getText(); // "aaa bbb\n"
    caretAt(ed, 3);
    await type("\n"); // Ada splits Bo's line
    await until(() => b.text.toString() === "aaa\n bbb\n", 5000, "the split at Bo");
    b.text.insert(0, "aaa"); // Bo types the same characters next to Ada's
    await until(() => ed.document.getText() === "aaaaaa\n bbb\n", 5000, "Bo's repeat in VS Code");
    await vscode.commands.executeCommand("relay.undo");
    await until(() => b.text.toString() === "aaaaaa bbb\n", 5000, `only the split undone (Bo sees ${JSON.stringify(b.text.toString())})`);
    assert.notEqual(base, b.text.toString());
  } finally {
    b.close();
  }
});

// ---------- files and folders, both ways ----------

const shared = async (p: string): Promise<string | null> => {
  const r = await boApi<{ text: string }>("GET", `/file?path=${encodeURIComponent(p)}`);
  return r.status === 200 ? r.body.text : null;
};
const local = (p: string): string | null => (existsSync(join(CHECKOUT, p)) ? readFileSync(join(CHECKOUT, p), "utf8") : null);
async function untilShared(p: string, want: string | null, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  let got: string | null = null;
  while (Date.now() < end) {
    got = await shared(p);
    if (got === want) return;
    await sleep(40);
  }
  assert.equal(got, want, `Relay's ${p}`);
}
const setting = (k: string, v: unknown) => vscode.workspace.getConfiguration("relay").update(k, v, vscode.ConfigurationTarget.Workspace);

test("a file created in VS Code is created in Relay with its content, folders included", async () => {
  const we = new vscode.WorkspaceEdit();
  we.createFile(uri("src/made/in/vscode.js"), { contents: new TextEncoder().encode("export const made = 'here';\n") });
  assert.ok(await vscode.workspace.applyEdit(we));
  await untilShared("src/made/in/vscode.js", "export const made = 'here';\n");
  // Opening it shares it live, like any other project file.
  const ed = await openShared("src/made/in/vscode.js");
  caretAt(ed, ed.document.getText().length);
  await type("// more\n");
  await untilShared("src/made/in/vscode.js", "export const made = 'here';\n// more\n");
  // An empty file too.
  const e2 = new vscode.WorkspaceEdit();
  e2.createFile(uri("src/empty.js"));
  assert.ok(await vscode.workspace.applyEdit(e2));
  await untilShared("src/empty.js", "");
});

test("creating a file Relay already has never overwrites either copy", async () => {
  // Bo creates it in Relay; this window creates a different one at the same moment.
  const [r] = await Promise.all([
    boApi("POST", "/files", { path: "src/race.js", content: "// Bo's\n" }),
    (async () => {
      const we = new vscode.WorkspaceEdit();
      we.createFile(uri("src/race.js"), { contents: new TextEncoder().encode("// Ada's\n"), ignoreIfExists: true });
      await vscode.workspace.applyEdit(we);
    })(),
  ]);
  assert.equal(r.status, 201);
  await relay.settled();
  assert.equal(await shared("src/race.js"), "// Bo's\n", "Relay keeps Bo's");
  assert.equal(local("src/race.js"), "// Ada's\n", "the checkout keeps Ada's until she chooses");
});

test("files git ignores are never shared", async () => {
  const we = new vscode.WorkspaceEdit();
  we.createFile(uri("debug.log"), { contents: new TextEncoder().encode("secret-ish output\n") });
  assert.ok(await vscode.workspace.applyEdit(we));
  await relay.settled();
  assert.equal(await shared("debug.log"), null);
  assert.ok(!relay.sharedFiles().includes("debug.log"));
});

test("a file created in Relay appears in the checkout; one that exists here with other content is left alone", async () => {
  assert.equal((await boApi("POST", "/files", { path: "lib/from/relay.js", content: "export const fromRelay = 1;\n" })).status, 201);
  await until(() => local("lib/from/relay.js") === "export const fromRelay = 1;\n", 8000, "the new file in the checkout");
  writeFileSync(join(CHECKOUT, "src/mine-first.js"), "// mine\n");
  assert.equal((await boApi("POST", "/files", { path: "src/mine-first.js", content: "// Bo's\n" })).status, 201);
  await relay.settled();
  await sleep(300);
  await relay.settled();
  assert.equal(local("src/mine-first.js"), "// mine\n", "never written over");
});

test("renaming an open file in VS Code renames it in Relay; unsent typing, history and undo move with it", async () => {
  const ed = await openShared("src/rename.js");
  const sync = relay.syncFor(ed.document.uri)!;
  caretAt(ed, ed.document.getText().length);
  await type("// typed just before the rename\n");
  // Rename straight away, while the last keys may still be on their way.
  const we = new vscode.WorkspaceEdit();
  we.renameFile(uri("src/rename.js"), uri("src/renamed.js"));
  assert.ok(await vscode.workspace.applyEdit(we));
  await untilShared("src/renamed.js", "// rename me\n// typed just before the rename\n");
  assert.equal(await shared("src/rename.js"), null, "the old name is gone, not left behind as a copy");
  const moved = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri("src/renamed.js").toString())!;
  await until(() => relay.syncFor(moved.uri) === sync && sync.path === "src/renamed.js" && sync.state === "synced", 8000, "the same shared session under the new name");
  // History came along: the line typed before the rename is still credited to Ada.
  const h = await boApi<{ origins: { author: string }[] }>("GET", "/attribution/line?path=src/renamed.js&line=2");
  assert.ok(h.body.origins.some((o) => o.author === relay.connection!.me!.id), JSON.stringify(h.body));
  // Undo still reaches the edit made before the rename.
  await vscode.window.showTextDocument(moved);
  await vscode.commands.executeCommand("relay.undo");
  await untilShared("src/renamed.js", "// rename me\n");
});

test("moving a file to another folder in VS Code moves it in Relay", async () => {
  const we = new vscode.WorkspaceEdit();
  we.renameFile(uri("src/presence.js"), uri("lib/moved/presence.js"));
  assert.ok(await vscode.workspace.applyEdit(we));
  await untilShared("lib/moved/presence.js", "const a = 1;\nconst b = 2;\n");
  assert.equal(await shared("src/presence.js"), null);
});

test("a rename Relay refuses is reported, and nothing changes in Relay", async () => {
  const we = new vscode.WorkspaceEdit();
  we.renameFile(uri("src/empty.js"), uri("empty.log")); // git ignores *.log: Relay won't share that name
  assert.ok(await vscode.workspace.applyEdit(we));
  await relay.settled();
  assert.equal(await shared("src/empty.js"), "", "still shared under its old name");
  assert.equal(await shared("empty.log"), null);
});

test("a file renamed in Relay is renamed here; the open editor follows with its session", async () => {
  const ed = await openShared("src/undo.js");
  const sync = relay.syncFor(ed.document.uri)!;
  assert.equal((await boApi("POST", "/files/rename", { from: "src/undo.js", to: "src/undone.js" })).status, 200);
  await until(() => local("src/undone.js") !== null && local("src/undo.js") === null, 8000, "the rename in the checkout");
  const moved = await vscode.workspace.openTextDocument(uri("src/undone.js"));
  await until(() => relay.syncFor(moved.uri) === sync && sync.state === "synced", 8000, `the session under the new name (attached ${!!relay.syncFor(moved.uri)}, same ${relay.syncFor(moved.uri) === sync}, path ${sync.path}, state ${sync.state}, open docs ${vscode.workspace.textDocuments.map((d) => d.uri.path.split("/").pop()).join(",")})`);
  await vscode.window.showTextDocument(moved);
  caretAt(vscode.window.activeTextEditor!, 0);
  await type("// after the rename\n");
  await until(() => moved.getText().startsWith("// after the rename\n"), 5000, "the typing in the editor");
  await untilShared("src/undone.js", moved.getText());
});

test("deleting a shared file in VS Code: the setting decides whether it's deleted for everyone", async () => {
  await setting("shareDeletes", "never");
  let we = new vscode.WorkspaceEdit();
  we.deleteFile(uri("src/race.js"));
  assert.ok(await vscode.workspace.applyEdit(we));
  await relay.settled();
  assert.equal(await shared("src/race.js"), "// Bo's\n", "kept in Relay");
  await setting("shareDeletes", "always");
  we = new vscode.WorkspaceEdit();
  we.deleteFile(uri("src/made/in/vscode.js"));
  assert.ok(await vscode.workspace.applyEdit(we));
  await untilShared("src/made/in/vscode.js", null);
  await setting("shareDeletes", undefined);
});

test("a file deleted in Relay is removed here only if this copy holds nothing Relay didn't have", async () => {
  // Clean copy: removed.
  assert.equal((await boApi("POST", "/files/delete", { path: "lib/from/relay.js" })).status, 200);
  await until(() => local("lib/from/relay.js") === null, 8000, "the clean copy removed");
  // A copy with local changes: kept.
  writeFileSync(join(CHECKOUT, "src/other.js"), "export const other = 'changed here';\n");
  assert.equal((await boApi("POST", "/files/delete", { path: "src/other.js" })).status, 200);
  await relay.settled();
  await sleep(300);
  await relay.settled();
  assert.equal(local("src/other.js"), "export const other = 'changed here';\n", "local work kept");
});

test("files other programs create or delete in the checkout are never shared or deleted automatically", async () => {
  writeFileSync(join(CHECKOUT, "src/generated.js"), "// generated\n");
  rmSync(join(CHECKOUT, "README.md"));
  // The watcher batches, then asks; nothing happens in Relay without an answer.
  await sleep(1500);
  await relay.settled();
  assert.equal(await shared("src/generated.js"), null, "not shared without asking");
  assert.notEqual(await shared("README.md"), null, "not deleted without asking");
});

test("an open shared file rewritten on disk by another program: shared only if chosen", async () => {
  const ed = await openShared("src/interop.js");
  await ed.document.save();
  const before = await shared("src/interop.js");
  await setting("externalChanges", "keepShared");
  writeFileSync(join(CHECKOUT, "src/interop.js"), "// rewritten by a generator\n");
  await until(() => ed.document.getText() === before, 8000, `the shared text back in the editor (editor: ${JSON.stringify(ed.document.getText())})`);
  assert.equal(await shared("src/interop.js"), before, "Relay unchanged");
  // (The editor now holds the shared text and the disk the other program's: saving would hit VS Code's own "file is
  // newer on disk" conflict, which is VS Code's protection and left to the person. The next case uses a fresh file.)
  await setting("externalChanges", "share");
  const gen = await openShared("src/gen.js");
  await gen.document.save();
  writeFileSync(join(CHECKOUT, "src/gen.js"), "// rewritten by a generator, and shared\n");
  await untilShared("src/gen.js", "// rewritten by a generator, and shared\n");
  await setting("externalChanges", undefined);
});

test("joining compares the checkout with Relay: missing and differing files are reported, nothing is changed", async () => {
  // Left by earlier tests: README.md was deleted here by "another program" (Relay kept it); src/mine-first.js exists
  // here with different content than Relay's and was never opened.
  const r = await relay.compareWithShared();
  assert.ok(r.missing.includes("README.md"), JSON.stringify(r));
  assert.ok(r.differ.includes("src/mine-first.js"), JSON.stringify(r));
  assert.equal(local("src/mine-first.js"), "// mine\n", "nothing changed by comparing");
  assert.equal(local("README.md"), null);
});

// ---------- a whole file lifecycle with the browser IDE ----------

test("a file's whole life across VS Code and the browser: create, edit together, rename, undo, delete", async () => {
  // 1. Ada creates it in VS Code.
  const we = new vscode.WorkspaceEdit();
  we.createFile(uri("src/flow.js"), { contents: new TextEncoder().encode("// flow\n") });
  assert.ok(await vscode.workspace.applyEdit(we));
  await untilShared("src/flow.js", "// flow\n");
  signal("flow-created");
  // 2. Cy opens it in the browser; both type at once.
  await until(() => signalled("flow-opened"), 60_000, "Cy to open it in the browser");
  const ed = await openShared("src/flow.js");
  caretAt(ed, ed.document.getText().length);
  await type("// ada was here\n");
  await until(() => ed.document.getText().includes("cy was here") && ed.document.getText().includes("ada was here"), 20_000, `both edits (editor: ${JSON.stringify(ed.document.getText())})`);
  await untilShared("src/flow.js", ed.document.getText(), 10_000);
  const text = ed.document.getText().split("\n");
  const adaLine = text.findIndex((l) => l.includes("ada was here")) + 1;
  const cyLine = text.findIndex((l) => l.includes("cy was here")) + 1;
  const who = async (line: number) => (await boApi<{ origins: { author: string; text: string }[] }>("GET", `/attribution/line?path=src/flow.js&line=${line}`)).body.origins;
  assert.ok((await who(adaLine)).some((o) => o.author === relay.connection!.me!.id && o.text.includes("ada was here")), "Ada's line is credited to Ada");
  assert.ok((await who(cyLine)).some((o) => o.author !== relay.connection!.me!.id && o.text.includes("cy was here")), "Cy's words are credited to Cy");
  // 3. Cy renames it in the browser; VS Code follows with the same session.
  const sync = relay.syncFor(ed.document.uri)!;
  signal("flow-edited");
  await until(() => signalled("flow-renamed"), 60_000, "Cy's rename");
  await until(() => local("src/flow2.js") !== null && local("src/flow.js") === null, 15_000, "the rename in this checkout");
  const moved = await vscode.workspace.openTextDocument(uri("src/flow2.js"));
  await until(() => relay.syncFor(moved.uri) === sync && sync.state === "synced", 15_000, "the session under the new name");
  // 4. Ada's undo removes her line only.
  await vscode.window.showTextDocument(moved);
  await vscode.commands.executeCommand("relay.undo");
  await until(() => !moved.getText().includes("ada was here") && moved.getText().includes("cy was here"), 10_000, "Ada's undo");
  await untilShared("src/flow2.js", moved.getText());
  signal("flow-undone");
  // 5. Ada deletes it for everyone from VS Code; Cy's tab closes with a notice.
  await setting("shareDeletes", "always");
  const del = new vscode.WorkspaceEdit();
  del.deleteFile(uri("src/flow2.js"));
  assert.ok(await vscode.workspace.applyEdit(del));
  await untilShared("src/flow2.js", null);
  signal("flow-deleted");
  await until(() => signalled("flow-done"), 60_000, "the browser side to finish");
  await setting("shareDeletes", undefined);
});

// ---------- recovery ----------

const signal = (name: string) => writeFileSync(join(SIGNALS, name), "");
const signalled = (name: string) => existsSync(join(SIGNALS, name));

test("a server restart: typing during the outage is kept, the status says so, and everything arrives after", async () => {
  const ed = await openShared("src/app.js");
  const sync = relay.syncFor(ed.document.uri)!;
  signal("restart-server");
  await until(() => signalled("server-down"), 20_000, "the server to stop");
  await until(() => sync.state === "offline" || sync.state === "connecting", 10_000, "the session to notice");
  caretAt(ed, 0);
  await type("// typed while the server was down\n");
  assert.doesNotMatch(relay.statusText(), /Synced/, `never "Synced" while the server is down (status: ${relay.statusText()})`);
  signal("bring-server-back");
  await until(() => signalled("server-back"), 30_000, "the server to come back");
  await until(() => sync.state === "synced" && !sync.unsent(), 30_000, `the session to recover (state ${sync.state}, unsent ${sync.unsent()})`);
  await untilShared("src/app.js", ed.document.getText(), 10_000);
  assert.match((await shared("src/app.js"))!, /typed while the server was down/);
  // A file created right after the restart reaches this checkout through the event feed's catch-up.
  await until(() => local("src/after-restart.js") === "// created right after the restart\n", 30_000, "the file created after the restart");
  assert.match(relay.statusText(), /Synced/);
});

test("an incompatible server is refused before the invite is spent", async () => {
  const seen: string[] = [];
  const fake = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ protocol: 99, version: "9.0.0" }));
  });
  await new Promise<void>((ok) => fake.listen(0, "127.0.0.1", () => ok()));
  try {
    const port = (fake.address() as { port: number }).port;
    const before = relay.connection;
    await vscode.commands.executeCommand("relay.join", `http://127.0.0.1:${port}/join#not-spent`);
    assert.deepEqual(seen, ["GET /api/version"], "only the version was asked; the invite was never sent");
    assert.equal(relay.connection, before, "still connected to the original project");
  } finally {
    fake.close();
  }
});

test("after leaving, nothing from that project touches this checkout", async () => {
  await vscode.commands.executeCommand("relay.leave");
  assert.equal(relay.connection, null);
  assert.equal((await boApi("POST", "/files", { path: "src/after-leaving.js", content: "// not for you\n" })).status, 201);
  await sleep(1500);
  assert.equal(local("src/after-leaving.js"), null, "not mirrored after leaving");
  assert.equal(relay.statusText(), "Relay");
});

// ---------- joining from a link: the real confirmation dialog ----------

test("an Open in VS Code link asks before joining; no answer means no, and the invite isn't spent", async () => {
  // In the extension test host VS Code refuses to show modal dialogs ("refused to show dialog in tests") and answers
  // "no answer": exactly the decline path. The accept path, with the real dialog answered by keyboard, is tested
  // against a normally started VS Code by test/install.mts.
  const conn = () => relay.connection as Connection | null;
  assert.equal(conn(), null, "starts signed out (previous test left the project)");
  const invite = env("RELAY_TEST_INVITE2");
  await vscode.env.openExternal(vscode.Uri.parse(`vscode://relay.relay-vscode/join?invite=${encodeURIComponent(invite)}`));
  await sleep(1500);
  await relay.settled();
  assert.equal(conn(), null, "not joined without a yes");
  // The invite still works, so asking didn't spend it.
  await vscode.commands.executeCommand("relay.join", invite);
  await until(() => conn()?.me?.name === "Ada again", 15_000, "joined with the same invite afterwards");
  // A one-time invite can't be used twice; the current session is untouched.
  const me = conn()!.me!.id;
  await vscode.commands.executeCommand("relay.join", invite);
  assert.equal(conn()?.me?.id, me, "still the same session after a refused reuse");
  // A link without an invite is refused before anything is asked.
  await vscode.env.openExternal(vscode.Uri.parse("vscode://relay.relay-vscode/join"));
  await sleep(500);
  assert.equal(conn()?.me?.id, me);
});

export async function run(): Promise<void> {
  const failures: string[] = [];
  // RELAY_TEST_ONLY=<regex>: run matching tests (plus joining, which the others need) while working on one area.
  const only = process.env.RELAY_TEST_ONLY ? new RegExp(process.env.RELAY_TEST_ONLY) : null;
  for (const [name, fn] of tests) {
    if (only && !only.test(name) && !name.startsWith("joining with an invite link")) continue;
    const t0 = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      // A test waiting on a dialog nobody answers fails with that diagnosis instead of hanging the run.
      await Promise.race([fn(), new Promise((_, fail) => (timer = setTimeout(() => fail(new Error("test timed out after 90 s (a dialog waiting for an answer?)")), 90_000)))]);
      clearTimeout(timer);
      console.log(`ok - ${name} (${Date.now() - t0} ms)`);
    } catch (e) {
      clearTimeout(timer);
      failures.push(name);
      console.log(`not ok - ${name}\n  ${(e as Error).stack?.split("\n").slice(0, 4).join("\n  ")}`);
    }
  }
  console.log(`# pass ${tests.length - failures.length}\n# fail ${failures.length}`);
  if (failures.length) throw new Error(`${failures.length} test(s) failed`);
}
