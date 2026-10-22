import * as vscode from "vscode";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Connection, RelayError, parseInvite } from "./connection.ts";
import type { RelayEvent } from "./connection.ts";
import { FileSync } from "./fileSync.ts";
import type { Divergence } from "./fileSync.ts";
import { PresenceDecorations } from "./presence.ts";
import { CoordinationTree } from "./coordination.ts";
import type { CoordTask } from "./coordination.ts";
import { SessionContent, showLineHistory } from "./history.ts";

/** What the extension exposes to other extensions (and to its tests). */
export interface RelayApi {
  readonly connection: Connection | null;
  syncFor(uri: vscode.Uri): FileSync | undefined;
  statusText(): string;
  refreshCoordination(): Promise<void>;
}

const SECRET = (folder: vscode.Uri) => `relay.session:${folder.toString()}`;

class RelayExtension implements vscode.Disposable {
  conn: Connection | null = null;
  private files = new Set<string>();
  private syncs = new Map<string, FileSync>();
  private status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private presence = new PresenceDecorations();
  readonly tree = new CoordinationTree();
  private sessions = new SessionContent();
  private disposables: vscode.Disposable[] = [];
  private treeTimer: NodeJS.Timeout | undefined;

  constructor(private ctx: vscode.ExtensionContext) {
    this.status.command = "relay.status";
    this.disposables.push(
      this.status,
      this.presence,
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

  /** The project path of a document, if it belongs to this folder. Relay paths use forward slashes. */
  private pathOf(doc: vscode.TextDocument): string | null {
    if (doc.uri.scheme !== "file" || !this.folder) return null;
    const rel = relative(this.folder.uri.fsPath, doc.uri.fsPath);
    if (!rel || rel.startsWith("..")) return null;
    return rel.split(sep).join("/");
  }

  // ---------- joining ----------

  async join(link?: string): Promise<void> {
    const folder = this.folder;
    if (!folder) throw new Error("Open the project's folder first (your own checkout of the repository), then join.");
    link ??= await vscode.window.showInputBox({ title: "Join a Relay project", prompt: "Paste the invite link the project owner sent you", placeHolder: "http://host:port/join#…", ignoreFocusOut: true });
    if (!link) return;
    const { server, token } = parseInvite(link);
    const cookie = await Connection.redeem(server, token);
    await this.ctx.secrets.store(SECRET(folder.uri), JSON.stringify({ server, cookie }));
    await this.connect(server, cookie);
  }

  /** Reconnect with the session saved for this folder, if any. */
  async resume(): Promise<void> {
    const folder = this.folder;
    if (!folder) return;
    const saved = await this.ctx.secrets.get(SECRET(folder.uri));
    if (!saved) return;
    const { server, cookie } = JSON.parse(saved) as { server: string; cookie: string };
    try {
      await this.connect(server, cookie);
    } catch (e) {
      if (e instanceof RelayError && e.status === 401) {
        await this.ctx.secrets.delete(SECRET(folder.uri));
        void vscode.window.showWarningMessage("Your Relay session for this folder ended. Join again with a new invite link.", "Join…").then((a) => a && vscode.commands.executeCommand("relay.join"));
      } else void vscode.window.showWarningMessage(`Couldn't reach Relay at ${server}: ${(e as Error).message}`, "Retry").then((a) => a && this.resume());
    }
  }

  private async connect(server: string, cookie: string): Promise<void> {
    this.disconnect();
    const conn = new Connection(server, cookie);
    await conn.refresh();
    this.conn = conn;
    this.files = new Set(await conn.files());
    this.tree.conn = conn;
    this.sessions.conn = conn;
    await vscode.commands.executeCommand("setContext", "relay.connected", true);
    // Is this folder the same project? Count the shared files that exist here.
    const here = [...this.files].filter((f) => existsSync(join(this.folder!.uri.fsPath, f))).length;
    if (this.files.size && here < this.files.size / 2) void vscode.window.showWarningMessage(`This folder may not be ${conn.project.name}: only ${here} of its ${this.files.size} files exist here. Files are shared by their path in the project.`);
    conn.follow(
      (e) => this.onEvent(e),
      () => this.render(),
    );
    for (const d of vscode.workspace.textDocuments) this.track(d);
    await this.tree.refresh();
    this.render();
  }

  disconnect(): void {
    for (const s of this.syncs.values()) s.dispose();
    this.syncs.clear();
    this.conn?.close();
    this.conn = null;
    this.tree.conn = null;
    this.sessions.conn = null;
    void this.tree.refresh();
    void vscode.commands.executeCommand("setContext", "relay.connected", false);
    this.render();
  }

  async leave(): Promise<void> {
    const conn = this.conn;
    if (conn) await conn.request("POST", "/logout").catch(() => {});
    if (this.folder) await this.ctx.secrets.delete(SECRET(this.folder.uri));
    this.disconnect();
  }

  // ---------- which documents are shared ----------

  private track(doc: vscode.TextDocument): void {
    const conn = this.conn;
    const path = this.pathOf(doc);
    if (!conn?.me || !path || !this.files.has(path) || this.syncs.has(doc.uri.toString())) return;
    const sync = new FileSync(conn, path, doc, conn.me, (p, local, shared) => this.decide(p, local, shared));
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
    s.dispose();
    this.syncs.delete(doc.uri.toString());
    this.render();
  }

  /** The local file and the shared one differ: never overwrite either without asking (unless a setting says how). */
  private async decide(path: string, local: string, shared: string): Promise<Divergence> {
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

  // ---------- events from Relay ----------

  private onEvent(e: RelayEvent): void {
    const who = this.nameOf(e.actor);
    if (e.type === "file.renamed") {
      const files = (e.data.files as { from: string; to: string }[] | undefined) ?? [];
      void this.refreshFiles();
      for (const f of files) void this.followRename(f.from, f.to, who);
    } else if (e.type === "file.deleted") {
      const files = (e.data.files as string[] | undefined) ?? [];
      void this.refreshFiles();
      for (const p of files) void this.followDelete(p, who);
    } else if (e.type === "file.created" || e.type === "folder.created") {
      void this.refreshFiles();
    }
    if (e.taskId || e.type.startsWith("integration.") || e.type.startsWith("agent.")) {
      clearTimeout(this.treeTimer);
      this.treeTimer = setTimeout(() => void this.tree.refresh(), 300);
    }
  }

  private nameOf(actor: string): string {
    const id = actor.replace(/^human:/, "");
    return this.conn?.members.find((m) => m.id === id)?.name ?? (actor.startsWith("agent:") ? `Agent ${actor.slice(6)}` : "Someone");
  }

  private async refreshFiles(): Promise<void> {
    if (!this.conn) return;
    this.files = new Set(await this.conn.files());
    for (const d of vscode.workspace.textDocuments) this.track(d);
  }

  private syncAt(path: string): FileSync | undefined {
    return [...this.syncs.values()].find((s) => s.path === path);
  }

  private async followRename(from: string, to: string, who: string): Promise<void> {
    const folder = this.folder;
    if (!folder) return;
    const oldUri = vscode.Uri.joinPath(folder.uri, from);
    if (!existsSync(oldUri.fsPath)) return;
    const rename = "Rename my copy too";
    const pick = await vscode.window.showInformationMessage(`${who} renamed ${from} to ${to} in Relay.`, rename, "Keep my copy as is");
    if (pick !== rename) return;
    const we = new vscode.WorkspaceEdit();
    we.renameFile(oldUri, vscode.Uri.joinPath(folder.uri, to), { overwrite: false });
    if (!(await vscode.workspace.applyEdit(we))) void vscode.window.showWarningMessage(`Couldn't rename ${from} to ${to} here (does ${to} already exist?).`);
  }

  private async followDelete(path: string, who: string): Promise<void> {
    const folder = this.folder;
    if (!folder) return;
    const uri = vscode.Uri.joinPath(folder.uri, path);
    if (!existsSync(uri.fsPath)) return;
    const del = "Delete my copy too";
    const open = this.syncAt(path);
    const pick = await vscode.window.showInformationMessage(`${who} deleted ${path} in Relay.${open ? " Your open copy is no longer shared." : ""}`, del, "Keep my copy");
    if (pick !== del) return;
    const we = new vscode.WorkspaceEdit();
    we.deleteFile(uri, { ignoreIfNotExists: true });
    await vscode.workspace.applyEdit(we);
  }

  // ---------- commands ----------

  activeSync(): FileSync | undefined {
    const ed = vscode.window.activeTextEditor;
    return ed ? this.syncs.get(ed.document.uri.toString()) : undefined;
  }

  async undo(redo = false): Promise<void> {
    const s = this.activeSync();
    if (!s?.bound) return void (await vscode.commands.executeCommand(redo ? "redo" : "undo"));
    if (redo) s.undoManager.redo();
    else s.undoManager.undo();
  }

  async lineHistory(): Promise<void> {
    const ed = vscode.window.activeTextEditor;
    const s = this.activeSync();
    if (!ed || !s || !this.conn) throw new Error("Open a file that is shared in Relay first.");
    await showLineHistory(this.conn, s.path, ed.selection.active.line + 1);
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
    items.push({ label: "$(debug-disconnect) Leave this Relay project", run: () => this.leave() });
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
    if (!this.conn) return "Relay";
    const s = this.activeSync();
    if (!s) return `Relay: ${this.conn.project.name}`;
    const peers = s.peers().length;
    return `Relay: ${this.fileStatus(s)}${peers ? ` · ${peers + 1} here` : ""}`;
  }

  private render(): void {
    const s = this.activeSync();
    const text = this.statusText();
    const icon = !this.conn ? "$(plug)" : !s ? "$(organization)" : s.state === "synced" && !s.late() && s.bound ? "$(check)" : s.state === "connecting" ? "$(sync~spin)" : "$(warning)";
    this.status.text = `${icon} ${text}`;
    this.status.tooltip = !this.conn ? "Join a Relay project" : s ? `${s.path} is shared live in Relay. Click for details.` : "This file isn't part of the Relay project";
    this.status.backgroundColor = s && (s.late() || s.state === "offline" || s.state === "gone") ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    this.status.show();
    void vscode.commands.executeCommand("setContext", "relay.fileShared", !!s?.bound);
  }

  syncFor(uri: vscode.Uri): FileSync | undefined {
    return this.syncs.get(uri.toString());
  }

  dispose(): void {
    clearTimeout(this.treeTimer);
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
    vscode.commands.registerCommand("relay.coordination.refresh", run(() => relay.tree.refresh())),
    vscode.commands.registerCommand("relay.apply", run((node: { task: CoordTask }) => relay.apply(node.task))),
    vscode.commands.registerCommand("relay.applyDenied", () => vscode.window.showInformationMessage("Only project owners can apply agent work to the shared project.")),
  );
  void relay.resume();
  return {
    get connection() {
      return relay.conn;
    },
    syncFor: (uri) => relay.syncFor(uri),
    statusText: () => relay.statusText(),
    refreshCoordination: () => relay.tree.refresh(),
  };
}

export function deactivate(): void {}
