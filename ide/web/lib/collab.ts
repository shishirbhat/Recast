import * as Y from "yjs";
import * as decoding from "lib0/decoding";
import { WebsocketProvider } from "y-websocket";
import { restorePresenceOnReconnect } from "./presence";
import type { Member } from "./types";

/** "gone": the file was renamed or deleted; the session stops and never reconnects. */
export type SyncStatus = "connecting" | "synced" | "offline" | "gone";

/** Relay's acknowledgement message: the server's state vector after it saved our update (`src/server/collab.ts`). */
const MESSAGE_ACK = 10;
/** How long our edits may be unconfirmed before the status bar stops saying "Synced". */
export const UNCONFIRMED_MS = 2500;

/** One shared file: its Yjs document, the connection, and this user's presence in it. */
let nextId = 0;

export class DocSession {
  /** Stable for the life of the session, across renames; editors are keyed by it so they never remount on a rename. */
  readonly id = `doc-${++nextId}`;
  /** The file this document is, now. Changes when someone renames it (see `retarget`). */
  path: string;
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  readonly provider: WebsocketProvider;
  readonly undoManager: Y.UndoManager;
  status: SyncStatus = "connecting";
  /** Local edits made while not connected: kept in the CRDT and sent on reconnect, but not yet on the server. */
  pendingOffline = false;
  /** Our own edits the server has confirmed saving: its clock for our Yjs client id. */
  private confirmed = 0;
  /** When our oldest unconfirmed edit was made, or null when the server has everything we typed. */
  private unconfirmedSince: number | null = null;
  private lateTimer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();
  /** Member id -> when their last document update arrived. Typing is read from the edits themselves, not extra messages. */
  private typedAt = new Map<string, number>();
  private typingLapse: ReturnType<typeof setTimeout> | undefined;

  constructor(path: string, me: Member) {
    this.path = path;
    this.doc = new Y.Doc();
    this.text = this.doc.getText("content");
    // Undo only reverts this user's own edits, never a collaborator's.
    this.undoManager = new Y.UndoManager(this.text);
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    this.provider = new WebsocketProvider(`${proto}//${location.host}/collab`, encodeURIComponent(`file:${path}`), this.doc, { disableBc: true, params: { ack: "1" } });
    this.provider.messageHandlers[MESSAGE_ACK] = (_enc, dec) => this.acknowledged(Y.decodeStateVector(decoding.readVarUint8Array(dec)));
    restorePresenceOnReconnect(this.provider);
    this.provider.awareness.setLocalStateField("user", { id: me.id, name: me.name, color: me.color, colorLight: me.color + "33" });
    this.provider.on("status", ({ status }: { status: string }) => {
      if (status !== "connected" && this.status !== "gone") this.set("offline");
    });
    // The server closes with 4410 when the file is renamed or deleted. Reconnecting would send this copy back and
    // could recreate the file, so stop for good.
    this.provider.on("connection-close", (e: CloseEvent | null) => {
      if (e?.code !== 4410) return;
      this.provider.shouldConnect = false;
      this.provider.disconnect();
      this.set("gone");
    });
    this.provider.on("sync", (synced: boolean) => {
      this.set(synced ? "synced" : "connecting");
    });
    this.doc.on("update", (u: Uint8Array, origin: unknown) => {
      if (origin === this.provider) {
        const clients = new Set(Y.decodeUpdate(u).structs.map((s) => s.id.client));
        for (const [cid, st] of this.provider.awareness.getStates()) if (clients.has(cid) && st.user?.id) this.typedAt.set(st.user.id, Date.now());
        if (clients.size) {
          this.set(this.status);
          // Let the "typing" state lapse visibly once the edits stop.
          clearTimeout(this.typingLapse);
          this.typingLapse = setTimeout(() => this.set(this.status), 2600);
        }
      }
      // Origin is the provider for remote updates; anything else is a local edit.
      if (origin === this.provider || !this.unsent()) return;
      if (this.unconfirmedSince === null) {
        this.unconfirmedSince = Date.now();
        clearTimeout(this.lateTimer);
        this.lateTimer = setTimeout(() => this.set(this.status), UNCONFIRMED_MS + 50);
      }
      if (this.status !== "synced" && !this.pendingOffline) {
        this.pendingOffline = true;
        this.set(this.status);
      }
    });
  }

  /** How much this browser has typed into the document; compare two readings to tell whether the person typed between. */
  ownClock(): number {
    return Y.getState(this.doc.store, this.doc.clientID);
  }

  /** Edits of ours the server hasn't confirmed yet (typed offline, in flight, or lost on a dead connection). */
  unsent(): boolean {
    return Y.getState(this.doc.store, this.doc.clientID) > this.confirmed;
  }

  /**
   * Our edits have gone unconfirmed for longer than a round trip should take. The connection may look open but be
   * dead (no acknowledgement ever comes), so the status bar says so instead of "Synced". Edits stay in the CRDT and
   * are resent when the connection recovers.
   */
  late(): boolean {
    return this.unconfirmedSince !== null && Date.now() - this.unconfirmedSince >= UNCONFIRMED_MS;
  }

  private acknowledged(sv: Map<number, number>): void {
    this.confirmed = Math.max(this.confirmed, sv.get(this.doc.clientID) ?? 0);
    if (this.unsent() || (this.unconfirmedSince === null && !this.pendingOffline)) return;
    this.unconfirmedSince = null;
    this.pendingOffline = false;
    clearTimeout(this.lateTimer);
    this.set(this.status);
  }

  private set(s: SyncStatus): void {
    this.status = s;
    for (const l of this.listeners) l();
  }

  /**
   * The file was renamed: keep this document (its text, undo history, awareness and anything typed but not yet sent)
   * and connect it to the file's new name. The server carried the document's history to the new name, so syncing
   * sends exactly what the server doesn't have yet; nothing typed during the rename is lost.
   */
  retarget(path: string): void {
    if (path === this.path) return;
    this.path = path;
    this.provider.disconnect();
    this.provider.roomname = encodeURIComponent(`file:${path}`);
    this.provider.connect();
    this.set("connecting");
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Collaborators who changed this file in the last few seconds. */
  typing(windowMs = 2500): string[] {
    const t = Date.now();
    return [...this.typedAt.entries()].filter(([, at]) => t - at < windowMs).map(([id]) => id);
  }

  /** A collaborator's caret in this file (1-based line), resolved from their awareness state. */
  cursorOf(memberId: string): { line: number; col: number } | null {
    for (const [, s] of this.provider.awareness.getStates()) {
      if (s.user?.id !== memberId || !s.cursor?.head) continue;
      const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(s.cursor.head), this.doc);
      if (!abs) return null;
      const before = this.text.toString().slice(0, abs.index);
      const line = before.split("\n").length;
      return { line, col: abs.index - before.lastIndexOf("\n") };
    }
    return null;
  }

  /** Collaborators currently in this file (excluding me), from live awareness. */
  peers(): { clientId: number; name: string; color: string; id: string }[] {
    const out: { clientId: number; name: string; color: string; id: string }[] = [];
    for (const [cid, s] of this.provider.awareness.getStates()) {
      if (cid === this.doc.clientID || !s.user) continue;
      out.push({ clientId: cid, name: s.user.name, color: s.user.color, id: s.user.id });
    }
    return out;
  }

  destroy(): void {
    clearTimeout(this.typingLapse);
    clearTimeout(this.lateTimer);
    this.provider.destroy();
    this.doc.destroy();
  }
}
