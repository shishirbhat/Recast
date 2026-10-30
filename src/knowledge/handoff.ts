import { randomUUID } from "node:crypto";
import type { Relay } from "../core/engine.ts";
import { RelayError } from "../core/types.ts";
import type { Member } from "../server/auth.ts";
import type { Changeset } from "../analysis/changeset.ts";
import type { RadarAlert } from "../analysis/radar.ts";
import type { ReproBundle } from "../analysis/repro.ts";
import type { Records } from "./records.ts";
import { sanitize } from "./sanitize.ts";

/**
 * Handoff packets: passing a task from one person (or agent run) to another without losing what is known.
 *
 * A packet is assembled by Relay from evidence (the changeset summary with which checks ran on exactly this change,
 * failing checks and whether they reproduce, decisions and contracts in force, radar alerts) plus what the person
 * handing over writes (note, open questions, next steps), which is kept apart and labelled as their words. The packet
 * is frozen when made; the recipient sees what the giver saw, and can open the live task for what changed since.
 *
 * A person acknowledges (and becomes the task's owner) or declines with a reason; the giver can withdraw an open
 * one. A packet for "the next agent" goes into the briefing of the next agent run on the task, once; that is recorded
 * as delivered, which is not the agent's acknowledgement (an agent's word proves nothing).
 */

export type HandoffStatus = "open" | "acknowledged" | "declined" | "withdrawn" | "delivered";
export const NEXT_AGENT = "next-agent";

export interface HandoffPacket {
  task: { id: string; objective: string; state: string; scope: string[]; verify: string[] };
  work: { source: string; files: string[]; tree: string; changesetDigest: string };
  checks: { command: string; exitCode: number | null; onThisChange: boolean; recordedAt: string | null }[];
  failures: { command: string; reproducibility: string; failingTests: string[] }[];
  decisions: { id: string; title: string }[];
  contracts: { id: string; planned: number; current: number | null }[];
  alerts: { title: string; certainty: string; severity: string }[];
  warnings: string[];
  /** The giver's own words: not checked by Relay. */
  fromGiver: { note: string; questions: string[]; nextSteps: string[] };
}

export interface Handoff {
  id: string;
  taskId: string;
  from: { id: string; name: string };
  to: string;
  toName: string;
  status: HandoffStatus;
  packet: HandoffPacket;
  createdAt: string;
  respondedAt: string | null;
  response: string | null;
}

export interface HandoffSources {
  changeset: (taskId: string) => Changeset;
  repro: (evidenceId: string) => ReproBundle | null;
  radar: () => RadarAlert[];
}

export class Handoffs {
  private relay: Relay;
  private root: string;
  private records: Records;
  private src: HandoffSources;

  constructor(relay: Relay, root: string, records: Records, src: HandoffSources) {
    this.relay = relay;
    this.root = root;
    this.records = records;
    this.src = src;
    relay.db.exec(`CREATE TABLE IF NOT EXISTS handoffs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, from_id TEXT NOT NULL, from_name TEXT NOT NULL, to_id TEXT NOT NULL, to_name TEXT NOT NULL,
      status TEXT NOT NULL, packet TEXT NOT NULL, created_at TEXT NOT NULL, responded_at TEXT, response TEXT)`);
  }

  private toHandoff(r: Record<string, unknown>): Handoff {
    return {
      id: r.id as string, taskId: r.task_id as string, from: { id: r.from_id as string, name: r.from_name as string }, to: r.to_id as string, toName: r.to_name as string,
      status: r.status as HandoffStatus, packet: JSON.parse(r.packet as string), createdAt: r.created_at as string, respondedAt: (r.responded_at as string) ?? null, response: (r.response as string) ?? null,
    };
  }

