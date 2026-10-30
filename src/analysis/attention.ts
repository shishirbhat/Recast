import type { DatabaseSync } from "node:sqlite";
import type { ContractVersion, Task } from "../core/types.ts";
import type { AgentRun } from "../server/runs.ts";
import type { Member } from "../server/auth.ts";
import type { RadarAlert } from "./radar.ts";

/**
 * The attention inbox, on the server: what needs a person, for each member, with a reason it is theirs. Only
 * situations that need someone are listed (never routine activity). An item's key names the situation exactly (the
 * run, the contract version, the alert), so marking it seen hides that situation only: if it changes, it comes back.
 * Seen marks are per member and kept in the database.
 */

export type AttentionTarget = { kind: "task"; id: string } | { kind: "contracts" } | { kind: "conflict"; id: string; path: string } | { kind: "tests" } | { kind: "coordination" };

export interface AttentionItem {
  key: string;
  /** block: work can't proceed; review: someone has to look; info: worth knowing, nothing broken. */
  level: "block" | "review" | "info";
  title: string;
  why: string;
  /** Why this is in this person's inbox. */
  forYou: string;
  target: AttentionTarget;
  action: string;
  /** When the situation began, if known. */
  at: string | null;
  seen: boolean;
}

export interface AttentionInput {
  me: Member;
  tasks: (Task & { runs: AgentRun[] })[];
  contracts: { id: string; history: ContractVersion[] }[];
  conflicts: { id: string; doc: string; createdAt?: string }[];
  tests: { id: string; command: string; status: string; stale: boolean; results: { status: string }[]; endedAt: string | null } | null;
  radar: RadarAlert[];
  /** Handoffs addressed to this person and still open, and ones they made that were declined. */
  handoffs?: { id: string; taskId: string; from: { id: string; name: string }; toName: string; status: string; createdAt: string; respondedAt: string | null; response: string | null; packet: { fromGiver: { note: string } } }[];
  db: DatabaseSync;
}

export function ensureAttentionTable(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS attention_seen (member_id TEXT NOT NULL, key TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (member_id, key))");
}

export function markSeen(db: DatabaseSync, memberId: string, keys: string[], seen: boolean): void {
  ensureAttentionTable(db);
  for (const k of keys) {
    if (seen) db.prepare("INSERT OR REPLACE INTO attention_seen (member_id, key, at) VALUES (?, ?, ?)").run(memberId, k, new Date().toISOString());
    else db.prepare("DELETE FROM attention_seen WHERE member_id = ? AND key = ?").run(memberId, k);
  }
}

