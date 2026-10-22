import WS from "ws";

/** A member of the Relay project, as the server describes them. */
export interface Member {
  id: string;
  name: string;
  role: "owner" | "editor" | "viewer";
  color: string;
}

/** A project event from the server's feed (`/events`). */
export interface RelayEvent {
  seq: number;
  type: string;
  actor: string;
  taskId?: string | null;
  data: Record<string, unknown>;
  at: string;
}

/** Where a member is right now (ephemeral, from the server's presence feed). */
export interface Participant {
  memberId: string;
  path: string;
  typing: boolean;
}

export class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Parse an invite link (`http://host:port/join#<token>`) into the server's origin and the one-time token. */
export function parseInvite(link: string): { server: string; token: string } {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    throw new Error("That isn't a link. Paste the invite link the project owner sent you (it looks like http://host:port/join#…).");
  }
  const token = url.hash.replace(/^#/, "");
  if (!/^\/join\/?$/.test(url.pathname) || !token) throw new Error("That link isn't a Relay invite: it should end in /join#<token>.");
  return { server: url.origin, token };
}

/**
 * One signed-in connection to a Relay server: the session cookie, authenticated HTTP, WebSockets that carry the
 * cookie, and the project's event feed. The cookie is a credential; it is never logged or shown.
 */
export class Connection {
  me: Member | null = null;
  members: Member[] = [];
  project: { name: string; head: string | null } = { name: "", head: null };
  private eventsWs: WS | null = null;
  private lastSeq = 0;
  private closed = false;
  private retry: NodeJS.Timeout | undefined;

  constructor(
    readonly server: string,
    private readonly cookie: string,
  ) {}

  /** Redeem an invite token for a session. Returns the session cookie (`name=value`). */
  static async redeem(server: string, token: string): Promise<string> {
    const res = await fetch(`${server}/api/join`, { method: "POST", headers: { "content-type": "application/json", "x-relay": "1" }, body: JSON.stringify({ token }) });
    if (res.status !== 200) throw new RelayError(res.status, await errorText(res, "The invite was refused (it may have been used already or revoked)."));
    const set = res.headers.get("set-cookie");
    const cookie = set?.split(";")[0];
    if (!cookie) throw new RelayError(500, "The server didn't start a session.");
    return cookie;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.server}/api${path}`, {
      method,
      headers: { cookie: this.cookie, "x-relay": "1", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new RelayError(res.status, await errorText(res, `${method} ${path} failed (${res.status})`));
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  /** Load who I am, the members and the project; throws RelayError 401 if the session ended. */
  async refresh(): Promise<void> {
    const s = await this.request<{ me: Member; members: Member[]; project: { name: string; head: string | null } }>("GET", "/state");
    this.me = s.me;
    this.members = s.members;
    this.project = s.project;
  }

  async files(): Promise<string[]> {
    return (await this.request<{ files: string[] }>("GET", "/files")).files;
  }

  /** A WebSocket class that sends the session cookie, for y-websocket's provider. */
  socketClass(): typeof WebSocket {
    const cookie = this.cookie;
    class AuthedWS extends WS {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols, { headers: { cookie } });
      }
    }
    return AuthedWS as unknown as typeof WebSocket;
  }

  get wsBase(): string {
    return this.server.replace(/^http/, "ws");
  }

  /** Follow the project's event feed, resuming from the last event seen after a reconnect. */
  follow(onEvent: (e: RelayEvent) => void, onState: (connected: boolean) => void, onPresence?: (p: { online: string[]; participants: Participant[] }) => void): void {
    if (this.closed) return;
    const ws = new WS(`${this.wsBase}/events${this.lastSeq ? `?since=${this.lastSeq}` : ""}`, { headers: { cookie: this.cookie } });
    this.eventsWs = ws;
    ws.on("open", () => onState(true));
    ws.on("message", (raw) => {
      let msg: { type?: string; seq?: number; events?: RelayEvent[]; online?: string[]; participants?: Participant[] };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === "hello") {
        if (!this.lastSeq && typeof msg.seq === "number") this.lastSeq = msg.seq;
      } else if (msg.type === "events") {
        for (const e of msg.events ?? []) {
          if (e.seq <= this.lastSeq) continue;
          this.lastSeq = e.seq;
          onEvent(e);
        }
      } else if (msg.type === "presence") {
        onPresence?.({ online: msg.online ?? [], participants: msg.participants ?? [] });
      }
    });
    ws.on("close", (code) => {
      onState(false);
      if (this.closed || code === 4401) return;
      this.retry = setTimeout(() => this.follow(onEvent, onState, onPresence), 1500);
    });
    ws.on("error", () => {});
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retry);
    this.eventsWs?.close();
  }
}

async function errorText(res: Response, fallback: string): Promise<string> {
  try {
    const b = (await res.json()) as { message?: string };
    return b.message ?? fallback;
  } catch {
    return fallback;
  }
}
