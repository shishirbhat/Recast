import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import type { Member } from "./types";

export type SyncStatus = "connecting" | "synced" | "offline";

/** One shared file: its Yjs document, the connection, and this user's presence in it. */
export class DocSession {
  readonly path: string;
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  readonly provider: WebsocketProvider;
  readonly undoManager: Y.UndoManager;
  status: SyncStatus = "connecting";
  private listeners = new Set<() => void>();

  constructor(path: string, me: Member) {
    this.path = path;
    this.doc = new Y.Doc();
    this.text = this.doc.getText("content");
    // Undo only reverts this user's own edits, never a collaborator's.
    this.undoManager = new Y.UndoManager(this.text);
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    this.provider = new WebsocketProvider(`${proto}//${location.host}/collab`, encodeURIComponent(`file:${path}`), this.doc, { disableBc: true });
    this.provider.awareness.setLocalStateField("user", { id: me.id, name: me.name, color: me.color, colorLight: me.color + "33" });
    this.provider.on("status", ({ status }: { status: string }) => {
      if (status !== "connected") this.set("offline");
    });
    this.provider.on("sync", (synced: boolean) => this.set(synced ? "synced" : "connecting"));
  }

  private set(s: SyncStatus): void {
    this.status = s;
    for (const l of this.listeners) l();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
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
    this.provider.destroy();
    this.doc.destroy();
  }
}