  get(id: string): Handoff {
    const r = this.relay.db.prepare("SELECT * FROM handoffs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!r) throw new RelayError("not_found", `No handoff ${id}`);
    return this.toHandoff(r);
  }

  list(filter: { taskId?: string; to?: string; status?: HandoffStatus } = {}): Handoff[] {
    return (this.relay.db.prepare("SELECT * FROM handoffs ORDER BY created_at DESC").all() as Record<string, unknown>[])
      .map((r) => this.toHandoff(r))
      .filter((h) => (!filter.taskId || h.taskId === filter.taskId) && (!filter.to || h.to === filter.to) && (!filter.status || h.status === filter.status));
  }

  /** Assemble the packet from evidence, freeze it, and hand it over. */
  create(input: { taskId: string; to: string; toName: string; note: string; questions?: string[]; nextSteps?: string[] }, from: Member): Handoff {
    const task = this.relay.requireTask(input.taskId);
    if (["completed", "cancelled"].includes(task.state)) throw new RelayError("illegal_transition", `${task.id} is ${task.state}; there's nothing left to hand over`);
    if (input.to === from.id) throw new RelayError("invalid", "You can't hand a task to yourself");
    if (this.list({ taskId: task.id, status: "open" }).length) throw new RelayError("conflict", `${task.id} already has an open handoff; withdraw it first`);
    const clean = (s: string) => sanitize(s, this.root).text.trim();
    const note = clean(input.note ?? "");
    if (!note) throw new RelayError("invalid", "Say in a sentence where things stand");
    const cs = this.src.changeset(task.id);
    const failingIds = new Map<string, string>();
    for (const e of cs.evidence) if (e.kind === "command" && e.source === "system" && e.command) failingIds.set(e.command, e.exitCode !== 0 ? e.id : "");
    const ctx = this.records.contextFor(task.id);
    const packet: HandoffPacket = {
      task: { id: task.id, objective: task.objective, state: task.state, scope: task.scope, verify: task.verify },
      work: { source: cs.source === "agent-worktree" ? `agent work (${cs.agent?.provider}) not yet in the project` : "the shared project", files: cs.change.files.map((f) => f.path), tree: cs.change.tree, changesetDigest: cs.digest },
      checks: task.verify.map((cmd) => {
        const e = cs.evidence.filter((x) => x.command === cmd && x.source === "system").at(-1);
        return { command: cmd, exitCode: e?.exitCode ?? null, onThisChange: !!e?.coversThisChange, recordedAt: e?.recordedAt ?? null };
      }),
      failures: [...failingIds.entries()].filter(([, id]) => id).map(([command, id]) => {
        const b = this.src.repro(id);
        return { command, reproducibility: b?.reproducibility ?? "unknown", failingTests: b?.failingTests.map((t) => t.name) ?? [] };
      }),
      decisions: ctx.decisions.map((d) => ({ id: d.id, title: d.title })),
      contracts: ctx.contracts.map((c) => ({ id: c.id, planned: c.planned, current: c.current })),
      alerts: this.src.radar().filter((a) => a.tasks.includes(task.id)).map((a) => ({ title: a.title, certainty: a.certainty, severity: a.severity })),
      warnings: [...cs.warnings, ...ctx.warnings],
      fromGiver: { note, questions: (input.questions ?? []).map(clean).filter(Boolean).slice(0, 20), nextSteps: (input.nextSteps ?? []).map(clean).filter(Boolean).slice(0, 20) },
    };
    const h: Handoff = { id: `HO-${randomUUID().slice(0, 6)}`, taskId: task.id, from: { id: from.id, name: from.name }, to: input.to, toName: input.toName, status: "open", packet, createdAt: new Date().toISOString(), respondedAt: null, response: null };
    this.relay.db.prepare("INSERT INTO handoffs VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(h.id, h.taskId, h.from.id, h.from.name, h.to, h.toName, h.status, JSON.stringify(packet), h.createdAt, null, null);
    this.relay.record("handoff.created", `human:${from.name}`, { id: h.id, to: h.toName }, task.id);
    return h;
  }

  /** The recipient's answer. Acknowledging takes the task over (its owner becomes the recipient). */
  respond(id: string, by: Member, status: "acknowledged" | "declined", response?: string): Handoff {
    const h = this.get(id);
    if (h.to !== by.id) throw new RelayError("forbidden", `This handoff is for ${h.toName}`);
    if (h.status !== "open") throw new RelayError("illegal_transition", `This handoff is ${h.status}`);
    const reply = sanitize(response ?? "", this.root).text.trim();
    if (status === "declined" && !reply) throw new RelayError("invalid", "Say why you're declining, so the person handing over knows");
    const at = new Date().toISOString();
    this.relay.db.prepare("UPDATE handoffs SET status = ?, responded_at = ?, response = ? WHERE id = ?").run(status, at, reply || null, id);
    if (status === "acknowledged") this.relay.db.prepare("UPDATE tasks SET owner = ?, updated_at = ? WHERE id = ?").run(by.id, at, h.taskId);
    this.relay.record(`handoff.${status}`, `human:${by.name}`, { id, from: h.from.name, reply: reply || null }, h.taskId);
    return this.get(id);
  }

  withdraw(id: string, by: Member): Handoff {
    const h = this.get(id);
    if (h.from.id !== by.id) throw new RelayError("forbidden", "Only the person who handed it over can withdraw it");
    if (h.status !== "open") throw new RelayError("illegal_transition", `This handoff is ${h.status}`);
    this.relay.db.prepare("UPDATE handoffs SET status = 'withdrawn', responded_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    this.relay.record("handoff.withdrawn", `human:${by.name}`, { id }, h.taskId);
    return this.get(id);
  }

  /**
   * For the agent runner: the open packet addressed to the next agent on this task, as briefing text, marked delivered
   * to `runId`. Delivered once; the giver's words are labelled as such.
   */
  deliverToAgent(taskId: string, runId: string): string {
    const h = this.list({ taskId, to: NEXT_AGENT, status: "open" })[0];
    if (!h) return "";
    this.relay.db.prepare("UPDATE handoffs SET status = 'delivered', responded_at = ?, response = ? WHERE id = ?").run(new Date().toISOString(), `delivered to agent run ${runId}`, h.id);
    this.relay.record("handoff.delivered", "system:runner", { id: h.id, runId }, taskId);
    return `Handoff from ${h.from.name} (their words, not verified by Relay; check before relying on them):\n${handoffText(h, false)}`;
  }
}

export function handoffText(h: Handoff, header = true): string {
  const p = h.packet;
  const lines = [
    ...(header ? [`Handoff ${h.id}: ${p.task.id} (${p.task.objective}) from ${h.from.name} to ${h.toName}, ${h.createdAt} · ${h.status}`, ""] : []),
    `Work: ${p.work.files.length} file(s) in ${p.work.source}: ${p.work.files.join(", ") || "none yet"}`,
    "Checks (recorded by Relay):",
    ...(p.checks.length ? p.checks.map((c) => `  ${c.exitCode === null ? "not run" : c.exitCode === 0 ? "PASS" : "FAIL"}  ${c.command}${c.exitCode === null ? "" : c.onThisChange ? "  on exactly this change" : "  on other files"}`) : ["  none set"]),
    ...(p.failures.length ? ["Failures:", ...p.failures.map((f) => `  ${f.command}: ${f.reproducibility.replace(/-/g, " ")}${f.failingTests.length ? ` (${f.failingTests.join(", ")})` : ""}`)] : []),
    ...(p.decisions.length ? ["Decisions in force:", ...p.decisions.map((d) => `  ${d.id} ${d.title}`)] : []),
    ...(p.contracts.length ? ["Contracts:", ...p.contracts.map((c) => `  ${c.id} planned v${c.planned}, current ${c.current === null ? "none" : `v${c.current}`}`)] : []),
    ...(p.alerts.length ? ["Radar:", ...p.alerts.map((a) => `  ${a.severity} ${a.certainty}: ${a.title}`)] : []),
    ...(p.warnings.length ? ["Warnings:", ...p.warnings.map((w) => `  - ${w}`)] : []),
    `From ${h.from.name}:`,
    `  ${p.fromGiver.note}`,
    ...(p.fromGiver.questions.length ? ["  Open questions:", ...p.fromGiver.questions.map((q) => `  - ${q}`)] : []),
    ...(p.fromGiver.nextSteps.length ? ["  Next steps:", ...p.fromGiver.nextSteps.map((s) => `  - ${s}`)] : []),
    ...(h.response ? [`Reply from ${h.toName}: ${h.response}`] : []),
  ];
  return lines.join("\n");
}
