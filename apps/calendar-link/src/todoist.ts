// Todoist, optional and separate from Google: a personal API token the person copies from Todoist
// (Settings → Integrations → Developer → API token). Kept on this computer only, in a file only they can read.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Transport } from "@recast/bridges";

export interface TodoistLink { token: string; connected_at: string }
const API = "https://api.todoist.com";
export const todoistFile = (dir: string) => path.join(dir, "todoist.json");
export function readTodoist(dir: string): TodoistLink | null { try { return JSON.parse(readFileSync(todoistFile(dir), "utf8")) as TodoistLink; } catch { return null; } }
export function forgetTodoist(dir: string) { if (existsSync(todoistFile(dir))) rmSync(todoistFile(dir)); }

/** Checks the token with Todoist (it must list the person's projects) before saving anything. */
export async function connectTodoist(dir: string, token: string, f: typeof fetch, now: number): Promise<{ ok: true; link: TodoistLink } | { ok: false; message: string }> {
  token = token.trim();
  if (!/^[0-9a-f]{40}$/i.test(token)) return { ok: false, message: "That does not look like a Todoist API token (40 letters and digits, from Settings → Integrations → Developer)." };
  try {
    const r = await f(`${API}/api/v1/projects`, { headers: { authorization: `Bearer ${token}` } });
    if (r.status === 401 || r.status === 403) return { ok: false, message: "Todoist did not accept that token. Nothing was saved." };
    if (r.status !== 200) return { ok: false, message: `Todoist answered ${r.status}. Nothing was saved.` };
  } catch { return { ok: false, message: "Todoist could not be reached. Nothing was saved." }; }
  const link: TodoistLink = { token, connected_at: new Date(now).toISOString() };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(todoistFile(dir), JSON.stringify(link), { mode: 0o600 }); chmodSync(todoistFile(dir), 0o600);
  return { ok: true, link };
}

export function todoistTransport(link: TodoistLink, f: typeof fetch): Transport {
  return async (req) => {
    if (new URL(req.url).origin !== API) throw new Error("Todoist requests go to api.todoist.com only");
    const r = await f(req.url, { method: req.method, headers: { authorization: `Bearer ${link.token}`, ...(req.body !== undefined ? { "content-type": "application/json" } : {}), ...req.headers }, ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}) });
    return { status: r.status, json: r.status === 204 ? null : await r.json().catch(() => null) };
  };
}
