import * as vscode from "vscode";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import * as decoding from "lib0/decoding";
import type { Connection, Member } from "./connection.ts";
import { readFileSync } from "node:fs";
import { replacement } from "./text.ts";

function readDisk(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Origin of edits typed in this VS Code window. Undo tracks only these, so it never reverts a collaborator's work. */
export const LOCAL = Symbol("relay:local");
/** Origin of shared updates being caught up into the editor's own copy, once the editor shows them. */
const SHOWN = Symbol("relay:shown");
/** Relay's save acknowledgement: the server's state vector after it applied and logged our update. */
const MESSAGE_ACK = 10;
/** How long our edits may go unconfirmed before the status bar stops saying "Synced". */
export const UNCONFIRMED_MS = 2500;

/** "paused": the person chose not to share this file. "gone": it was renamed or deleted in Relay. */
export type SyncState = "connecting" | "synced" | "offline" | "gone" | "paused";

/** What to do when the local file and the shared one differ the first time they meet. */
export type Divergence = "shared" | "local" | "skip";

/** What to do when another program rewrote an open shared file on disk (git checkout, a generator, Revert File). */
export type ExternalChoice = "share" | "keepShared";

/** Decisions FileSync needs from the person, asked by the extension. */
export interface SyncChoices {
  divergence(path: string, local: string, shared: string): Promise<Divergence>;
  externalChange(path: string): Promise<ExternalChoice>;
  /** A short notice (e.g. "nothing of yours to undo"). */
  notice(message: string): void;
  /** Diagnostics for the Relay output channel: states and codes, never content. */
  log(line: string): void;
}

export interface Peer {
  clientId: number;
  member: { id: string; name: string; color: string };
  /** Caret and selection anchor as offsets in the VS Code document; null when the peer has no caret in the file. */
  head: number | null;
  anchor: number | null;
}

interface EditOp {
  offset: number;
  length: number;
  text: string;
}

/**
 * One shared file, bound to a VS Code document.
 *
 * Two Yjs documents: `doc` is the shared one (connected to Relay), and `view` is always exactly what the editor shows.
 * - A keystroke is applied to `view` at the editor's own offsets (exact, because `view` equals the editor), and the
 *   resulting Yjs update is merged into `doc`. The CRDT places it correctly even if collaborators' edits have arrived
 *   that the editor doesn't show yet: no offset arithmetic, so no misplaced characters.
 * - Collaborators' updates (and undo) wait in `pending` until they are written into the editor. A write is a
 *   version-checked workspace edit: VS Code refuses it if the person typed in between, and it is recomputed. When it
 *   lands, the same updates are applied to `view`, so `view` equals the editor again.
 */
export class FileSync {
  readonly doc = new Y.Doc();
  readonly text = this.doc.getText("content");
  /** The editor's text as a Yjs document. */
  private readonly view = new Y.Doc();
  private readonly viewText = this.view.getText("content");
  readonly provider: WebsocketProvider;
  readonly undoManager: Y.UndoManager;
  state: SyncState = "connecting";
  /** The document follows the shared text (after the first sync and, if they differed, the person's choice). */
  bound = false;
  /** Shared updates the editor doesn't show yet. */
  private pending: Uint8Array[] = [];
  /** An edit in flight: the text the editor will have when it lands, and how many pending updates it covers. */
  private writing: { target: string; covers: number; landed: boolean } | null = null;
  private binding = false;
  private confirmed = new Map<number, number>();
  private unconfirmedSince: number | null = null;
  private lateTimer: NodeJS.Timeout | undefined;
  private listeners = new Set<() => void>();
  private readOnlyWarned = false;
  /** Waiting on the person (an outside rewrite) or restoring after a native undo: nothing is written or forwarded. */
  private held = false;

  constructor(
    readonly conn: Connection,
    public path: string,
    public document: vscode.TextDocument,
    readonly me: Member,
    private readonly choices: SyncChoices,
  ) {
    this.undoManager = new Y.UndoManager(this.text, { trackedOrigins: new Set([LOCAL]) });
    this.provider = new WebsocketProvider(`${conn.wsBase}/collab`, encodeURIComponent(`file:${path}`), this.doc, {
      WebSocketPolyfill: conn.socketClass(),
      disableBc: true,
      params: { ack: "1" },
    });
    this.provider.messageHandlers[MESSAGE_ACK] = (_enc, dec) => this.acknowledged(Y.decodeStateVector(decoding.readVarUint8Array(dec)));
    this.provider.awareness.setLocalStateField("user", { id: me.id, name: me.name, color: me.color, colorLight: `${me.color}33` });
    this.provider.on("status", ({ status }: { status: string }) => {
      if (status !== "connected" && this.state !== "gone" && this.state !== "paused") this.set("offline");
    });
    this.provider.on("connection-close", (e: { code?: number } | null) => {
      if (e) this.choices.log(`${this.path}: connection closed (${e.code})`);
      // 4410: renamed or deleted in Relay. Reconnecting would send this copy back, so stop for good.
      if (e?.code !== 4410) return;
      this.provider.shouldConnect = false;
      this.provider.disconnect();
      this.set("gone");
    });
    this.provider.on("sync", (synced: boolean) => {
      this.choices.log(`${this.path}: ${synced ? "synced" : "syncing"}`);
      if (!synced) return this.set("connecting");
      if (this.state === "paused" || this.state === "gone") return;
      if (!this.bound) void this.bind();
      else this.set("synced");
    });
    // Everything that changes the shared text and didn't come from this editor waits to be shown.
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === LOCAL || !this.bound) return;
      this.pending.push(update);
      void this.flush();
    });
    // The editor's own edits, made in `view`, go to the shared document.
    this.view.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === LOCAL) Y.applyUpdate(this.doc, update, LOCAL);
    });
    this.provider.awareness.on("change", () => this.emit());
  }

  // ---------- binding ----------

  private async bind(): Promise<void> {
    if (this.binding || this.bound) return;
    this.binding = true;
    try {
      const local = this.document.getText();
      const shared = this.text.toString();
      let choice: Divergence = "shared";
      if (local !== shared) choice = await this.choices.divergence(this.path, local, shared);
      if (choice === "skip") {
        this.set("paused");
        this.provider.disconnect();
        return;
      }
      if (choice === "local") {
        if (this.me.role === "viewer") throw new Error("Viewers can't change shared files");
        const r = replacement(this.text.toString(), this.document.getText());
        if (r) this.doc.transact(() => (this.text.delete(r.start, r.end - r.start), this.text.insert(r.start, r.insert)), LOCAL);
        this.noteLocalEdit();
      }
      // Show the shared text in the editor (a no-op if they're already equal), retrying if the person types meanwhile.
      for (let i = 0; i < 50 && this.document.getText() !== this.text.toString(); i++) {
        const r = replacement(this.document.getText(), this.text.toString())!;
        const we = new vscode.WorkspaceEdit();
        we.replace(this.document.uri, new vscode.Range(this.document.positionAt(r.start), this.document.positionAt(r.end)), r.insert);
        await vscode.workspace.applyEdit(we);
      }
      if (this.document.getText() !== this.text.toString()) throw new Error(`Couldn't bring ${this.path} in step with the shared copy; reopen the file to try again.`);
      Y.applyUpdate(this.view, Y.encodeStateAsUpdate(this.doc), SHOWN);
      this.bound = true;
      if (this.provider.synced && this.state !== "gone") this.set("synced");
      void this.flush();
    } catch (e) {
      this.set("paused");
      this.provider.disconnect();
      void vscode.window.showErrorMessage(`Relay: ${(e as Error).message}`);
    } finally {
      this.binding = false;
    }
  }

  // ---------- local edits (typed in VS Code) ----------

  /** Called for every change event of this document, in order. */
  onLocalChange(e: vscode.TextDocumentChangeEvent): void {
    if (!this.bound || !e.contentChanges.length) return;
    const after = e.document.getText();
    if (this.writing && after === this.writing.target) return this.shown();
    if (this.held) return;
    // VS Code's own undo/redo (Edit menu, Command Palette, toolbar, any key not bound to Relay's) works on its native
    // history, which includes collaborators' edits. Put the text back and run Relay's undo, which only reverts yours.
    if (e.reason === vscode.TextDocumentChangeReason.Undo || e.reason === vscode.TextDocumentChangeReason.Redo) {
      void this.nativeUndo(e.reason === vscode.TextDocumentChangeReason.Redo);
      return;
    }
    // Rewritten on disk by another program and reloaded by VS Code: the document is clean and its text is exactly the
    // file on disk. (VS Code updates `isDirty` after the change event, so a first keystroke can look clean too; typing
    // never makes the editor equal to the file on disk, which is why both are checked. The disk is only read on that
    // clean-document case, not on every keystroke.) Don't share it, or overwrite it, without asking.
    if (!e.document.isDirty && this.document.uri.scheme === "file" && readDisk(this.document.uri.fsPath) === after) {
      void this.externalChange();
      return;
    }
    if (this.me.role === "viewer") {
      if (!this.readOnlyWarned) void vscode.window.showWarningMessage(`You're a viewer in this Relay project: changes to ${this.path} aren't shared, and are replaced by the shared text.`);
      this.readOnlyWarned = true;
      // Put the shared text back.
      void this.hold(() => this.restoreEditor());
      return;
    }
    // Offsets are the editor's, and `view` should be the editor as it was before this change. Check that before
    // forwarding anything: if it isn't (e.g. VS Code reopened a renamed file from disk, then restored its unsaved
    // text), these offsets would land in the wrong place for everyone.
    const changes = [...e.contentChanges].sort((a, b) => b.rangeOffset - a.rangeOffset);
    let expected = this.viewText.toString();
    for (const c of changes) expected = expected.slice(0, c.rangeOffset) + c.text + expected.slice(c.rangeOffset + c.rangeLength);
    if (expected !== after) {
      void this.outOfStep(after);
      return;
    }
    this.view.transact(() => {
      for (const c of changes) {
        if (c.rangeLength) this.viewText.delete(c.rangeOffset, c.rangeLength);
        if (c.text) this.viewText.insert(c.rangeOffset, c.text);
      }
    }, LOCAL);
    this.noteLocalEdit();
    void this.flush();
  }

  /** Our write landed: the editor now shows the pending updates it covered. Catch `view` up with them. */
  private shown(): void {
    const w = this.writing!;
    w.landed = true;
    const covered = this.pending.splice(0, w.covers);
    if (covered.length) Y.applyUpdate(this.view, Y.mergeUpdates(covered), SHOWN);
    if (this.viewText.toString() !== w.target) void this.outOfStep(this.document.getText());
  }

  // ---------- shared edits (collaborators, undo) → the editor ----------

  /** Write pending shared updates into the editor. One write at a time; retried when VS Code refuses a stale one. */
  private async flush(): Promise<void> {
    if (!this.bound || this.held || this.writing || !this.pending.length) return;
    // Edits are computed in `view`'s offsets; they're only valid if the editor shows exactly `view`.
    if (this.document.getText() !== this.viewText.toString()) return void this.outOfStep(this.document.getText());
    // What the editor would show with the pending updates: computed on a copy of `view`, as edits in its offsets.
    const covers = this.pending.length;
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(this.view));
    const copyText = copy.getText("content");
    let delta: Y.YTextEvent["delta"] = [];
    copyText.observe((ev) => (delta = ev.delta));
    Y.applyUpdate(copy, Y.mergeUpdates(this.pending.slice(0, covers)));
    const target = copyText.toString();
    copy.destroy();
    if (target === this.viewText.toString()) {
      // Nothing visible (e.g. formatting attributes or an echo): catch up without touching the editor.
      Y.applyUpdate(this.view, Y.mergeUpdates(this.pending.splice(0, covers)), SHOWN);
      return;
    }
    const ops: EditOp[] = [];
    let pos = 0;
    for (const d of delta) {
      if (d.retain !== undefined) pos += d.retain;
      else if (d.delete !== undefined) {
        const last = ops.at(-1);
        if (last && last.offset + last.length === pos) last.length += d.delete;
        else ops.push({ offset: pos, length: d.delete, text: "" });
        pos += d.delete;
      } else if (typeof d.insert === "string") {
        const last = ops.at(-1);
        if (last && last.offset + last.length === pos) last.text += d.insert;
        else ops.push({ offset: pos, length: 0, text: d.insert });
      }
    }
    const doc = this.document;
    const we = new vscode.WorkspaceEdit();
    for (const op of ops) we.replace(doc.uri, new vscode.Range(doc.positionAt(op.offset), doc.positionAt(op.offset + op.length)), op.text);
    const w = (this.writing = { target, covers, landed: false });
    try {
      // Version-checked by VS Code: if the person typed since, nothing is applied (and we try again below).
      const ok = await vscode.workspace.applyEdit(we);
      // VS Code updates the document (and fires its change event) before the edit's promise resolves.
      if (ok && !w.landed && this.document.getText() === target) this.shown();
    } finally {
      this.writing = null;
    }
    if (this.pending.length) setImmediate(() => void this.flush());
  }

  /** Make the editor show `view` again (after a native undo or an outside rewrite), retrying if VS Code refuses. */
  private async restoreEditor(): Promise<void> {
    for (let i = 0; i < 50 && this.document.getText() !== this.viewText.toString(); i++) {
      const target = this.viewText.toString();
      const r = replacement(this.document.getText(), target)!;
      const we = new vscode.WorkspaceEdit();
      we.replace(this.document.uri, new vscode.Range(this.document.positionAt(r.start), this.document.positionAt(r.end)), r.insert);
      this.writing = { target, covers: 0, landed: false };
      try {
        await vscode.workspace.applyEdit(we);
      } finally {
        this.writing = null;
      }
    }
  }

  private async nativeUndo(redo: boolean): Promise<void> {
    this.held = true;
    try {
      await this.restoreEditor();
      const stack = redo ? this.undoManager.redoStack : this.undoManager.undoStack;
      if (!stack.length) this.choices.notice(redo ? "Nothing of yours to redo in this file." : "Nothing of yours to undo in this file. Relay's undo only reverts your own edits.");
      else if (redo) this.undoManager.redo();
      else this.undoManager.undo();
    } finally {
      this.held = false;
    }
    void this.flush();
  }

  private async externalChange(): Promise<void> {
    this.held = true;
    try {
      const choice = await this.choices.externalChange(this.path);
      if (choice === "share") {
        if (this.me.role === "viewer") throw new Error("Viewers can't change shared files");
        const r = replacement(this.viewText.toString(), this.document.getText());
        if (r) this.view.transact(() => (this.viewText.delete(r.start, r.end - r.start), this.viewText.insert(r.start, r.insert)), LOCAL);
        this.noteLocalEdit();
      } else await this.restoreEditor();
    } catch (e) {
      this.choices.notice((e as Error).message);
      await this.restoreEditor();
    } finally {
      this.held = false;
    }
    void this.flush();
  }

  /** Wait (up to `ms`) until the server has confirmed every edit from this window. True if it has. */
  async confirmedWithin(ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (this.unsent() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    return !this.unsent();
  }

  /**
   * The file was renamed (here or in Relay): keep this shared document, its undo history and anything not yet sent,
   * and connect it under the new name. The server carried the history to the new name; syncing sends what it lacks.
   */
  retarget(path: string, document: vscode.TextDocument): void {
    this.path = path;
    this.document = document;
    this.provider.disconnect();
    this.provider.roomname = encodeURIComponent(`file:${path}`);
    this.provider.shouldConnect = true;
    this.provider.connect();
    this.set("connecting");
  }

  /** Run `fn` with forwarding and writing paused, then catch up. */
  private async hold(fn: () => Promise<void>): Promise<void> {
    this.held = true;
    try {
      await fn();
    } finally {
      this.held = false;
    }
    void this.flush();
  }

  /**
   * The editor no longer shows what this session believes it shows. If it now shows the shared text, nothing to do.
   * Otherwise it holds something Relay doesn't (or lacks something it has): never guess, ask, exactly as when a file
   * that differs is first opened. Nothing is forwarded or overwritten until then.
   */
  private async outOfStep(editorText: string): Promise<void> {
    if (this.held) return;
    if (editorText === this.viewText.toString()) return;
    this.choices.log(`${this.path}: editor out of step with its shared copy (${editorText.length} vs ${this.viewText.length} chars); asking`);
    await this.hold(async () => {
      const choice = this.me.role === "viewer" ? "shared" : await this.choices.divergence(this.path, this.document.getText(), this.viewText.toString());
      if (choice === "local") {
        const r = replacement(this.viewText.toString(), this.document.getText());
        if (r) this.view.transact(() => (this.viewText.delete(r.start, r.end - r.start), this.viewText.insert(r.start, r.insert)), LOCAL);
        this.noteLocalEdit();
      } else if (choice === "shared") await this.restoreEditor();
      else {
        this.bound = false;
        this.set("paused");
        this.provider.disconnect();
      }
    });
  }

  // ---------- saved / not saved ----------

  private noteLocalEdit(): void {
    if (!this.unsent() || this.unconfirmedSince !== null) return;
    this.unconfirmedSince = Date.now();
    clearTimeout(this.lateTimer);
    this.lateTimer = setTimeout(() => this.emit(), UNCONFIRMED_MS + 50);
    this.emit();
  }

  private acknowledged(sv: Map<number, number>): void {
    for (const id of [this.doc.clientID, this.view.clientID]) this.confirmed.set(id, Math.max(this.confirmed.get(id) ?? 0, sv.get(id) ?? 0));
    if (this.unsent() || this.unconfirmedSince === null) return;
    this.unconfirmedSince = null;
    clearTimeout(this.lateTimer);
    this.emit();
  }

  /** Edits from this window (typing in `view`, undo in `doc`) the server hasn't confirmed saving. */
  unsent(): boolean {
    return [this.doc.clientID, this.view.clientID].some((id) => Y.getState(this.doc.store, id) > (this.confirmed.get(id) ?? 0));
  }

  /** Unconfirmed for longer than a round trip should take: the connection may be dead. */
  late(): boolean {
    return this.unconfirmedSince !== null && Date.now() - this.unconfirmedSince >= UNCONFIRMED_MS;
  }

  // ---------- presence ----------

  /** Share this window's caret and selection, in the browser IDE's format (Yjs relative positions). */
  setCursor(anchor: number, head: number): void {
    if (!this.bound) return;
    // Positions in `view` are positions in the editor; their item ids resolve the same in the shared document.
    this.provider.awareness.setLocalStateField("cursor", {
      anchor: Y.createRelativePositionFromTypeIndex(this.viewText, anchor),
      head: Y.createRelativePositionFromTypeIndex(this.viewText, head),
    });
  }

  /** Collaborators in this file and where their carets are, in this editor's offsets. */
  peers(): Peer[] {
    const out: Peer[] = [];
    for (const [clientId, s] of this.provider.awareness.getStates()) {
      if (clientId === this.doc.clientID || !s.user?.id || s.user.id === this.me.id) continue;
      const at = (rel: unknown) => {
        if (!rel || !this.bound) return null;
        // Resolved in `view`, so the offset is the editor's even while some of their edits are still on the way.
        const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(rel), this.view);
        return abs ? abs.index : null;
      };
      out.push({ clientId, member: { id: s.user.id, name: s.user.name, color: s.user.color }, head: at(s.cursor?.head), anchor: at(s.cursor?.anchor) });
    }
    return out;
  }

  // ---------- lifecycle ----------

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(s: SyncState): void {
    this.state = s;
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  dispose(): void {
    clearTimeout(this.lateTimer);
    this.listeners.clear();
    this.provider.destroy();
    this.doc.destroy();
    this.view.destroy();
  }
}
