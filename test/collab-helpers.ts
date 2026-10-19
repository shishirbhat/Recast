import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WS from "ws";
import { startServer } from "../src/server/server.ts";
import type { RelayServer, ServerOptions } from "../src/server/server.ts";
import type { Role } from "../src/server/auth.ts";
import { makeRepo, tempDb } from "./helpers.ts";

export async function testServer(files: Record<string, string> = { "src/app.js": "export const greeting = 'hi';\n", "README.md": "# demo\n" }, opts: Partial<ServerOptions> = {}) {
  const repo = opts.root ?? makeRepo(files);
  const dbPath = opts.dbPath ?? tempDb();
  const server = await startServer({ root: repo, dbPath, port: 0, flushMs: 30, ...opts });
  return { server, repo, dbPath };
}

/** Invite + redeem through the real HTTP API; returns the session cookie. */
export async function join(server: RelayServer, name: string, role: Role = "editor"): Promise<{ cookie: string; id: string }> {
  const { token, member } = server.members.invite(name, role);
  const res = await fetch(`${server.url}/api/join`, { method: "POST", headers: { "content-type": "application/json", "x-relay": "1" }, body: JSON.stringify({ token }) });
  if (res.status !== 200) throw new Error(`join failed: ${res.status} ${await res.text()}`);
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  return { cookie, id: member.id };
}

export interface Client {
  doc: Y.Doc;
  text: Y.Text;
  provider: WebsocketProvider;
  close(): void;
}

/** A real Yjs client using the stock y-websocket provider, authenticated by cookie. */
export function client(server: RelayServer, cookie: string, path: string): Promise<Client> {
  const doc = new Y.Doc();
  class AuthedWS extends WS {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols, { headers: { cookie } });
    }
  }
  const provider = new WebsocketProvider(server.url.replace("http", "ws") + "/collab", encodeURIComponent(`file:${path}`), doc, {
    WebSocketPolyfill: AuthedWS as unknown as typeof WebSocket,
    disableBc: true,
    resyncInterval: -1,
  });
  const c: Client = { doc, text: doc.getText("content"), provider, close: () => (provider.destroy(), doc.destroy()) };
  return new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`client for ${path} did not sync`)), 5000);
    provider.on("sync", (synced: boolean) => {
      if (synced) {
        clearTimeout(t);
        ok(c);
      }
    });
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn` is true or time runs out. */
export async function until(fn: () => boolean, ms = 3000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

export async function api(server: RelayServer, cookie: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = { "x-relay": "1" }) {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
