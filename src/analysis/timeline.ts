import { execFileSync } from "node:child_process";
import type { Relay } from "../core/engine.ts";

/**
 * The flight recorder: one searchable timeline of what happened in the project, from Relay's append-only event log,
 * people's edit sessions, and git commits.
 *
 * Two times are kept apart, because they differ in practice:
 * - `recordedAt`: when Relay (or git, for commits) wrote it down;
 * - `occurredAt`: when it happened, when the source says so and it differs. A git commit's author date can be days
 *   before it was committed; an edit session spans from its first to its last edit as the server received them (edits
 *   made offline arrive, and are dated, when the connection comes back). When nothing says otherwise, only
 *   `recordedAt` is known and `occurredAt` is null; nothing is guessed.
 */

export type TimelineKind = "task" | "agent" | "check" | "integration" | "decision" | "contract" | "file" | "edit" | "git" | "member" | "investigation" | "other";

export interface TimelineEntry {
  id: string;
  kind: TimelineKind;
  type: string;
  recordedAt: string;
  occurredAt: { from: string; to: string | null } | null;
  actor: string;
  task: string | null;
  /** Every task the entry concerns (a combined check names several). */
  tasks: string[];
  summary: string;
}

export interface TimelineQuery {
  q?: string;
  task?: string;
  actor?: string;
  kinds?: TimelineKind[];
  since?: string;
  until?: string;
  limit?: number;
}

function kindOf(type: string): TimelineKind {
  const head = type.split(".")[0]!;
  if (head === "task" || head === "intent") return "task";
  if (head === "agent") return "agent";
  if (head === "evidence" || head === "tests" || head === "repro" || head === "review" || head === "enforcement") return "check";
  if (head === "integration") return "integration";
  if (head === "decision") return "decision";
  if (head === "contract") return "contract";
  if (head === "file" || head === "folder" || head === "files" || head === "doc") return "file";
  if (head === "git" || head === "github") return "git";
  if (head === "member") return "member";
  if (head === "investigation") return "investigation";
  return "other";
}

const list = (v: unknown) => (Array.isArray(v) ? v.map(String).join(", ") : "");

/** One line per event, from its recorded data; unknown types fall back to their type and a few fields. */
export function summarize(type: string, d: Record<string, unknown>, from: string | null, to: string | null): string {
  switch (type) {
    case "task.created": return d.objective ? `Created: ${String(d.objective)}` : "Task created";
    case "task.base_changed": return `Base set to ${String(d.to ?? "").slice(0, 7)}`;
    case "task.contract_acknowledged": return `Acknowledged contract ${String(d.contract)} v${String(d.to)}`;
    case "enforcement.diff_check": return "Relay checked which files the task changed";
    case "task.transition": return `${from ?? "?"} → ${to ?? "?"}${d.reason ? ` (${String(d.reason)})` : ""}${d.integrationId ? " by an approved combined check" : ""}`;
    case "task.input_changed": return `${String(d.by)} edited ${String(d.path)} while the agent worked from an older copy`;
    case "task.decision_changed": return `Decision ${String(d.decision)} ${String(d.change)}${d.reason ? `: ${String(d.reason)}` : ""}`;
    case "task.contract_stale": return `Built on an older contract version`;
    case "agent.run_started": return `Agent (${String(d.provider)}) started from snapshot ${String(d.snapshot ?? "").slice(0, 7)}`;
    case "agent.run_ended": return `Agent run ${String(d.status)} (exit ${d.exitCode ?? "?"}), changed ${list(d.changedFiles) || "nothing"}`;
    case "agent.run_cancelled": return "Agent run cancelled";
    case "agent.tool": return `Agent: ${String(d.tool ?? "")} ${String(d.target ?? "")}`.trim();
    case "agent.denied": return `Relay blocked an agent action: ${String(d.tool ?? "")} ${String(d.target ?? "")}`.trim();
    case "agent.error": return `Agent error: ${String(d.detail ?? "").slice(0, 160)}`;
    case "agent.result": return `Agent reported: ${String(d.detail ?? "").slice(0, 160)}`;
    case "agent.changes_applied": return `Applied ${list(d.applied) || "nothing"}${list(d.conflicts) ? `; conflicts in ${list(d.conflicts)}` : ""}`;
    case "agent.apply_failed": return `Approved, but writing the files failed: ${String(d.error ?? "")}`;
    case "agent.merged_check": return `Re-checked on the current project: ${String(d.status)}`;
    case "evidence.recorded": return `${d.verified ? "Relay ran" : "Agent claimed"} ${String(d.kind)}${d.command ? `: ${String(d.command)}` : ""}${d.exitCode !== null && d.exitCode !== undefined ? ` (exit ${String(d.exitCode)})` : ""}`;
    case "repro.attempted": return `Reran ${String(d.command)} on its recorded files: ${String(d.outcome).replace(/-/g, " ")}`;
    case "tests.started": return `Tests started: ${String(d.command ?? "")}`;
    case "integration.checked": return `Checked ${list(d.tasks)} together: ${String(d.status)}${d.explanation ? ` (cause ${String(d.explanation)})` : ""}`;
    case "integration.approved": return `Approved ${list(d.tasks)} together`;
    case "decision.proposed": return `Proposed ${String(d.id)}: ${String(d.title ?? "")}`;
    case "file.created": case "file.deleted": return `${type === "file.created" ? "Created" : "Deleted"} ${String(d.path ?? list(d.files))}`;
    case "file.renamed": return `Renamed ${((d.files as { from: string; to: string }[] | undefined) ?? []).map((f) => `${f.from} → ${f.to}`).join(", ")}`;
    case "git.committed": return `Committed ${String(d.commit ?? "").slice(0, 7)}: ${String(d.message ?? "")}`;
    case "member.joined": return `${String(d.name ?? "Someone")} joined as ${String(d.role ?? "")}`;
    case "investigation.created": return `Investigation ${String(d.id)}: ${String(d.title ?? "")}`;
  }
  if (type.startsWith("decision.")) return `${String(d.id)} ${type.slice(9)}${d.reason ? `: ${String(d.reason)}` : ""}`;
  if (type.startsWith("contract.")) return `${String(d.contractId ?? d.id ?? "")} v${String(d.version ?? "?")} ${type.slice(9)}`;
  const keys = Object.entries(d).filter(([, v]) => typeof v === "string" || typeof v === "number").slice(0, 3);
  return `${type}${keys.length ? ` · ${keys.map(([k, v]) => `${k} ${String(v).slice(0, 60)}`).join(", ")}` : ""}`;
}

