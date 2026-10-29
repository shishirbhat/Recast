// Notion, optional and separate from Google: an internal integration's token (notion.so/profile/integrations → New
// integration) and one database shared with that integration. Kept on this computer only, in a file only you can read.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Transport } from "@recast/bridges";

export interface NotionLink { token: string; databaseId: string; databaseName: string; titleProperty: string; urlProperty: string | false; connected_at: string }
const API = "https://api.notion.com";
const VERSION = "2022-06-28";
export const notionFile = (dir: string) => path.join(dir, "notion.json");
export function readNotion(dir: string): NotionLink | null { try { return JSON.parse(readFileSync(notionFile(dir), "utf8")) as NotionLink; } catch { return null; } }
export function forgetNotion(dir: string) { if (existsSync(notionFile(dir))) rmSync(notionFile(dir)); }

/** The database's id from its link or the id itself: 32 hexadecimal characters, with or without dashes. */
export function databaseIdOf(s: string): string | null {
  const t = s.trim(); const path = (() => { try { return new URL(t).pathname; } catch { return t; } })();
  const m = /([0-9a-f]{32})(?:[?#/]|$)/i.exec(path.replace(/-/g, "")) ?? /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(path);
  return m ? m[1]!.replace(/-/g, "").toLowerCase() : null;
}

/** Finds the database with the token, and its title and link columns, before saving anything. */
export async function connectNotion(dir: string, token: string, database: string, f: typeof fetch, now: number): Promise<{ ok: true; link: NotionLink } | { ok: false; message: string }> {
  token = token.trim();
  if (!/^(secret_|ntn_)[A-Za-z0-9]{20,}$/.test(token)) return { ok: false, message: "That does not look like a Notion integration token (they start with ntn_ or secret_)." };
  const id = databaseIdOf(database);
  if (!id) return { ok: false, message: "Paste the database's link (Share → Copy link) or its id." };
  let body: Record<string, any>;
  try {
    const r = await f(`${API}/v1/databases/${id}`, { headers: { authorization: `Bearer ${token}`, "Notion-Version": VERSION } });
    if (r.status === 401) return { ok: false, message: "Notion did not accept that token. Nothing was saved." };
    if (r.status === 404) return { ok: false, message: "Notion cannot see that database with this token. In Notion, open the database → ••• → Connections, add your integration, then try again. Nothing was saved." };
    if (r.status !== 200) return { ok: false, message: `Notion answered ${r.status}. Nothing was saved.` };
    body = await r.json() as Record<string, any>;
  } catch { return { ok: false, message: "Notion could not be reached. Nothing was saved." }; }
  const props = Object.entries((body.properties ?? {}) as Record<string, { type?: string }>);
  const title = props.find(([, p]) => p.type === "title")?.[0];
  if (!title) return { ok: false, message: "That database has no title column. Nothing was saved." };
  const url = props.find(([, p]) => p.type === "url")?.[0] ?? false;
  const name = Array.isArray(body.title) ? body.title.map((t: any) => String(t?.plain_text ?? "")).join("").trim() : "";
  const link: NotionLink = { token, databaseId: id, databaseName: name || "your database", titleProperty: title, urlProperty: url, connected_at: new Date(now).toISOString() };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(notionFile(dir), JSON.stringify(link), { mode: 0o600 }); chmodSync(notionFile(dir), 0o600);
  return { ok: true, link };
}

export function notionTransport(link: NotionLink, f: typeof fetch): Transport {
  return async (req) => {
    if (new URL(req.url).origin !== API) throw new Error("Notion requests go to api.notion.com only");
    const r = await f(req.url, { method: req.method, headers: { authorization: `Bearer ${link.token}`, "Notion-Version": VERSION, ...(req.body !== undefined ? { "content-type": "application/json" } : {}), ...req.headers }, ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
}