export function attention(input: AttentionInput): AttentionItem[] {
  const { me } = input;
  const out: Omit<AttentionItem, "seen">[] = [];
  const isOwner = me.role === "owner";
  const canEdit = me.role !== "viewer";
  const mine = (t: Task & { runs: AgentRun[] }) => t.owner === me.id || t.runs.some((r) => r.startedBy === me.id);
  const reason = (t: Task & { runs: AgentRun[] }, fallback: string) => (t.runs.at(-1)?.startedBy === me.id ? "You started this agent run" : t.owner === me.id ? "You own this task" : fallback);
  const accepted = new Map(input.contracts.map((c) => [c.id, c.history.filter((h) => h.status === "accepted").at(-1)?.version]));

  for (const t of input.tasks) {
    if (t.state === "completed" || t.state === "cancelled") {
      const pending = t.runs.find((r) => r.applyPending);
      if (pending && isOwner) out.push({ key: `apply-pending:${pending.id}`, level: "block", title: `${t.id} was approved, but its files weren't all written`, why: `Writing them failed (${pending.applyPending!.error}). Applying again finishes it; nothing is lost.`, forYou: "Owners apply approved work", target: { kind: "task", id: t.id }, action: "Open task", at: pending.applyPending!.at });
      continue;
    }
    const run = t.runs.at(-1);
    const target = { kind: "task" as const, id: t.id };
    if (t.state === "review_required" && (isOwner || mine(t))) out.push({ key: `review:${t.id}:${t.updatedAt}`, level: "review", title: `${t.id} is ready for review`, why: t.objective, forYou: isOwner ? "Owners approve work" : reason(t, ""), target, action: "Review", at: t.updatedAt });
    if (t.state === "proposed" && isOwner) out.push({ key: `proposed:${t.id}`, level: "review", title: `${t.id} is waiting for approval to start`, why: t.objective, forYou: "Owners approve plans", target, action: "Review plan", at: t.updatedAt });
    if (t.state === "blocked" && (isOwner || mine(t))) out.push({ key: `blocked:${t.id}:${t.updatedAt}`, level: "block", title: `${t.id} is blocked`, why: "Work on it can't continue until the cause is resolved; the task shows why.", forYou: reason(t, "Owners unblock work"), target, action: "Open task", at: t.updatedAt });
    if ((t.state === "failed" || run?.status === "failed") && (isOwner || mine(t)))
      out.push({ key: `failed:${t.id}:${run?.id ?? t.updatedAt}`, level: "block", title: run?.status === "failed" ? `The agent on ${t.id} failed` : `${t.id} failed`, why: "Its log and the last error are in the task. It can be requeued once the cause is fixed.", forYou: reason(t, "Owners decide what happens to failed work"), target, action: "Investigate", at: run?.endedAt ?? t.updatedAt });
    for (const [cid, v] of Object.entries(t.contracts)) {
      const cur = accepted.get(cid);
      if (cur !== undefined && cur > v) out.push({ key: `stale:${t.id}:${cid}:${cur}`, level: "block", title: `${t.id} is built on ${cid} v${v}, but v${cur} is accepted`, why: "Its work may not match what other tasks now expect, so it can't be integrated until it's updated to the current version.", forYou: reason(t, "It can't be integrated as it is"), target, action: "Open task", at: null });
    }
    for (const s of run?.status === "running" ? run.staleInputs : []) out.push({ key: `input:${t.id}:${run!.id}:${s.path}`, level: "info", title: `${s.by} edited ${s.path} while the agent on ${t.id} was working`, why: "The agent's copy is older. Relay checks this again before anything is applied.", forYou: reason(t, "Someone's edit overlaps an agent's work"), target, action: "Open task", at: s.at });
  }
  if (isOwner)
    for (const c of input.contracts)
      for (const h of c.history)
        if (h.status === "proposed") out.push({ key: `contract:${c.id}:${h.version}`, level: "review", title: `${c.id} v${h.version} is proposed`, why: "Tasks that depend on this contract keep building on the accepted version until an owner decides.", forYou: "Owners accept contracts", target: { kind: "contracts" }, action: "Review contract", at: h.createdAt });
  if (canEdit)
    for (const c of input.conflicts) {
      const path = c.doc.replace(/^file:/, "");
      out.push({ key: `conflict:${c.id}`, level: "block", title: `An outside edit to ${path} conflicted`, why: "Both versions were kept and nothing was overwritten. Compare them and choose which to keep.", forYou: "Anyone who edits can resolve it", target: { kind: "conflict", id: c.id, path }, action: "Resolve", at: c.createdAt ?? null });
    }
  const tests = input.tests;
  const failing = tests && tests.status !== "running" && !tests.stale ? tests.results.filter((r) => r.status === "fail").length : 0;
  if (failing) out.push({ key: `tests:${tests!.id}`, level: "block", title: `${failing} test${failing === 1 ? "" : "s"} failing`, why: `From ${tests!.command}, run on the current files.`, forYou: "The shared project's tests are failing", target: { kind: "tests" }, action: "Show tests", at: tests!.endedAt });

  // Conflict Radar: high alerts, and decisions that changed under someone's work. Suspected ones say so.
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  for (const a of input.radar) {
    if (a.severity !== "high" && a.kind !== "decision-changed") continue;
    // Already listed as its own item above ("built on vN, but vM is accepted"): one situation, said once.
    if (a.kind === "contract-mismatch") continue;
    const involved = a.tasks.map((id) => byId.get(id)).filter((t): t is Task & { runs: AgentRun[] } => !!t);
    const own = involved.find(mine);
    if (!isOwner && !own) continue;
    out.push({ key: `radar:${a.id}`, level: a.certainty === "known" && a.severity === "high" ? "block" : "review", title: a.title, why: `${a.certainty === "known" ? "Known" : "Suspected"}: ${a.detail}`, forYou: own ? reason(own, "") : "Owners integrate this work", target: a.tasks.length === 1 ? { kind: "task", id: a.tasks[0]! } : { kind: "coordination" }, action: a.tasks.length === 1 ? "Open task" : "Open radar", at: a.since });
  }

  for (const h of input.handoffs ?? []) {
    if (h.status === "open") out.push({ key: `handoff:${h.id}`, level: "review", title: `${h.from.name} handed you ${h.taskId}`, why: h.packet.fromGiver.note, forYou: "It's addressed to you: acknowledge to take it over, or decline", target: { kind: "task", id: h.taskId }, action: "Open handoff", at: h.createdAt });
    else if (h.status === "declined") out.push({ key: `handoff-declined:${h.id}`, level: "review", title: `${h.toName} declined ${h.taskId}`, why: h.response ?? "", forYou: "You handed it over", target: { kind: "task", id: h.taskId }, action: "Open task", at: h.respondedAt });
  }
  ensureAttentionTable(input.db);
  const seen = new Set((input.db.prepare("SELECT key FROM attention_seen WHERE member_id = ?").all(me.id) as { key: string }[]).map((r) => r.key));
  const rank = { block: 0, review: 1, info: 2 };
  return out.map((i) => ({ ...i, seen: seen.has(i.key) })).sort((a, b) => Number(a.seen) - Number(b.seen) || rank[a.level] - rank[b.level] || (b.at ?? "").localeCompare(a.at ?? ""));
}
