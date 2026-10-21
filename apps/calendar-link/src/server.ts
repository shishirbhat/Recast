// Recast's Google Calendar sign-in, run on your own computer. It does one thing: let you connect a Google account, so
// Recast can later place events in that account's calendar. Nothing is hosted and nothing is deployed.
//
// Security, in order of what could go wrong:
// - Only reachable from this computer: it listens on 127.0.0.1 and refuses any Host other than localhost (DNS rebinding).
// - The client secret stays in the server's memory: it is never sent to a browser, never written to a page, never logged.
// - A forged callback is refused: each sign-in has a one-time `state`, held both here and in an HttpOnly cookie, that
//   expires after ten minutes.
// - A stolen authorization code is useless: PKCE (S256) ties the code to a verifier only this server knows.
// - Least privilege: one scope, calendar.events (create and delete events), not the whole calendar account.
// - Tokens are written to one local file, readable only by you (0600), in a git-ignored folder; never shown, never logged.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import path from "node:path";
import { createTestEvents, type Outcome } from "./test-event.js";

export const SCOPE = "https://www.googleapis.com/auth/calendar.events";
export interface LinkConfig {
  clientId: string; clientSecret: string; port: number;
  /** Where the tokens are kept on this computer. */
  tokenFile: string;
  /** Google's endpoints; replaceable only so tests can stand in for Google. */
  authUrl?: string; tokenUrl?: string; revokeUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}
export interface StoredToken { refresh_token?: string; access_token: string; expires_at: number; scope: string; token_type: string; connected_at: string }

const STATE_TTL_MS = 10 * 60 * 1000;
const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export function readToken(file: string): StoredToken | null {
  try { return JSON.parse(readFileSync(file, "utf8")) as StoredToken; } catch { return null; }
}

export function createLinkServer(c: LinkConfig): Server {
  const authUrl = c.authUrl ?? "https://accounts.google.com/o/oauth2/v2/auth";
  const tokenUrl = c.tokenUrl ?? "https://oauth2.googleapis.com/token";
  const revokeUrl = c.revokeUrl ?? "https://oauth2.googleapis.com/revoke";
  const f = c.fetch ?? fetch; const now = c.now ?? Date.now;
  const redirectUri = `http://localhost:${c.port}/oauth/callback`;
  const tests = createTestEvents({ clientId: c.clientId, clientSecret: c.clientSecret, tokenFile: c.tokenFile, tokenUrl, fetch: f, now,
    stateFile: path.join(path.dirname(c.tokenFile), "test-event.json") });
  let last: Outcome | null = null;   // the result of the last test button, shown once on the page
  const pending = new Map<string, { verifier: string; at: number }>();   // state → PKCE verifier, one use each

  const send = (res: ServerResponse, status: number, html: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
      // same-origin, not no-referrer: with no-referrer, browsers send "Origin: null" on this page's own form posts.
      "referrer-policy": "same-origin", "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      ...extra,
    });
    res.end(html);
  };
  const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:56px auto;padding:0 16px;color:#191714;background:#faf9f6}h1{font-size:24px;margin:0 0 8px}p{margin:8px 0}
