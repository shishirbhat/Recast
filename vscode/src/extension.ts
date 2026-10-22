import * as vscode from "vscode";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Connection, PROTOCOL, RelayError, parseInvite } from "./connection.ts";
import type { RelayEvent } from "./connection.ts";
import { FileSync } from "./fileSync.ts";
import type { Divergence, ExternalChoice, SyncChoices } from "./fileSync.ts";
import { FileMirror } from "./fileOps.ts";
import { PresenceDecorations } from "./presence.ts";
import { CoordinationTree } from "./coordination.ts";
import type { CoordTask } from "./coordination.ts";
import { SessionContent, showLineHistory } from "./history.ts";

/** What the extension exposes to other extensions (and to its tests). */
export interface RelayApi {
  readonly connection: Connection | null;
  readonly version: string;
  syncFor(uri: vscode.Uri): FileSync | undefined;
  statusText(): string;
  refreshCoordination(): Promise<void>;
  /** Shared file paths as this window last fetched them. */
  sharedFiles(): string[];
  /** Resolves once the extension has handled every file operation it has seen so far (for tests and scripts). */
  settled(): Promise<void>;
  /** Shared files missing from this checkout, and ones whose local copy differs (what joining reports). */
  compareWithShared(): Promise<{ missing: string[]; differ: string[] }>;
}

const SECRET = (folder: vscode.Uri) => `relay.session:${folder.toString()}`;

class RelayExtension implements vscode.Disposable, SyncChoices {
  conn: Connection | null = null;
  files = new Set<string>();
  private syncs = new Map<string, FileSync>();
  /** Sessions moving with a renamed file, by new path: re-attached when the renamed document opens. */
  private carried = new Map<string, { sync: FileSync; ready: boolean; doc?: vscode.TextDocument; timer: NodeJS.Timeout }>();
  private mirror: FileMirror | null = null;
  private status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private presence = new PresenceDecorations();
  readonly tree = new CoordinationTree();
  private sessions = new SessionContent();
  readonly output = vscode.window.createOutputChannel("Relay");
  private disposables: vscode.Disposable[] = [];
  private treeTimer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private retryDelay = 2000;
  private reconnecting: string | null = null;
  private busy = new Set<Promise<unknown>>();
  readonly version: string;

