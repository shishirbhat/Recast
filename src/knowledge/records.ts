import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tx } from "../core/db.ts";
import { inScope } from "../core/conflicts.ts";
import { verificationEnv } from "../core/engine.ts";
import type { Relay } from "../core/engine.ts";
import { RelayError } from "../core/types.ts";
import type { Task } from "../core/types.ts";
import type { DependencyGraph } from "../analysis/depgraph.ts";
import { isSecretPath } from "../server/files.ts";
import { sanitize } from "./sanitize.ts";

/**
 * Shared engineering records: investigations (a bug being worked on by several people and agents) and decisions
 * (what was decided, why, what was rejected). Both are built from sourced statements:
 * - a source is something anyone can open: a file (pinned to its content), a commit, a test, a Relay evidence record,
 *   a contract version, or another decision;
 * - a "finding" or a "confirmed" hypothesis must cite at least one checkable source; anything else is an assumption;
 * - pasted text is sanitized (credentials, machine paths) before it is stored or shown;
 * - nothing here is ever turned into instructions automatically. Agents only receive accepted decisions, as reference data.
 */

export type SourceType = "file" | "commit" | "test" | "evidence" | "contract" | "decision" | "url";
export interface Source {
  type: SourceType;
  ref: string;
  /** Pinned at the time it was cited: blob hash for files/tests, full sha for commits, exit code for evidence. */
  pin?: string;
}
export interface SourceStatus extends Source {
  state: "current" | "changed" | "missing" | "unchecked";
  detail?: string;
}

export type EntryKind = "repro" | "failing_test" | "log" | "file" | "hypothesis" | "experiment" | "finding" | "assumption" | "attempt" | "next_step" | "note" | "command";
export const ENTRY_KINDS: EntryKind[] = ["repro", "failing_test", "log", "file", "hypothesis", "experiment", "finding", "assumption", "attempt", "next_step", "note", "command"];

export interface InvestigationEntry {
  id: string;
  investigationId: string;
  kind: EntryKind;
  body: string;
  /** hypothesis: open | confirmed | refuted. attempt: worked | failed. next_step: open | done. */
  status: string | null;
  sources: Source[];
  /** true only when Relay itself produced the content (a command it ran) or it cites checkable sources. */
  verified: boolean;
  redactions: number;
  revision: string;
  author: string;
  createdAt: string;
}
export interface Investigation {
  id: string;
  title: string;
  description: string;
  status: "open" | "resolved" | "abandoned";
  owner: string;
  revision: string;
  taskId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type DecisionStatus = "proposed" | "accepted" | "rejected" | "superseded" | "invalidated";
export interface Decision {
  id: string;
  title: string;
  context: string;
  decision: string;
  alternatives: { option: string; rejectedBecause: string }[];
  scope: string[];
  contracts: string[];
  kind: "decision" | "hazard" | "constraint" | "question";
  sources: Source[];
  status: DecisionStatus;
  supersedes: string | null;
  supersededBy: string | null;
  statusReason: string | null;
  createdBy: string;
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
}

const VERIFIABLE: SourceType[] = ["file", "commit", "test", "evidence", "contract", "decision"];
const now = () => new Date().toISOString();

export class Records {
  private relay: Relay;
  private root: string;

  constructor(relay: Relay, root: string) {
    this.relay = relay;
    this.root = root;
    relay.db.exec(`
      CREATE TABLE IF NOT EXISTS investigations (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL, owner TEXT NOT NULL,
        revision TEXT NOT NULL, task_id TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS investigation_entries (
        id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, status TEXT,
        sources TEXT NOT NULL, verified INTEGER NOT NULL, redactions INTEGER NOT NULL, revision TEXT NOT NULL,
        author TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS investigation_entries_by_inv ON investigation_entries (investigation_id, created_at);
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, context TEXT NOT NULL, decision TEXT NOT NULL, alternatives TEXT NOT NULL,
        scope TEXT NOT NULL, contracts TEXT NOT NULL, kind TEXT NOT NULL, sources TEXT NOT NULL, status TEXT NOT NULL,
        supersedes TEXT, superseded_by TEXT, status_reason TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
        decided_by TEXT, decided_at TEXT
      );
    `);
  }

