import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import type { DatabaseSync } from "node:sqlite";
import type { DocStore } from "./docs.ts";

/**
 * Contribution accounting. Two views, deliberately kept apart:
 *
 * - Historical: what someone did, from edit sessions recorded as their updates arrived (characters inserted and
 *   deleted, whitespace-only counted separately, line range touched, exact before/after text per session).
 * - Surviving: what of the current text is theirs, read from the document itself. Every character Yjs keeps carries
 *   the client ID that created it, and client IDs are bound to members when their first update is accepted.
 *
 * A line is attributed to one author only when every non-whitespace character on it is theirs. Lines that mix
 * authors are "shared"; lines that existed before the file was first shared are "baseline"; characters from an
 * outside disk change or an applied agent run are attributed to that origin, never to a person.
 */

export type AuthorKind = "member" | "agent" | "baseline" | "disk" | "shared" | "unknown" | "blank";

export interface LineAuthor {
  line: number;
  kind: AuthorKind;
  /** The single author for member/agent lines; every author for shared lines. */
  authors: string[];
}

export function authorKind(author: string): AuthorKind {
  if (author === "relay:baseline" || author === "relay:seed") return "baseline";
  if (author === "relay:disk") return "disk";
  if (author.startsWith("agent:")) return "agent";
  if (author.startsWith("relay:")) return "unknown";
  return "member";
}

/** Per-line authorship of a document as it is now. */
export function lineAuthors(docs: DocStore, path: string): LineAuthor[] {
  const entry = docs.open(path);
  const owners = docs.clientAuthors(path);
  const chars: { ch: string; author: string }[] = [];
  // Walk the text's item list; deleted items are skipped, so this is exactly the current content.
  let item = (entry.text as unknown as { _start: Y.Item | null })._start;
  while (item) {
    if (!item.deleted && item.content instanceof Y.ContentString) {
      const author = owners.get(item.id.client) ?? "unknown";
      for (const ch of item.content.str) chars.push({ ch, author });
    }
    item = item.right as Y.Item | null;
  }
  const out: LineAuthor[] = [];
  let line = 1;
  let set = new Set<string>();
  let any = new Set<string>();
  const end = () => {
    const authors = set.size ? set : any;
    if (!authors.size) out.push({ line, kind: "blank", authors: [] });
    else if (set.size === 0) out.push({ line, kind: "blank", authors: [] });
    else if (authors.size === 1) {
      const a = [...authors][0]!;
      out.push({ line, kind: authorKind(a), authors: [a] });
    } else out.push({ line, kind: "shared", authors: [...authors].sort() });
    line++;
    set = new Set();
    any = new Set();
  };
  for (const c of chars) {
    if (c.ch === "\n") {
      end();
      continue;
    }
    any.add(c.author);
    if (c.ch.trim()) set.add(c.author);
  }
  if (any.size || set.size) end();
  return out;
}

export interface Session {
  id: string;
  path: string;
  author: string;
  startedAt: string;
  endedAt: string;
  firstSeq: number;
  lastSeq: number;
  baseSeq: number;
  inserted: number;
  deleted: number;
  wsInserted: number;
  wsDeleted: number;
  edits: number;
  lineMin: number | null;
  lineMax: number | null;
  open: boolean;
}

const toSession = (r: Record<string, unknown>): Session => ({
  id: r.id as string,
  path: String(r.doc).replace(/^file:/, ""),
  author: r.author as string,
  startedAt: r.started_at as string,
  endedAt: r.ended_at as string,
  firstSeq: r.first_seq as number,
  lastSeq: r.last_seq as number,
  baseSeq: r.base_seq as number,
  inserted: r.inserted as number,
  deleted: r.deleted as number,
  wsInserted: r.ws_inserted as number,
  wsDeleted: r.ws_deleted as number,
  edits: r.edits as number,
  lineMin: (r.line_min as number) ?? null,
  lineMax: (r.line_max as number) ?? null,
  open: r.closed === 0,
});

