import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { RelayError } from "../core/types.ts";
import type { Actor } from "../core/types.ts";

export type Role = "owner" | "editor" | "viewer";
export const ROLES: readonly Role[] = ["owner", "editor", "viewer"];

export interface Member {
  id: string;
  name: string;
  role: Role;
  color: string;
}

/**
 * Participant colors: distinct hues at similar lightness so none dominates, each readable as a
 * cursor on both the light and the dark editor background.
 */
export const PRESENCE_COLORS = ["#8b5cf6", "#5aa0e0", "#2f8f6b", "#d1497a", "#7d9a3a", "#b8892a", "#0f9aa8", "#9a5bd1"];

const SESSION_DAYS = 7;
const INVITE_HOURS = 72;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const now = () => new Date().toISOString();

export function actorFor(m: Member): Actor {
  return { kind: "human", id: m.id };
}

export function can(role: Role, action: "read" | "edit" | "approve" | "admin"): boolean {
  if (action === "read") return true;
  if (action === "edit") return role === "owner" || role === "editor";
  return role === "owner";
}

export class Members {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  list(): Member[] {
    return (this.db.prepare("SELECT id, name, role, color FROM members WHERE revoked_at IS NULL ORDER BY created_at").all() as unknown as Member[]).map((m) => ({ ...m }));
  }

  get(id: string): Member | undefined {
    const r = this.db.prepare("SELECT id, name, role, color FROM members WHERE id = ? AND revoked_at IS NULL").get(id) as Member | undefined;
    return r ? { ...r } : undefined;
  }

  /** Adds a member (or re-invites an existing one) and returns a one-time join token. */
  invite(name: string, role: Role): { member: Member; token: string } {
    if (!ROLES.includes(role)) throw new RelayError("invalid", `Role must be one of ${ROLES.join(", ")}`);
    const clean = name.trim();
    if (!/^[\p{L}\p{N} ._'-]{1,40}$/u.test(clean)) throw new RelayError("invalid", "Names are 1-40 letters, digits, spaces or . _ ' -");
    const id = clean.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "member";
    let member = this.get(id);
    if (!member) {
      const color = PRESENCE_COLORS[this.list().length % PRESENCE_COLORS.length]!;
      this.db.prepare("INSERT INTO members (id, name, role, color, created_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role, revoked_at = NULL").run(id, clean, role, color, now());
      member = this.get(id)!;
    } else if (member.role !== role) {
      this.db.prepare("UPDATE members SET role = ? WHERE id = ?").run(role, id);
      member = this.get(id)!;
    }
    const token = randomBytes(24).toString("base64url");
    const expires = new Date(Date.now() + INVITE_HOURS * 3600_000).toISOString();
    this.db.prepare("INSERT INTO invites (token_hash, member_id, expires_at) VALUES (?,?,?)").run(hash(token), id, expires);
    return { member, token };
  }

  /** Exchanges a one-time invite token for a session token. */
  redeem(inviteToken: string): { member: Member; session: string } {
    const row = this.db.prepare("SELECT member_id, expires_at, used_at FROM invites WHERE token_hash = ?").get(hash(inviteToken)) as
      | { member_id: string; expires_at: string; used_at: string | null }
      | undefined;
    if (!row || row.used_at || row.expires_at < now()) throw new RelayError("forbidden", "This invite link is invalid, used, or expired. Ask the project owner for a new one.");
    const member = this.get(row.member_id);
    if (!member) throw new RelayError("forbidden", "This member was removed from the project.");
    this.db.prepare("UPDATE invites SET used_at = ? WHERE token_hash = ?").run(now(), hash(inviteToken));
    const session = randomBytes(32).toString("base64url");
    const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
    this.db.prepare("INSERT INTO sessions (token_hash, member_id, created_at, expires_at) VALUES (?,?,?,?)").run(hash(session), member.id, now(), expires);
    return { member, session };
  }

  /** The member behind a session token, or undefined. Revoked members lose access immediately. */
  fromSession(session: string | undefined): Member | undefined {
    if (!session) return undefined;
    const row = this.db.prepare("SELECT member_id, expires_at FROM sessions WHERE token_hash = ?").get(hash(session)) as { member_id: string; expires_at: string } | undefined;
    if (!row || row.expires_at < now()) return undefined;
    return this.get(row.member_id);
  }

  /** Sign out: the session stops working immediately, not just the cookie. */
  endSession(session: string | undefined): void {
    if (session) this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash(session));
  }

  revoke(id: string): void {
    this.db.prepare("UPDATE members SET revoked_at = ? WHERE id = ?").run(now(), id);
    this.db.prepare("DELETE FROM sessions WHERE member_id = ?").run(id);
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const SESSION_COOKIE = "relay_session";
