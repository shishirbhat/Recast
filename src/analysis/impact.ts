import type { Relay } from "../core/engine.ts";
import { inScope } from "../core/conflicts.ts";
import type { Task } from "../core/types.ts";
import { changedFiles, relayOwnFiles, resolveCommit, showAt, workspaceFingerprint } from "../git.ts";
import { listProjectFiles } from "../server/files.ts";
import { DependencyGraph } from "./depgraph.ts";
import type { Impact } from "./depgraph.ts";

/**
 * The dependency map joined with Relay's coordination state: which tasks a change affects, through which evidence,
 * and which recorded verification no longer holds.
 *
 * Two kinds of relationship appear here and are never mixed up:
 * - "static": established by parsing source (imports, exports, property reads);
 * - "declared": established by people in Relay (task scope, task contracts).
 */

export interface AffectedTask {
  taskId: string;
  state: Task["state"];
  reasons: { kind: "static" | "declared"; detail: string }[];
}
export interface StaleEvidence {
  taskId: string;
  evidenceId: string;
  kind: string;
  command: string | null;
  recordedAt: string;
  reason: string;
}
export interface ProjectImpact extends Impact {
  head: string;
  tasks: AffectedTask[];
  contracts: { id: string; version: number | null; providers: string[]; consumers: string[] }[];
  stale: StaleEvidence[];
}

const ACTIVE: Task["state"][] = ["proposed", "queued", "running", "review_required", "blocked", "failed"];

export class ImpactService {
  private relay: Relay;
  private root: string;
  private dbPath: string;
  readonly graph: DependencyGraph;

  constructor(relay: Relay, root: string, dbPath: string) {
    this.relay = relay;
    this.root = root;
    this.dbPath = dbPath;
    this.graph = new DependencyGraph(root);
  }

  /** Impact of the workspace relative to `base` (a revision), or relative to a task's base commit. */
  compute(opts: { base?: string; taskId?: string } = {}): ProjectImpact {
    const task = opts.taskId ? this.relay.requireTask(opts.taskId) : null;
    const base = resolveCommit(this.root, opts.base ?? task?.baseCommit ?? "HEAD");
    const own = relayOwnFiles(this.root, this.dbPath);
    this.graph.refresh(listProjectFiles(this.root));
    const changed = changedFiles(this.root, base, own).filter((f) => !own.includes(f));
    const impact = this.graph.impact(base, changed, (p) => showAt(this.root, base, p));

    const changedIfaces = impact.interfaces.filter((i) => i.change !== "added");
    const consumerFiles = new Set(impact.consumers.map((c) => c.file));
    const testFiles = new Set(impact.tests.map((t) => t.file));
    const tasks = this.relay.listTasks().filter((t) => ACTIVE.includes(t.state));
    const affected = new Map<string, AffectedTask>();
    const add = (t: Task, kind: "static" | "declared", detail: string) => {
      const a = affected.get(t.id) ?? { taskId: t.id, state: t.state, reasons: [] };
      if (!a.reasons.some((r) => r.detail === detail)) a.reasons.push({ kind, detail });
      affected.set(t.id, a);
    };
    for (const t of tasks) {
      for (const i of changedIfaces) if (inScope(t.scope, i.file)) add(t, "declared", `owns ${i.file}, where ${i.symbol} changed (${i.change})`);
      for (const c of impact.consumers) if (inScope(t.scope, c.file)) add(t, "static", `owns ${c.evidence.detail}${c.breaks.length ? `; ${c.breaks.map((b) => `line ${b.line} ${b.reason}`).join("; ")}` : ""}`);
      for (const f of testFiles) if (inScope(t.scope, f) && !consumerFiles.has(f)) add(t, "static", `owns test ${f}, which reaches the change through imports`);
    }
    // Contracts: tasks that own a changed provider file share contracts with other tasks; those are declared dependents.
    const providerTasks = [...affected.values()].map((a) => this.relay.requireTask(a.taskId)).filter((t) => changedIfaces.some((i) => inScope(t.scope, i.file)));
    const contracts = new Map<string, { id: string; version: number | null; providers: Set<string>; consumers: Set<string> }>();
    for (const p of providerTasks)
      for (const cid of Object.keys(p.contracts)) {
        const c = contracts.get(cid) ?? { id: cid, version: this.relay.currentContract(cid)?.version ?? null, providers: new Set<string>(), consumers: new Set<string>() };
        c.providers.add(p.id);
        for (const t of tasks) if (t.id !== p.id && cid in t.contracts) (c.consumers.add(t.id), add(t, "declared", `depends on contract ${cid} with ${p.id}, which owns the changed code`));
        contracts.set(cid, c);
      }

    // Verification recorded against a different workspace no longer holds; say which change invalidated it.
    const tree = workspaceFingerprint(this.root, own);
    const stale: StaleEvidence[] = [];
    const cause = changedIfaces.length ? changedIfaces.map((i) => `${i.file}#${i.symbol} (${i.change})`).join(", ") : changed.slice(0, 5).join(", ");
    for (const a of affected.values()) {
      const latest = new Map<string, ReturnType<Relay["evidence"]>[number]>();
      for (const e of this.relay.evidence(a.taskId)) if (e.source === "system") latest.set(`${e.kind}|${e.command ?? ""}`, e);
      for (const e of latest.values())
        if (e.environment.tree && e.environment.tree !== tree) stale.push({ taskId: a.taskId, evidenceId: e.id, kind: e.kind, command: e.command, recordedAt: e.createdAt, reason: `recorded before ${cause} changed` });
    }
    return {
      ...impact,
      head: resolveCommit(this.root, "HEAD").slice(0, 7),
      tasks: [...affected.values()],
      contracts: [...contracts.values()].map((c) => ({ id: c.id, version: c.version, providers: [...c.providers], consumers: [...c.consumers] })),
      stale,
    };
  }
}
