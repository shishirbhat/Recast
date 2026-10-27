import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename, dirname, join as pathJoin } from "node:path";
import { RelayError } from "./core/types.ts";

/**
 * The CLI as a client of a running Relay server. Agent runs and their worktrees live in that server, so commands that
 * act on them (Check Together) must go through it, with a member's session and the server's own authorization.
 *
 * A session comes from a one-time invite link, exactly as in the browser and VS Code. It is stored next to the
 * project database (owner-readable only) and never printed. RELAY_SERVER + RELAY_SESSION override it (for CI).
 */

export interface RemoteSession {
  server: string;
  cookie: string;
}

/** A failure to reach or use the server: the command could not complete (distinct from a blocked result). */
export class RemoteError extends Error {
  readonly status: number | null;
  constructor(status: number | null, message: string) {
    super(message);
    this.status = status;
  }
}

export function parseInviteLink(link: string): { server: string; token: string } {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new RelayError("usage", "That isn't a link. Pass the invite link a project owner sent you (http://host:port/join#…).");
  }
  const token = url.hash.slice(1);
  if (!/^\/join\/?$/.test(url.pathname) || !token) throw new RelayError("usage", "That link isn't a Relay invite: it should end in /join#<token>.");
  return { server: url.origin, token };
}

export function loadSession(file: string): RemoteSession | null {
  if (process.env.RELAY_SERVER && process.env.RELAY_SESSION) return { server: process.env.RELAY_SERVER.replace(/\/$/, ""), cookie: `relay_session=${process.env.RELAY_SESSION}` };
  if (!existsSync(file)) return null;
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as RemoteSession;
    return s.server && s.cookie ? s : null;
  } catch {
    return null;
  }
}

export function saveSession(file: string, s: RemoteSession): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(s), { mode: 0o600 });
  chmodSync(file, 0o600);
  // A developer's checkout may never have run a Relay server (which excludes .relay/ from git): keep the session
  // out of commits regardless.
  const ignore = pathJoin(dirname(file), ".gitignore");
  const lines = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  if (!lines.split("\n").includes(basename(file))) writeFileSync(ignore, `${lines}${lines && !lines.endsWith("\n") ? "\n" : ""}${basename(file)}\n`);
}

export function forgetSession(file: string): void {
  rmSync(file, { force: true });
}

/**
 * One JSON request. node:http rather than fetch: a rehearsal can run longer than fetch's default 300 s header timeout,
 * and the server bounds each verification command itself.
 */
export function call<T>(server: string, cookie: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: T; headers: Record<string, string | string[] | undefined> }> {
  const url = new URL(`/api${path}`, server);
  const data = body === undefined ? undefined : JSON.stringify(body);
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((ok, fail) => {
    const req = send(url, { method, headers: { "x-relay": "1", "x-relay-client": "cli", ...(cookie ? { cookie } : {}), ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}) } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let parsed: unknown = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          return fail(new RemoteError(res.statusCode ?? null, `${server} didn't answer like a Relay server (HTTP ${res.statusCode})`));
        }
        ok({ status: res.statusCode ?? 0, body: parsed as T, headers: res.headers });
      });
      res.on("error", (e) => fail(new RemoteError(null, `the connection to ${server} broke before the result arrived (${e.message})`)));
    });
    req.on("error", (e) => fail(new RemoteError(null, `can't reach ${server} (${e.message})`)));
    if (data) req.write(data);
    req.end();
  });
}

/** The server's error message, whatever shape it came in. */
export function errorText(body: unknown, fallback: string): string {
  const b = body as { error?: string | { message?: string }; message?: string } | null;
  if (typeof b?.error === "string") return b.message ?? b.error;
  return b?.error?.message ?? b?.message ?? fallback;
}

export async function join(link: string, file: string): Promise<{ server: string; name: string; role: string }> {
  const { server, token } = parseInviteLink(link);
  const r = await call<{ member: { name: string; role: string } }>(server, null, "POST", "/join", { token });
  if (r.status !== 200) throw new RemoteError(r.status, `couldn't join: ${errorText(r.body, `HTTP ${r.status}`)}`);
  const set = ([] as string[]).concat(r.headers["set-cookie"] ?? []);
  const cookie = set.map((c) => c.split(";")[0]!).find((c) => c.startsWith("relay_session="));
  if (!cookie) throw new RemoteError(r.status, "the server accepted the invite but sent no session");
  saveSession(file, { server, cookie });
  return { server, name: r.body.member.name, role: r.body.member.role };
}