  private head(): string {
    try {
      const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: this.root, encoding: "utf8" }).trim();
      const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: this.root, encoding: "utf8" }).trim();
      return dirty ? `${sha}+dirty` : sha;
    } catch {
      return "unknown";
    }
  }

  private blob(path: string): string | null {
    const abs = join(this.root, path);
    if (!existsSync(abs)) return null;
    return execFileSync("git", ["hash-object", "--", abs], { cwd: this.root, encoding: "utf8" }).trim();
  }

  /** Check a cited source exists and pin it, so later readers can tell whether it still says the same thing. */
  private pin(s: Source): Source {
    if (!s || typeof s.ref !== "string" || !s.ref.trim() || s.ref.length > 500) throw new RelayError("invalid", "Each source needs a type and a ref");
    const ref = s.ref.trim();
    switch (s.type) {
      case "file":
      case "test": {
        const path = ref.replace(/:\d+(-\d+)?$/, "");
        if (path.includes("..") || path.startsWith("/")) throw new RelayError("invalid", `Source ${ref} must be a project-relative path`);
        if (isSecretPath(path)) throw new RelayError("forbidden", `${path} is a protected path and can't be cited`);
        const b = this.blob(path);
        if (!b) throw new RelayError("invalid", `Source ${ref}: ${path} doesn't exist`);
        return { type: s.type, ref, pin: b };
      }
      case "commit":
        try {
          return { type: "commit", ref, pin: execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: this.root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() };
        } catch {
          throw new RelayError("invalid", `Source ${ref} isn't a commit in this repository`);
        }
      case "evidence": {
        const row = this.relay.db.prepare("SELECT exit_code, source FROM evidence WHERE id = ?").get(ref) as { exit_code: number | null; source: string } | undefined;
        if (!row) throw new RelayError("invalid", `Evidence ${ref} doesn't exist`);
        return { type: "evidence", ref, pin: `${row.source}:exit=${row.exit_code}` };
      }
      case "contract": {
        const [id, v] = ref.split("@");
        if (!id || !v || !this.relay.contractHistory(id).some((c) => c.version === Number(v))) throw new RelayError("invalid", `Contract ${ref} doesn't exist (use id@version)`);
        return { type: "contract", ref };
      }
      case "decision":
        if (!this.getDecision(ref)) throw new RelayError("invalid", `Decision ${ref} doesn't exist`);
        return { type: "decision", ref };
      case "url":
        if (!/^https?:\/\/\S+$/.test(ref)) throw new RelayError("invalid", `Source ${ref} isn't a URL`);
        return { type: "url", ref };
      default:
        throw new RelayError("invalid", `Unknown source type ${(s as Source).type}`);
    }
  }

  /** Is each source still what it was when cited? */
  checkSources(sources: Source[]): SourceStatus[] {
    return sources.map((s) => {
      if (s.type === "file" || s.type === "test") {
        const b = this.blob(s.ref.replace(/:\d+(-\d+)?$/, ""));
        if (!b) return { ...s, state: "missing" as const, detail: "file no longer exists" };
        return b === s.pin ? { ...s, state: "current" as const } : { ...s, state: "changed" as const, detail: "file changed since it was cited" };
      }
      if (s.type === "contract") {
        const [id, v] = s.ref.split("@");
        const cur = this.relay.currentContract(id!);
        return cur && cur.version !== Number(v) ? { ...s, state: "changed" as const, detail: `accepted version is now v${cur.version}` } : { ...s, state: "current" as const };
      }
      if (s.type === "decision") {
        const d = this.getDecision(s.ref);
        return !d ? { ...s, state: "missing" as const } : d.status === "accepted" ? { ...s, state: "current" as const } : { ...s, state: "changed" as const, detail: `decision is ${d.status}` };
      }
      if (s.type === "url") return { ...s, state: "unchecked" as const };
      return { ...s, state: "current" as const };
    });
  }

  /* ---------------------------------------- investigations ---------------------------------------- */

  createInvestigation(input: { title: string; description: string; taskId?: string; owner?: string }, by: string): Investigation {
    if (input.taskId) this.relay.requireTask(input.taskId);
    const inv: Investigation = { id: `INV-${randomUUID().slice(0, 6)}`, title: sanitize(input.title, this.root).text.slice(0, 200), description: sanitize(input.description, this.root).text, status: "open", owner: input.owner ?? by, revision: this.head(), taskId: input.taskId ?? null, createdBy: by, createdAt: now(), updatedAt: now() };
    this.relay.db.prepare("INSERT INTO investigations VALUES (?,?,?,?,?,?,?,?,?,?)").run(inv.id, inv.title, inv.description, inv.status, inv.owner, inv.revision, inv.taskId, inv.createdBy, inv.createdAt, inv.updatedAt);
    this.relay.record("investigation.created", by, { id: inv.id, title: inv.title, revision: inv.revision }, inv.taskId);
    return inv;
  }

  private requireInvestigation(id: string): Investigation {
    const r = this.relay.db.prepare("SELECT * FROM investigations WHERE id = ?").get(id) as Record<string, string | null> | undefined;
    if (!r) throw new RelayError("not_found", `Unknown investigation ${id}`);
    return { id: r.id!, title: r.title!, description: r.description!, status: r.status as Investigation["status"], owner: r.owner!, revision: r.revision!, taskId: r.task_id ?? null, createdBy: r.created_by!, createdAt: r.created_at!, updatedAt: r.updated_at! };
  }

  listInvestigations(): (Investigation & { entries: number })[] {
    return (this.relay.db.prepare("SELECT id FROM investigations ORDER BY updated_at DESC").all() as { id: string }[]).map(({ id }) => ({ ...this.requireInvestigation(id), entries: (this.relay.db.prepare("SELECT COUNT(*) AS n FROM investigation_entries WHERE investigation_id = ?").get(id) as { n: number }).n }));
  }

  getInvestigation(id: string): { investigation: Investigation; entries: (InvestigationEntry & { sourceStatus: SourceStatus[] })[] } {
    const investigation = this.requireInvestigation(id);
    const rows = this.relay.db.prepare("SELECT * FROM investigation_entries WHERE investigation_id = ? ORDER BY created_at, rowid").all(id) as Record<string, unknown>[];
    const entries = rows.map((r) => {
      const e: InvestigationEntry = { id: r.id as string, investigationId: id, kind: r.kind as EntryKind, body: r.body as string, status: (r.status as string) ?? null, sources: JSON.parse(r.sources as string), verified: r.verified === 1, redactions: r.redactions as number, revision: r.revision as string, author: r.author as string, createdAt: r.created_at as string };
      return { ...e, sourceStatus: this.checkSources(e.sources) };
    });
    return { investigation, entries };
  }

  addEntry(id: string, input: { kind: EntryKind; body: string; sources?: Source[]; status?: string }, by: string): InvestigationEntry {
    const inv = this.requireInvestigation(id);
    if (!ENTRY_KINDS.includes(input.kind) || input.kind === "command") throw new RelayError("invalid", `Entry kind must be one of ${ENTRY_KINDS.filter((k) => k !== "command").join(", ")}`);
    const sources = (input.sources ?? []).slice(0, 20).map((s) => this.pin(s));
    const checkable = sources.some((s) => VERIFIABLE.includes(s.type));
    const status = input.kind === "hypothesis" ? (input.status ?? "open") : input.kind === "attempt" ? (input.status ?? null) : input.kind === "next_step" ? (input.status ?? "open") : null;
    if (input.kind === "hypothesis" && !["open", "confirmed", "refuted"].includes(status!)) throw new RelayError("invalid", "A hypothesis is open, confirmed or refuted");
    if ((input.kind === "finding" || status === "confirmed" || status === "refuted") && !checkable)
      throw new RelayError("invalid", "A finding (or a confirmed/refuted hypothesis) must cite a file, test, commit, evidence or contract. Without one, record it as an assumption.");
    const clean = sanitize(input.body, this.root);
    if (!clean.text.trim()) throw new RelayError("invalid", "Entry body is empty");
    const e: InvestigationEntry = { id: randomUUID(), investigationId: id, kind: input.kind, body: clean.text.slice(0, 50_000), status, sources, verified: checkable && input.kind !== "assumption", redactions: clean.redactions, revision: this.head(), author: by, createdAt: now() };
    this.insertEntry(e);
    this.relay.record("investigation.entry", by, { id, kind: e.kind, entry: e.id, redactions: e.redactions }, inv.taskId);
    return e;
  }

  /** Relay runs a command (owners only, checked by the caller) and records its real output and exit code. */
  runCommand(id: string, command: string, by: string, timeoutMs = 120_000): InvestigationEntry {
    const inv = this.requireInvestigation(id);
    const r = spawnSync(command, { cwd: this.root, shell: true, encoding: "utf8", timeout: timeoutMs, env: verificationEnv(), maxBuffer: 8 * 1024 * 1024 });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-20_000);
    const clean = sanitize(`$ ${command}\n${output}\n[exit ${r.status ?? (r.error ? "timeout" : "signal")}]`, this.root);
    const e: InvestigationEntry = { id: randomUUID(), investigationId: id, kind: "command", body: clean.text, status: r.status === 0 ? "passed" : "failed", sources: [], verified: true, redactions: clean.redactions, revision: this.head(), author: `relay (run by ${by})`, createdAt: now() };
    this.insertEntry(e);
    this.relay.record("investigation.command", by, { id, command, exitCode: r.status, entry: e.id }, inv.taskId);
    return e;
  }

  private insertEntry(e: InvestigationEntry): void {
    tx(this.relay.db, () => {
      this.relay.db.prepare("INSERT INTO investigation_entries VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(e.id, e.investigationId, e.kind, e.body, e.status, JSON.stringify(e.sources), e.verified ? 1 : 0, e.redactions, e.revision, e.author, e.createdAt);
      this.relay.db.prepare("UPDATE investigations SET updated_at = ? WHERE id = ?").run(e.createdAt, e.investigationId);
    });
  }

  updateInvestigation(id: string, patch: { status?: Investigation["status"]; owner?: string }, by: string): Investigation {
    const inv = this.requireInvestigation(id);
    if (patch.status && !["open", "resolved", "abandoned"].includes(patch.status)) throw new RelayError("invalid", "Status is open, resolved or abandoned");
    if (patch.status === "resolved" && !this.getInvestigation(id).entries.some((e) => (e.kind === "finding" || (e.kind === "attempt" && e.status === "worked")) && e.verified))
      throw new RelayError("blocked", "Resolve with at least one sourced finding or a worked attempt that cites evidence");
    this.relay.db.prepare("UPDATE investigations SET status = ?, owner = ?, updated_at = ? WHERE id = ?").run(patch.status ?? inv.status, patch.owner ?? inv.owner, now(), id);
    this.relay.record("investigation.updated", by, { id, ...patch }, inv.taskId);
    return this.requireInvestigation(id);
  }

  /* ---------------------------------------- decisions ---------------------------------------- */

  private toDecision(r: Record<string, unknown>): Decision {
    return {
      id: r.id as string, title: r.title as string, context: r.context as string, decision: r.decision as string, alternatives: JSON.parse(r.alternatives as string),
      scope: JSON.parse(r.scope as string), contracts: JSON.parse(r.contracts as string), kind: r.kind as Decision["kind"], sources: JSON.parse(r.sources as string),
      status: r.status as DecisionStatus, supersedes: (r.supersedes as string) ?? null, supersededBy: (r.superseded_by as string) ?? null, statusReason: (r.status_reason as string) ?? null,
      createdBy: r.created_by as string, createdAt: r.created_at as string, decidedBy: (r.decided_by as string) ?? null, decidedAt: (r.decided_at as string) ?? null,
    };
  }
  getDecision(id: string): Decision | undefined {
    const r = this.relay.db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? this.toDecision(r) : undefined;
  }
  listDecisions(): (Decision & { sourceStatus: SourceStatus[] })[] {
    return (this.relay.db.prepare("SELECT * FROM decisions ORDER BY created_at DESC").all() as Record<string, unknown>[]).map((r) => {
      const d = this.toDecision(r);
      return { ...d, sourceStatus: this.checkSources(d.sources) };
    });
  }

  proposeDecision(input: { title: string; context: string; decision: string; alternatives?: { option: string; rejectedBecause: string }[]; scope?: string[]; contracts?: string[]; kind?: Decision["kind"]; sources: Source[]; supersedes?: string }, by: string): Decision {
    const sources = input.sources.slice(0, 30).map((s) => this.pin(s));
    if (!sources.some((s) => VERIFIABLE.includes(s.type))) throw new RelayError("invalid", "A decision record must cite at least one file, commit, test, evidence, contract or decision");
    if (input.supersedes) {
      const old = this.getDecision(input.supersedes);
      if (!old) throw new RelayError("not_found", `Unknown decision ${input.supersedes}`);
      if (old.status !== "accepted") throw new RelayError("illegal_transition", `${old.id} is ${old.status}; only an accepted decision can be superseded`);
    }
    for (const c of input.contracts ?? []) if (!this.relay.currentContract(c)) throw new RelayError("invalid", `Contract ${c} has no accepted version`);
    const s = (x: string) => sanitize(x, this.root).text;
    const d: Decision = {
      id: `DR-${randomUUID().slice(0, 6)}`, title: s(input.title).slice(0, 200), context: s(input.context), decision: s(input.decision),
      alternatives: (input.alternatives ?? []).slice(0, 20).map((a) => ({ option: s(a.option), rejectedBecause: s(a.rejectedBecause) })),
      scope: input.scope ?? [], contracts: input.contracts ?? [], kind: input.kind ?? "decision", sources, status: "proposed",
      supersedes: input.supersedes ?? null, supersededBy: null, statusReason: null, createdBy: by, createdAt: now(), decidedBy: null, decidedAt: null,
    };
    this.relay.db.prepare("INSERT INTO decisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(d.id, d.title, d.context, d.decision, JSON.stringify(d.alternatives), JSON.stringify(d.scope), JSON.stringify(d.contracts), d.kind, JSON.stringify(d.sources), d.status, d.supersedes, null, null, d.createdBy, d.createdAt, null, null);
    this.relay.record("decision.proposed", by, { id: d.id, title: d.title, supersedes: d.supersedes });
    return d;
  }

  /** Accept, reject or invalidate. Owners only (checked by the caller); accepting a replacement supersedes the old record. */
  decide(id: string, to: "accepted" | "rejected" | "invalidated", by: string, reason?: string): Decision {
    return tx(this.relay.db, () => {
      const d = this.getDecision(id);
      if (!d) throw new RelayError("not_found", `Unknown decision ${id}`);
      const ok = (to === "accepted" || to === "rejected") ? d.status === "proposed" : d.status === "accepted";
      if (!ok) throw new RelayError("illegal_transition", `${id} is ${d.status}; can't mark it ${to}`);
      if (to === "invalidated" && !reason?.trim()) throw new RelayError("invalid", "Say why the decision no longer holds");
      this.relay.db.prepare("UPDATE decisions SET status = ?, status_reason = ?, decided_by = ?, decided_at = ? WHERE id = ?").run(to, reason ?? null, by, now(), id);
      if (to === "accepted" && d.supersedes) this.relay.db.prepare("UPDATE decisions SET status = 'superseded', superseded_by = ?, status_reason = ? WHERE id = ?").run(id, `superseded by ${id}`, d.supersedes);
      this.relay.record(`decision.${to}`, by, { id, reason, supersedes: to === "accepted" ? d.supersedes : undefined });
      return this.getDecision(id)!;
    });
  }

  /**
   * The smallest relevant context for a task: accepted decisions that touch its files (directly or through the code it
   * imports), its contracts at their current versions, and anything conflicting or obsolete, each with its sources.
   */
  contextFor(taskId: string, graph?: DependencyGraph): {
    task: Pick<Task, "id" | "objective" | "scope">;
    decisions: (Decision & { why: string[]; sourceStatus: SourceStatus[] })[];
    contracts: { id: string; planned: number; current: number | null; definition: string | null; stale: boolean }[];
    warnings: string[];
    obsolete: { id: string; title: string; status: DecisionStatus; replacement: string | null; why: string[] }[];
  } {
    const task = this.relay.requireTask(taskId);
    // Files the task's code imports (one hop, concrete): decisions about them matter too.
    const imported = new Map<string, string>();
    if (graph)
      for (const m of graph.modules())
        if (inScope(task.scope, m.path)) for (const i of m.imports) if (i.to && !i.to.startsWith("pkg:") && !inScope(task.scope, i.to)) imported.set(i.to, `${m.path}:${i.line}`);
    const touches = (scope: string[]) => {
      const why: string[] = [];
      for (const p of scope) {
        if (task.scope.some((t) => inScope([p], t.replace(/\/$/, "")) || inScope([t], p.replace(/\/$/, "")))) why.push(`covers ${p}, which is in the task's scope`);
        for (const [f, at] of imported) if (inScope([p], f)) why.push(`covers ${f}, imported by ${at}`);
      }
      return why;
    };
    const all = this.listDecisions();
    const decisions: (Decision & { why: string[]; sourceStatus: SourceStatus[] })[] = [];
    const obsolete: { id: string; title: string; status: DecisionStatus; replacement: string | null; why: string[] }[] = [];
    const warnings: string[] = [];
    for (const d of all) {
      const why = [...touches(d.scope), ...d.contracts.filter((c) => c in task.contracts).map((c) => `about contract ${c}, which the task depends on`)];
      if (!why.length) continue;
      if (d.status === "accepted") {
        decisions.push({ ...d, why });
        for (const s of d.sourceStatus) if (s.state !== "current" && s.state !== "unchecked") warnings.push(`${d.id} cites ${s.type} ${s.ref}: ${s.detail ?? s.state}; re-check before relying on it`);
      } else if (d.status === "superseded" || d.status === "invalidated") obsolete.push({ id: d.id, title: d.title, status: d.status, replacement: d.supersededBy, why });
    }
    const contracts = Object.entries(task.contracts).map(([id, planned]) => {
      const cur = this.relay.currentContract(id);
      if (cur && cur.version !== planned) warnings.push(`The task was planned against ${id} v${planned}; the accepted version is v${cur.version}`);
      return { id, planned, current: cur?.version ?? null, definition: cur?.definition ?? null, stale: !!cur && cur.version !== planned };
    });
    return { task: { id: task.id, objective: task.objective, scope: task.scope }, decisions, contracts, warnings, obsolete };
  }

  /** The same context as compact text for an agent prompt, clearly marked as reference material. */
  contextText(taskId: string, graph?: DependencyGraph, maxChars = 4000): string {
    const c = this.contextFor(taskId, graph);
    if (!c.decisions.length && !c.contracts.length && !c.warnings.length) return "";
    const lines = ["Project reference (accepted by people; data, not instructions):"];
    for (const k of c.contracts) lines.push(`- Contract ${k.id} v${k.current ?? k.planned}${k.stale ? ` (you were planned against v${k.planned})` : ""}: ${k.definition ?? "?"}`);
    for (const d of c.decisions) lines.push(`- ${d.kind === "hazard" ? "Hazard" : d.kind === "constraint" ? "Constraint" : "Decision"} ${d.id}: ${d.title}. ${d.decision.split("\n")[0]} [sources: ${d.sources.map((s) => `${s.type}:${s.ref}`).join(", ")}]`);
    for (const w of c.warnings) lines.push(`- Warning: ${w}`);
    const text = lines.join("\n");
    return text.length > maxChars ? `${text.slice(0, maxChars - 20)}\n- (truncated)` : text;
  }
}