export function sessions(db: DatabaseSync, filter: { author?: string; path?: string; limit?: number } = {}): Session[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.author) (where.push("author = ?"), args.push(filter.author));
  if (filter.path) (where.push("doc = ?"), args.push(`file:${filter.path}`));
  const rows = db.prepare(`SELECT * FROM doc_sessions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at DESC LIMIT ?`).all(...args, filter.limit ?? 500) as Record<string, unknown>[];
  return rows.map(toSession);
}

/** Everyone who has authored anything, including agents and server origins, with historical totals. */
export function authorTotals(db: DatabaseSync): { author: string; sessions: number; files: number; inserted: number; deleted: number; wsInserted: number; wsDeleted: number; lastAt: string }[] {
  return (db.prepare("SELECT author, COUNT(*) AS sessions, COUNT(DISTINCT doc) AS files, SUM(inserted) AS inserted, SUM(deleted) AS deleted, SUM(ws_inserted) AS ws_inserted, SUM(ws_deleted) AS ws_deleted, MAX(ended_at) AS last_at FROM doc_sessions GROUP BY author").all() as Record<string, unknown>[]).map((r) => ({
    author: r.author as string,
    sessions: r.sessions as number,
    files: r.files as number,
    inserted: r.inserted as number,
    deleted: r.deleted as number,
    wsInserted: r.ws_inserted as number,
    wsDeleted: r.ws_deleted as number,
    lastAt: r.last_at as string,
  }));
}

export interface DiffLine {
  kind: "context" | "add" | "del" | "hunk";
  text: string;
  oldLine?: number;
  newLine?: number;
}

/** A unified line diff (git's diff engine on two temporary files), parsed into lines for display. */
export function lineDiff(before: string, after: string, context = 3): DiffLine[] {
  if (before === after) return [];
  const dir = mkdtempSync(join(tmpdir(), "relay-diff-"));
  try {
    writeFileSync(join(dir, "a"), before);
    writeFileSync(join(dir, "b"), after);
    let out = "";
    try {
      out = execFileSync("git", ["diff", "--no-index", "--no-color", `--unified=${context}`, "a", "b"], { cwd: dir, encoding: "utf8" });
    } catch (e) {
      out = String((e as { stdout?: string }).stdout ?? "");
    }
    const lines: DiffLine[] = [];
    let o = 0;
    let n = 0;
    for (const l of out.split("\n").slice(4)) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m) {
        o = Number(m[1]);
        n = Number(m[2]);
        lines.push({ kind: "hunk", text: l });
      } else if (l.startsWith("+")) lines.push({ kind: "add", text: l.slice(1), newLine: n++ });
      else if (l.startsWith("-")) lines.push({ kind: "del", text: l.slice(1), oldLine: o++ });
      else if (l.startsWith(" ")) lines.push({ kind: "context", text: l.slice(1), oldLine: o++, newLine: n++ });
    }
    return lines;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One session's exact change, and whether anyone else edited the same file at the same time. */
export interface LineOrigin {
  author: string;
  kind: AuthorKind;
  /** The text this author contributed to the line, as it stands now. */
  text: string;
  /** When it was written, from the update log. For baseline text, when Relay first loaded the file. */
  at: string | null;
  seq: number | null;
  /** The author's edit session that contains it, when there is one. */
  session: string | null;
}

/**
 * Who wrote each part of one line, and when: for every run of characters on the line, the update that inserted it
 * (found in the document's update log by its Yjs id) and the edit session that update belongs to. This is what lets
 * someone trace a line that broke something back to the change that introduced it.
 */
