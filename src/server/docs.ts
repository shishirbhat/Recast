import * as Y from "yjs";
import { statSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import type { FSWatcher } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { merge3, readText, splice, writeAtomic } from "./files.ts";
import { tx } from "../core/db.ts";

/** Who caused a document change. Connections are objects; server-side origins are these strings. */
export type ServerOrigin = "seed" | "disk" | "agent" | "restore";

/** A pending text change from the current transaction, measured in the observer before the update is logged. */
interface PendingDelta {
  inserted: number;
  deleted: number;
  wsInserted: number;
  wsDeleted: number;
  lineMin: number;
  lineMax: number;
}

interface OpenSession {
  id: string;
  author: string;
  lastAt: number;
  timer: NodeJS.Timeout;
}

export interface DocEntry {
  path: string;
  doc: Y.Doc;
  text: Y.Text;
  /** Exactly what the server last wrote to (or read from) disk. */
  lastWritten: string | null;
  timer: NodeJS.Timeout | null;
  updatesSinceCompaction: number;
  pending: PendingDelta | null;
  sessions: Map<string, OpenSession>;
}

export interface DocStoreEvents {
  /** A change was applied to a document. `origin` is a connection object for client edits. */
  onChange?: (path: string, origin: unknown) => void;
  /** Something worth recording in the project's event log. */
  onEvent?: (type: string, data: Record<string, unknown>) => void;
}

const now = () => new Date().toISOString();
/** Edits by the same author in the same file closer together than this form one session. */
export const SESSION_GAP_MS = 5 * 60_000;
const randomClientId = () => (Math.random() * 0xffffffff) >>> 0;

export class DocStore {
  private db: DatabaseSync;
  private root: string;
  private entries = new Map<string, DocEntry>();
  private dirWatchers = new Map<string, FSWatcher>();
  private poller: NodeJS.Timeout | null = null;
  private stats = new Map<string, string>();
  private watching: boolean;
  private watchTimers = new Map<string, NodeJS.Timeout>();
  readonly flushMs: number;
  readonly compactEvery: number;
  private events: DocStoreEvents;
  /** Maps a transaction origin (a client connection) to the member who sent it. Set by the collaboration service. */
  attributor: ((origin: unknown) => string | undefined) | null = null;

  constructor(db: DatabaseSync, root: string, opts: { flushMs?: number; compactEvery?: number; watch?: boolean } & DocStoreEvents = {}) {
    this.db = db;
    this.root = root;
    this.flushMs = opts.flushMs ?? 300;
    this.compactEvery = opts.compactEvery ?? 500;
    this.events = { onChange: opts.onChange, onEvent: opts.onEvent };
    this.watching = opts.watch !== false;
    if (this.watching) this.startWatching();
  }

  static docName(path: string): string {
    return `file:${path}`;
  }

  loaded(): string[] {
    return [...this.entries.keys()];
  }

  get(path: string): DocEntry | undefined {
    return this.entries.get(path);
  }

  /** Loads (or creates) the shared document for an already-validated repo-relative path. */
  open(path: string): DocEntry {
    const existing = this.entries.get(path);
    if (existing) return existing;
    const name = DocStore.docName(path);
    const doc = new Y.Doc({ gc: true });
    const text = doc.getText("content");
    // Latest snapshot, then every update after it. The full update log stays as history.
    const snap = this.db.prepare("SELECT upto_seq, data FROM doc_snapshots WHERE doc = ? ORDER BY upto_seq DESC LIMIT 1").get(name) as { upto_seq: number; data: Uint8Array } | undefined;
    if (snap) Y.applyUpdate(doc, snap.data, "restore");
    const rows = this.db.prepare("SELECT data FROM doc_updates WHERE doc = ? AND seq > ? ORDER BY seq").all(name, snap?.upto_seq ?? 0) as { data: Uint8Array }[];
    for (const r of rows) Y.applyUpdate(doc, r.data, "restore");
    const fileRow = this.db.prepare("SELECT last_written FROM doc_files WHERE doc = ?").get(name) as { last_written: string } | undefined;
    const entry: DocEntry = { path, doc, text, lastWritten: fileRow?.last_written ?? null, timer: null, updatesSinceCompaction: rows.length, pending: null, sessions: new Map() };
    this.entries.set(path, entry);
    this.watchDir(path);
    this.stats.set(path, this.statOf(path));

    // Measure what each transaction did to the text (observers run before the update is emitted).
    text.observe((event, tr) => {
      if (tr.origin === "restore") return;
      const after = text.toString();
      const lineAt = (pos: number) => {
        let n = 1;
        for (let i = 0; i < pos && i < after.length; i++) if (after.charCodeAt(i) === 10) n++;
        return n;
      };
      const d: PendingDelta = { inserted: 0, deleted: 0, wsInserted: 0, wsDeleted: 0, lineMin: Infinity, lineMax: 0 };
      let pos = 0;
      for (const op of event.delta) {
        if (op.retain) pos += op.retain;
        else if (typeof op.insert === "string") {
          d.inserted += op.insert.length;
          if (!op.insert.trim()) d.wsInserted += op.insert.length;
          d.lineMin = Math.min(d.lineMin, lineAt(pos));
          d.lineMax = Math.max(d.lineMax, lineAt(pos + op.insert.length));
          pos += op.insert.length;
        } else if (op.delete) {
          d.deleted += op.delete;
          d.lineMin = Math.min(d.lineMin, lineAt(pos));
          d.lineMax = Math.max(d.lineMax, lineAt(pos));
        }
      }
      entry.pending = d;
    });

    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "restore") return;
      // Durable before anyone else sees it: the update log is written synchronously, then broadcast.
      const seq = Number(this.db.prepare("INSERT INTO doc_updates (doc, data, created_at) VALUES (?,?,?)").run(name, update, now()).lastInsertRowid);
      const delta = entry.pending;
      entry.pending = null;
      const author = typeof origin === "string" ? (origin.startsWith("agent:") ? origin : `relay:${origin}`) : this.attributor?.(origin);
      if (author && typeof origin !== "string") this.claimClients(path, DocStore.clientsIn(update), author);
      if (delta && author && origin !== "seed") this.recordEdit(entry, author, seq, delta);
      entry.updatesSinceCompaction++;
      if (entry.updatesSinceCompaction >= this.compactEvery) this.compact(entry);
      this.scheduleFlush(entry);
      this.events.onChange?.(path, origin);
    });

    const disk = readText(this.root, path);
    if (rows.length === 0 && !snap) {
      // First time this file is shared: the disk content becomes the initial document (pre-existing content).
      if (disk) this.serverTransact(entry, "seed", () => text.insert(0, disk));
      entry.lastWritten = disk ?? "";
      this.recordWritten(entry);
    } else if (disk !== null && disk !== entry.lastWritten) {
      // The file changed on disk while nobody had it open (or while the server was down).
      this.reconcile(entry, disk);
    }
    return entry;
  }

  /** Yjs client IDs that authored structs in an update. */
  static clientsIn(update: Uint8Array): number[] {
    return [...new Set(Y.decodeUpdate(update).structs.map((s) => s.id.client))];
  }

  /** Record a refused document update in the event log (no content, just who and why). */
  reject(path: string, member: string, reason: string): void {
    this.events.onEvent?.("doc.update_rejected", { path, member, reason });
  }

  /** Who owns a client ID in a document, if anyone has claimed it. */
  clientOwner(path: string, client: number): string | undefined {
    return (this.db.prepare("SELECT author FROM doc_clients WHERE doc = ? AND client_id = ?").get(DocStore.docName(path), client) as { author: string } | undefined)?.author;
  }

  /** Bind unclaimed client IDs to an author. Already-claimed IDs are left alone (the caller rejects conflicting claims). */
  claimClients(path: string, clients: number[], author: string): void {
    const stmt = this.db.prepare("INSERT OR IGNORE INTO doc_clients (doc, client_id, author, created_at) VALUES (?,?,?,?)");
    for (const c of clients) stmt.run(DocStore.docName(path), c, author, now());
  }

  /** Every client ID of a document and its author. */
  clientAuthors(path: string): Map<number, string> {
    const rows = this.db.prepare("SELECT client_id, author FROM doc_clients WHERE doc = ?").all(DocStore.docName(path)) as { client_id: number; author: string }[];
    return new Map(rows.map((r) => [r.client_id, r.author]));
  }

  /**
   * Server-made edits get their own Yjs client ID, bound to a labelled author (baseline content, a disk merge, an
   * applied agent run), so their characters are never mistaken for a person's.
   */
  private serverTransact(entry: DocEntry, origin: string, fn: () => void): void {
    entry.doc.clientID = randomClientId();
    const author = origin === "seed" ? "relay:baseline" : origin.startsWith("agent:") ? origin : `relay:${origin}`;
    this.claimClients(entry.path, [entry.doc.clientID], author);
    entry.doc.transact(fn, origin);
  }

  private recordEdit(entry: DocEntry, author: string, seq: number, d: PendingDelta): void {
    const at = Date.now();
    const open = entry.sessions.get(author);
    const lineMin = Number.isFinite(d.lineMin) ? d.lineMin : null;
    const lineMax = d.lineMax || null;
    if (open && at - open.lastAt < SESSION_GAP_MS) {
      this.db
        .prepare("UPDATE doc_sessions SET ended_at = ?, last_seq = ?, inserted = inserted + ?, deleted = deleted + ?, ws_inserted = ws_inserted + ?, ws_deleted = ws_deleted + ?, edits = edits + 1, line_min = MIN(COALESCE(line_min, ?), COALESCE(?, line_min)), line_max = MAX(COALESCE(line_max, ?), COALESCE(?, line_max)) WHERE id = ?")
        .run(now(), seq, d.inserted, d.deleted, d.wsInserted, d.wsDeleted, lineMin, lineMin, lineMax, lineMax, open.id);
      open.lastAt = at;
      open.timer.refresh();
      return;
    }
    if (open) this.closeSession(entry, author);
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO doc_sessions (id, doc, author, started_at, ended_at, first_seq, last_seq, base_seq, inserted, deleted, ws_inserted, ws_deleted, edits, line_min, line_max) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)")
      .run(id, DocStore.docName(entry.path), author, now(), now(), seq, seq, seq - 1, d.inserted, d.deleted, d.wsInserted, d.wsDeleted, lineMin, lineMax);
    const timer = setTimeout(() => this.closeSession(entry, author), SESSION_GAP_MS);
    timer.unref();
    entry.sessions.set(author, { id, author, lastAt: at, timer });
  }

  /** End an edit session and record it once in the project's event log. */
  closeSession(entry: DocEntry, author: string): void {
    const s = entry.sessions.get(author);
    if (!s) return;
    clearTimeout(s.timer);
    entry.sessions.delete(author);
    this.db.prepare("UPDATE doc_sessions SET closed = 1 WHERE id = ?").run(s.id);
    const r = this.db.prepare("SELECT inserted, deleted, ws_inserted, ws_deleted, line_min, line_max, started_at, ended_at, edits FROM doc_sessions WHERE id = ?").get(s.id) as Record<string, number | string | null>;
    this.events.onEvent?.("doc.edit_session", { path: entry.path, author, sessionId: s.id, ...r });
  }

  /** Close every open edit session (on shutdown, or when a test wants the timeline now). */
  closeSessions(): void {
    for (const e of this.entries.values()) for (const a of [...e.sessions.keys()]) this.closeSession(e, a);
  }

  /** Replace a document's content with `next`, as one minimal edit, attributed to `origin`. */
  applyText(path: string, next: string, origin: ServerOrigin | `agent:${string}`): boolean {
    const entry = this.open(path);
    const cur = entry.text.toString();
    const s = splice(cur, next);
    if (!s) return false;
    this.serverTransact(entry, origin, () => {
      if (s.remove) entry.text.delete(s.index, s.remove);
      if (s.insert) entry.text.insert(s.index, s.insert);
    });
    return true;
  }

  /**
   * Merge an external change to the file on disk into the shared document.
   * base = what the server last wrote, ours = the shared document, theirs = disk.
   * A clean merge is applied as a minimal edit. A conflicted one leaves the document as it is and
   * keeps the disk version in doc_conflicts: it is recorded, never dropped.
   */
  reconcile(entry: DocEntry, disk: string): "applied" | "conflict" | "unchanged" {
    const base = entry.lastWritten ?? "";
    const ours = entry.text.toString();
    if (disk === ours) {
      entry.lastWritten = disk;
      this.recordWritten(entry);
      return "unchanged";
    }
    const merged = ours === base ? { clean: true, text: disk } : merge3(base, ours, disk);
    if (merged.clean) {
      entry.lastWritten = disk;
      this.recordWritten(entry);
      this.applyText(entry.path, merged.text, "disk");
      this.events.onEvent?.("doc.external_change_merged", { path: entry.path, concurrent: ours !== base });
      return "applied";
    }
    const id = randomUUID();
    this.db.prepare("INSERT INTO doc_conflicts (id, doc, base, ours, theirs, created_at) VALUES (?,?,?,?,?,?)").run(id, DocStore.docName(entry.path), base, ours, disk, now());
    entry.lastWritten = disk;
    this.recordWritten(entry);
    this.scheduleFlush(entry);
    this.events.onEvent?.("doc.external_change_conflict", { path: entry.path, conflictId: id });
    return "conflict";
  }

  conflicts(path?: string): { id: string; doc: string; theirs: string; createdAt: string }[] {
    const rows = path
      ? this.db.prepare("SELECT id, doc, theirs, created_at FROM doc_conflicts WHERE doc = ? AND resolved_at IS NULL").all(DocStore.docName(path))
      : this.db.prepare("SELECT id, doc, theirs, created_at FROM doc_conflicts WHERE resolved_at IS NULL").all();
    return (rows as { id: string; doc: string; theirs: string; created_at: string }[]).map((r) => ({ id: r.id, doc: r.doc, theirs: r.theirs, createdAt: r.created_at }));
  }

  private scheduleFlush(entry: DocEntry): void {
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.flush(entry);
    }, this.flushMs);
  }

  flush(entry: DocEntry): void {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    // Never write over a change someone made on disk since our last write: merge it first (or keep it as a conflict).
    const disk = readText(this.root, entry.path);
    if (disk !== null && entry.lastWritten !== null && disk !== entry.lastWritten && disk !== entry.text.toString()) this.reconcile(entry, disk);
    const text = entry.text.toString();
    if (text === entry.lastWritten) return;
    writeAtomic(this.root, entry.path, text);
    entry.lastWritten = text;
    this.recordWritten(entry);
  }

  flushAll(): void {
    for (const e of this.entries.values()) this.flush(e);
  }

  private recordWritten(entry: DocEntry): void {
    this.db
      .prepare("INSERT INTO doc_files (doc, last_written, written_at) VALUES (?,?,?) ON CONFLICT(doc) DO UPDATE SET last_written = excluded.last_written, written_at = excluded.written_at")
      .run(DocStore.docName(entry.path), entry.lastWritten ?? "", now());
  }

  /** Store a load-time snapshot of the full state. The update log is kept, so every revision stays reconstructible. */
  private compact(entry: DocEntry): void {
    const name = DocStore.docName(entry.path);
    const upto = (this.db.prepare("SELECT MAX(seq) AS m FROM doc_updates WHERE doc = ?").get(name) as { m: number | null }).m ?? 0;
    this.db.prepare("INSERT OR REPLACE INTO doc_snapshots (doc, upto_seq, data, created_at) VALUES (?,?,?,?)").run(name, upto, Y.encodeStateAsUpdate(entry.doc), now());
    entry.updatesSinceCompaction = 0;
  }

  /**
   * The document's text right after update `seq` (or its initial state for seq 0), rebuilt from the update log.
   * Returns null if that point is older than the retained history.
   */
  textAt(path: string, seq: number): string | null {
    const name = DocStore.docName(path);
    const first = (this.db.prepare("SELECT MIN(seq) AS m FROM doc_updates WHERE doc = ?").get(name) as { m: number | null }).m;
    if (first === null) return null;
    const doc = new Y.Doc({ gc: false });
    const snap = this.db.prepare("SELECT upto_seq, data FROM doc_snapshots WHERE doc = ? AND upto_seq <= ? ORDER BY upto_seq DESC LIMIT 1").get(name, seq) as { upto_seq: number; data: Uint8Array } | undefined;
    if (snap) Y.applyUpdate(doc, snap.data);
    const rows = this.db.prepare("SELECT data FROM doc_updates WHERE doc = ? AND seq > ? AND seq <= ? ORDER BY seq").all(name, snap?.upto_seq ?? 0, seq) as { data: Uint8Array }[];
    for (const r of rows) Y.applyUpdate(doc, r.data);
    const text = doc.getText("content").toString();
    doc.destroy();
    return text;
  }

  /**
   * External changes are noticed two ways. Each open document's directory is watched: directory watches survive the
   * atomic rename Relay uses to save, whereas watching the file itself (what Node's recursive watcher does on Linux)
   * goes deaf after the first save. A light poll of the open files' size and mtime backs that up.
   */
  private startWatching(): void {
    this.poller = setInterval(() => {
      for (const e of this.entries.values()) {
        const st = this.statOf(e.path);
        if (st !== this.stats.get(e.path)) {
          this.stats.set(e.path, st);
          this.queueCheck(e.path);
        }
      }
    }, 2000);
    this.poller.unref();
  }

  private statOf(path: string): string {
    try {
      const st = statSync(join(this.root, path));
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return "missing";
    }
  }

  private watchDir(path: string): void {
    if (!this.watching) return;
    const dir = dirname(path);
    if (this.dirWatchers.has(dir)) return;
    try {
      const w = watch(join(this.root, dir), (_event, filename) => {
        if (!filename) return;
        const rel = dir === "." ? filename.toString() : `${dir}/${filename.toString()}`;
        if (this.entries.has(rel)) this.queueCheck(rel);
      });
      w.on("error", () => this.dirWatchers.delete(dir));
      this.dirWatchers.set(dir, w);
    } catch (err) {
      this.events.onEvent?.("doc.watch_unavailable", { dir, error: String(err) });
    }
  }

  private queueCheck(path: string): void {
    clearTimeout(this.watchTimers.get(path));
    this.watchTimers.set(
      path,
      setTimeout(() => {
        this.watchTimers.delete(path);
        const entry = this.entries.get(path);
        if (entry) this.checkDisk(entry);
        this.stats.set(path, this.statOf(path));
      }, 75),
    );
  }

  /** Re-read every open document from disk (after a branch switch or pull changed files underneath them). */
  checkAll(): void {
    for (const e of this.entries.values()) this.checkDisk(e);
  }

  /** Compare disk with what the server last wrote; anything else is an external change. */
  checkDisk(entry: DocEntry): void {
    let disk: string | null;
    try {
      disk = readText(this.root, entry.path);
    } catch {
      return;
    }
    if (disk === null) {
      this.events.onEvent?.("doc.deleted_on_disk", { path: entry.path });
      return;
    }
    if (disk !== entry.lastWritten) this.reconcile(entry, disk);
  }

  close(): void {
    for (const w of this.dirWatchers.values()) w.close();
    if (this.poller) clearInterval(this.poller);
    for (const t of this.watchTimers.values()) clearTimeout(t);
    this.flushAll();
    for (const e of this.entries.values()) e.doc.destroy();
    this.entries.clear();
  }
}