  constructor(private ctx: vscode.ExtensionContext) {
    this.version = (ctx.extension.packageJSON as { version: string }).version;
    Connection.client = `vscode/${this.version}`;
    this.status.command = "relay.status";
    this.disposables.push(
      this.status,
      this.presence,
      this.output,
      vscode.window.registerTreeDataProvider("relay.coordination", this.tree),
      vscode.workspace.registerTextDocumentContentProvider("relay-session", this.sessions),
      vscode.workspace.onDidOpenTextDocument((d) => this.track(d)),
      vscode.workspace.onDidCloseTextDocument((d) => this.untrack(d)),
      vscode.workspace.onDidChangeTextDocument((e) => this.syncs.get(e.document.uri.toString())?.onLocalChange(e)),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        const s = this.syncs.get(e.textEditor.document.uri.toString());
        const sel = e.selections[0];
        if (s && sel) s.setCursor(e.textEditor.document.offsetAt(sel.anchor), e.textEditor.document.offsetAt(sel.active));
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.render()),
      vscode.window.onDidChangeVisibleTextEditors(() => {
        for (const s of this.syncs.values()) this.presence.render(s);
      }),
    );
    this.render();
  }

  get folder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
  }
  get root(): vscode.Uri | undefined {
    return this.folder?.uri;
  }

  /** The project path of a file in this folder, with forward slashes; null outside the folder. */
  pathOf(uri: vscode.Uri): string | null {
    if (uri.scheme !== "file" || !this.folder) return null;
    const rel = relative(this.folder.uri.fsPath, uri.fsPath);
    if (!rel || rel.startsWith("..")) return null;
    return rel.split(sep).join("/");
  }

  log(line: string): void {
    // Paths and outcomes only: never tokens, cookies or file contents.
    this.output.appendLine(`${new Date().toISOString()} ${line}`);
    if (process.env.RELAY_TEST_SERVER) console.log(`[relay] ${line}`);
  }

  /** Track async work so tests and scripts can wait for it (`settled`). */
  private track$<T>(p: Promise<T>): Promise<T> {
    this.busy.add(p);
    void p.finally(() => this.busy.delete(p)).catch(() => {});
    return p;
  }

  async settled(): Promise<void> {
    while (this.busy.size || this.mirror) {
      await Promise.allSettled([...this.busy]);
      await this.mirror?.settled();
      if (!this.busy.size) break;
    }
  }

  // ---------- joining ----------

  async join(link?: string): Promise<void> {
    const folder = this.folder;
    if (!folder) throw new Error("Open the project's folder first (your own checkout of the repository), then join.");
    link ??= await vscode.window.showInputBox({ title: "Join a Relay project", prompt: "Paste the invite link the project owner sent you", placeHolder: "http://host:port/join#…", ignoreFocusOut: true });
    if (!link) return;
    const { server, token } = parseInvite(link);
    // Before spending the one-time invite: is this a Relay server this extension can talk to?
    await Connection.checkServer(server);
    const cookie = await Connection.redeem(server, token);
    // Saved for reconnecting after a restart. Not awaited before connecting: on Linux without a keyring VS Code asks
    // how to store secrets, and joining shouldn't wait on that. If it can't be saved, say what that means.
    void Promise.resolve(this.ctx.secrets.store(SECRET(folder.uri), JSON.stringify({ server, cookie }))).then(undefined, (e: Error) => {
      this.log(`couldn't save the Relay session in VS Code's secret storage: ${e.message}`);
      void vscode.window.showWarningMessage("Relay couldn't save your session in VS Code's secret storage, so you'll need a new invite after VS Code restarts.");
    });
    await this.connect(server, cookie);
  }

  /** Reconnect with the session saved for this folder, if any. Network failures retry with backoff, never wedge. */
  async resume(): Promise<void> {
    clearTimeout(this.retryTimer);
    const folder = this.folder;
    if (!folder) return;
    const saved = await this.ctx.secrets.get(SECRET(folder.uri));
    if (!saved) return;
    const { server, cookie } = JSON.parse(saved) as { server: string; cookie: string };
    try {
      await this.connect(server, cookie);
      this.retryDelay = 2000;
      this.reconnecting = null;
    } catch (e) {
      if (e instanceof RelayError && e.status === 401) {
        await this.ctx.secrets.delete(SECRET(folder.uri));
        this.reconnecting = null;
        void vscode.window.showWarningMessage("Your Relay session for this folder ended (signed out or access revoked). Join again with a new invite link.", "Join…").then((a) => a && vscode.commands.executeCommand("relay.join"));
      } else if (e instanceof RelayError && e.status === 426) {
        this.reconnecting = null;
        void vscode.window.showErrorMessage((e as Error).message);
      } else {
        this.reconnecting = server;
        this.log(`can't reach ${server}: ${(e as Error).message}; retrying in ${this.retryDelay / 1000}s`);
        this.retryTimer = setTimeout(() => void this.resume(), this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
      }
      this.render();
    }
  }

  private async connect(server: string, cookie: string): Promise<void> {
    this.disconnect();
    await Connection.checkServer(server);
    const conn = new Connection(server, cookie);
    await conn.refresh();
    this.conn = conn;
    this.files = new Set(await conn.files());
    this.tree.conn = conn;
    this.sessions.conn = conn;
    this.mirror = new FileMirror(this);
    await vscode.commands.executeCommand("setContext", "relay.connected", true);
    this.log(`connected to ${conn.project.name} at ${server} as ${conn.me?.name} (${conn.me?.role})`);
    // Is this folder the same project? Count the shared files that exist here.
    const here = [...this.files].filter((f) => existsSync(join(this.folder!.uri.fsPath, f))).length;
    if (this.files.size && here < this.files.size / 2) void vscode.window.showWarningMessage(`This folder may not be ${conn.project.name}: only ${here} of its ${this.files.size} files exist here. Files are shared by their path in the project.`);
    conn.follow(
      (e) => void this.track$(this.onEvent(e, conn)),
      (up) => {
        if (!up) this.log("event feed disconnected; reconnecting");
        this.render();
      },
    );
    for (const d of vscode.workspace.textDocuments) this.track(d);
    void this.track$(this.mirror.compareOnJoin().catch((e) => this.log(`couldn't compare with the shared project: ${(e as Error).message}`)));
    await this.tree.refresh();
    this.render();
  }

  disconnect(): void {
    for (const s of this.syncs.values()) s.dispose();
    this.syncs.clear();
    for (const c of this.carried.values()) (clearTimeout(c.timer), c.sync.dispose());
    this.carried.clear();
    this.mirror?.dispose();
    this.mirror = null;
    this.conn?.close();
    this.conn = null;
    this.tree.conn = null;
    this.sessions.conn = null;
    void this.tree.refresh();
    void vscode.commands.executeCommand("setContext", "relay.connected", false);
    this.render();
  }

  async leave(): Promise<void> {
    clearTimeout(this.retryTimer);
    this.reconnecting = null;
    const conn = this.conn;
    if (conn) await conn.request("POST", "/logout").catch(() => {});
    if (this.folder) await this.ctx.secrets.delete(SECRET(this.folder.uri));
    this.disconnect();
  }

  // ---------- which documents are shared ----------

  private track(doc: vscode.TextDocument): void {
    const conn = this.conn;
    const path = this.pathOf(doc.uri);
    if (!conn?.me || !path) return;
    const carried = this.carried.get(path);
    if (carried) {
      // A renamed file reopened under its new name: same shared session, now for this document.
      carried.doc = doc;
      this.syncs.set(doc.uri.toString(), carried.sync);
      if (carried.ready) this.reattach(path);
      return;
    }
    if (!this.files.has(path) || this.syncs.has(doc.uri.toString())) return;
    const sync = new FileSync(conn, path, doc, conn.me, this);
    this.syncs.set(doc.uri.toString(), sync);
    sync.subscribe(() => {
      this.presence.render(sync);
      this.render();
    });
    this.render();
  }

  private untrack(doc: vscode.TextDocument): void {
    const s = this.syncs.get(doc.uri.toString());
    if (!s) return;
    this.syncs.delete(doc.uri.toString());
    // Closed because it was renamed: the session lives on with the new document. VS Code may open the renamed document
    // before closing the old one, so check both: still carried, or already in use under the new name.
    const inUse = [...this.carried.values()].some((c) => c.sync === s) || [...this.syncs.values()].includes(s);
    if (!inUse) s.dispose();
    this.render();
  }

  syncsUnder(path: string): FileSync[] {
    return [...new Set(this.syncs.values())].filter((s) => s.path === path || s.path.startsWith(`${path}/`));
  }

  carry(sync: FileSync, toPath: string, ready: boolean): void {
    const prev = this.carried.get(toPath);
    if (prev) clearTimeout(prev.timer);
    // If the renamed document never opens (e.g. it was closed meanwhile), let the session go.
    const timer = setTimeout(() => {
      const c = this.carried.get(toPath);
      if (c && !c.doc) {
        this.carried.delete(toPath);
        c.sync.dispose();
      }
    }, 15_000);
    this.carried.set(toPath, { sync, ready, timer, doc: prev?.doc });
    if (ready) this.reattach(toPath);
  }

  landed(toPath: string, ok: boolean): void {
    const c = this.carried.get(toPath);
    if (!c) return;
    if (ok) {
      c.ready = true;
      this.reattach(toPath);
      return;
    }
    clearTimeout(c.timer);
    this.carried.delete(toPath);
    if (c.doc) this.syncs.delete(c.doc.uri.toString());
    c.sync.dispose();
    this.render();
  }

  private reattach(toPath: string): void {
    const c = this.carried.get(toPath);
    if (!c?.doc || !c.ready) return;
    clearTimeout(c.timer);
    this.carried.delete(toPath);
    c.sync.retarget(toPath, c.doc);
    this.log(`${toPath}: shared session moved with the rename`);
    this.render();
  }

  // ---------- decisions (SyncChoices) ----------

  /** The local file and the shared one differ: never overwrite either without asking (unless a setting says how). */
  async divergence(path: string, local: string, shared: string): Promise<Divergence> {
    const setting = vscode.workspace.getConfiguration("relay").get<string>("whenFilesDiffer", "ask");
    const viewer = this.conn?.me?.role === "viewer";
    if (setting === "useShared") return "shared";
    if (setting === "shareMine" && !viewer) return "local";
    const useShared = "Use the shared version";
    const mine = "Share my version";
    const skip = "Don't share this file";
    const lines = (t: string) => t.split("\n").length;
    const pick = await vscode.window.showWarningMessage(
      `${path} here differs from the shared copy in Relay (${lines(local)} lines here, ${lines(shared)} shared). Which one should everyone see?`,
      ...(viewer ? [useShared, skip] : [useShared, mine, skip]),
    );
    return pick === useShared ? "shared" : pick === mine ? "local" : "skip";
  }

  /** Another program rewrote an open shared file (git checkout, a generator, Revert File). */
  async externalChange(path: string): Promise<ExternalChoice> {
    const setting = vscode.workspace.getConfiguration("relay").get<string>("externalChanges", "ask");
    if (setting === "share" && this.conn?.me?.role !== "viewer") return "share";
    if (setting === "keepShared") return "keepShared";
    const share = "Share the new content";
    const keep = "Keep the shared version";
    const pick = await vscode.window.showWarningMessage(
      `${path} was changed on disk by another program (for example git checkout, a code generator or Revert File).`,
      { modal: true, detail: "Share the new content with everyone in Relay, or put the shared version back in your editor? Nothing is shared until you choose." },
      ...(this.conn?.me?.role === "viewer" ? [keep] : [share, keep]),
    );
    return pick === share ? "share" : "keepShared";
  }

  notice(message: string): void {
    vscode.window.setStatusBarMessage(`Relay: ${message}`, 5000);
    this.log(message);
  }

  // ---------- events from Relay ----------

  private async onEvent(e: RelayEvent, conn: Connection): Promise<void> {
    // Events from a connection this window has since left (switched projects, signed out) are ignored.
    if (conn !== this.conn) return;
    if (/^(file|folder)\./.test(e.type)) {
      await this.refreshFiles();
      try {
        await this.mirror?.onEvent(e);
      } catch (err) {
        this.log(`couldn't mirror ${e.type}: ${(err as Error).message}`);
        void vscode.window.showWarningMessage(`Relay: couldn't apply ${e.type.replace(".", " ")} here: ${(err as Error).message}`);
      }
    }
    if (e.taskId || e.type.startsWith("integration.") || e.type.startsWith("agent.")) {
      clearTimeout(this.treeTimer);
      this.treeTimer = setTimeout(() => void this.tree.refresh(), 300);
    }
  }

  nameOf(actor: string): string {
    const id = actor.replace(/^human:/, "");
    return this.conn?.members.find((m) => m.id === id)?.name ?? (actor.startsWith("agent:") ? `Agent ${actor.slice(6)}` : "Someone");
  }

  async refreshFiles(): Promise<void> {
    if (!this.conn) return;
    this.files = new Set(await this.conn.files());
    for (const d of vscode.workspace.textDocuments) this.track(d);
  }

  // ---------- commands ----------

  activeSync(): FileSync | undefined {
    const ed = vscode.window.activeTextEditor;
    return ed ? this.syncs.get(ed.document.uri.toString()) : undefined;
  }

  async undo(redo = false): Promise<void> {
    const s = this.activeSync();
    if (!s?.bound) return void (await vscode.commands.executeCommand(redo ? "redo" : "undo"));
    const stack = redo ? s.undoManager.redoStack : s.undoManager.undoStack;
    if (!stack.length) return this.notice(redo ? "Nothing of yours to redo in this file." : "Nothing of yours to undo in this file. Relay's undo only reverts your own edits.");
    if (redo) s.undoManager.redo();
    else s.undoManager.undo();
  }

  async lineHistory(): Promise<void> {
    const ed = vscode.window.activeTextEditor;
    const s = this.activeSync();
    if (!ed || !s || !this.conn) throw new Error("Open a file that is shared in Relay first.");
    await showLineHistory(this.conn, s.path, ed.selection.active.line + 1);
  }

  async compare(): Promise<{ missing: string[]; differ: string[] }> {
    if (!this.mirror) throw new Error("Join a Relay project first.");
    return this.mirror.compareOnJoin();
  }

  async restoreShared(): Promise<void> {
    if (!this.mirror) throw new Error("Join a Relay project first.");
    const n = await this.mirror.restoreMissing();
    if (n) void vscode.window.showInformationMessage(`Restored ${n} shared ${n === 1 ? "file" : "files"} into your checkout.`);
  }

  async apply(task: CoordTask): Promise<void> {
    if (!this.conn) return;
    const go = "Apply to project";
    const pick = await vscode.window.showWarningMessage(
      `Apply ${task.id}'s changes (${task.files.join(", ")}) to the shared project? If the project changed since the agent started, Relay checks the merged result first.`,
      { modal: true },
      go,
    );
    if (pick !== go) return;
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Applying ${task.id}…` }, () =>
      this.conn!.request<{ applied: string[]; conflicts: { path: string }[]; reverified: boolean }>("POST", `/tasks/${encodeURIComponent(task.id)}/apply`),
    );
    if (r.conflicts.length) void vscode.window.showErrorMessage(`Not applied: ${r.conflicts.map((c) => c.path).join(", ")} changed in the shared project in a way that conflicts. Nothing was merged.`);
    else void vscode.window.showInformationMessage(`Applied ${r.applied.length} ${r.applied.length === 1 ? "file" : "files"} from ${task.id}${r.reverified ? ", after checking it against the project as it is now" : ""}.`);
    await this.tree.refresh();
  }

  async showStatus(): Promise<void> {
    if (!this.conn) return void (await vscode.commands.executeCommand("relay.join"));
    const s = this.activeSync();
    const items: (vscode.QuickPickItem & { run?: () => unknown })[] = [
      { label: `$(organization) ${this.conn.project.name}`, description: `${this.conn.server} · you are ${this.conn.me?.name} (${this.conn.me?.role})` },
    ];
    if (s) {
      items.push({ label: `$(file) ${s.path}`, description: this.fileStatus(s) });
      for (const p of s.peers()) items.push({ label: `$(person) ${p.member.name}`, description: "in this file" });
      items.push({ label: "$(history) Who wrote this line?", run: () => this.lineHistory() });
    }
    items.push({ label: "$(cloud-download) Restore shared files missing here", run: () => this.restoreShared() });
    items.push({ label: "$(debug-disconnect) Leave this Relay project", run: () => this.leave() });
    items.push({ label: `$(info) Relay for VS Code ${this.version}`, description: `protocol ${PROTOCOL}` });
    const pick = await vscode.window.showQuickPick(items, { title: "Relay" });
    await pick?.run?.();
  }

  // ---------- status ----------

  fileStatus(s: FileSync): string {
    if (s.state === "gone") return "Moved or deleted in Relay";
    if (s.state === "paused") return "Not shared (you chose to keep your copy)";
    if (s.state === "offline") return s.unsent() ? "Offline: edits kept here, sent when back" : "Offline";
    if (s.state === "connecting") return "Connecting…";
    if (!s.bound) return "Waiting for your choice";
    if (s.late()) return "Not saved yet";
    return "Synced";
  }

  statusText(): string {
    if (!this.conn) return this.reconnecting ? "Relay: reconnecting…" : "Relay";
    const s = this.activeSync();
    if (!s) return `Relay: ${this.conn.project.name}`;
    const peers = s.peers().length;
    return `Relay: ${this.fileStatus(s)}${peers ? ` · ${peers + 1} here` : ""}`;
  }

  private render(): void {
    const s = this.activeSync();
    const text = this.statusText();
    const icon = !this.conn ? (this.reconnecting ? "$(sync~spin)" : "$(plug)") : !s ? "$(organization)" : s.state === "synced" && !s.late() && s.bound ? "$(check)" : s.state === "connecting" ? "$(sync~spin)" : "$(warning)";
    this.status.text = `${icon} ${text}`;
    this.status.tooltip = !this.conn ? (this.reconnecting ? `Can't reach ${this.reconnecting}; retrying` : "Join a Relay project") : s ? `${s.path} is shared live in Relay. Click for details.` : "This file isn't part of the Relay project";
    this.status.backgroundColor = s && (s.late() || s.state === "offline" || s.state === "gone") ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    this.status.show();
    void vscode.commands.executeCommand("setContext", "relay.fileShared", !!s?.bound);
  }

  syncFor(uri: vscode.Uri): FileSync | undefined {
    return this.syncs.get(uri.toString());
  }

  dispose(): void {
    clearTimeout(this.treeTimer);
    clearTimeout(this.retryTimer);
    this.disconnect();
    for (const d of this.disposables) d.dispose();
  }
}