.box{padding:16px;border:1px solid #e7e1d6;border-radius:14px;background:#fff;margin:16px 0}button,.btn{display:inline-block;font:inherit;font-weight:600;border:0;border-radius:999px;padding:10px 18px;background:#191714;color:#fff;cursor:pointer;text-decoration:none}
.ghost{background:transparent;color:#191714;box-shadow:inset 0 0 0 1px #d6d0c4}.ok{color:#15803d;font-weight:600}.muted{color:#5d574e;font-size:14px}code{font-size:14px}
@media (prefers-color-scheme:dark){body{background:#141311;color:#f5f1e8}.box{background:#1d1b19;border-color:#34302b}button,.btn{background:#f5f1e8;color:#141311}.ghost{background:transparent;color:#f5f1e8;box-shadow:inset 0 0 0 1px #46413a}.muted{color:#b0aba3}.ok{color:#4ade80}}</style></head><body>${body}</body></html>`;

  async function handle(req: IncomingMessage, res: ServerResponse) {
    // Only this computer, by name: a web page elsewhere cannot point a DNS name at 127.0.0.1 and talk to this server.
    const host = req.headers.host ?? "";
    if (host !== `localhost:${c.port}` && host !== `127.0.0.1:${c.port}`) return send(res, 421, page("Wrong address", `<p>Open <a href="http://localhost:${c.port}/">http://localhost:${c.port}/</a> instead.</p>`));
    const url = new URL(req.url ?? "/", `http://localhost:${c.port}`);

    if (req.method === "GET" && url.pathname === "/") {
      const t = readToken(c.tokenFile);
      const shown = last; last = null;
      const btn = (action: string, label: string, ghost = false) => `<form method="post" action="/test/${action}" style="display:inline-block;margin:4px 4px 0 0"><button${ghost ? ' class="ghost"' : ""} type="submit">${label}</button></form>`;
      const testBox = t ? `<div class="box"><h2 style="font-size:18px;margin:0 0 4px">Try it with a test event</h2>
<p class="muted">Adds “Recast test event” tomorrow 10:00–11:00 to this account's calendar. Open Google Calendar alongside to watch.</p>
${shown ? `<p class="${shown.ok ? "ok" : ""}" role="status">${esc(shown.text)}</p>` : ""}
<div>${btn("place", "Place a test event")}${btn("undo", "Undo", true)}${btn("check", "Check", true)}</div>
<p class="muted" style="margin-top:12px">Safety tests: press <b>Place</b> twice (you should still get one event), or <b>Place with a lost answer</b>, which really adds it but ignores Google's reply, then press <b>Check</b>.</p>
<div>${btn("lost", "Place with a lost answer", true)}</div></div>` : "";
      return send(res, 200, page("Recast: connect Google Calendar", `<h1>Connect Google Calendar</h1>
<p class="muted">This page runs only on your computer. It lets Recast add events to, and remove its own events from, one Google account's calendar.</p>
<div class="box">${t
        ? `<p class="ok">Connected.</p><p class="muted">Since ${esc(t.connected_at)}. Permission: create and delete calendar events.${t.refresh_token ? "" : " (No long-lived permission was granted: connect again if it stops working.)"}</p>
<form method="post" action="/disconnect"><button class="ghost" type="submit">Disconnect and remove the permission</button></form>`
        : `<p>Not connected yet.</p><p><a class="btn" href="/oauth/start">Sign in with Google</a></p><p class="muted">Use your throwaway test account, not your personal one.</p>`}</div>${testBox}`));
    }

    if (req.method === "GET" && url.pathname === "/oauth/start") {
      const state = b64url(randomBytes(24)); const verifier = b64url(randomBytes(48));
      for (const [k, v] of pending) if (now() - v.at > STATE_TTL_MS) pending.delete(k);
      pending.set(state, { verifier, at: now() });
      const q = new URLSearchParams({
        client_id: c.clientId, redirect_uri: redirectUri, response_type: "code", scope: SCOPE, state,
        code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
        access_type: "offline", prompt: "consent", include_granted_scopes: "false",
      });
      res.writeHead(302, { location: `${authUrl}?${q}`, "set-cookie": `recast_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/oauth; Max-Age=600`, "cache-control": "no-store" });
      return res.end();
    }

    if (req.method === "GET" && url.pathname === "/oauth/callback") {
      const state = url.searchParams.get("state") ?? ""; const code = url.searchParams.get("code"); const err = url.searchParams.get("error");
      const cookie = /(?:^|;\s*)recast_oauth_state=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "";
      const entry = pending.get(state); pending.delete(state);   // one use, whatever happens next
      const clear = { "set-cookie": "recast_oauth_state=; HttpOnly; SameSite=Lax; Path=/oauth; Max-Age=0" };
      if (!state || !entry || !cookie || !same(cookie, state) || now() - entry.at > STATE_TTL_MS)
        return send(res, 400, page("Sign-in not accepted", `<h1>That sign-in was not accepted</h1><p>It did not start from this page, or it took longer than ten minutes. <a href="/">Start again</a>.</p>`), clear);
      if (err || !code)
        return send(res, 400, page("Not connected", `<h1>Not connected</h1><p>Google said: <code>${esc(err ?? "no code")}</code>. Nothing was saved. <a href="/">Try again</a>.</p>`), clear);
      let r: Response;
      try {
        r = await f(tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: c.clientId, client_secret: c.clientSecret, code_verifier: entry.verifier }) });
      } catch { return send(res, 502, page("Not connected", `<h1>Not connected</h1><p>Could not reach Google. Check your internet connection, then <a href="/">try again</a>.</p>`), clear); }
      const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      // Report Google's error code only (e.g. invalid_client); never echo a token or the secret.
      if (!r.ok || typeof body.access_token !== "string")
        return send(res, 400, page("Not connected", `<h1>Not connected</h1><p>Google refused the sign-in: <code>${esc(String(body.error ?? r.status))}</code>. ${body.error === "invalid_client" ? "The client ID or secret in your .env file does not match Google's." : body.error === "redirect_uri_mismatch" ? `In Google Cloud, the redirect URI must be exactly <code>${esc(redirectUri)}</code>.` : ""} <a href="/">Try again</a>.</p>`), clear);
      const granted = String(body.scope ?? "");
      if (!granted.split(" ").includes(SCOPE))
        return send(res, 400, page("Not connected", `<h1>Not connected</h1><p>The calendar permission was not granted (on Google's screen, the box for calendar events must be ticked). Nothing was saved. <a href="/">Try again</a>.</p>`), clear);
      const token: StoredToken = { access_token: body.access_token, ...(typeof body.refresh_token === "string" ? { refresh_token: body.refresh_token } : {}),
        expires_at: now() + Number(body.expires_in ?? 3600) * 1000, scope: granted, token_type: String(body.token_type ?? "Bearer"), connected_at: new Date(now()).toISOString() };
      mkdirSync(path.dirname(c.tokenFile), { recursive: true, mode: 0o700 });
      writeFileSync(c.tokenFile, JSON.stringify(token), { mode: 0o600 }); chmodSync(c.tokenFile, 0o600);
      return send(res, 200, page("Connected", `<h1 class="ok">Connected</h1><p>Recast can now add events to this Google account's calendar. You can close this tab.</p><p><a href="/">Back</a></p>`), clear);
    }

    // Forms on this page only (Origin checked), so another site cannot press these buttons for you.
    const origin = req.headers.origin;
    const site = req.headers["sec-fetch-site"];
    const foreign = (!!origin && origin !== `http://localhost:${c.port}` && origin !== `http://127.0.0.1:${c.port}`) || (!!site && site !== "same-origin" && site !== "none");
    const action = /^\/test\/(place|lost|check|undo)$/.exec(url.pathname)?.[1];
    if (req.method === "POST" && action) {
      if (foreign) return send(res, 403, page("Refused", "<p>Refused.</p>"));
      try { last = await (action === "place" ? tests.place() : action === "lost" ? tests.placeLosingAnswer() : action === "check" ? tests.check() : tests.undo()); }
      catch (e) { last = { ok: false, text: (e as Error).message }; }
      res.writeHead(303, { location: "/" }); return res.end();
    }

    if (req.method === "POST" && url.pathname === "/disconnect") {
      if (foreign) return send(res, 403, page("Refused", "<p>Refused.</p>"));
      const t = readToken(c.tokenFile);
      if (t) { try { await f(revokeUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: t.refresh_token ?? t.access_token }) }); } catch { /* removed locally regardless */ } }
      if (existsSync(c.tokenFile)) rmSync(c.tokenFile);
      res.writeHead(303, { location: "/" }); return res.end();
    }

    return send(res, 404, page("Not found", "<p>Not found. <a href=\"/\">Home</a></p>"));
  }

  return createServer((req, res) => { handle(req, res).catch(() => { if (!res.headersSent) send(res, 500, page("Error", "<p>Something went wrong. Nothing was saved.</p>")); }); });
}