/** Commits on HEAD, newest first, with author date (when written) and committer date (when committed). */
function commits(root: string, limit: number): TimelineEntry[] {
  let out = "";
  try {
    out = execFileSync("git", ["log", `-${limit}`, "--format=%H%x1f%aI%x1f%cI%x1f%an%x1f%s"], { cwd: root, encoding: "utf8" });
  } catch {
    return [];
  }
  return out.split("\n").filter(Boolean).map((l) => {
    const [sha, authored, committed, author, subject] = l.split("\x1f") as [string, string, string, string, string];
    const a = new Date(authored).toISOString();
    const c = new Date(committed).toISOString();
    return { id: `commit:${sha}`, kind: "git", type: "git.commit", recordedAt: c, occurredAt: a !== c ? { from: a, to: null } : null, actor: author, task: null, tasks: [], summary: `${sha.slice(0, 7)} ${subject}` };
  });
}

export function timeline(relay: Relay, root: string, query: TimelineQuery = {}): { entries: TimelineEntry[]; truncated: boolean } {
  const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000);
  const entries: TimelineEntry[] = [];
  // Agent text and tool steps are many and already in each run's log; the recorder keeps the rest of the agent's trail.
  const rows = relay.db.prepare("SELECT seq, id, task_id, type, actor, at, from_state, to_state, data FROM events WHERE type NOT IN ('agent.text') ORDER BY seq DESC LIMIT 5000").all() as { seq: number; id: string; task_id: string | null; type: string; actor: string; at: string; from_state: string | null; to_state: string | null; data: string }[];
  for (const r of rows) {
    const d = JSON.parse(r.data) as Record<string, unknown>;
    const tasks = [...new Set([...(r.task_id ? [r.task_id] : []), ...(Array.isArray(d.tasks) ? d.tasks.map(String) : [])])];
    entries.push({ id: `event:${r.seq}`, kind: kindOf(r.type), type: r.type, recordedAt: r.at, occurredAt: null, actor: r.actor, task: r.task_id, tasks, summary: summarize(r.type, d, r.from_state, r.to_state) });
  }
  const sessions = relay.db.prepare("SELECT id, doc, author, started_at, ended_at, inserted, deleted, edits FROM doc_sessions ORDER BY ended_at DESC LIMIT 2000").all() as { id: string; doc: string; author: string; started_at: string; ended_at: string; inserted: number; deleted: number; edits: number }[];
  for (const s of sessions)
    entries.push({ id: `edit:${s.id}`, kind: "edit", type: "edit.session", recordedAt: s.ended_at, occurredAt: { from: s.started_at, to: s.ended_at }, actor: s.author, task: null, tasks: [], summary: `Edited ${s.doc.replace(/^file:/, "")}: +${s.inserted} −${s.deleted} characters in ${s.edits} edit${s.edits === 1 ? "" : "s"}` });
  entries.push(...commits(root, 200));

  const q = query.q?.toLowerCase().trim();
  const filtered = entries
    .filter((e) => (!query.task || e.tasks.includes(query.task)) && (!query.actor || e.actor.toLowerCase().includes(query.actor.toLowerCase())) && (!query.kinds?.length || query.kinds.includes(e.kind)))
    .filter((e) => (!query.since || e.recordedAt >= query.since) && (!query.until || e.recordedAt <= query.until))
    .filter((e) => !q || `${e.summary} ${e.actor} ${e.tasks.join(" ")} ${e.type}`.toLowerCase().includes(q))
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.id.localeCompare(a.id));
  return { entries: filtered.slice(0, limit), truncated: filtered.length > limit };
}
