import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, normalize, resolve } from "node:path";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { Relay } from "../core/engine.ts";
import { RelayError, TASK_STATES } from "../core/types.ts";
import type { TaskState } from "../core/types.ts";
import { repoRoot, resolveCommit } from "../git.ts";
import { Members, SESSION_COOKIE, actorFor, can, parseCookies } from "./auth.ts";
import type { Member } from "./auth.ts";
import { CollabService } from "./collab.ts";
import { DocStore } from "./docs.ts";
import { listProjectFiles, resolveProjectPath, readText } from "./files.ts";
import { AgentRuns } from "./runs.ts";

export interface ServerOptions {
  /** Any path inside the project's git repository. */
  root: string;
  dbPath: string;
  port?: number;
  host?: string;
  /** Directory with the built IDE (ide/web/out). Optional: the API works without it. */
  staticDir?: string;
  flushMs?: number;
  /** Command used to run Claude Code for agent tasks. */
  claudeBin?: string;
}

export interface RelayServer {
  url: string;
  port: number;
  relay: Relay;
  members: Members;
  docs: DocStore;
  collab: CollabService;
  runs: AgentRuns;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  // Next's static export inlines its bootstrap scripts, and CodeMirror injects styles at runtime.
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const STATUS_FOR: Record<string, number> = {
  usage: 400,
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  stale_state: 409,
  illegal_transition: 409,
  blocked: 409,
  unverified: 409,
  too_large: 413,
  binary: 415,
};

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS, ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit = 256 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, "too_large", "Request body too large");
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid", "Body must be a JSON object");
  }
}

const str = (v: unknown, what: string, max = 4000): string => {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new HttpError(400, "invalid", `${what} is required (max ${max} characters)`);
  return v;
};
const strList = (v: unknown, what: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x || x.length > 512) || v.length > 200) throw new HttpError(400, "invalid", `${what} must be a list of strings`);
  return v as string[];
};

/** Fixed-window limiter per key. Enough to stop a runaway client, not a DDoS defence. */
function limiter(perSecond: number) {
  const windows = new Map<string, { at: number; n: number }>();
  return (key: string): boolean => {
    const now = Math.floor(Date.now() / 1000);
    const w = windows.get(key);
    if (!w || w.at !== now) {
      windows.set(key, { at: now, n: 1 });
      if (windows.size > 10_000) windows.clear();
      return true;
    }
    return ++w.n <= perSecond;
  };
}

