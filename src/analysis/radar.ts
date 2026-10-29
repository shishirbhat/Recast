import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Relay } from "../core/engine.ts";
import { inScope } from "../core/conflicts.ts";
import type { Task } from "../core/types.ts";
import { showAt } from "../git.ts";
import type { AgentRun } from "../server/runs.ts";
import { merge3 } from "../server/files.ts";
import type { Coordination, CoordTask } from "./coordination.ts";
import { DependencyGraph, parseModule } from "./depgraph.ts";
import type { ProjectImpact } from "./impact.ts";

/**
 * Conflict Radar: what could go wrong between pieces of work before anyone integrates them, from evidence only.
 *
 * Every alert separates what Relay KNOWS (a fact it can show: both changed this file, the edits conflict as text, the
 * project changed under an agent, a contract moved on, verification ran on other files) from what it only SUSPECTS
 * (static analysis says a module reads a property an interface no longer returns; two changes merge as text but nobody
 * has checked they work together). Nothing here blocks or changes anything; the integration gates stay the authority.
 *
 * Times: each piece of evidence carries when it happened (`at`); an alert's `since` is when the situation began (its
 * latest evidence, since that's when all of it held), and the radar's `computedAt` is when Relay looked.
 */

export type Certainty = "known" | "suspected";
export type AlertKind = "same-file" | "scope-crossing" | "project-moved" | "stale-input" | "interface-changed" | "stale-verification" | "contract-mismatch" | "integration-outdated";

export interface AlertEvidence {
  at: string | null;
  /** Where the fact comes from: git (diffs, merges), the engine's records, an agent run, live editing, or static analysis of source. */
  source: "git" | "engine" | "agent-run" | "editing" | "static-analysis";
  text: string;
}

export type AlertAction =
  | { kind: "check-together"; tasks: string[] }
  | { kind: "open-diff"; task: string; path: string }
  | { kind: "open-task"; task: string }
  | { kind: "open-file"; path: string }
  | { kind: "run-checks"; task: string }
  | { kind: "apply"; task: string };

export interface AlertOption {
  label: string;
  action: AlertAction;
  /** Why the option can't be used right now; absent when it can. */
  disabled?: string;
}

export interface RadarAlert {
  /** Stable for the same situation, so a client can tell new alerts from ones it has seen. */
  id: string;
  kind: AlertKind;
  certainty: Certainty;
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  tasks: string[];
  files: string[];
  evidence: AlertEvidence[];
  since: string | null;
  options: AlertOption[];
}

export interface Radar {
  computedAt: string;
  alerts: RadarAlert[];
  /** What the radar can't see, said once rather than implied by silence. */
  limits: string[];
}

export interface RadarInput {
  relay: Relay;
  root: string;
  coord: Coordination;
  runsFor: (taskId: string) => AgentRun[];
  /** The shared project relative to HEAD (stale evidence, interface changes people made). */
  impact: ProjectImpact;
  /** A file's content in the shared project right now (open documents included), or null if it doesn't exist. */
  projectText: (path: string) => string | null;
  /** Is this integration's combined worktree known to the agent runner (so it can be approved)? */
  isRehearsing: (taskId: string) => boolean;
  /** Is the shared project, as it is now, the same tree as `commit`? (Agent combined checks are bound to their base.) */
  projectMatches: (commit: string) => boolean;
  /** Workspace fingerprint of the shared project now (a person's integration check is bound to it). */
  projectTree: () => string;
}

const LIVE: readonly Task["state"][] = ["proposed", "queued", "running", "blocked", "review_required"];
const SEVERITY = { high: 0, medium: 1, low: 2 } as const;

/** The agent run whose work is not in the project yet, if any. */
function pendingRun(runs: AgentRun[]): AgentRun | null {
  const r = runs.at(-1);
  return r && ["starting", "running", "finished"].includes(r.status) && existsSync(r.worktree) ? r : null;
}

function readIn(dir: string, path: string): string | null {
  try {
    return readFileSync(join(dir, path), "utf8");
  } catch {
    return null;
  }
}

