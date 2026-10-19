import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type { WebSocket } from "ws";
import type { DocStore, DocEntry } from "./docs.ts";
import type { Member } from "./auth.ts";
import { can } from "./auth.ts";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;
/** Bytes a client may have queued before we drop it instead of buffering without bound. */
const MAX_BUFFERED = 8 * 1024 * 1024;
const PING_MS = 15_000;

interface Room {
  entry: DocEntry;
  onUpdate: (update: Uint8Array, origin: unknown) => void;
  awareness: awarenessProtocol.Awareness;
  conns: Map<WebSocket, Conn>;
}

/** One connection's identity and the awareness client IDs it is allowed to speak for. */
export interface Conn {
  member: Member;
  clientIds: Set<number>;
  alive: boolean;
}

function send(ws: WebSocket, data: Uint8Array): void {
  if (ws.readyState !== ws.OPEN) return;
  if (ws.bufferedAmount > MAX_BUFFERED) {
    ws.close(1013, "client too slow");
    return;
  }
  ws.send(data, (err) => {
    if (err) ws.terminate();
  });
}

/**
 * Parse an awareness update and check that every state it carries belongs to this connection's member.
 * Awareness is client-authored, so without this a client could show up as someone else.
 */
function awarenessIsOwn(update: Uint8Array, conn: Conn, room: Room): boolean {
  const d = decoding.createDecoder(update);
  const n = decoding.readVarUint(d);
  for (let i = 0; i < n; i++) {
    const clientId = decoding.readVarUint(d);
    decoding.readVarUint(d); // clock
    const state = JSON.parse(decoding.readVarString(d)) as { user?: { id?: unknown } } | null;
    for (const [other, c] of room.conns) if (other !== undefined && c !== conn && c.clientIds.has(clientId)) return false;
    if (state !== null && state.user?.id !== conn.member.id) return false;
  }
  return true;
}

export class CollabService {
  private rooms = new Map<string, Room>();
  private store: DocStore;
  private pinger: NodeJS.Timeout;

  constructor(store: DocStore) {
    this.store = store;
    this.pinger = setInterval(() => this.heartbeat(), PING_MS);
  }

  private room(path: string): Room {
    let room = this.rooms.get(path);
    if (room) return room;
    const entry = this.store.open(path);
    const awareness = new awarenessProtocol.Awareness(entry.doc);
    awareness.setLocalState(null); // the server has no presence of its own
    const r: Room = {
      entry,
      awareness,
      conns: new Map(),
      onUpdate: (update, origin) => {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MESSAGE_SYNC);
        syncProtocol.writeUpdate(enc, update);
        const msg = encoding.toUint8Array(enc);
        for (const ws of r.conns.keys()) if (ws !== origin) send(ws, msg);
      },
    };
    entry.doc.on("update", r.onUpdate);
    awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      const changed = [...added, ...updated, ...removed];
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
      const msg = encoding.toUint8Array(enc);
      for (const ws of r.conns.keys()) send(ws, msg);
    });
    this.rooms.set(path, r);
    room = r;
    return room;
  }

  /** Who is in which document right now (ephemeral). */
  presence(): { path: string; members: string[] }[] {
    return [...this.rooms.entries()].map(([path, r]) => ({ path, members: [...new Set([...r.conns.values()].map((c) => c.member.id))] }));
  }

  /** Attach an authenticated socket to a document. The caller has already validated `path` and `member`. */
  attach(ws: WebSocket, path: string, member: Member): void {
    const room = this.room(path);
    const conn: Conn = { member, clientIds: new Set(), alive: true };
    room.conns.set(ws, conn);
    ws.binaryType = "arraybuffer";
    ws.on("pong", () => (conn.alive = true));

    ws.on("message", (raw: ArrayBuffer | Buffer) => {
      try {
        const data = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
        const dec = decoding.createDecoder(data);
        const type = decoding.readVarUint(dec);
        if (type === MESSAGE_SYNC) {
          const syncType = decoding.peekVarUint(dec);
          // Viewers may ask for state (step 1) but never send content (step 2 or updates).
          if (syncType !== syncProtocol.messageYjsSyncStep1 && !can(conn.member.role, "edit")) return;
          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, MESSAGE_SYNC);
          syncProtocol.readSyncMessage(dec, enc, room.entry.doc, ws);
          if (encoding.length(enc) > 1) send(ws, encoding.toUint8Array(enc));
        } else if (type === MESSAGE_AWARENESS) {
          const update = decoding.readVarUint8Array(dec);
          if (!awarenessIsOwn(update, conn, room)) return;
          const d2 = decoding.createDecoder(update);
          const n = decoding.readVarUint(d2);
          for (let i = 0; i < n; i++) {
            conn.clientIds.add(decoding.readVarUint(d2));
            decoding.readVarUint(d2);
            decoding.readVarString(d2);
          }
          awarenessProtocol.applyAwarenessUpdate(room.awareness, update, ws);
        } else if (type === MESSAGE_QUERY_AWARENESS) {
          this.sendAwareness(ws, room);
        }
      } catch {
        ws.close(1003, "malformed message");
      }
    });

    ws.on("close", () => {
      room.conns.delete(ws);
      awarenessProtocol.removeAwarenessStates(room.awareness, [...conn.clientIds], null);
      if (room.conns.size === 0) {
        this.store.flush(room.entry);
        room.entry.doc.off("update", room.onUpdate);
        room.awareness.destroy();
        this.rooms.delete(path);
      }
    });

    // Start the sync handshake and send who is already here.
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(enc, room.entry.doc);
    send(ws, encoding.toUint8Array(enc));
    this.sendAwareness(ws, room);
  }

  private sendAwareness(ws: WebSocket, room: Room): void {
    const states = room.awareness.getStates();
    if (states.size === 0) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()]));
    send(ws, encoding.toUint8Array(enc));
  }

  /** Drop connections that stopped answering pings; their presence goes with them. */
  private heartbeat(): void {
    for (const room of this.rooms.values()) {
      for (const [ws, conn] of room.conns) {
        if (!conn.alive) {
          ws.terminate();
          continue;
        }
        conn.alive = false;
        ws.ping();
      }
    }
  }

  /** Close every connection belonging to a member (on revocation). */
  disconnectMember(memberId: string): void {
    for (const room of this.rooms.values()) for (const [ws, c] of room.conns) if (c.member.id === memberId) ws.close(4401, "access revoked");
  }

  close(): void {
    clearInterval(this.pinger);
    for (const room of this.rooms.values()) for (const ws of room.conns.keys()) ws.terminate();
    this.rooms.clear();
  }
}

export { Y };
