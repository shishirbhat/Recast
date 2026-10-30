import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { RelayError } from "../core/types.ts";

/**
 * Shareable run reports: an owner makes a read-only link to one report (a changeset, a combined check, a failure's
 * reproduction) for someone outside the project. The report is frozen when the link is made, so the reader sees what
 * the owner saw, dated; it is not a window into the live project. Links expire, can be revoked at any time (the
 * page then says so), and count views (no addresses or identities are kept). Only a hash of the link's secret is
 * stored; the link itself is shown once, to the owner who made it.
 */

export type ShareKind = "changeset" | "integration" | "repro";

export interface Share {
  id: string;
  kind: ShareKind;
  ref: string;
  title: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  views: number;
  lastViewedAt: string | null;
  includesSource: boolean;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export class Shares {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, ref TEXT NOT NULL, title TEXT NOT NULL,
      text TEXT NOT NULL, data TEXT NOT NULL, includes_source INTEGER NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, revoked_at TEXT, views INTEGER NOT NULL DEFAULT 0, last_viewed_at TEXT)`);
  }

  private toShare(r: Record<string, unknown>): Share {
    return {
      id: r.id as string, kind: r.kind as ShareKind, ref: r.ref as string, title: r.title as string, createdBy: r.created_by as string, createdAt: r.created_at as string,
      expiresAt: r.expires_at as string, revokedAt: (r.revoked_at as string) ?? null, views: r.views as number, lastViewedAt: (r.last_viewed_at as string) ?? null, includesSource: r.includes_source === 1,
    };
  }

  /** Freeze a report and return the share with its one-time link token. */
  create(input: { kind: ShareKind; ref: string; title: string; text: string; data: unknown; includesSource: boolean; days: number }, by: string): { share: Share; token: string } {
    if (!(input.days >= 1 && input.days <= 90)) throw new RelayError("invalid", "A link lasts between 1 and 90 days");
    const token = randomBytes(24).toString("base64url");
    const now = new Date();
    const id = `SH-${randomUUID().slice(0, 8)}`;
    this.db
      .prepare("INSERT INTO shares (id, token_hash, kind, ref, title, text, data, includes_source, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, hash(token), input.kind, input.ref, input.title, input.text, JSON.stringify(input.data), input.includesSource ? 1 : 0, by, now.toISOString(), new Date(now.getTime() + input.days * 86_400_000).toISOString());
    return { share: this.get(id), token };
  }

  get(id: string): Share {
    const r = this.db.prepare("SELECT * FROM shares WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!r) throw new RelayError("not_found", `No share ${id}`);
    return this.toShare(r);
  }

  list(): Share[] {
    return (this.db.prepare("SELECT * FROM shares ORDER BY created_at DESC").all() as Record<string, unknown>[]).map((r) => this.toShare(r));
  }

  revoke(id: string): Share {
    const s = this.get(id);
    if (!s.revokedAt) this.db.prepare("UPDATE shares SET revoked_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    return this.get(id);
  }

  /** Resolve a link for a reader: the frozen report, or why it can't be read. Counts the view. */
  open(token: string): { ok: true; share: Share; text: string; data: unknown } | { ok: false; status: 404 | 410; reason: string } {
    const r = this.db.prepare("SELECT * FROM shares WHERE token_hash = ?").get(hash(token)) as Record<string, unknown> | undefined;
    if (!r) return { ok: false, status: 404, reason: "This link doesn't exist." };
    const s = this.toShare(r);
    if (s.revokedAt) return { ok: false, status: 410, reason: `This link was revoked on ${s.revokedAt.slice(0, 10)}.` };
    if (s.expiresAt <= new Date().toISOString()) return { ok: false, status: 410, reason: `This link expired on ${s.expiresAt.slice(0, 10)}.` };
    const at = new Date().toISOString();
    this.db.prepare("UPDATE shares SET views = views + 1, last_viewed_at = ? WHERE id = ?").run(at, s.id);
    return { ok: true, share: { ...s, views: s.views + 1, lastViewedAt: at }, text: r.text as string, data: JSON.parse(r.data as string) };
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The reader's page: plain, self-contained, no scripts. */
export function sharePage(r: ReturnType<Shares["open"]>, project: string): string {
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${r.ok ? esc(r.share.title) : "Relay report"}</title><style>
:root{color-scheme:light dark;--bg:#fff;--ink:#1b1b1f;--muted:#6b6b76;--rule:#e4e4ea}@media(prefers-color-scheme:dark){:root{--bg:#0b0b0d;--ink:#e8e8ee;--muted:#9a9aa6;--rule:#26262c}}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,sans-serif}main{max-width:900px;margin:0 auto;padding:24px 16px}
h1{font-size:18px;margin:0 0 4px}p.meta{color:var(--muted);margin:0 0 16px;font-size:13px}pre{white-space:pre-wrap;word-break:break-word;font:12.5px/1.5 ui-monospace,monospace;border-top:1px solid var(--rule);padding-top:12px}</style></head><body><main>`;
  if (!r.ok) return `${head}<h1>Report unavailable</h1><p class="meta">${esc(r.reason)}</p></main></body></html>`;
  const s = r.share;
  return `${head}<h1>${esc(s.title)}</h1><p class="meta">Shared from the Relay project ${esc(project)} by ${esc(s.createdBy)} on ${esc(s.createdAt.slice(0, 16).replace("T", " "))} UTC. A snapshot as of then, not live. ${s.includesSource ? "Includes source changes." : "Source code isn't included."} Link expires ${esc(s.expiresAt.slice(0, 10))}.</p><pre>${esc(r.text)}</pre></main></body></html>`;
}
