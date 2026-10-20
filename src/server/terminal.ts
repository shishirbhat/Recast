import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { IPty } from "node-pty";
import type { Member } from "./auth.ts";

/**
 * Integrated terminal: a real PTY on the machine running the Relay server.
 *
 * This is arbitrary code execution as the server's user, so the policy is strict:
 * owners only, and only when the server listens on loopback unless it was started with --allow-terminal.
 * Sessions belong to the member who created them; nobody else can attach.
 */

const MAX_SESSIONS_PER_MEMBER = 4;
const REPLAY_BYTES = 256 * 1024;
const IDLE_MS = 30 * 60_000;
const MAX_INPUT = 64 * 1024;

export interface TerminalPolicy {
  /** The server is bound to 127.0.0.1 / ::1 / localhost. */
  loopback: boolean;
  /** Started with --allow-terminal. */
  allowRemote: boolean;
}

export interface Availability {
  available: boolean;
  reason: string | null;
}

interface Session {
  id: string;
  owner: string;
  pty: IPty;
  buffer: string;
  clients: Set<WebSocket>;
  idleTimer: NodeJS.Timeout | null;
  exited: number | null;
  createdAt: string;
  title: string;
}

type PtyModule = typeof import("node-pty");

export class TerminalService {
  private sessions = new Map<string, Session>();
  private root: string;
  private policy: TerminalPolicy;
  private pty: PtyModule | null = null;
  private loadError: string | null = null;

  constructor(root: string, policy: TerminalPolicy) {
    this.root = root;
    this.policy = policy;
  }

  /** node-pty is a native module: load lazily so a missing build disables the terminal instead of the server. */
  private async load(): Promise<PtyModule | null> {
    if (this.pty || this.loadError) return this.pty;
    try {
      this.pty = (await import("node-pty")).default as unknown as PtyModule;
    } catch (err) {
      this.loadError = `node-pty could not be loaded (${(err as Error).message.split("\n")[0]})`;
    }
    return this.pty;
  }

  async availability(member: Member): Promise<Availability> {
    if (member.role !== "owner") return { available: false, reason: "Only project owners can open a terminal: it runs commands on the host machine." };
    if (!this.policy.loopback && !this.policy.allowRemote) return { available: false, reason: "The server is reachable from the network, so the terminal is off. Restart it with --allow-terminal to enable it." };
    if (!(await this.load())) return { available: false, reason: `The terminal backend is unavailable: ${this.loadError}.` };
    return { available: true, reason: null };
  }

  list(member: Member): { id: string; title: string; exited: number | null; createdAt: string }[] {
    return [...this.sessions.values()].filter((s) => s.owner === member.id).map((s) => ({ id: s.id, title: s.title, exited: s.exited, createdAt: s.createdAt }));
  }

  /** Attach a socket to an existing session of this member, or create one. Throws if not allowed. */
  async attach(ws: WebSocket, member: Member, sessionId: string | null, cols: number, rows: number): Promise<void> {
    const ok = await this.availability(member);
    if (!ok.available) throw new Error(ok.reason ?? "terminal unavailable");
    let s = sessionId ? this.sessions.get(sessionId) : undefined;
    if (s && s.owner !== member.id) throw new Error("Not your terminal session");
    if (!s) {
      if (this.list(member).filter((x) => x.exited === null).length >= MAX_SESSIONS_PER_MEMBER) throw new Error(`At most ${MAX_SESSIONS_PER_MEMBER} terminals per person`);
      s = this.spawn(member, cols, rows);
    }
    const session = s;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = null;
    session.clients.add(ws);
    const send = (o: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(o));
    send({ type: "ready", id: session.id, title: session.title });
    if (session.buffer) send({ type: "output", data: session.buffer });
    if (session.exited !== null) send({ type: "exit", code: session.exited });
    else session.pty.resize(clamp(cols, 2, 500), clamp(rows, 1, 200));

    ws.on("message", (raw: Buffer) => {
      if (raw.length > MAX_INPUT) return;
      let msg: { type?: string; data?: unknown; cols?: unknown; rows?: unknown };
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      if (session.exited !== null) return;
      if (msg.type === "input" && typeof msg.data === "string") session.pty.write(msg.data);
      else if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") session.pty.resize(clamp(msg.cols, 2, 500), clamp(msg.rows, 1, 200));
    });
    ws.on("close", () => {
      session.clients.delete(ws);
      // Detaching (closing the panel, reloading) keeps the shell alive for a while.
      // (Not for a session that was just killed: its sockets close as part of the kill.)
      if (session.clients.size === 0 && this.sessions.has(session.id)) {
        session.idleTimer = setTimeout(() => this.kill(session.id), IDLE_MS);
        session.idleTimer.unref();
      }
    });
  }

  private spawn(member: Member, cols: number, rows: number): Session {
    const shell = process.env.SHELL && /^[\w/.-]+$/.test(process.env.SHELL) ? process.env.SHELL : "bash";
    const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", RELAY_TERMINAL: "1" } as Record<string, string>;
    const pty = this.pty!.spawn(shell, [], { name: "xterm-256color", cols: clamp(cols, 2, 500), rows: clamp(rows, 1, 200), cwd: this.root, env });
    const n = this.list(member).length + 1;
    const s: Session = { id: randomUUID(), owner: member.id, pty, buffer: "", clients: new Set(), idleTimer: null, exited: null, createdAt: new Date().toISOString(), title: `${shell.split("/").pop()} ${n}` };
    pty.onData((data) => {
      s.buffer = (s.buffer + data).slice(-REPLAY_BYTES);
      const msg = JSON.stringify({ type: "output", data });
      for (const c of s.clients) if (c.readyState === c.OPEN && c.bufferedAmount < 4 << 20) c.send(msg);
    });
    pty.onExit(({ exitCode }) => {
      s.exited = exitCode;
      const msg = JSON.stringify({ type: "exit", code: exitCode });
      for (const c of s.clients) if (c.readyState === c.OPEN) c.send(msg);
    });
    this.sessions.set(s.id, s);
    return s;
  }

  kill(id: string, member?: Member): boolean {
    const s = this.sessions.get(id);
    if (!s || (member && s.owner !== member.id)) return false;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    if (s.exited === null) {
      try {
        s.pty.kill();
      } catch {}
    }
    for (const c of s.clients) c.close(1000, "terminal closed");
    this.sessions.delete(id);
    return true;
  }

  close(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
