// Outlook Calendar, optional and separate from Google: a Microsoft sign-in on this computer (Microsoft identity platform,
// authorization code with PKCE, as a public client: there is no client secret to keep). One permission:
// Calendars.ReadWrite, plus offline_access so the sign-in can be renewed without asking again. The token is kept in one
// file readable only by you, never shown, never logged; requests with it go to graph.microsoft.com only.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Transport } from "@recast/bridges";

export const MS_SCOPE = "Calendars.ReadWrite";
const SCOPES = `offline_access ${MS_SCOPE}`;
const STATE_TTL_MS = 10 * 60 * 1000;
const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export interface MicrosoftToken { access_token: string; refresh_token?: string; expires_at: number; scope: string; connected_at: string }
export interface MicrosoftConfig {
  clientId: string; port: number; dir: string; fetch: typeof fetch; now: () => number;
  /** Microsoft's endpoints; replaceable only so tests can stand in for Microsoft. */
  authUrl?: string; tokenUrl?: string;
}
export const microsoftFile = (dir: string) => path.join(dir, "microsoft-token.json");
export function readMicrosoft(dir: string): MicrosoftToken | null { try { return JSON.parse(readFileSync(microsoftFile(dir), "utf8")) as MicrosoftToken; } catch { return null; } }
export function forgetMicrosoft(dir: string) { if (existsSync(microsoftFile(dir))) rmSync(microsoftFile(dir)); }
const save = (dir: string, t: MicrosoftToken) => { mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(microsoftFile(dir), JSON.stringify(t), { mode: 0o600 }); chmodSync(microsoftFile(dir), 0o600); };
const hasScope = (granted: string) => granted.split(/\s+/).some((s) => s.toLowerCase() === MS_SCOPE.toLowerCase() || s.toLowerCase().endsWith(`/${MS_SCOPE.toLowerCase()}`));

export function createMicrosoft(c: MicrosoftConfig) {
  const authUrl = c.authUrl ?? "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
  const tokenUrl = c.tokenUrl ?? "https://login.microsoftonline.com/common/oauth2/v2.0/token";
  const redirectUri = `http://localhost:${c.port}/microsoft/callback`;
  const pending = new Map<string, { verifier: string; at: number }>();
  const COOKIE = "recast_ms_state";

  async function tokenRequest(form: Record<string, string>): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
    let r: Response;
    try { r = await c.fetch(tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: c.clientId, ...form }) }); }
    catch { return { ok: false, error: "unreachable" }; }
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    // Only Microsoft's error code is ever reported (for example invalid_grant), never a token or a description.
    return r.ok && typeof body.access_token === "string" ? { ok: true, body } : { ok: false, error: String(body.error ?? r.status) };
  }

  return {
    redirectUri,
    /** The address to send the browser to, and the cookie that ties the answer to this browser. */
    start(): { location: string; cookie: string } {
      const state = b64url(randomBytes(24)); const verifier = b64url(randomBytes(48));
      for (const [k, v] of pending) if (c.now() - v.at > STATE_TTL_MS) pending.delete(k);
      pending.set(state, { verifier, at: c.now() });
      const q = new URLSearchParams({ client_id: c.clientId, response_type: "code", redirect_uri: redirectUri, response_mode: "query", scope: SCOPES, state,
        code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256", prompt: "select_account" });
      return { location: `${authUrl}?${q}`, cookie: `${COOKIE}=${state}; HttpOnly; SameSite=Lax; Path=/microsoft; Max-Age=600` };
    },
    clearCookie: `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/microsoft; Max-Age=0`,
    /** The answer from Microsoft. Returns a sentence for the page; never echoes a code or a token. */
    async callback(q: URLSearchParams, cookieHeader: string): Promise<{ ok: boolean; message: string }> {
      const state = q.get("state") ?? ""; const code = q.get("code"); const err = q.get("error");
      const cookie = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(cookieHeader)?.[1] ?? "";
      const entry = pending.get(state); pending.delete(state);
      if (!state || !entry || !cookie || !same(cookie, state) || c.now() - entry.at > STATE_TTL_MS) return { ok: false, message: "That sign-in did not start from this page, or it took longer than ten minutes. Start again." };
      if (err || !code) return { ok: false, message: `Microsoft said: ${err ?? "no code"}. Nothing was saved.` };
      const r = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: entry.verifier, scope: SCOPES });
      if (!r.ok) return { ok: false, message: r.error === "unreachable" ? "Microsoft could not be reached. Nothing was saved." : `Microsoft refused the sign-in (${r.error}). Nothing was saved.` };
      const granted = String(r.body.scope ?? "");
      if (!hasScope(granted)) return { ok: false, message: "The calendar permission was not granted. Nothing was saved." };
      save(c.dir, { access_token: r.body.access_token as string, ...(typeof r.body.refresh_token === "string" ? { refresh_token: r.body.refresh_token } : {}),
        expires_at: c.now() + Number(r.body.expires_in ?? 3600) * 1000, scope: granted, connected_at: new Date(c.now()).toISOString() });
      return { ok: true, message: "Connected to Outlook Calendar." };
    },
    accessToken,
    /** Calls Graph with the person's token: graph.microsoft.com only. */
    transport(): Transport {
      return async (req) => {
        if (new URL(req.url).origin !== "https://graph.microsoft.com") throw new Error("Outlook requests go to graph.microsoft.com only");
        const r = await c.fetch(req.url, { method: req.method, headers: { authorization: `Bearer ${await accessToken()}`, ...(req.body !== undefined ? { "content-type": "application/json" } : {}), ...req.headers },
          ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}) });
        return { status: r.status, json: r.status === 204 ? null : await r.json().catch(() => null) };
      };
    },
  };

  /** A valid access token, renewed with the refresh token when it is (nearly) expired. */
  async function accessToken(): Promise<string> {
      const t = readMicrosoft(c.dir);
      if (!t) throw new Error("Outlook Calendar is not connected. Sign in with Microsoft on the Recast page first.");
      if (t.expires_at - 60_000 > c.now()) return t.access_token;
      if (!t.refresh_token) throw new Error("The Microsoft sign-in has expired. Sign in with Microsoft again on the Recast page.");
      const r = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, scope: SCOPES });
      if (!r.ok) throw new Error(r.error === "unreachable" ? "Microsoft could not be reached to renew the sign-in." : "Microsoft no longer accepts this sign-in (expired or revoked). Sign in with Microsoft again on the Recast page.");
      const next: MicrosoftToken = { ...t, access_token: r.body.access_token as string, ...(typeof r.body.refresh_token === "string" ? { refresh_token: r.body.refresh_token } : {}), expires_at: c.now() + Number(r.body.expires_in ?? 3600) * 1000 };
      save(c.dir, next);
      return next.access_token;
  }
}
export type Microsoft = ReturnType<typeof createMicrosoft>;
