import * as Y from "yjs";
import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { merge3, readText, splice, writeAtomic } from "./files.ts";
import { tx } from "../core/db.ts";

/** Who caused a document change. Connections are objects; server-side origins are these strings. */
export type ServerOrigin = "seed" | "disk" | "agent" | "restore";

export interface DocEntry {
  path: string;
  doc: Y.Doc;
  text: Y.Text;
  /** Exactly what the server last wrote to (or read from) disk. */
  lastWritten: string | null;
  timer: NodeJS.Timeout | null;
  updatesSinceCompaction: number;
}

export interface DocStoreEvents {
  /** A change was applied to a document. `origin` is a connection object for client edits. */
  onChange?: (path: string, origin: unknown) => void;
  /** Something worth recording in the project's event log. */
  onEvent?: (type: string, data: Record<string, unknown>) => void;
}

const now = () => new Date().toISOString();

export class DocStore {
  private db: DatabaseSync;
  private root: string;
  private entries = new Map<string, DocEntry>();
  private watcher: FSWatcher | null = null;
  private watchTimers = new Map<string, NodeJS.Timeout>();
  readonly flushMs: number;
  readonly compactEvery: number;
  private events: DocStoreEvents;

  constructor(db: DatabaseSync, root: string, opts: { flushMs?: number; compactEvery?: number; watch?: boolean } & DocStoreEvents = {}) {
    this.db = db;
    this.root = root;
    this.flushMs = opts.flushMs ?? 300;
    this.compactEvery = opts.compactEvery ?? 500;
    this.events = { onChange: opts.onChange, onEvent: opts.onEvent };
    if (opts.watch !== false) this.startWatching();
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
    const rows = this.db.prepare("SELECT data FROM doc_updates WHERE doc = ? ORDER BY seq").all(name) as { data: Uint8Array }[];
    for (const r of rows) Y.applyUpdate(doc, r.data, "restore");
    const fileRow = this.db.prepare("SELECT last_written FROM doc_files WHERE doc = ?").get(name) as { last_written: string } | undefined;
    const entry: DocEntry = { path, doc, text, lastWritten: fileRow?.last_written ?? null, timer: null, updatesSinceCompaction: rows.length };
    this.entries.set(path, entry);

    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "restore") return;
      // Durable before anyone else sees it: the update log is written synchronously, then broadcast.
      this.db.prepare("INSERT INTO doc_updates (doc, data, created_at) VALUES (?,?,?)").run(name, update, now());
      entry.updatesSinceCompaction++;
      if (entry.updatesSinceCompaction >= this.compactEvery) this.compact(entry);
      this.scheduleFlush(entry);
      this.events.onChange?.(path, origin);
    });

    const disk = readText(this.root, path);
    if (rows.length === 0) {
      // First time this file is shared: the disk content becomes the initial document.
      if (disk) doc.transact(() => text.insert(0, disk), "seed");
      entry.lastWritten = disk ?? "";
      this.recordWritten(entry);
    } else if (disk !== null && disk !== entry.lastWritten) {
      // The file changed on disk while nobody had it open (or while the server was down).
      this.reconcile(entry, disk);
    }
    return entry;
  }

  /** Replace a document's content with `next`, as one minimal edit, attributed to `origin`. */
  applyText(path: string, next: string, origin: ServerOrigin): boolean {
    const entry = this.open(path);
    const cur = entry.text.toString();
    const s = splice(cur, next);
    if (!s) return false;
    entry.doc.transact(() => {
      if (s.remove) entry.text.delete(s.index, s.remove);
      if (s.insert) entry.text.insert(s.index, s.insert);
    }, origin);
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

  /** Replace a document's update log with one snapshot update. Same state, fewer rows. */
  private compact(entry: DocEntry): void {
    const name = DocStore.docName(entry.path);
    const snapshot = Y.encodeStateAsUpdate(entry.doc);
    tx(this.db, () => {
      this.db.prepare("DELETE FROM doc_updates WHERE doc = ?").run(name);
      this.db.prepare("INSERT INTO doc_updates (doc, data, created_at) VALUES (?,?,?)").run(name, snapshot, now());
    });
    entry.updatesSinceCompaction = 1;
  }

  private startWatching(): void {
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const path = filename.toString().split("\\").join("/");
        const entry = this.entries.get(path);
        if (!entry) return;
        clearTimeout(this.watchTimers.get(path));
        this.watchTimers.set(
          path,
          setTimeout(() => {
            this.watchTimers.delete(path);
            this.checkDisk(entry);
          }, 75),
        );
      });
    } catch (err) {
      this.events.onEvent?.("doc.watch_unavailable", { error: String(err) });
    }
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
    this.watcher?.close();
    for (const t of this.watchTimers.values()) clearTimeout(t);
    this.flushAll();
    for (const e of this.entries.values()) e.doc.destroy();
    this.entries.clear();
  }
}
