import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { Relay } from "../core/engine.ts";
import { RelayError, TASK_STATES } from "../core/types.ts";
import type { TaskState } from "../core/types.ts";
import { relayOwnFiles, repoRoot, resolveCommit, showAt, workspaceFingerprint } from "../git.ts";
import { createHash, randomUUID } from "node:crypto";
import { Members, SESSION_COOKIE, actorFor, can, parseCookies } from "./auth.ts";
import type { Member } from "./auth.ts";
import { CollabService } from "./collab.ts";
import { DocStore } from "./docs.ts";
import { coordination } from "../analysis/coordination.ts";
import { changeRecord } from "../analysis/change.ts";
import { integrationReport } from "../analysis/explain.ts";
import { syntaxProblems } from "../analysis/syntax.ts";
import * as gitops from "./gitops.ts";
import { TestRunner } from "./testrunner.ts";
import { authorKind, authorTotals, lineAuthors, lineOrigin, sessionDiff, sessionSides, sessions as editSessions } from "./attribution.ts";
import { ImpactService } from "../analysis/impact.ts";
import { ENTRY_KINDS, Records } from "../knowledge/records.ts";
import type { EntryKind, Source } from "../knowledge/records.ts";
import { GitHub } from "./github.ts";
import type { GitHubOptions, MergeMethod } from "./github.ts";
import { expandReplacement, findMatches, textFingerprint, writeAtomic, gitStatus, listEmptyFolders, listProjectFiles, resolveProjectPath, readText, searchProject, workspaceSymbols } from "./files.ts";
import type { SearchOptions } from "./files.ts";
import { AgentRuns } from "./runs.ts";
import { TerminalService } from "./terminal.ts";

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
  /** Allow the integrated terminal even when listening on a non-loopback address. */
  allowTerminal?: boolean;
  /** GitHub delivery. The token never leaves the server. */
  github?: GitHubOptions;
}