export async function startServer(opts: ServerOptions): Promise<RelayServer> {
  const root = repoRoot(resolve(opts.root));
  const relay = new Relay(opts.dbPath);
  const members = new Members(relay.db);
  const runs = new AgentRuns(relay, root, opts.dbPath, opts.claudeBin ?? "claude");
  const docs = new DocStore(relay.db, root, {
    flushMs: opts.flushMs,
    onEvent: (type, data) => relay.record(type, "system:collab", data),
    onChange: (path, origin) => {
      // A human edit (origin = a client connection) to a file an agent is working from makes that run stale.
      if (typeof origin === "object" && origin !== null) runs.noteHumanEdit(path, (origin as { __member?: string }).__member ?? "someone");
    },
  });
  runs.attachDocs(docs);
  const collab = new CollabService(docs);
  const project = { name: basename(root), root };
  const allow = limiter(40);

  const memberFrom = (req: IncomingMessage): Member | undefined => members.fromSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);

  function requireMember(req: IncomingMessage, action: "read" | "edit" | "approve" | "admin"): Member {
    const m = memberFrom(req);
    if (!m) throw new HttpError(401, "unauthenticated", "Sign in with an invite link from the project owner.");
    if (!can(m.role, action)) throw new HttpError(403, "forbidden", `Your role (${m.role}) can't do this.`);
    if (!allow(`m:${m.id}`)) throw new HttpError(429, "rate_limited", "Slow down a little.");
    return m;
  }

  /** Same-origin check for state-changing requests (on top of the SameSite=Strict cookie). */
  function checkOrigin(req: IncomingMessage): void {
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (origin && host && new URL(origin).host !== host) throw new HttpError(403, "forbidden", "Cross-origin request refused");
    if (req.headers["x-relay"] !== "1") throw new HttpError(403, "forbidden", "Missing x-relay header");
  }

  function snapshot(m: Member) {
    const tasks = relay.listTasks();
    const contracts = [...new Set(tasks.flatMap((t) => Object.keys(t.contracts)))].concat([...relay.currentContracts().keys()]);
    return {
      me: m,
      project: { name: project.name, head: safeHead() },
      members: members.list(),
      presence: collab.presence(),
      tasks: tasks.map((t) => ({ ...t, runs: runs.forTask(t.id) })),
      contracts: [...new Set(contracts)].map((id) => ({ id, history: relay.contractHistory(id) })),
      conflicts: docs.conflicts(),
    };
  }
  const safeHead = () => {
    try {
      return resolveCommit(root, "HEAD").slice(0, 7);
    } catch {
      return null;
    }
  };

  /** Plain-language reasons a task cannot complete right now, from the engine's own gate. */
  function why(taskId: string) {
    const task = relay.requireTask(taskId);
    const gaps = task.state === "completed" ? [] : relay.completionGaps(task, root);
    const evidence = relay.evidence(taskId);
    return {
      task,
      ladder: {
        agentClaimed: evidence.some((e) => e.source === "agent") || task.state === "review_required",
        relayVerified: gaps.filter((g) => !/shares a contract/.test(g)).length === 0,
        humanApproved: task.state === "completed",
      },
      gaps,
    };
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"
    if (method !== "GET") checkOrigin(req);

    if (method === "POST" && parts[0] === "join") {
      if (!allow(`ip:${req.socket.remoteAddress}`)) throw new HttpError(429, "rate_limited", "Too many attempts");
      const body = await readBody(req);
      const { member, session } = members.redeem(str(body.token, "token", 200));
      relay.record("member.joined", `human:${member.id}`, { member: member.id });
      return json(res, 200, { member }, { "set-cookie": `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 86400}` });
    }
    if (method === "POST" && parts[0] === "logout") {
      return json(res, 200, {}, { "set-cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }
    if (method === "GET" && parts[0] === "state") return json(res, 200, snapshot(requireMember(req, "read")));
    if (method === "GET" && parts[0] === "files") {
      requireMember(req, "read");
      return json(res, 200, { files: listProjectFiles(root) });
    }
    if (method === "POST" && parts[0] === "files") {
      const m = requireMember(req, "edit");
      const body = await readBody(req);
      const path = resolveProjectPath(root, str(body.path, "path", 512));
      if (readText(root, path) !== null) throw new HttpError(409, "conflict", `${path} already exists`);
      docs.open(path);
      docs.flush(docs.get(path)!);
      relay.record("file.created", actorFor(m), { path });
      return json(res, 201, { path });
    }
    if (parts[0] === "tasks") {
      if (method === "POST" && parts.length === 1) {
        const m = requireMember(req, "edit");
        const b = await readBody(req);
        const contracts: Record<string, number> = {};
        for (const c of strList(b.contracts, "contracts")) {
          const cur = relay.currentContract(c);
          if (!cur) throw new HttpError(400, "invalid", `Contract ${c} has no accepted version`);
          contracts[c] = cur.version;
        }
        const scope = strList(b.scope, "scope").map((p) => (p.endsWith("/") ? p : resolveProjectPath(root, p)));
        if (!scope.length) throw new HttpError(400, "invalid", "A task needs at least one file or folder in scope");
        // Verification commands run on this machine: only owners may define them.
        const verify = strList(b.verify, "verify");
        if (verify.length && !can(m.role, "approve")) throw new HttpError(403, "forbidden", "Only owners can set verification commands");
        const task = relay.createTask(
          { id: str(b.id, "id", 64), objective: str(b.objective, "objective"), scope, contracts, verify, prerequisites: strList(b.prerequisites, "prerequisites"), owner: m.id, baseCommit: resolveCommit(root) },
          actorFor(m),
        );
        return json(res, 201, task);
      }
      const id = parts[1] ?? "";
      if (method === "GET" && parts[2] === "why") return json(res, 200, why((requireMember(req, "read"), id)));
      if (method === "GET" && parts.length === 2) {
        requireMember(req, "read");
        return json(res, 200, { task: relay.requireTask(id), evidence: relay.evidence(id), events: relay.events(id), runs: runs.forTask(id) });
      }
      if (method === "POST" && parts[2] === "transition") {
        const b = await readBody(req);
        const to = str(b.to, "to", 32) as TaskState;
        if (!TASK_STATES.includes(to)) throw new HttpError(400, "invalid", `Unknown state ${to}`);
        const consequential = to === "queued" || to === "completed" || to === "cancelled";
        const m = requireMember(req, consequential ? "approve" : "edit");
        const task = relay.transition(id, to, actorFor(m), { reason: typeof b.reason === "string" ? b.reason.slice(0, 2000) : undefined, cwd: to === "completed" ? root : undefined });
        return json(res, 200, task);
      }
      if (method === "POST" && parts[2] === "check") {
        requireMember(req, "edit");
        const check = relay.diffCheck(id, root);
        const verification = relay.runVerification(id, root);
        return json(res, 200, { files: check.files, diffCheck: check.evidence, verification });
      }
      if (method === "POST" && parts[2] === "run") {
        const m = requireMember(req, "edit");
        return json(res, 202, await runs.start(id, m));
      }
      if (method === "POST" && parts[2] === "cancel-run") {
        requireMember(req, "edit");
        return json(res, 200, runs.cancel(id));
      }
      if (method === "POST" && parts[2] === "apply") {
        const m = requireMember(req, "approve");
        return json(res, 200, runs.apply(id, m));
      }
    }
    if (parts[0] === "runs" && method === "POST" && parts.length === 1) {
      const m = requireMember(req, "edit");
      const b = await readBody(req);
      return json(res, 202, await runs.start(strList(b.tasks, "tasks"), m));
    }
    if (parts[0] === "contracts" && method === "POST") {
      if (parts.length === 1) {
        const m = requireMember(req, "edit");
        const b = await readBody(req);
        return json(res, 201, relay.proposeContract(str(b.id, "id", 64), str(b.definition, "definition", 20000), actorFor(m), typeof b.rationale === "string" ? b.rationale.slice(0, 4000) : undefined));
      }
      if (parts[3] === "accept") {
        const m = requireMember(req, "approve");
        return json(res, 200, relay.acceptContract(parts[1] ?? "", Number(parts[2]), actorFor(m)));
      }
      if (parts[3] === "reject") {
        const m = requireMember(req, "approve");
        return json(res, 200, relay.rejectContract(parts[1] ?? "", Number(parts[2]), actorFor(m)));
      }
    }
    if (parts[0] === "integrations" && method === "POST") {
      if (parts[1] === "check") {
        const m = requireMember(req, "edit");
        const b = await readBody(req);
        const extra = strList(b.verify, "verify");
        if (extra.length && !can(m.role, "approve")) throw new HttpError(403, "forbidden", "Only owners can add verification commands");
        const ids = strList(b.tasks, "tasks");
        // Agent tasks are checked in a combined worktree of their changes; human tasks in the shared workspace.
        if (ids.length && ids.every((id) => runs.hasRuns(id))) return json(res, 200, runs.checkTogether(ids, extra));
        docs.flushAll();
        return json(res, 200, relay.checkIntegration(ids, root, extra));
      }
      if (parts[2] === "approve") {
        const m = requireMember(req, "approve");
        const id = parts[1] ?? "";
        if (runs.hasCombined(id)) return json(res, 200, runs.approveTogether(id, m));
        docs.flushAll();
        return json(res, 200, { integration: relay.approveIntegration(id, actorFor(m), root), applied: [], conflicts: [], skipped: [] });
      }
    }
    if (parts[0] === "members" && method === "POST") {
      requireMember(req, "admin");
      const b = await readBody(req);
      const { member, token } = members.invite(str(b.name, "name", 40), (str(b.role, "role", 10) as "owner" | "editor" | "viewer"));
      return json(res, 201, { member, joinPath: `/join#${token}` });
    }
    throw new HttpError(404, "not_found", "No such endpoint");
  }

  function serveStatic(res: ServerResponse, pathname: string): void {
    const dir = opts.staticDir;
    if (!dir || !existsSync(dir)) {
      res.writeHead(404, { "content-type": "text/plain", ...SECURITY_HEADERS });
      res.end("Relay server is running. The IDE has not been built (cd ide/web && npm run build).");
      return;
    }
    const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(dir, clean);
    if (!file.startsWith(resolve(dir))) file = join(dir, "index.html");
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file) && existsSync(file + ".html")) file += ".html";
    if (!existsSync(file)) file = join(dir, "index.html");
    const immutable = file.includes(`${"_next"}/static`);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache", ...SECURITY_HEADERS });
    res.end(readFileSync(file));
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://relay.local");
    if (!url.pathname.startsWith("/api/")) return serveStatic(res, url.pathname);
    api(req, res, url).catch((err: unknown) => {
      if (err instanceof HttpError) return json(res, err.status, { error: err.code, message: err.message });
      if (err instanceof RelayError) return json(res, STATUS_FOR[err.code] ?? 400, { error: err.code, message: err.message });
      relay.record("server.error", "system:server", { path: url.pathname, message: String((err as Error)?.message ?? err).slice(0, 500) });
      json(res, 500, { error: "internal", message: "Something went wrong on the Relay server." });
    });
  });

  // ---------- WebSockets: /collab/<doc> and /events ----------
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  const eventClients = new Set<WebSocket>();
  let lastSeq = relay.events().at(-1)?.seq ?? 0;
  const feed = setInterval(() => {
    const fresh = relay.eventsSince(lastSeq);
    if (!fresh.length) return;
    lastSeq = fresh.at(-1)!.seq;
    const msg = JSON.stringify({ type: "events", events: fresh });
    for (const ws of eventClients) if (ws.readyState === ws.OPEN && ws.bufferedAmount < 1 << 20) ws.send(msg);
  }, 200);

  server.on("upgrade", (req, socket, head) => {
    const reject = (code: number, msg: string) => {
      socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    try {
      const url = new URL(req.url ?? "/", "http://relay.local");
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return reject(403, "Forbidden");
      const member = memberFrom(req);
      if (!member) return reject(401, "Unauthorized");
      if (url.pathname === "/events") {
        return wss.handleUpgrade(req, socket, head, (ws) => {
          eventClients.add(ws);
          ws.on("close", () => eventClients.delete(ws));
        });
      }
      const m = /^\/collab\/(.+)$/.exec(url.pathname);
      if (!m) return reject(404, "Not Found");
      const name = decodeURIComponent(m[1]!);
      if (!name.startsWith("file:")) return reject(400, "Bad Request");
      const path = resolveProjectPath(root, name.slice(5));
      readText(root, path); // binary / too-large files are refused before joining
      wss.handleUpgrade(req, socket, head, (ws) => {
        (ws as unknown as { __member: string }).__member = member.name;
        collab.attach(ws, path, member);
      });
    } catch (err) {
      reject(err instanceof RelayError && err.code === "forbidden" ? 403 : 400, "Bad Request");
    }
  });

  await new Promise<void>((ok) => server.listen(opts.port ?? 4747, opts.host ?? "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;

  return {
    url: `http://${opts.host ?? "127.0.0.1"}:${port}`,
    port,
    relay,
    members,
    docs,
    collab,
    runs,
    async close() {
      clearInterval(feed);
      runs.close();
      for (const ws of eventClients) ws.terminate();
      collab.close();
      wss.close();
      await new Promise<void>((ok) => server.close(() => ok()));
      docs.close();
      relay.close();
    },
  };
}