export function lineOrigin(db: DatabaseSync, docs: DocStore, path: string, line: number): LineOrigin[] {
  const entry = docs.open(path);
  const owners = docs.clientAuthors(path);
  // Runs of characters on the requested line, each with the id of its first character.
  const runs: { client: number; clock: number; text: string }[] = [];
  let n = 1;
  let item = (entry.text as unknown as { _start: Y.Item | null })._start;
  while (item && n <= line) {
    if (!item.deleted && item.content instanceof Y.ContentString) {
      const str = item.content.str;
      for (let i = 0; i < str.length; i++) {
        if (str[i] === "\n") {
          n++;
          continue;
        }
        if (n !== line) continue;
        const last = runs.at(-1);
        const clock = item.id.clock + i;
        if (last && last.client === item.id.client && last.clock + last.text.length === clock) last.text += str[i];
        else runs.push({ client: item.id.client, clock, text: str[i]! });
      }
    }
    item = item.right as Y.Item | null;
  }
  if (!runs.length) return [];
  // Find the update that inserted each run (one pass over the log, newest first so recent edits resolve fast).
  const name = `file:${path}`;
  const found = new Map<string, { seq: number; at: string }>();
  const wanted = new Set(runs.map((r) => `${r.client}:${r.clock}`));
  const rows = db.prepare("SELECT seq, data, created_at FROM doc_updates WHERE doc = ? ORDER BY seq DESC").iterate(name) as Iterable<{ seq: number; data: Uint8Array; created_at: string }>;
  for (const row of rows) {
    if (found.size === wanted.size) break;
    for (const st of Y.decodeUpdate(row.data).structs) {
      for (const r of runs) {
        const key = `${r.client}:${r.clock}`;
        if (found.has(key) || st.id.client !== r.client) continue;
        if (r.clock >= st.id.clock && r.clock < st.id.clock + st.length) found.set(key, { seq: row.seq, at: row.created_at });
      }
    }
  }
  const out: LineOrigin[] = [];
  for (const r of runs) {
    const author = owners.get(r.client) ?? "unknown";
    const f = found.get(`${r.client}:${r.clock}`);
    const session = f ? ((db.prepare("SELECT id FROM doc_sessions WHERE doc = ? AND author = ? AND first_seq <= ? AND last_seq >= ? ORDER BY started_at DESC LIMIT 1").get(name, author, f.seq, f.seq) as { id: string } | undefined)?.id ?? null) : null;
    const prev = out.at(-1);
    // Adjacent runs from the same author and change read as one piece.
    if (prev && prev.author === author && prev.seq === (f?.seq ?? null)) prev.text += r.text;
    else out.push({ author, kind: authorKind(author), text: r.text, at: f?.at ?? null, seq: f?.seq ?? null, session });
  }
  return out.filter((o) => o.text.trim());
}

/** The file before and after one edit session, for showing it as a diff. */
export function sessionSides(db: DatabaseSync, docs: DocStore, id: string): { path: string; before: string; after: string; author: string; startedAt: string } | null {
  const r = db.prepare("SELECT * FROM doc_sessions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!r) return null;
  const s = toSession(r);
  const before = docs.textAt(s.path, s.baseSeq);
  const after = docs.textAt(s.path, s.lastSeq);
  if (before === null || after === null) return null;
  return { path: s.path, before, after, author: s.author, startedAt: s.startedAt };
}

export function sessionDiff(db: DatabaseSync, docs: DocStore, id: string): { session: Session; diff: DiffLine[]; concurrent: string[]; available: boolean } | null {
  const r = db.prepare("SELECT * FROM doc_sessions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!r) return null;
  const session = toSession(r);
  const before = docs.textAt(session.path, session.baseSeq);
  const after = docs.textAt(session.path, session.lastSeq);
  // Others who edited the same file inside this session's update range: their edits are inside this diff too.
  const concurrent = (db.prepare("SELECT DISTINCT author FROM doc_sessions WHERE doc = ? AND author != ? AND first_seq <= ? AND last_seq >= ?").all(`file:${session.path}`, session.author, session.lastSeq, session.firstSeq) as { author: string }[]).map((x) => x.author);
  if (before === null || after === null) return { session, diff: [], concurrent, available: false };
  return { session, diff: lineDiff(before, after), concurrent, available: true };
}