export interface RelayServer {
  url: string;
  port: number;
  relay: Relay;
  members: Members;
  docs: DocStore;
  collab: CollabService;
  runs: AgentRuns;
  terminals: TerminalService;
  github: GitHub;
  impact: ImpactService;
  records: Records;
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

/**
 * The client protocol: collaboration messages (Yjs sync + awareness + Relay's save acknowledgement), the event feed and
 * the HTTP API the VS Code extension uses. Bump when a change would break an older client; clients refuse a mismatch.
 */
export const PROTOCOL = 1;
const RELAY_VERSION = (JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8")) as { version: string }).version;
const VSIX_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../vscode");
const VSIX_MISSING = "The VS Code extension hasn't been packaged on this server (cd vscode && npm install && npm run package).";
/** The newest packaged VS Code extension next to this Relay install, or null. */
function vsixPath(): string | null {
  try {
    const files = readdirSync(VSIX_DIR).filter((f) => /^relay-vscode-.*\.vsix$/.test(f)).sort();
    return files.length ? join(VSIX_DIR, files.at(-1)!) : null;
  } catch {
    return null;
  }
}

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
  const host = opts.host ?? "127.0.0.1";
  const terminals = new TerminalService(root, { loopback: ["127.0.0.1", "::1", "localhost"].includes(host), allowRemote: opts.allowTerminal === true });
  const project = { name: basename(root), root };
  const impact = new ImpactService(relay, root, resolve(opts.dbPath));
  const records = new Records(relay, root);
  const tests = new TestRunner(relay.db, root, () => workspaceFingerprint(root, relayOwnFiles(root, resolve(opts.dbPath))));
  tests.onChange = () => {
    const r = tests.running();
    if (r && r.status !== "running") return;
    // Live progress goes to subscribers as a lightweight event; the full record is persisted when the run ends.
    pushTests();
  };
  relay.db.exec(`CREATE TABLE IF NOT EXISTS review_comments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, path TEXT NOT NULL, line INTEGER NOT NULL, body TEXT NOT NULL,
    author TEXT NOT NULL, revision TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT
  )`);
  /** The content hash of the version of `path` a task's review is looking at (agent worktree or shared workspace). */
  const reviewBlob = (taskId: string, path: string): string => {
    const run = runs.forTask(taskId).at(-1);
    const text = run && run.status !== "applied" ? (() => { try { return readFileSync(join(run.worktree, path), "utf8"); } catch { return ""; } })() : (docs.get(path)?.text.toString() ?? readText(root, path) ?? "");
    return createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");
  };
  const freshGraph = () => (impact.graph.refresh(listProjectFiles(root)), impact.graph);
  runs.attachContext((taskId) => records.contextText(taskId, freshGraph()));
  const github = new GitHub(root, relay.db, resolve(opts.dbPath), opts.github);
  const preflight = () => {
    const tasks = relay.listTasks();
    const all = tasks.flatMap((t) => runs.forTask(t.id));
    return {
      conflicts: docs.conflicts().length,
      runningAgents: all.filter((r) => r.status === "running" || r.status === "starting").length,
      awaitingReview: tasks.filter((t) => t.state === "review_required").map((t) => t.id),
      unappliedProposals: [...new Set(all.filter((r) => r.status === "finished").map((r) => r.taskId))],
    };
  };
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

  /** A file's shared text: the live document if one is loaded (it may be ahead of the disk by the flush delay), else disk. Null if missing or not text. */
  function sharedText(path: string): string | null {
    const live = docs.get(path);
    if (live) return live.text.toString();
    try {
      return readText(root, path);
    } catch {
      return null;
    }
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
      // Which client joined (e.g. "vscode/0.2.0"): useful when diagnosing version problems. Never secret, kept short.
      const client = String(req.headers["x-relay-client"] ?? "browser").replace(/[^\w./-]/g, "").slice(0, 40);
      relay.record("member.joined", `human:${member.id}`, { member: member.id, client });
      return json(res, 200, { member }, { "set-cookie": `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 86400}` });
    }
    if (method === "POST" && parts[0] === "logout") {
      members.endSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
      return json(res, 200, {}, { "set-cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }
    if (method === "GET" && parts[0] === "state") return json(res, 200, snapshot(requireMember(req, "read")));
    if (method === "GET" && parts[0] === "version") {
      // Public, so a client can tell an incompatible server apart before it redeems a one-time invite.
      return json(res, 200, { protocol: PROTOCOL, version: RELAY_VERSION });
    }
    if (method === "GET" && parts[0] === "files" && parts[1] === "fingerprints") {
      // The shared text of every file, as fingerprints (same FNV-1a as clients compute), so a client can tell which of
      // its local copies differ without downloading the project. Live documents count over what's on disk.
      requireMember(req, "read");
      const out: Record<string, string> = {};
      for (const p of listProjectFiles(root)) {
        const text = sharedText(p);
        if (text !== null) out[p] = textFingerprint(text);
      }
      return json(res, 200, { fingerprints: out });
    }
    if (method === "GET" && parts[0] === "files") {
      requireMember(req, "read");
      return json(res, 200, { files: listProjectFiles(root), folders: listEmptyFolders(root) });
    }
    if (method === "GET" && parts[0] === "file") {
      requireMember(req, "read");
      const path = resolveProjectPath(root, url.searchParams.get("path") ?? "");
      const text = sharedText(path);
      if (text === null) throw new HttpError(404, "not_found", `${path} doesn't exist`);
      return json(res, 200, { path, text, fingerprint: textFingerprint(text) });
    }
    if (method === "GET" && parts[0] === "capabilities") {
      const m = requireMember(req, "read");
      const p = runs.provider;
      return json(res, 200, { terminal: await terminals.availability(m), agent: { provider: p.id, displayName: p.displayName, capabilities: p.capabilities, ...(await p.available()) }, extensions: { available: false, reason: "Relay has no extension host yet. Language support is built in." }, vscodeExtension: vsixPath() ? { available: true, url: "/downloads/relay-vscode.vsix" } : { available: false, reason: VSIX_MISSING } });
    }
    if (parts[0] === "terminals") {
      const m = requireMember(req, "read");
      if (method === "GET") return json(res, 200, { sessions: terminals.list(m) });
      if (method === "POST" && parts[2] === "kill") return json(res, 200, { killed: terminals.kill(parts[1] ?? "", m) });
    }
    if (method === "POST" && parts[0] === "save") {
      requireMember(req, "edit");
      const b = await readBody(req);
      const path = resolveProjectPath(root, str(b.path, "path", 512));
      const entry = docs.get(path);
      if (!entry) throw new HttpError(404, "not_found", `${path} is not open`);
      docs.flush(entry);
      return json(res, 200, { path, savedAt: new Date().toISOString() });
    }
    if (method === "GET" && parts[0] === "output") {
      // What Relay itself ran (diff checks, verification, integration checks), newest first.
      requireMember(req, "read");
      const evidence = relay.db.prepare("SELECT id, task_id, kind, command, exit_code, output, created_at FROM evidence WHERE source = 'system' ORDER BY created_at DESC LIMIT 40").all();
      const integrations = relay.db.prepare("SELECT id, tasks, status, results, created_at FROM integrations ORDER BY created_at DESC LIMIT 10").all() as { id: string; tasks: string; status: string; results: string; created_at: string }[];
      return json(res, 200, { evidence, integrations: integrations.map((i) => ({ ...i, tasks: JSON.parse(i.tasks), results: JSON.parse(i.results) })) });
    }
    if (method === "GET" && parts[0] === "scripts") {
      requireMember(req, "read");
      try {
        const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
        return json(res, 200, { scripts: Object.entries(pkg.scripts ?? {}).map(([name, command]) => ({ name, command: String(command) })) });
      } catch {
        return json(res, 200, { scripts: [] });
      }
    }
    if (method === "GET" && parts[0] === "search") {
      requireMember(req, "read");
      docs.flushAll(); // search what collaborators see, not a stale disk
      const opts: SearchOptions = { matchCase: url.searchParams.get("case") === "1", wholeWord: url.searchParams.get("word") === "1", regex: url.searchParams.get("regex") === "1" };
      return json(res, 200, searchProject(root, url.searchParams.get("q") ?? "", 300, opts));
    }
    if (method === "POST" && parts[0] === "replace") {
      // Replace in Files: applied to the shared documents (so open editors update live), attributed to the person, one
      // change per file. With dryRun it only counts. Only the paths the person confirmed are touched.
      const m = requireMember(req, "edit");
      const b = await readBody(req);
      const query = str(b.query, "query", 200);
      const replacement = typeof b.replacement === "string" ? b.replacement : "";
      const opts: SearchOptions = { matchCase: b.matchCase === true, wholeWord: b.wholeWord === true, regex: b.regex === true };
      const paths = [...new Set(strList(b.paths, "paths").map((p) => resolveProjectPath(root, p)))].slice(0, 500);
      const files: { path: string; count: number }[] = [];
      for (const path of paths) {
        if (readText(root, path) === null && !docs.get(path)) continue;
        const entry = docs.open(path);
        const text = entry.text.toString();
        const matches = findMatches(text, query, opts);
        if (!matches.length) continue;
        if (b.dryRun !== true) docs.applyEdits(path, matches.map((x) => ({ from: x.index, to: x.index + x.text.length, insert: expandReplacement(replacement, x, opts.regex === true) })), `member:${m.id}`);
        files.push({ path, count: matches.length });
      }
      if (b.dryRun !== true && files.length) relay.record("files.replaced", actorFor(m), { files: files.map((f) => f.path), replacements: files.reduce((n, f) => n + f.count, 0) });
      return json(res, 200, { files, replacements: files.reduce((n, f) => n + f.count, 0) });
    }
    if (method === "GET" && parts[0] === "coordination") {
      requireMember(req, "read");
      docs.flushAll(); // changed files and verification are judged on what collaborators see
      return json(res, 200, coordination(relay, root, resolve(opts.dbPath), (id) => runs.forTask(id), impact.compute({})));
    }
    if (method === "GET" && parts[0] === "symbols") {
      requireMember(req, "read");
      docs.flushAll();
      return json(res, 200, workspaceSymbols(root, url.searchParams.get("q") ?? ""));
    }
    if (method === "GET" && parts[0] === "git" && parts.length === 1) {
      requireMember(req, "read");
      docs.flushAll();
      return json(res, 200, gitStatus(root));
    }
    if (parts[0] === "git" && parts[1]) {
      // Git workflow. Anything that changes files for everyone (switch, pull) or reaches a remote (push) is owner-only.
      const op = parts[1];
      if (method === "GET" && op === "state") {
        requireMember(req, "read");
        docs.flushAll();
        return json(res, 200, { ...gitops.gitState(root), branches: gitops.branches(root), log: gitops.log(root, 20) });
      }
      if (method === "GET" && op === "diff") {
        requireMember(req, "read");
        const path = resolveProjectPath(root, str(url.searchParams.get("path"), "path", 512));
        docs.flushAll();
        return json(res, 200, { path, ...gitops.diffSides(root, path, url.searchParams.get("staged") === "1", docs.get(path)?.text.toString() ?? readText(root, path)) });
      }
      if (method === "POST") {
        const b = await readBody(req);
        const paths = () => strList(b.paths, "paths").map((p) => resolveProjectPath(root, p));
        if (op === "stage" || op === "unstage") {
          requireMember(req, "edit");
          docs.flushAll();
          (op === "stage" ? gitops.stage : gitops.unstage)(root, paths());
          return json(res, 200, gitops.gitState(root));
        }
        if (op === "commit") {
          const m = requireMember(req, "edit");
          docs.flushAll();
          const c = gitops.commit(root, str(b.message, "message", 5000), m);
          relay.record("git.committed", actorFor(m), { sha: c.sha, files: c.files, message: String(b.message).split("\n")[0]!.slice(0, 120) });
          return json(res, 201, c);
        }
        if (op === "branch") {
          const sw = b.switch === true;
          const m = requireMember(req, sw ? "approve" : "edit");
          gitops.createBranch(root, str(b.name, "name", 200), sw);
          relay.record("git.branch_created", actorFor(m), { name: b.name, switched: sw });
          return json(res, 201, { name: b.name });
        }
        if (op === "switch" || op === "pull" || op === "push") {
          const m = requireMember(req, "approve");
          docs.flushAll();
          let message = "";
          if (op === "switch") (gitops.switchBranch(root, str(b.name, "name", 200)), (message = `Switched to ${b.name}.`));
          else if (op === "pull") message = gitops.pull(root, await github.gitEnv());
          else message = gitops.push(root, await github.gitEnv());
          if (op !== "push") docs.checkAll(); // shared documents pick up the new file contents now
          relay.record(`git.${op === "switch" ? "branch_switched" : op === "pull" ? "pulled" : "pushed"}`, actorFor(m), { name: b.name ?? null, message: message.slice(0, 300) });
          return json(res, 200, { message, state: gitops.gitState(root) });
        }
      }
    }
    if (parts[0] === "investigations") {
      const sources = (v: unknown): Source[] => {
        if (v === undefined) return [];
        if (!Array.isArray(v) || v.length > 20) throw new HttpError(400, "invalid", "sources must be a list");
        return v.map((x) => ({ type: String((x as Source)?.type) as Source["type"], ref: String((x as Source)?.ref ?? "") }));
      };
      if (method === "GET" && parts.length === 1) return (requireMember(req, "read"), json(res, 200, { investigations: records.listInvestigations() }));
      if (method === "POST" && parts.length === 1) {
        const m = requireMember(req, "edit");
        const b = await readBody(req);
        return json(res, 201, records.createInvestigation({ title: str(b.title, "title", 200), description: str(b.description, "description", 20000), taskId: typeof b.taskId === "string" && b.taskId ? b.taskId : undefined }, m.name));
      }
      const id = parts[1] ?? "";
      if (method === "GET" && parts.length === 2) return (requireMember(req, "read"), json(res, 200, records.getInvestigation(id)));
      if (method === "POST" && parts[2] === "entries") {
        const m = requireMember(req, "edit");
        const b = await readBody(req, 512 * 1024);
        const kind = str(b.kind, "kind", 20) as EntryKind;
        if (!ENTRY_KINDS.includes(kind)) throw new HttpError(400, "invalid", `kind must be one of ${ENTRY_KINDS.join(", ")}`);
        return json(res, 201, records.addEntry(id, { kind, body: str(b.body, "body", 100_000), sources: sources(b.sources), status: typeof b.status === "string" ? b.status : undefined }, m.name));
      }
      if (method === "POST" && parts[2] === "run") {
        // Commands run on this machine: owners only, like verification commands.
        const m = requireMember(req, "approve");
        const b = await readBody(req);
        return json(res, 201, records.runCommand(id, str(b.command, "command", 2000), m.name));
      }
      if (method === "POST" && parts.length === 2) {
        const m = requireMember(req, "edit");
        const b = await readBody(req);
        return json(res, 200, records.updateInvestigation(id, { status: typeof b.status === "string" ? (b.status as "open") : undefined, owner: typeof b.owner === "string" ? b.owner.slice(0, 80) : undefined }, m.name));
      }
    }
    if (parts[0] === "decisions") {
      if (method === "GET" && parts.length === 1) return (requireMember(req, "read"), json(res, 200, { decisions: records.listDecisions() }));
      if (method === "POST" && parts.length === 1) {
        const m = requireMember(req, "edit");
        const b = await readBody(req, 512 * 1024);
        const alts = Array.isArray(b.alternatives) ? (b.alternatives as { option?: unknown; rejectedBecause?: unknown }[]).map((a) => ({ option: String(a?.option ?? ""), rejectedBecause: String(a?.rejectedBecause ?? "") })) : [];
        const kind = ["decision", "hazard", "constraint", "question"].includes(b.kind as string) ? (b.kind as "decision") : "decision";
        const srcs = Array.isArray(b.sources) ? (b.sources as Source[]).map((x) => ({ type: String(x?.type) as Source["type"], ref: String(x?.ref ?? "") })) : [];
        return json(res, 201, records.proposeDecision({ title: str(b.title, "title", 200), context: str(b.context, "context", 20000), decision: str(b.decision, "decision", 20000), alternatives: alts, scope: strList(b.scope, "scope"), contracts: strList(b.contracts, "contracts"), kind, sources: srcs, supersedes: typeof b.supersedes === "string" ? b.supersedes : undefined }, m.name));
      }
      const to = ({ accept: "accepted", reject: "rejected", invalidate: "invalidated" } as const)[parts[2] as "accept"];
      if (method === "POST" && to) {
        // Only people with approval rights make a record authoritative.
        const m = requireMember(req, "approve");
        const b = await readBody(req);
        return json(res, 200, records.decide(parts[1] ?? "", to, m.name, typeof b.reason === "string" ? b.reason.slice(0, 2000) : undefined));
      }
    }
    if (method === "GET" && parts[0] === "context") {
      requireMember(req, "read");
      return json(res, 200, records.contextFor(str(url.searchParams.get("task"), "task", 64), freshGraph()));
    }
    if (method === "GET" && parts[0] === "people" && parts.length === 1) {
      // Humans (members) and agents, with live presence and historical totals. Server origins are reported separately.
      requireMember(req, "read");
      const live = new Map(collab.participants().map((a) => [a.memberId, a]));
      const totals = new Map(authorTotals(relay.db).map((t) => [t.author, t]));
      const online = new Set([...eventMembers.values(), ...live.keys()]);
      const status = (id: string) => {
        const a = live.get(id);
        if (!a) return online.has(id) ? "online" : "offline";
        const idle = Date.now() - a.at;
        return idle < 60_000 ? "active" : idle < 600_000 ? "idle" : "away";
      };
      const humans = members.list().map((m) => ({ ...m, kind: "human" as const, status: status(m.id), path: live.get(m.id)?.path ?? null, lastActive: live.get(m.id) ? new Date(live.get(m.id)!.at).toISOString() : (totals.get(m.id)?.lastAt ?? null), typing: !!live.get(m.id)?.typedAt && Date.now() - live.get(m.id)!.typedAt! < 3000, totals: totals.get(m.id) ?? null }));
      const agents = [...totals.values()].filter((t) => authorKind(t.author) === "agent").map((t) => ({ id: t.author, name: t.author.replace(/^agent:/, ""), kind: "agent" as const, role: "agent", color: "#9a9faa", status: "offline", path: null, lastActive: t.lastAt, typing: false, totals: t }));
      const origins = [...totals.values()].filter((t) => ["disk", "unknown", "baseline"].includes(authorKind(t.author)));
      return json(res, 200, { people: [...humans, ...agents], origins });
    }
    if (method === "GET" && parts[0] === "people" && parts[1]) {
      requireMember(req, "read");
      const id = decodeURIComponent(parts[1]);
      const ss = editSessions(relay.db, { author: id, limit: 1000 });
      const files = new Map<string, { path: string; inserted: number; deleted: number; wsInserted: number; wsDeleted: number; sessions: number; lastAt: string }>();
      for (const x of ss) {
        const f = files.get(x.path) ?? { path: x.path, inserted: 0, deleted: 0, wsInserted: 0, wsDeleted: 0, sessions: 0, lastAt: x.endedAt };
        f.inserted += x.inserted;
        f.deleted += x.deleted;
        f.wsInserted += x.wsInserted;
        f.wsDeleted += x.wsDeleted;
        f.sessions++;
        if (x.endedAt > f.lastAt) f.lastAt = x.endedAt;
        files.set(x.path, f);
      }
      // Surviving lines: read from the live documents (files that no longer exist are reported as such).
      const surviving = [...files.keys()].map((path) => {
        try {
          if (readText(root, path) === null && !docs.get(path)) return { path, exists: false, lines: [] as number[], shared: [] as number[] };
          const la = lineAuthors(docs, path);
          return { path, exists: true, lines: la.filter((l) => l.kind !== "shared" && l.authors[0] === id).map((l) => l.line), shared: la.filter((l) => l.kind === "shared" && l.authors.includes(id)).map((l) => l.line) };
        } catch {
          return { path, exists: false, lines: [], shared: [] };
        }
      });
      const a = collab.participants().find((p) => p.memberId === id);
      return json(res, 200, { id, sessions: ss, files: [...files.values()], surviving, now: a ? { path: a.path, at: new Date(a.at).toISOString() } : null });
    }
    if (parts[0] === "reviews") {
      // Line comments pinned to the exact revision (blob hash) of the file they were made on.
      if (method === "GET") {
        requireMember(req, "read");
        const task = str(url.searchParams.get("task"), "task", 64);
        const path = url.searchParams.get("path");
        const current = (p: string) => reviewBlob(task, p);
        const rows = relay.db.prepare(`SELECT * FROM review_comments WHERE task_id = ? ${path ? "AND path = ?" : ""} ORDER BY created_at`).all(...(path ? [task, path] : [task])) as Record<string, string | number>[];
        return json(res, 200, { comments: rows.map((r) => ({ id: r.id, path: r.path, line: r.line, body: r.body, author: r.author, revision: r.revision, createdAt: r.created_at, resolved: !!r.resolved_at, outdated: current(String(r.path)) !== r.revision })) });
      }
      if (method === "POST" && parts.length === 1) {
        const m = requireMember(req, "edit");
        const b = await readBody(req);
        const task = relay.requireTask(str(b.task, "task", 64)).id;
        const path = resolveProjectPath(root, str(b.path, "path", 512));
        const line = Number(b.line);
        if (!Number.isInteger(line) || line < 1) throw new HttpError(400, "invalid", "line must be a positive integer");
        const id = randomUUID();
        const revision = reviewBlob(task, path);
        relay.db.prepare("INSERT INTO review_comments (id, task_id, path, line, body, author, revision, created_at) VALUES (?,?,?,?,?,?,?,?)").run(id, task, path, line, str(b.body, "body", 5000), m.name, revision, new Date().toISOString());
        relay.record("review.commented", actorFor(m), { path, line, revision: revision.slice(0, 12) }, task);
        return json(res, 201, { id, revision });
      }
      if (method === "POST" && parts[2] === "resolve") {
        const m = requireMember(req, "edit");
        relay.db.prepare("UPDATE review_comments SET resolved_at = ? WHERE id = ?").run(new Date().toISOString(), parts[1] ?? "");
        relay.record("review.resolved", actorFor(m), { comment: parts[1] });
        return json(res, 200, {});
      }
    }
    if (parts[0] === "conflicts" && parts[1]) {
      // An outside edit that couldn't be merged automatically: both sides, and an explicit decision.
      if (method === "GET") {
        requireMember(req, "read");
        const c = docs.conflict(parts[1]);
        if (!c) throw new HttpError(404, "not_found", "No such conflict");
        return json(res, 200, { ...c, current: docs.get(c.path)?.text.toString() ?? readText(root, c.path) ?? "" });
      }
      if (method === "POST" && parts[2] === "resolve") {
        const m = requireMember(req, "edit");
        const b = await readBody(req);
        const take = b.take === "outside" ? "outside" : b.take === "shared" ? "shared" : null;
        if (!take) throw new HttpError(400, "invalid", 'take must be "shared" or "outside"');
        const { path } = docs.resolveConflict(parts[1], take);
        relay.record("doc.conflict_resolved", actorFor(m), { path, conflictId: parts[1], kept: take });
        return json(res, 200, { path, kept: take });
      }
    }
    if (parts[0] === "tests") {
      if (method === "GET") {
        requireMember(req, "read");
        docs.flushAll();
        return json(res, 200, { discover: tests.discover(listProjectFiles(root)), latest: tests.latest() });
      }
      if (method === "POST" && parts[1] === "run") {
        // Tests execute project code on this machine: owners only, like verification commands.
        const m = requireMember(req, "approve");
        const b = await readBody(req);
        docs.flushAll();
        const run = tests.start({ files: strList(b.files, "files"), names: strList(b.names, "names"), by: m.name, projectFiles: listProjectFiles(root) });
        relay.record("tests.started", actorFor(m), { runId: run.id, command: run.command });
        return json(res, 202, run);
      }
      if (method === "POST" && parts[1] === "stop") {
        const m = requireMember(req, "approve");
        const stopped = tests.stop();
        if (stopped) relay.record("tests.stopped", actorFor(m), {});
        return json(res, 200, { stopped });
      }
    }
    if (method === "GET" && parts[0] === "diagnostics") {
      // Syntax errors from the TypeScript parser (JS/TS) or JSON.parse, on the shared document's current text.
      requireMember(req, "read");
      const path = resolveProjectPath(root, str(url.searchParams.get("path"), "path", 512));
      const text = docs.get(path)?.text.toString() ?? readText(root, path) ?? "";
      return json(res, 200, { path, problems: syntaxProblems(path, text) });
    }
    if (method === "GET" && parts[0] === "attribution" && parts[1] === "line") {
      requireMember(req, "read");
      const path = resolveProjectPath(root, str(url.searchParams.get("path"), "path", 512));
      const line = Number(url.searchParams.get("line"));
      if (!Number.isInteger(line) || line < 1) throw new HttpError(400, "invalid", "line must be a positive integer");
      return json(res, 200, { path, line, origins: lineOrigin(relay.db, docs, path, line) });
    }
    if (method === "GET" && parts[0] === "sessions" && parts[1] && parts[2] === "sides") {
      requireMember(req, "read");
      const sides = sessionSides(relay.db, docs, parts[1]);
      if (!sides) throw new HttpError(404, "not_found", "That edit session is older than the retained history");
      return json(res, 200, { ...sides, beforeLabel: "before the session", afterLabel: `after ${sides.author}'s edits` });
    }
    if (method === "GET" && parts[0] === "attribution") {
      requireMember(req, "read");
      const path = resolveProjectPath(root, str(url.searchParams.get("path"), "path", 512));
      return json(res, 200, { path, lines: lineAuthors(docs, path) });
    }
    if (method === "GET" && parts[0] === "sessions" && parts[1] && parts[2] === "diff") {
      requireMember(req, "read");
      const d = sessionDiff(relay.db, docs, parts[1]);
      if (!d) throw new HttpError(404, "not_found", "No such edit session");
      return json(res, 200, d);
    }
    if (method === "GET" && parts[0] === "history") {
      requireMember(req, "read");
      const path = resolveProjectPath(root, str(url.searchParams.get("path"), "path", 512));
      const seq = url.searchParams.get("seq");
      if (seq !== null) {
        const text = docs.textAt(path, Number(seq));
        if (text === null) throw new HttpError(404, "not_found", "That revision is older than the retained history");
        return json(res, 200, { path, seq: Number(seq), text });
      }
      return json(res, 200, { path, sessions: editSessions(relay.db, { path, limit: 200 }) });
    }
    if (method === "POST" && parts[0] === "members" && parts[2] === "revoke") {
      // Revocation is immediate: sessions, invites, open documents, the event feed and terminals all end now.
      const m = requireMember(req, "admin");
      const id = decodeURIComponent(parts[1] ?? "");
      if (!members.get(id)) throw new HttpError(404, "not_found", "No such member");
      if (id === m.id) throw new HttpError(400, "invalid", "You can't revoke yourself");
      members.revoke(id);
      collab.disconnectMember(id);
      for (const [ws, mid] of eventMembers) if (mid === id) ws.close(4401, "access revoked");
      const terminalsClosed = terminals.killMember(id);
      relay.record("member.revoked", actorFor(m), { member: id, terminalsClosed });
      return json(res, 200, { revoked: id, terminalsClosed });
    }
    if (method === "GET" && parts[0] === "impact") {
      // The live dependency map: changed interfaces, consumers, tests, affected tasks, stale verification.
      requireMember(req, "read");
      docs.flushAll();
      const task = url.searchParams.get("task") ?? undefined;
      const base = url.searchParams.get("base") ?? undefined;
      if (base && !/^[\w./~^@-]{1,100}$/.test(base)) throw new HttpError(400, "invalid", "Invalid base revision");
      return json(res, 200, impact.compute({ base, taskId: task }));
    }
    if (parts[0] === "github") {
      if (method === "GET" && parts.length === 1) {
        requireMember(req, "read");
        docs.flushAll();
        const status = await github.status();
        return json(res, 200, { ...status, checks: github.checks(preflight(), status.connected) });
      }
      if (method === "POST" && parts[1] === "refresh") {
        requireMember(req, "approve");
        github.refresh();
        return json(res, 200, {});
      }
      if (method === "POST" && parts[1] === "ship") {
        // Publishing to GitHub is consequential: owners only, through Relay's ship gate.
        const m = requireMember(req, "approve");
        const b = await readBody(req);
        docs.flushAll();
        const shipped = await github.ship({ title: str(b.title, "title", 200).trim(), body: typeof b.body === "string" ? b.body.slice(0, 20000) : undefined, by: m }, preflight());
        relay.record("github.shipped", actorFor(m), { pr: shipped.pr.number, url: shipped.pr.url, files: shipped.files.length, leftOut: shipped.secrets });
        if (b.merge !== true) return json(res, 201, shipped);
        // The pull request exists either way; a refused merge (branch protection, required checks) is reported, not thrown.
        try {
          const merged = await github.merge({ number: shipped.pr.number, method: b.method as MergeMethod | undefined });
          relay.record("github.merged", actorFor(m), { pr: merged.pr.number, sha: merged.sha, method: merged.method });
          return json(res, 201, { ...shipped, merged });
        } catch (e) {
          return json(res, 201, { ...shipped, mergeError: (e as Error).message });
        }
      }
      if (method === "POST" && parts[1] === "merge") {
        const m = requireMember(req, "approve");
        const b = await readBody(req);
        const merged = await github.merge({ number: typeof b.number === "number" ? b.number : undefined, method: b.method as MergeMethod | undefined });
        relay.record("github.merged", actorFor(m), { pr: merged.pr.number, sha: merged.sha, method: merged.method });
        return json(res, 200, merged);
      }
    }
    if (method === "POST" && parts[0] === "files" && parts[1] === "rename") {
      const m = requireMember(req, "edit");
      const b = await readBody(req);
      const from = resolveProjectPath(root, str(b.from, "from", 512));
      const to = resolveProjectPath(root, str(b.to, "to", 512));
      const fromAbs = join(root, from);
      const st = statSync(fromAbs, { throwIfNoEntry: false });
      if (!st) throw new HttpError(404, "not_found", `${from} doesn't exist`);
      // A case-only rename (a.js -> A.js) on a case-insensitive disk finds "to" already there: it's the same file.
      const toSt = statSync(join(root, to), { throwIfNoEntry: false });
      if (to === from || (toSt && toSt.ino !== st.ino)) throw new HttpError(409, "conflict", `${to} already exists`);
      if (to.startsWith(`${from}/`)) throw new HttpError(400, "invalid", "A folder can't be moved inside itself");
      // Every shared file under the old path: written out, its editors closed, its history carried to the new name.
      const moved = st.isDirectory() ? listProjectFiles(root).filter((p) => p.startsWith(`${from}/`)) : [from];
      const pairs = moved.map((p) => ({ from: p, to: to + p.slice(from.length) }));
      for (const p of pairs) {
        const e = docs.get(p.from);
        if (e) docs.flush(e);
        collab.closeDocument(p.from, `moved:${p.to}`);
        docs.unload(p.from);
      }
      mkdirSync(dirname(join(root, to)), { recursive: true });
      renameSync(fromAbs, join(root, to));
      for (const p of pairs) {
        docs.moveHistory(p.to, `replaced:${Date.now()}:${DocStore.docName(p.to)}`);
        docs.moveHistory(p.from, DocStore.docName(p.to));
      }
      relay.record("file.renamed", actorFor(m), { from, to, files: pairs });
      return json(res, 200, { from, to, files: pairs });
    }
    if (method === "POST" && parts[0] === "files" && parts[1] === "delete") {
      const m = requireMember(req, "edit");
      const b = await readBody(req);
      const path = resolveProjectPath(root, str(b.path, "path", 512));
      const abs = join(root, path);
      const st = statSync(abs, { throwIfNoEntry: false });
      if (!st) throw new HttpError(404, "not_found", `${path} doesn't exist`);
      const removed = st.isDirectory() ? listProjectFiles(root).filter((p) => p.startsWith(`${path}/`)) : [path];
      // What the server had last, per file: a client whose copy differs (keys still in flight, or typed offline) knows
      // it holds text nobody else has and can keep it, instead of losing it silently.
      const finalHash: Record<string, string> = {};
      for (const p of removed) {
        const text = docs.get(p)?.text.toString() ?? (() => {
          try {
            return readText(root, p);
          } catch {
            return null;
          }
        })();
        if (text !== null) finalHash[p] = textFingerprint(text);
      }
      for (const p of removed) {
        collab.closeDocument(p, "deleted");
        docs.unload(p);
        // History is kept, out of the way: a new file at this path starts empty instead of reviving the old one.
        docs.moveHistory(p, `deleted:${Date.now()}:${DocStore.docName(p)}`);
      }
      rmSync(abs, { recursive: st.isDirectory() });
      relay.record("file.deleted", actorFor(m), { path, files: removed, finalHash });
      return json(res, 200, { path, files: removed });
    }
    if (method === "POST" && parts[0] === "folders") {
      const m = requireMember(req, "edit");
      const b = await readBody(req);
      const path = resolveProjectPath(root, str(b.path, "path", 512));
      if (existsSync(join(root, path))) throw new HttpError(409, "conflict", `${path} already exists`);
      mkdirSync(join(root, path), { recursive: true });
      relay.record("folder.created", actorFor(m), { path });
      return json(res, 201, { path });
    }
    if (method === "POST" && parts[0] === "files") {
      const m = requireMember(req, "edit");
      const body = await readBody(req);
      const path = resolveProjectPath(root, str(body.path, "path", 512));
      if (readText(root, path) !== null) throw new HttpError(409, "conflict", `${path} already exists`);
      // Written now, even though it's empty: an empty document has nothing to flush, and a file that isn't on disk
      // isn't in the file list (or in git) until someone types in it.
      writeAtomic(root, path, "");
      docs.open(path);
      // Optional initial text (e.g. a copy kept after its file was deleted), credited to the person who saved it.
      if (typeof body.content === "string" && body.content) {
        if (Buffer.byteLength(body.content) > 2 * 1024 * 1024) throw new HttpError(413, "too_large", "Initial content is limited to 2 MB");
        docs.applyEdits(path, [{ from: 0, to: 0, insert: body.content }], `member:${m.id}`);
        docs.flush(docs.get(path)!);
      }
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
      if (method === "GET" && parts[2] === "diff") {
        // A task's change to one file: agent work (snapshot vs worktree) or a person's (base vs shared workspace).
        requireMember(req, "read");
        const task = relay.requireTask(id);
        const path = resolveProjectPath(root, str(url.searchParams.get("path"), "path", 512));
        const run = runs.forTask(id).at(-1);
        docs.flushAll();
        if (run && run.status !== "applied") {
          const after = (() => {
            try {
              return readFileSync(join(run.worktree, path), "utf8");
            } catch {
              return "";
            }
          })();
          return json(res, 200, { path, before: showAt(root, run.snapshot, path) ?? "", after, beforeLabel: `snapshot ${run.snapshot.slice(0, 7)}`, afterLabel: `${run.provider} worktree` });
        }
        const base = task.baseCommit ?? "HEAD";
        return json(res, 200, { path, before: showAt(root, base, path) ?? "", after: docs.get(path)?.text.toString() ?? readText(root, path) ?? "", beforeLabel: `base ${base.slice(0, 7)}`, afterLabel: "shared workspace" });
      }
      if (method === "GET" && parts[2] === "change") {
        requireMember(req, "read");
        docs.flushAll();
        return json(res, 200, changeRecord(relay, root, resolve(opts.dbPath), id, { runs: runs.forTask(id), impact: impact.compute({ taskId: relay.requireTask(id).baseCommit ? id : undefined }) }));
      }
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
        // Check what's on disk now: the shared documents are written out first, as for integration checks.
        docs.flushAll();
        const check = relay.diffCheck(id, root);
        const verification = await relay.runVerificationAsync(id, root);
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
        return json(res, 200, await runs.apply(id, m));
      }
    }
    if (parts[0] === "agent" && method === "POST") {
      // The agent composer: every request becomes a scoped Relay task, never an ungoverned chat.
      const m = requireMember(req, "edit");
      const b = await readBody(req);
      const prompt = str(b.prompt, "prompt", 4000).trim();
      const mode = b.mode === "plan" ? "plan" : "agent";
      const scope = [...new Set(strList(b.files, "files").map((f) => resolveProjectPath(root, f)))];
      if (!scope.length) throw new HttpError(400, "invalid", "Mention at least one file with @ so Relay knows what the agent may change.");
      const contracts: Record<string, number> = {};
      for (const c of strList(b.contracts, "contracts")) {
        const cur = relay.currentContract(c);
        if (!cur) throw new HttpError(400, "invalid", `Contract ${c} has no accepted version`);
        contracts[c] = cur.version;
      }
      let id = "";
      do id = `A-${Math.random().toString(36).slice(2, 6)}`;
      while (relay.getTask(id));
      const task = relay.createTask({ id, objective: prompt, scope, contracts, owner: m.id, baseCommit: resolveCommit(root) }, actorFor(m));
      if (mode === "plan") return json(res, 201, { task, runs: [], note: "Planned. Nothing runs until it is approved and started." });
      if (!can(m.role, "approve")) return json(res, 201, { task, runs: [], note: "Created as a proposal. A project owner approves it before an agent can start." });
      relay.transition(id, "queued", actorFor(m), { reason: "approved from the agent composer" });
      return json(res, 202, { task: relay.requireTask(id), runs: await runs.start(id, m), note: "Claude Code is working in its own worktree." });
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
        const ids = [...new Set(strList(b.tasks, "tasks"))];
        if (!ids.length) throw new HttpError(400, "invalid", "Name the tasks to check together");
        for (const id of ids) relay.requireTask(id);
        // Agent tasks are checked in a combined worktree of their changes; human tasks in the shared workspace. A mix
        // can't be built into one change yet, so it is refused rather than checked without the agents' work.
        const agent = ids.filter((id) => runs.hasRuns(id));
        if (agent.length && agent.length < ids.length) throw new HttpError(409, "invalid", `${agent.join(", ")} ${agent.length === 1 ? "has" : "have"} agent work in a worktree and ${ids.filter((id) => !agent.includes(id)).join(", ")} ${ids.length - agent.length === 1 ? "doesn't" : "don't"}; Relay can't combine the two into one check yet`);
        let integ;
        if (agent.length) integ = await runs.checkTogether(ids, extra);
        else {
          docs.flushAll();
          integ = await relay.checkIntegrationAsync(ids, root, extra);
        }
        return json(res, 200, { ...integ, report: integrationReport(integ) });
      }
      if (parts[2] === "approve") {
        const m = requireMember(req, "approve");
        const id = parts[1] ?? "";
        if (runs.hasCombined(id)) {
          const r = runs.approveTogether(id, m);
          return json(res, 200, { ...r, report: integrationReport(relay.getIntegration(id)!) });
        }
        docs.flushAll();
        const integ = relay.approveIntegration(id, actorFor(m), root);
        return json(res, 200, { integration: integ, applied: [], conflicts: [], skipped: [], report: integrationReport(integ) });
      }
    }
    if (method === "GET" && parts[0] === "integrations" && parts[1]) {
      requireMember(req, "read");
      const integ = relay.getIntegration(parts[1]);
      if (!integ) throw new HttpError(404, "not_found", "No such integration");
      return json(res, 200, { ...integ, report: integrationReport(integ) });
    }
    if (parts[0] === "members" && method === "POST") {
      requireMember(req, "admin");
      const b = await readBody(req);
      const { member, token } = members.invite(str(b.name, "name", 40), (str(b.role, "role", 10) as "owner" | "editor" | "viewer"));
      return json(res, 201, { member, joinPath: `/join#${token}` });
    }
    throw new HttpError(404, "not_found", "No such endpoint");
  }

  /** The VS Code extension, if it has been packaged (`cd vscode && npm run package`). Public: invitees aren't signed in yet. */
  function serveVsix(res: ServerResponse): void {
    const file = vsixPath();
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain", ...SECURITY_HEADERS });
      res.end(VSIX_MISSING);
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${basename(file)}"`, "cache-control": "no-cache", ...SECURITY_HEADERS });
    res.end(readFileSync(file));
  }

  const staticRoot = opts.staticDir ? resolve(opts.staticDir) : undefined;
  function serveStatic(res: ServerResponse, pathname: string): void {
    const dir = staticRoot;
    if (!dir || !existsSync(dir)) {
      res.writeHead(404, { "content-type": "text/plain", ...SECURITY_HEADERS });
      res.end("Relay server is running. The IDE has not been built (cd ide/web && npm run build).");
      return;
    }
    const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(dir, clean);
    if (!file.startsWith(dir)) file = join(dir, "index.html");
    // Next's export has both `join.html` and a `join/` folder of payloads: the page wins.
    if (existsSync(file + ".html") && (!existsSync(file) || statSync(file).isDirectory())) file += ".html";
    else if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) file = join(dir, "index.html");
    const immutable = file.includes(`${"_next"}/static`);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache", ...SECURITY_HEADERS });
    res.end(readFileSync(file));
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://relay.local");
    if (url.pathname === "/downloads/relay-vscode.vsix") return serveVsix(res);
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
  const eventMembers = new Map<WebSocket, string>();
  let lastSeq = relay.events().at(-1)?.seq ?? 0;
  const pump = () => {
    const fresh = relay.eventsSince(lastSeq);
    if (!fresh.length) return;
    lastSeq = fresh.at(-1)!.seq;
    const msg = JSON.stringify({ type: "events", events: fresh });
    for (const ws of eventClients) if (ws.readyState === ws.OPEN && ws.bufferedAmount < 1 << 20) ws.send(msg);
  };
  // Presence (ephemeral, never stored): who is online, where, and whether they're typing. Throttled to 4 per second.
  let presenceTimer: NodeJS.Timeout | null = null;
  const pushPresence = () => {
    if (presenceTimer) return;
    presenceTimer = setTimeout(() => {
      presenceTimer = null;
      const msg = JSON.stringify({ type: "presence", online: [...new Set(eventMembers.values())], participants: collab.participants().map((a) => ({ ...a, typing: !!a.typedAt && Date.now() - a.typedAt < 3000 })) });
      for (const ws of eventClients) if (ws.readyState === ws.OPEN && ws.bufferedAmount < 1 << 20) ws.send(msg);
    }, 250);
  };
  collab.onPresence = pushPresence;
  let testsTimer: NodeJS.Timeout | null = null;
  const pushTests = () => {
    if (testsTimer) return;
    testsTimer = setTimeout(() => {
      testsTimer = null;
      const r = tests.latest();
      if (!r) return;
      const msg = JSON.stringify({ type: "tests", run: { ...r, output: r.output.slice(-20_000) } });
      for (const ws of eventClients) if (ws.readyState === ws.OPEN && ws.bufferedAmount < 1 << 20) ws.send(msg);
    }, 200);
  };
  // This process's own events are pushed at once; the poll picks up events from hooks, MCP servers and the CLI.
  relay.onEvent = pump;
  const feed = setInterval(pump, 200);

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
      if (url.pathname === "/terminal") {
        const sessionId = url.searchParams.get("session");
        const cols = Number(url.searchParams.get("cols") ?? 80);
        const rows = Number(url.searchParams.get("rows") ?? 24);
        return wss.handleUpgrade(req, socket, head, (ws) => {
          terminals.attach(ws, member, sessionId || null, cols, rows).catch((err: Error) => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "error", message: err.message }));
            ws.close(4403, "terminal unavailable");
          });
        });
      }
      if (url.pathname === "/events") {
        return wss.handleUpgrade(req, socket, head, (ws) => {
          // A reconnecting client says the last event it saw; it gets what it missed first, so a rename or delete
          // that happened while it was away still reaches its open editors.
          const since = Number(url.searchParams.get("since"));
          if (Number.isInteger(since) && since > 0) {
            const missed = relay.eventsSince(since);
            if (missed.length) ws.send(JSON.stringify({ type: "events", events: missed }));
          }
          ws.send(JSON.stringify({ type: "hello", seq: (relay.db.prepare("SELECT MAX(seq) AS s FROM events").get() as { s: number | null }).s ?? 0 }));
          eventClients.add(ws);
          eventMembers.set(ws, member.id);
          ws.on("close", () => (eventClients.delete(ws), eventMembers.delete(ws), pushPresence()));
          pushPresence();
        });
      }
      const m = /^\/collab\/(.+)$/.exec(url.pathname);
      if (!m) return reject(404, "Not Found");
      const name = decodeURIComponent(m[1]!);
      if (!name.startsWith("file:")) return reject(400, "Bad Request");
      const path = resolveProjectPath(root, name.slice(5));
      // binary / too-large files are refused before joining; a renamed or deleted file is told so and never recreated
      // by a client that still has it open.
      const gone = readText(root, path) === null && !docs.get(path);
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (gone) return ws.close(4410, "deleted");
        (ws as unknown as { __member: string }).__member = member.name;
        collab.attach(ws, path, member, { ack: url.searchParams.get("ack") === "1" });
      });
    } catch (err) {
      reject(err instanceof RelayError && err.code === "forbidden" ? 403 : 400, "Bad Request");
    }
  });

  await new Promise<void>((ok) => server.listen(opts.port ?? 4747, host, ok));
  const port = (server.address() as { port: number }).port;

  return {
    url: `http://${host}:${port}`,
    port,
    relay,
    members,
    docs,
    collab,
    runs,
    terminals,
    github,
    impact,
    records,
    async close() {
      clearInterval(feed);
      if (presenceTimer) clearTimeout(presenceTimer);
      if (testsTimer) clearTimeout(testsTimer);
      tests.close();
      docs.closeSessions();
      relay.onEvent = null;
      terminals.close();
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