export async function activate(ctx: vscode.ExtensionContext): Promise<RelayApi> {
  const relay = new RelayExtension(ctx);
  ctx.subscriptions.push(relay);
  const run = (fn: (...args: never[]) => Promise<unknown>) => async (...args: never[]) => {
    try {
      await fn(...args);
    } catch (e) {
      void vscode.window.showErrorMessage((e as Error).message);
    }
  };
  ctx.subscriptions.push(
    vscode.commands.registerCommand("relay.join", run((link?: string) => relay.join(link))),
    vscode.commands.registerCommand("relay.leave", run(() => relay.leave())),
    vscode.commands.registerCommand("relay.status", run(() => relay.showStatus())),
    vscode.commands.registerCommand("relay.undo", run(() => relay.undo())),
    vscode.commands.registerCommand("relay.redo", run(() => relay.undo(true))),
    vscode.commands.registerCommand("relay.lineHistory", run(() => relay.lineHistory())),
    vscode.commands.registerCommand("relay.restoreShared", run(() => relay.restoreShared())),
    vscode.commands.registerCommand("relay.coordination.refresh", run(() => relay.tree.refresh())),
    vscode.commands.registerCommand("relay.apply", run((node: { task: CoordTask }) => relay.apply(node.task))),
    vscode.commands.registerCommand("relay.applyDenied", () => vscode.window.showInformationMessage("Only project owners can apply agent work to the shared project.")),
  );
  // "Open in VS Code" links from Relay's invite dialog. Any web page can open a vscode:// link, so joining always asks
  // first, naming the server that open files would be shared with.
  ctx.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: (uri) =>
        run(async () => {
          if (uri.path !== "/join") return;
          const invite = new URLSearchParams(uri.query).get("invite");
          if (!invite) throw new Error("That Relay link has no invite in it.");
          const { server } = parseInvite(invite);
          if (!vscode.workspace.workspaceFolders?.length) throw new Error("Open your checkout of the project in VS Code first, then open the invite link again.");
          const go = "Join";
          const pick = await vscode.window.showWarningMessage(
            `Join the Relay project at ${server}?`,
            { modal: true, detail: `Files you open in ${vscode.workspace.workspaceFolders[0]!.name} that are part of the project will be shared live with everyone in it. Only join servers you trust.` },
            go,
          );
          if (pick === go) await relay.join(invite);
          else relay.log(`declined to join ${server}`);
        })(),
    }),
  );
  void relay.resume();
  return {
    get connection() {
      return relay.conn;
    },
    version: relay.version,
    syncFor: (uri) => relay.syncFor(uri),
    statusText: () => relay.statusText(),
    refreshCoordination: () => relay.tree.refresh(),
    sharedFiles: () => [...relay.files],
    settled: () => relay.settled(),
    compareWithShared: () => relay.compare(),
  };
}

export function deactivate(): void {}