function latest(...ats: (string | null | undefined)[]): string | null {
  return ats.filter((a): a is string => !!a).sort().at(-1) ?? null;
}

/** Edit sessions people had on a file in the shared project after `after` (who and when), newest last. */
function editsSince(relay: Relay, path: string, after: string): { author: string; at: string }[] {
  return (relay.db.prepare("SELECT author, MAX(ended_at) AS at FROM doc_sessions WHERE doc = ? AND ended_at > ? GROUP BY author ORDER BY at").all(path, after) as { author: string; at: string }[]).filter((r) => !r.author.startsWith("agent:"));
}

export function radar(input: RadarInput): Radar {
  const { relay, root, coord } = input;
  const alerts: RadarAlert[] = [];
  const byId = new Map(coord.tasks.map((t) => [t.id, t]));
  const live = coord.tasks.filter((t) => LIVE.includes(t.state));
  const runs = new Map(live.map((t) => [t.id, pendingRun(input.runsFor(t.id))]));
  const runAt = (r: AgentRun) => r.endedAt ?? r.startedAt;
  const changeEvidence = (t: CoordTask, path: string): AlertEvidence => {
    const r = runs.get(t.id);
    if (r) return { at: runAt(r), source: "agent-run", text: `${t.id}'s agent (${r.provider}) changed ${path} in its worktree` };
    const e = editsSince(relay, path, "").at(-1);
    return { at: e?.at ?? null, source: "git", text: `${path} is changed in the shared project, in ${t.id}'s work${e ? ` (last edited by ${e.author})` : ""}` };
  };
  const togetherOption = (ids: string[]): AlertOption => {
    const rs = ids.map((id) => runs.get(id));
    const why = rs.every((r) => r) ? rs.map((r, i) => (r!.status !== "finished" ? `${ids[i]}'s agent is still ${r!.status}` : r!.checking ? `Relay is still checking ${ids[i]}` : input.isRehearsing(ids[i]!) ? `${ids[i]} is being checked together right now` : null)).find(Boolean) : rs.some((r) => r) ? "Agent work and people's work can't be checked together in one run yet" : ids.map((id) => byId.get(id)!).find((t) => t.state !== "review_required") ? "Both tasks must be submitted for review first" : null;
    return { label: `Check ${ids.join(" and ")} together`, action: { kind: "check-together", tasks: ids }, ...(why ? { disabled: why } : {}) };
  };

  // 1. Two live tasks changed the same file. Known; whether the edits conflict is decided by a real 3-way merge.
  for (const a of live) {
    for (const o of a.overlaps) {
      const b = byId.get(o.task)!;
      if (o.kind !== "both-changed" || a.id > b.id) continue;
      const ra = runs.get(a.id);
      const rb = runs.get(b.id);
      const conflicting: string[] = [];
      let mergeable = !!(ra && rb && ra.snapshot === rb.snapshot);
      if (mergeable) for (const f of o.files) {
        const ta = readIn(ra!.worktree, f);
        const tb = readIn(rb!.worktree, f);
        if (ta === null || tb === null) mergeable = false;
        else if (!merge3(showAt(root, ra!.snapshot, f) ?? "", ta, tb).clean) conflicting.push(f);
      }
      const evidence = o.files.flatMap((f) => [changeEvidence(a, f), changeEvidence(b, f)]);
      const files = o.files.join(", ");
      if (conflicting.length) evidence.push({ at: null, source: "git", text: `A 3-way merge of both versions of ${conflicting.join(", ")} from their shared snapshot has conflicting hunks` });
      else if (mergeable) evidence.push({ at: null, source: "git", text: `A 3-way merge of both versions from their shared snapshot is clean as text` });
      alerts.push({
        id: `same-file:${a.id}:${b.id}:${o.files.join(",")}`,
        kind: "same-file",
        certainty: conflicting.length ? "known" : mergeable ? "suspected" : "known",
        severity: conflicting.length ? "high" : "medium",
        title: conflicting.length ? `${a.id} and ${b.id} made conflicting edits to ${conflicting.join(", ")}` : `${a.id} and ${b.id} both changed ${files}`,
        detail: conflicting.length
          ? "The edits overlap line for line; they can't both be applied as they are. One task has to be redone on top of the other."
          : mergeable
            ? "The edits merge cleanly as text, but nothing has checked that the merged result works. Checking them together runs both tasks' verification on the combined change."
            : "Both tasks changed these files. Relay can't merge them ahead of time here (people's work is already in the shared project, or the agents started from different snapshots), so look at both diffs before integrating either.",
        tasks: [a.id, b.id],
        files: o.files,
        evidence,
        since: latest(...evidence.map((e) => e.at)),
        options: [togetherOption([a.id, b.id]), ...o.files.flatMap((f) => [{ label: `${a.id}'s diff of ${f}`, action: { kind: "open-diff", task: a.id, path: f } } as AlertOption, { label: `${b.id}'s diff of ${f}`, action: { kind: "open-diff", task: b.id, path: f } } as AlertOption])],
      });
    }
  }

  // 2. A task changed a file declared in another live task's scope. Known fact; harm is not implied.
  for (const a of live)
    for (const o of a.overlaps) {
      if (o.kind !== "in-their-scope") continue;
      const evidence = [...o.files.map((f) => changeEvidence(a, f)), { at: null, source: "engine", text: `${o.files.join(", ")} ${o.files.length === 1 ? "is" : "are"} in ${o.task}'s declared scope (${byId.get(o.task)!.scope.join(", ")})` } as AlertEvidence];
      alerts.push({
        id: `scope-crossing:${a.id}:${o.task}:${o.files.join(",")}`,
        kind: "scope-crossing",
        certainty: "known",
        severity: "medium",
        title: `${a.id} changed ${o.files.join(", ")}, which ${o.task} owns`,
        detail: `${o.task} is working on these files too (declared scope). Its owner should know before ${a.id} is integrated.`,
        tasks: [a.id, o.task],
        files: o.files,
        evidence,
        since: latest(...evidence.map((e) => e.at)),
        options: [...o.files.map((f): AlertOption => ({ label: `${a.id}'s diff of ${f}`, action: { kind: "open-diff", task: a.id, path: f } })), { label: `Open ${o.task}`, action: { kind: "open-task", task: o.task } }],
      });
    }

  // 3. The shared project moved under an agent's snapshot, in files the agent changed (known), or in files it may have
  //    read (a person edited a file in its scope while it worked: known edit, suspected effect).
  for (const t of live) {
    const r = runs.get(t.id);
    if (!r) continue;
    const moved: { path: string; clean: boolean }[] = [];
    for (const f of r.changedFiles) {
      const base = showAt(root, r.snapshot, f);
      const now = input.projectText(f);
      if (now === base || (now === null && base === null)) continue;
      const theirs = readIn(r.worktree, f);
      moved.push({ path: f, clean: theirs !== null && now !== null && merge3(base ?? "", now, theirs).clean });
    }
    if (moved.length) {
      const conflict = moved.filter((m) => !m.clean).map((m) => m.path);
      const evidence: AlertEvidence[] = [
        { at: r.startedAt, source: "agent-run", text: `${t.id}'s agent started from a snapshot of the project at ${r.startedAt}` },
        ...moved.flatMap((m) => {
          const who = editsSince(relay, m.path, r.startedAt);
          const stale = r.staleInputs.filter((s) => s.path === m.path);
          return stale.length || who.length
            ? [...stale.map((s): AlertEvidence => ({ at: s.at, source: "editing", text: `${s.by} edited ${m.path} while the agent worked` })), ...who.filter((w) => !stale.length).map((w): AlertEvidence => ({ at: w.at, source: "editing", text: `${w.author} edited ${m.path} after the agent started` }))]
            : [{ at: null, source: "git", text: `${m.path} differs from the agent's snapshot (changed outside Relay's editors, or by applied work)` } as AlertEvidence];
        }),
        ...(conflict.length ? [{ at: null, source: "git", text: `3-way merge of ${conflict.join(", ")} (snapshot, project now, agent's version) has conflicting hunks` } as AlertEvidence] : []),
      ];
      alerts.push({
        id: `project-moved:${t.id}:${r.id}:${moved.map((m) => m.path).join(",")}`,
        kind: "project-moved",
        certainty: "known",
        severity: conflict.length ? "high" : "medium",
        title: conflict.length ? `${conflict.join(", ")} changed in the project in a way that conflicts with ${t.id}'s agent` : `${moved.map((m) => m.path).join(", ")} changed in the project since ${t.id}'s agent started`,
        detail: conflict.length
          ? "Applying will be refused for these files; rerun the task on the current project, or resolve by hand."
          : "The edits merge as text. Applying merges them and re-runs the task's verification on the merged result first.",
        tasks: [t.id],
        files: moved.map((m) => m.path),
        evidence,
        since: latest(...evidence.map((e) => e.at)),
        options: [...moved.map((m): AlertOption => ({ label: `${t.id}'s diff of ${m.path}`, action: { kind: "open-diff", task: t.id, path: m.path } })), { label: `Open ${t.id}`, action: { kind: "open-task", task: t.id } }],
      });
    }
    const read = r.staleInputs.filter((s) => !r.changedFiles.includes(s.path));
    if (read.length)
      alerts.push({
        id: `stale-input:${t.id}:${r.id}:${read.map((s) => s.path).join(",")}`,
        kind: "stale-input",
        certainty: "suspected",
        severity: "low",
        title: `${read.map((s) => s.path).join(", ")} changed while ${t.id}'s agent worked from an older version`,
        detail: "The agent didn't change these files, but they are in its scope, so it may have relied on what they said before. Its verification only covers the files as they were in its snapshot.",
        tasks: [t.id],
        files: read.map((s) => s.path),
        evidence: read.map((s) => ({ at: s.at, source: "editing", text: `${s.by} edited ${s.path} after the agent's snapshot` })),
        since: latest(...read.map((s) => s.at)),
        options: [...read.map((s): AlertOption => ({ label: `Open ${s.path}`, action: { kind: "open-file", path: s.path } })), { label: `Open ${t.id}`, action: { kind: "open-task", task: t.id } }],
      });
  }

  // 4. An exported interface changed (by another task's agent, or in the shared project) that a task's code consumes.
  //    Static analysis: suspected, and says exactly which read it found.
  for (const a of live) {
    const ra = runs.get(a.id);
    if (!ra || !ra.changedFiles.length) continue;
    const graph = new DependencyGraph(ra.worktree);
    graph.refresh(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ra.worktree, encoding: "utf8" }).split("\n").filter(Boolean));
    const imp = graph.impact(ra.snapshot, ra.changedFiles, (p) => showAt(root, ra.snapshot, p));
    for (const b of live) {
      if (b.id === a.id) continue;
      const rb = runs.get(b.id);
      for (const c of imp.consumers) {
        if (ra.changedFiles.includes(c.file) || !(inScope(b.scope, c.file) || b.files.includes(c.file))) continue;
        const change = imp.interfaces.find((i) => i.file !== c.file && i.symbol === c.symbol)!;
        // If b changed the consumer, judge b's version of it: following the change is not a conflict.
        const text = rb && rb.changedFiles.includes(c.file) ? readIn(rb.worktree, c.file) : input.projectText(c.file);
        if (text === null) continue;
        const reads = parseModule(c.file, text, graph.resolve).uses.filter((u) => u.symbol === c.symbol);
        const broken = reads.filter((u) => change.removedKeys.includes(u.prop));
        if (!broken.length && change.change !== "signature" && change.change !== "removed") continue;
        const evidence: AlertEvidence[] = [
          { at: runAt(ra), source: "agent-run", text: `${a.id}'s agent changed ${change.file}: ${change.symbol} ${change.change === "shape" ? `no longer returns ${change.removedKeys.join(", ")}` : change.change === "removed" ? "was removed" : `signature ${change.before} → ${change.after}`}` },
          { at: null, source: "static-analysis", text: c.evidence.detail },
          ...broken.map((u): AlertEvidence => ({ at: null, source: "static-analysis", text: `${c.file}:${u.line} reads .${u.prop} from ${c.symbol}()${rb && rb.changedFiles.includes(c.file) ? ` (in ${b.id}'s version)` : ""}` })),
        ];
        alerts.push({
          id: `interface-changed:${a.id}:${b.id}:${change.file}#${change.symbol}:${c.file}`,
          kind: "interface-changed",
          certainty: "suspected",
          severity: broken.length ? "high" : "medium",
          title: broken.length ? `${a.id} changed ${change.symbol}(); ${b.id}'s ${c.file} still reads ${broken.map((u) => `.${u.prop}`).join(", ")}` : `${a.id} changed ${change.symbol}(), which ${b.id}'s ${c.file} uses`,
          detail: "Found by reading the source, not by running it: likely to break when both are integrated. Checking them together runs their tests on the combined change and settles it.",
          tasks: [a.id, b.id],
          files: [change.file, c.file],
          evidence,
          since: latest(...evidence.map((e) => e.at)),
          options: [togetherOption([a.id, b.id].sort()), { label: `${a.id}'s diff of ${change.file}`, action: { kind: "open-diff", task: a.id, path: change.file } }, { label: `Open ${c.file}`, action: { kind: "open-file", path: c.file } }],
        });
      }
    }
  }
  // People's interface changes in the shared project that another task's code consumes (relative to HEAD).
  const changedIfaces = input.impact.interfaces.filter((i) => i.change !== "added");
  for (const c of input.impact.consumers) {
    const change = changedIfaces.find((i) => i.symbol === c.symbol && i.file !== c.file);
    if (!change || !c.breaks.length) continue;
    const makers = live.filter((t) => inScope(t.scope, change.file)).map((t) => t.id);
    for (const b of live) {
      if (!inScope(b.scope, c.file) || makers.includes(b.id)) continue;
      const who = editsSince(relay, change.file, "").at(-1);
      const evidence: AlertEvidence[] = [
        { at: who?.at ?? null, source: who ? "editing" : "git", text: `${change.file} changed in the shared project since the last commit: ${change.symbol} no longer returns ${change.removedKeys.join(", ")}${who ? ` (last edited by ${who.author})` : ""}` },
        { at: null, source: "static-analysis", text: c.evidence.detail },
        ...c.breaks.map((x): AlertEvidence => ({ at: null, source: "static-analysis", text: `${c.file}:${x.line} ${x.reason}` })),
      ];
      alerts.push({
        id: `interface-changed:project:${b.id}:${change.file}#${change.symbol}:${c.file}`,
        kind: "interface-changed",
        certainty: "suspected",
        severity: "high",
        title: `${change.symbol}() changed in the project; ${b.id}'s ${c.file} still reads ${c.breaks.map((x) => `.${x.prop}`).join(", ")}`,
        detail: `Found by reading the source, not by running it.${makers.length ? ` ${makers.join(", ")} own${makers.length === 1 ? "s" : ""} ${change.file}.` : ""} Running ${b.id}'s checks settles it.`,
        tasks: [...makers, b.id],
        files: [change.file, c.file],
        evidence,
        since: latest(...evidence.map((e) => e.at)),
        options: [{ label: `Run ${b.id}'s checks`, action: { kind: "run-checks", task: b.id }, ...(runs.get(b.id) ? { disabled: "Agent work is checked in its worktree; Apply re-checks it on the current project" } : {}) }, { label: `Open ${c.file}`, action: { kind: "open-file", path: c.file } }],
      });
    }
  }

  // 5. Verification recorded on files that have changed since. Known: the recorded tree differs.
  for (const t of live) {
    if (t.stages?.find((s) => s.id === "tested")?.state !== "stale") continue;
    const stale = input.impact.stale.filter((s) => s.taskId === t.id);
    const ev = relay.evidence(t.id).filter((e) => e.source === "system" && e.kind === "command").at(-1);
    const evidence: AlertEvidence[] = stale.length
      ? stale.map((s) => ({ at: s.recordedAt, source: "engine", text: `${s.command ?? s.kind} was recorded ${s.reason}` }))
      : [{ at: ev?.createdAt ?? null, source: "engine", text: `${ev?.command ?? "Verification"} ran on a version of the files that has changed since` }];
    const agent = !!runs.get(t.id);
    alerts.push({
      id: `stale-verification:${t.id}:${evidence.map((e) => e.at).join(",")}`,
      kind: "stale-verification",
      certainty: "known",
      severity: "medium",
      title: `${t.id}'s verification no longer describes its files`,
      detail: agent ? "The agent's worktree changed after Relay checked it." : "The files changed after its checks ran. Until they run again, a passing result proves nothing about the current change.",
      tasks: [t.id],
      files: t.files,
      evidence,
      since: latest(...evidence.map((e) => e.at)),
      options: [agent ? { label: `Open ${t.id}`, action: { kind: "open-task", task: t.id } } : { label: `Run ${t.id}'s checks`, action: { kind: "run-checks", task: t.id }, ...(t.state === "review_required" ? {} : { disabled: "Checks run once the task is submitted for review" }) }],
    });
  }

  // 6. A task built against a contract version that is no longer current, or contract partners on different versions.
  for (const t of live)
    for (const [cid, v] of Object.entries(t.contracts)) {
      const cur = relay.currentContract(cid);
      if (!cur || cur.version === v) continue;
      const partners = live.filter((o) => o.id !== t.id && cid in o.contracts).map((o) => `${o.id} on v${o.contracts[cid]}`);
      alerts.push({
        id: `contract-mismatch:${t.id}:${cid}:${v}:${cur.version}`,
        kind: "contract-mismatch",
        certainty: "known",
        severity: "high",
        title: `${t.id} was built against ${cid} v${v}; v${cur.version} is current`,
        detail: `Integration requires the current version. ${partners.length ? `Partners: ${partners.join(", ")}.` : ""}`.trim(),
        tasks: [t.id, ...live.filter((o) => o.id !== t.id && cid in o.contracts).map((o) => o.id)],
        files: [],
        evidence: [{ at: cur.createdAt, source: "engine", text: `${cid} v${cur.version} accepted ${cur.createdAt}${cur.approvedBy ? ` by ${cur.approvedBy}` : ""}` }, { at: null, source: "engine", text: `${t.id} declares ${cid}: ${v}` }],
        since: cur.createdAt,
        options: [{ label: `Open ${t.id}`, action: { kind: "open-task", task: t.id } }],
      });
    }

  // 7. A passed combined check awaiting approval that approval would now refuse. Known: same checks as the gate.
  const pending = relay.db.prepare("SELECT id FROM integrations WHERE status = 'passed' AND approved_at IS NULL ORDER BY created_at").all() as { id: string }[];
  const seenTasks = new Map<string, string>();
  for (const { id } of pending.reverse()) {
    const integ = relay.getIntegration(id)!;
    if (!integ.tasks.every((tid) => byId.get(tid)?.state === "review_required")) continue;
    const reasons: AlertEvidence[] = [];
    const newer = integ.tasks.map((tid) => seenTasks.get(tid)).find(Boolean);
    if (newer) continue; // superseded by a newer check of the same tasks; only the newest one matters
    for (const tid of integ.tasks) seenTasks.set(tid, id);
    const agent = integ.tasks.some((tid) => runs.get(tid));
    if (agent ? integ.baseCommit && !input.projectMatches(integ.baseCommit) : integ.tree !== input.projectTree()) reasons.push({ at: null, source: "git", text: "The shared project changed after the check" });
    for (const [cid, v] of Object.entries(integ.contracts)) {
      const cur = relay.currentContract(cid);
      if (cur && cur.version !== v) reasons.push({ at: cur.createdAt, source: "engine", text: `${cid} moved from v${v} to v${cur.version} after the check` });
    }
    if (!reasons.length) continue;
    alerts.push({
      id: `integration-outdated:${id}`,
      kind: "integration-outdated",
      certainty: "known",
      severity: "medium",
      title: `The passed check of ${integ.tasks.join(" + ")} is out of date`,
      detail: "Approving it would be refused: what it checked is no longer what would be applied. Check the tasks together again.",
      tasks: integ.tasks,
      files: [],
      evidence: [{ at: integ.createdAt, source: "engine", text: `Checked together and passed at ${integ.createdAt}` }, ...reasons],
      since: latest(integ.createdAt, ...reasons.map((r) => r.at)),
      options: [togetherOption(integ.tasks)],
    });
  }

  alerts.sort((x, y) => SEVERITY[x.severity] - SEVERITY[y.severity] || (x.certainty === y.certainty ? 0 : x.certainty === "known" ? -1 : 1) || (y.since ?? "").localeCompare(x.since ?? ""));
  return {
    computedAt: new Date().toISOString(),
    alerts,
    limits: [
      "Interface checks read JavaScript and TypeScript source (imports, exports, property reads on a call's result); dynamic access and other languages aren't seen.",
      "Overlaps are judged on files changed so far; a task that hasn't changed anything yet only shows up through its declared scope.",
    ],
  };
}

export interface OwnedFile {
  path: string;
  /** Live tasks that declared this file in scope. */
  scopeOwners: string[];
  /** Who changed it and where the change lives now. */
  changes: { task: string | null; by: string; where: "agent-worktree" | "shared-project"; worktree?: string; at: string | null }[];
  /** Two or more live tasks changed it, or a task changed it outside its scope. */
  contested: boolean;
}

/**
 * The changed-file ownership map: every file changed in the shared project (since HEAD) or in an unapplied agent
 * worktree, with the tasks that own it by scope and everyone who changed it. Facts only: scope is declared, changes
 * come from git and the edit log.
 */
export function ownership(input: Pick<RadarInput, "relay" | "root" | "coord" | "runsFor">, projectChanged: string[]): OwnedFile[] {
  const { relay, coord } = input;
  const live = coord.tasks.filter((t) => LIVE.includes(t.state));
  const files = new Map<string, OwnedFile>();
  const entry = (path: string) => {
    let e = files.get(path);
    if (!e) files.set(path, (e = { path, scopeOwners: live.filter((t) => inScope(t.scope, path)).map((t) => t.id), changes: [], contested: false }));
    return e;
  };
  for (const t of live) {
    const r = pendingRun(input.runsFor(t.id));
    if (!r) continue;
    for (const f of r.changedFiles) entry(f).changes.push({ task: t.id, by: `agent:${r.provider}`, where: "agent-worktree", worktree: r.worktree.slice(Math.max(0, r.worktree.indexOf(".relay/"))), at: r.endedAt ?? r.startedAt });
  }
  const head = execFileSync("git", ["log", "-1", "--format=%cI"], { cwd: input.root, encoding: "utf8" }).trim();
  for (const f of projectChanged) {
    const e = entry(f);
    const owner = live.find((t) => !pendingRun(input.runsFor(t.id)) && t.files.includes(f));
    const who = editsSince(relay, f, head ? new Date(head).toISOString() : "");
    if (who.length) for (const w of who) e.changes.push({ task: owner?.id ?? null, by: w.author, where: "shared-project", at: w.at });
    else e.changes.push({ task: owner?.id ?? null, by: "outside Relay's editors", where: "shared-project", at: null });
  }
  for (const e of files.values()) {
    const tasks = new Set(e.changes.map((c) => c.task).filter(Boolean));
    e.contested = tasks.size > 1 || e.changes.some((c) => c.task && !e.scopeOwners.includes(c.task));
  }
  return [...files.values()].sort((a, b) => Number(b.contested) - Number(a.contested) || a.path.localeCompare(b.path));
}

