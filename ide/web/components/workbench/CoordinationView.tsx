"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, CircleAlert, FileDiff, GitBranch, Link2, Play, RefreshCw, ShieldCheck, Square, TriangleAlert } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { Member, TaskState } from "@/lib/types";

/** Mirrors src/analysis/coordination.ts. Every status is derived on the server from engine state and the change record. */
export type CoordStatus = "proposed" | "waiting" | "queued" | "running" | "stopped" | "checking" | "blocked" | "verification_failed" | "verification_required" | "review" | "ready" | "failed" | "cancelled" | "done";
export interface CoordTask {
  id: string;
  objective: string;
  state: TaskState;
  status: CoordStatus;
  why: string;
  owner: string | null;
  agent: string | null;
  scope: string[];
  contracts: Record<string, number>;
  run: { id: string; status: string; provider: string; worktree: string; startedAt: string; endedAt: string | null; last: { at: string; text: string } | null; staleInputs: number } | null;
  files: string[];
  outOfScope: string[];
  stages: { id: string; state: "done" | "missing" | "failed" | "stale" | "n/a" }[] | null;
  blockers: string[];
  safeToIntegrate: boolean;
  waitingOn: string[];
  blocks: string[];
  partners: string[];
  overlaps: { task: string; files: string[]; kind: "both-changed" | "in-their-scope" }[];
}
export interface CoordData {
  computedAt: string;
  tasks: CoordTask[];
  answers: { running: string[]; blocking: string[]; related: { a: string; b: string; files: string[]; why: string }[]; unverified: string[]; review: string[]; safeNext: string[] };
}

/** The status vocabulary: label, tone, and the engine fact behind it (shown as a tooltip). */
export const STATUS: Record<CoordStatus, { label: string; tone: "run" | "wait" | "need" | "bad" | "good" | "idle"; engine: string }> = {
  proposed: { label: "Awaiting approval", tone: "need", engine: "proposed" },
  waiting: { label: "Waiting", tone: "wait", engine: "queued, prerequisites unfinished" },
  queued: { label: "Queued", tone: "idle", engine: "queued" },
  running: { label: "Running", tone: "run", engine: "running" },
  stopped: { label: "Stopped", tone: "bad", engine: "running, but its agent run ended without finishing" },
  checking: { label: "Checking", tone: "run", engine: "running, agent run finished, Relay checks pending" },
  blocked: { label: "Blocked", tone: "bad", engine: "blocked" },
  verification_failed: { label: "Verification failed", tone: "bad", engine: "review_required, tested or contracts stage failed" },
  verification_required: { label: "Verification required", tone: "need", engine: "review_required, tests missing or out of date" },
  review: { label: "Needs review", tone: "need", engine: "review_required, verified, other blockers remain" },
  ready: { label: "Ready to integrate", tone: "good", engine: "review_required and the change record is safe to integrate" },
  failed: { label: "Failed", tone: "bad", engine: "failed" },
  cancelled: { label: "Cancelled", tone: "idle", engine: "cancelled" },
  done: { label: "Done", tone: "idle", engine: "completed" },
};
const TONE: Record<string, { dot: string; text: string; color: string }> = {
  run: { dot: "bg-accent", text: "text-ink", color: "var(--accent)" },
  wait: { dot: "bg-faint", text: "text-muted", color: "var(--faint)" },
  need: { dot: "bg-warn", text: "text-warn", color: "var(--warn)" },
  bad: { dot: "bg-danger", text: "text-danger", color: "var(--danger)" },
  good: { dot: "bg-ok", text: "text-ok", color: "var(--ok)" },
  idle: { dot: "bg-rule-strong", text: "text-muted", color: "var(--rule-strong)" },
};

export function StatusLabel({ status }: { status: CoordStatus }) {
  const s = STATUS[status];
  return (
    <span title={`Engine state: ${s.engine}`} className={`inline-flex shrink-0 items-center gap-1.5 text-[12px] font-medium ${TONE[s.tone]!.text}`} data-status={status}>
      <span className={`size-1.5 rounded-full ${TONE[s.tone]!.dot} ${s.tone === "run" ? "motion-safe:animate-pulse" : ""}`} />
      {s.label}
    </span>
  );
}

const STAGE_LABEL: Record<string, string> = { claimed: "Claimed", executed: "Ran", tested: "Tested", contracts: "Contracts", approved: "Approved", integrated: "Integrated" };
/** The six change-record stages as a compact strip; each cell says its state in text, not only colour. */
function Stages({ stages }: { stages: CoordTask["stages"] }) {
  if (!stages) return null;
  const cls = { done: "bg-ok-soft text-ok", failed: "bg-danger-soft text-danger", stale: "bg-warn-soft text-warn", missing: "bg-sunken text-faint", "n/a": "text-faint" } as const;
  const mark = { done: "✓", failed: "✕", stale: "~", missing: "·", "n/a": "–" } as const;
  return (
    <span className="flex flex-wrap gap-0.5" aria-label="Change record stages">
      {stages.map((s) => (
        <span key={s.id} title={`${STAGE_LABEL[s.id]}: ${s.state}`} className={`inline-flex h-[18px] items-center gap-1 rounded-[3px] px-1.5 font-mono text-[10.5px] ${cls[s.state]}`}>
          <span aria-hidden>{mark[s.state]}</span>
          {STAGE_LABEL[s.id]}
        </span>
      ))}
    </span>
  );
}

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};

/** Lanes group statuses by what a person does next. */
const LANES: { id: string; title: string; hint: string; statuses: CoordStatus[] }[] = [
  { id: "need", title: "Needs you", hint: "Decisions, failures and checks that are waiting on a person", statuses: ["verification_failed", "blocked", "stopped", "failed", "verification_required", "review", "proposed"] },
  { id: "ready", title: "Ready to integrate", hint: "Verified on the current workspace with nothing blocking", statuses: ["ready"] },
  { id: "moving", title: "Running", hint: "Agents and people working now", statuses: ["running", "checking"] },
  { id: "later", title: "Up next", hint: "Queued, or waiting on other tasks", statuses: ["queued", "waiting"] },
  { id: "done", title: "Done", hint: "Completed tasks", statuses: ["done"] },
];

/**
 * Relay's coordination workspace, as an editor tab. It answers the questions a person running parallel work asks
 * (what's running, what blocks what, who's touching the same files, what's unverified, what's ready), lays tasks out by
 * what they need next, and offers only actions the engine supports.
 */
export function CoordinationView({ tick, members, role, onOpenTask, onOpenFile, onOpenDiff, notify, onNewTask }: { tick: number; members: Member[]; role: "owner" | "editor" | "viewer"; onOpenTask: (id: string) => void; onOpenFile: (p: string) => void; onOpenDiff: (task: string, path: string) => void; notify: (m: string, tone?: "ok" | "danger" | "attention") => void; onNewTask: () => void }) {
  const [data, setData] = useState<CoordData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => {
    api<CoordData>("GET", "/coordination").then(
      (d) => (setData(d), setError(null)),
      (e) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, []);
  // Recomputed shortly after project activity, not on every keystroke elsewhere.
  useEffect(() => {
    const t = setTimeout(load, 400);
    return () => clearTimeout(t);
  }, [tick, load]);
  const byId = useMemo(() => new Map((data?.tasks ?? []).map((t) => [t.id, t])), [data]);
  const name = (id: string | null) => (id ? (members.find((m) => m.id === id)?.name ?? id) : null);
  const canEdit = role !== "viewer";

  const act = async (key: string, method: "POST", path: string, ok: string) => {
    setBusy(key);
    try {
      await api(method, path);
      notify(ok);
    } catch (e) {
      notify(e instanceof ApiError ? e.message : String(e), "danger");
    } finally {
      setBusy(null);
      load();
    }
  };

  if (error && !data)
    return (
      <div className="flex-1 overflow-y-auto p-8" data-testid="coordination">
        <p className="text-[13px] text-danger">Couldn&apos;t load coordination: {error}</p>
        <button onClick={load} className="mt-3 rounded-sm border border-rule px-2.5 py-1 text-[12.5px] text-ink-2 hover:bg-hover">
          Try again
        </button>
      </div>
    );
  if (!data)
    return (
      <div className="flex-1 p-8 text-[13px] text-muted" data-testid="coordination">
        Reading tasks, runs and change records…
      </div>
    );

  const chip = (id: string) => {
    const t = byId.get(id);
    return (
      <button key={id} onClick={() => onOpenTask(id)} title={t ? `${t.objective} — ${STATUS[t.status].label}` : id} className="inline-flex h-[22px] items-center gap-1.5 rounded-sm border border-rule bg-panel px-1.5 font-mono text-[11.5px] text-ink-2 hover:border-rule-strong hover:text-ink">
        {t && <span className={`size-1.5 rounded-full ${TONE[STATUS[t.status].tone]!.dot}`} />}
        {id}
      </button>
    );
  };
  const answers: { q: string; ids: string[]; none: string; extra?: React.ReactNode }[] = [
    { q: "What's running now?", ids: data.answers.running, none: "Nothing is running" },
    { q: "What's blocking other work?", ids: data.answers.blocking, none: "No task is holding up another" },
    {
      q: "Who's touching related work?",
      ids: [],
      none: "No overlapping files or shared contracts among live tasks",
      extra: data.answers.related.length ? (
        <span className="flex flex-col gap-1">
          {data.answers.related.map((r) => (
            <span key={`${r.a}-${r.b}`} className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
              {chip(r.a)}
              <Link2 size={11} className="text-faint" />
              {chip(r.b)}
              <span>{r.why}</span>
              {r.files.length > 0 && <span className="font-mono text-[11px] text-faint">{r.files.slice(0, 3).join(", ")}{r.files.length > 3 ? ` +${r.files.length - 3}` : ""}</span>}
            </span>
          ))}
        </span>
      ) : null,
    },
    { q: "Finished but not verified?", ids: data.answers.unverified, none: "Nothing is waiting on verification" },
    { q: "Ready for review?", ids: data.answers.review, none: "Nothing is waiting for review" },
    { q: "Safe to integrate next?", ids: data.answers.safeNext, none: "Nothing is verified and unblocked yet" },
  ];
  const live = data.tasks.filter((t) => t.status !== "done");

  return (
    <div className="flex-1 overflow-y-auto" data-testid="coordination">
      <div className="mx-auto max-w-[1120px] px-6 pb-16 pt-5">
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-ink">Coordination</h1>
          <span className="text-[12px] text-faint">
            {data.tasks.length} tasks · computed {ago(data.computedAt)} from the engine
          </span>
          <span className="ml-auto flex items-center gap-1">
            <button onClick={load} aria-label="Refresh" title="Refresh" className="grid size-7 place-items-center rounded-sm text-muted hover:bg-hover hover:text-ink">
              <RefreshCw size={13} />
            </button>
            <button onClick={onNewTask} disabled={!canEdit} title={canEdit ? "New Relay task" : "Viewers can't create tasks"} className="h-7 rounded-sm bg-accent px-2.5 text-[12.5px] font-medium text-accent-fg hover:brightness-110 disabled:opacity-40">
              New task
            </button>
          </span>
        </header>

        {data.tasks.length === 0 ? (
          <div className="mt-10 max-w-[560px]">
            <p className="text-[14px] font-medium text-ink">No tasks yet</p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-muted">A task gives one piece of work a scope (the files it may change), the contracts it depends on and the checks that prove it. Agents and people then work in parallel without stepping on each other, and Relay shows here what is running, what blocks what and what is safe to integrate.</p>
            <button onClick={onNewTask} disabled={!canEdit} className="mt-4 h-7 rounded-sm bg-accent px-2.5 text-[12.5px] font-medium text-accent-fg disabled:opacity-40">
              Create the first task
            </button>
          </div>
        ) : (
          <>
            <section aria-label="Answers" className="mt-4 grid gap-px overflow-hidden rounded-md border border-rule bg-rule sm:grid-cols-2 lg:grid-cols-3" data-testid="coord-answers">
              {answers.map((a) => (
                <div key={a.q} className="flex min-w-0 flex-col gap-1.5 bg-editor px-3.5 py-2.5">
                  <span className="text-[12px] text-muted">{a.q}</span>
                  {a.extra ?? (a.ids.length ? <span className="flex flex-wrap gap-1">{a.ids.map(chip)}</span> : <span className="text-[12.5px] text-faint">{a.none}</span>)}
                  {a.extra === null && <span className="text-[12.5px] text-faint">{a.none}</span>}
                </div>
              ))}
            </section>

            <DependencyGraph tasks={live} onOpen={onOpenTask} />

            {LANES.map((lane) => {
              const rows = data.tasks.filter((t) => lane.statuses.includes(t.status));
              if (!rows.length) return null;
              return (
                <section key={lane.id} aria-label={lane.title} className="mt-7" data-testid={`lane-${lane.id}`}>
                  <h2 className="flex items-baseline gap-2 text-[13px] font-semibold text-ink">
                    {lane.title} <span className="tnum font-normal text-faint">{rows.length}</span>
                    <span className="text-[12px] font-normal text-faint">{lane.hint}</span>
                  </h2>
                  <div className="mt-2 divide-y divide-rule overflow-hidden rounded-md border border-rule">
                    {rows.map((t) => (
                      <TaskRow key={t.id} t={t} canEdit={canEdit} busy={busy} owner={name(t.owner)} onOpenTask={onOpenTask} onOpenFile={onOpenFile} onOpenDiff={onOpenDiff} chip={chip} act={act} />
                    ))}
                  </div>
                </section>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

function TaskRow({ t, canEdit, busy, owner, onOpenTask, onOpenFile, onOpenDiff, chip, act }: { t: CoordTask; canEdit: boolean; busy: string | null; owner: string | null; onOpenTask: (id: string) => void; onOpenFile: (p: string) => void; onOpenDiff: (task: string, path: string) => void; chip: (id: string) => React.ReactNode; act: (key: string, method: "POST", path: string, ok: string) => Promise<void> }) {
  const pendingRun = t.run && t.run.status !== "applied" ? t.run : null;
  const live = t.run && (t.run.status === "running" || t.run.status === "starting");
  const btn = "inline-flex h-[24px] items-center gap-1.5 rounded-sm px-2 text-[12px] text-ink-2 hover:bg-hover hover:text-ink disabled:text-faint disabled:hover:bg-transparent";
  const checkWhy = !canEdit ? "Viewers can't run checks" : pendingRun ? "Agent work is checked in its own worktree when the run finishes" : !["running", "review_required", "blocked"].includes(t.state) ? "Only tasks in progress or in review are checked" : null;
  const startWhy = !canEdit ? "Viewers can't start agents" : t.state !== "queued" ? null : t.waitingOn.length ? `Waiting on ${t.waitingOn.join(", ")}` : null;
  return (
    <div className="group bg-editor px-3.5 py-2.5" data-testid={`coord-task-${t.id}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusLabel status={t.status} />
        <button onClick={() => onOpenTask(t.id)} className="font-mono text-[12px] text-muted hover:text-ink">
          {t.id}
        </button>
        <button onClick={() => onOpenTask(t.id)} className="min-w-0 flex-1 truncate text-left text-[13.5px] text-ink hover:underline">
          {t.objective}
        </button>
        <span className="flex shrink-0 items-center gap-0.5">
          {t.state === "queued" && (
            <button className={btn} disabled={!!startWhy || busy === `run:${t.id}`} title={startWhy ?? "Start an agent on this task in its own worktree"} onClick={() => void act(`run:${t.id}`, "POST", `/tasks/${encodeURIComponent(t.id)}/run`, `Agent started on ${t.id}.`)}>
              <Play size={12} /> Start agent
            </button>
          )}
          {live && (
            <button className={btn} disabled={!canEdit || busy === `stop:${t.id}`} title={canEdit ? "Stop the agent run" : "Viewers can't stop agents"} onClick={() => void act(`stop:${t.id}`, "POST", `/tasks/${encodeURIComponent(t.id)}/cancel-run`, `Stopped the agent on ${t.id}.`)}>
              <Square size={11} /> Stop
            </button>
          )}
          {["running", "review_required", "blocked"].includes(t.state) && (
            <button className={btn} disabled={!!checkWhy || busy === `check:${t.id}`} title={checkWhy ?? "Run the scope check and the task's verification commands now"} onClick={() => void act(`check:${t.id}`, "POST", `/tasks/${encodeURIComponent(t.id)}/check`, `Checked ${t.id}. Its record shows the result.`)}>
              <ShieldCheck size={12} /> {busy === `check:${t.id}` ? "Checking…" : "Run checks"}
            </button>
          )}
          <button className={btn} onClick={() => onOpenTask(t.id)} title={t.state === "review_required" ? "Open the review: evidence, approval and integration" : "Open the task"}>
            {t.state === "review_required" ? "Review" : "Open"} <ArrowRight size={12} />
          </button>
        </span>
      </div>
      <p className="mt-1 text-[12.5px] text-muted">{t.why}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-muted">
        {(t.agent || t.run) && <span title="Who is doing the work">{t.run ? t.run.provider : t.agent}</span>}
        {owner && <span title="Task owner">owner {owner}</span>}
        {pendingRun && (
          <span className="inline-flex items-center gap-1 font-mono text-[11px]" title="The agent's isolated git worktree; nothing there is in the shared project until it is applied">
            <GitBranch size={11} /> {pendingRun.worktree}
          </span>
        )}
        {t.run?.last && (
          <span className="truncate" title={t.run.last.text}>
            {t.run.last.text.slice(0, 80)} · {ago(t.run.last.at)}
          </span>
        )}
        {["running", "blocked", "review_required"].includes(t.state) && <Stages stages={t.stages} />}
      </div>
      {(t.files.length > 0 || t.waitingOn.length > 0 || t.blocks.length > 0 || t.partners.length > 0) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
          {t.files.length > 0 && (
            <span className="flex flex-wrap items-center gap-1">
              <FileDiff size={12} className="text-faint" />
              {t.files.slice(0, 4).map((f) => (
                <button key={f} onClick={() => (pendingRun || t.state !== "completed" ? onOpenDiff(t.id, f) : onOpenFile(f))} className={`font-mono text-[11.5px] hover:underline ${t.outOfScope.includes(f) ? "text-danger" : "text-ink-2"}`} title={t.outOfScope.includes(f) ? `${f} is outside the task's scope` : `Diff of ${f}`}>
                  {f.split("/").pop()}
                </button>
              ))}
              {t.files.length > 4 && <span className="text-faint">+{t.files.length - 4}</span>}
            </span>
          )}
          {t.waitingOn.length > 0 && <span className="flex items-center gap-1">waits on {t.waitingOn.map(chip)}</span>}
          {t.blocks.length > 0 && <span className="flex items-center gap-1">blocks {t.blocks.map(chip)}</span>}
          {t.partners.length > 0 && <span className="flex items-center gap-1" title="Tasks on the same contract integrate together">integrates with {t.partners.map(chip)}</span>}
        </div>
      )}
      {(t.overlaps.length > 0 || t.outOfScope.length > 0 || (t.run?.staleInputs ?? 0) > 0) && (
        <ul className="mt-2 space-y-1 text-[12px]">
          {t.overlaps.map((o) => (
            <li key={`${o.task}:${o.kind}`} className="flex flex-wrap items-center gap-1.5 text-warn" data-testid="coord-overlap">
              <TriangleAlert size={12} />
              {o.kind === "both-changed" ? "Also changed by" : "Changed files owned by"} {chip(o.task)}:
              {o.files.map((f) => (
                <button key={f} onClick={() => onOpenDiff(t.id, f)} className="font-mono text-[11.5px] underline-offset-2 hover:underline">
                  {f}
                </button>
              ))}
            </li>
          ))}
          {t.outOfScope.length > 0 && (
            <li className="flex items-center gap-1.5 text-danger">
              <CircleAlert size={12} /> {t.outOfScope.length} changed {t.outOfScope.length === 1 ? "file is" : "files are"} outside the task&apos;s scope; integration is blocked until that&apos;s resolved
            </li>
          )}
          {(t.run?.staleInputs ?? 0) > 0 && (
            <li className="flex items-center gap-1.5 text-warn">
              <TriangleAlert size={12} /> People edited {t.run!.staleInputs} {t.run!.staleInputs === 1 ? "file" : "files"} the agent read while it worked; Relay checks again before applying
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/**
 * Dependencies as a compact graph: tasks in columns by how many unfinished prerequisites stand before them. Solid
 * arrows are prerequisites, dashed links are shared contracts, amber links are overlapping files.
 */
function DependencyGraph({ tasks, onOpen }: { tasks: CoordTask[]; onOpen: (id: string) => void }) {
  const ids = new Set(tasks.map((t) => t.id));
  const edges = tasks.flatMap((t) => t.waitingOn.filter((p) => ids.has(p)).map((p) => ({ from: p, to: t.id })));
  const links = tasks.flatMap((t) => [
    ...t.partners.filter((p) => ids.has(p) && t.id < p).map((p) => ({ a: t.id, b: p, kind: "contract" as const })),
    ...t.overlaps.filter((o) => ids.has(o.task) && t.id < o.task).map((o) => ({ a: t.id, b: o.task, kind: "overlap" as const })),
  ]);
  if (!edges.length && !links.length) return null;
  // Depth = longest chain of unfinished prerequisites.
  const depth = new Map<string, number>();
  const d = (id: string, seen = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const t = tasks.find((x) => x.id === id);
    const v = t ? Math.max(0, ...t.waitingOn.filter((p) => ids.has(p)).map((p) => d(p, seen) + 1)) : 0;
    depth.set(id, v);
    return v;
  };
  const involved = [...new Set([...edges.flatMap((e) => [e.from, e.to]), ...links.flatMap((l) => [l.a, l.b])])].sort();
  for (const id of involved) d(id);
  const cols = new Map<number, string[]>();
  for (const id of involved) cols.set(depth.get(id)!, [...(cols.get(depth.get(id)!) ?? []), id]);
  const W = 220;
  const H = 30;
  const GX = 64;
  const GY = 14;
  const pos = new Map<string, { x: number; y: number }>();
  for (const [c, list] of cols) list.forEach((id, i) => pos.set(id, { x: 8 + c * (W + GX), y: 8 + i * (H + GY) }));
  const width = 16 + (Math.max(...cols.keys()) + 1) * (W + GX) - GX;
  const height = 16 + Math.max(...[...cols.values()].map((l) => l.length)) * (H + GY) - GY;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return (
    <section aria-label="Dependencies" className="mt-6" data-testid="coord-graph">
      <h2 className="flex items-baseline gap-2 text-[13px] font-semibold text-ink">
        Dependencies <span className="text-[12px] font-normal text-faint">arrows: must finish first · dashed: shared contract · amber: overlapping files</span>
      </h2>
      <div className="mt-2 overflow-x-auto rounded-md border border-rule bg-editor">
        <svg width={width} height={height} role="img" aria-label="Task dependency graph" className="block">
          <defs>
            <marker id="coord-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="var(--muted)" />
            </marker>
          </defs>
          {links.map((l) => {
            const a = pos.get(l.a)!;
            const b = pos.get(l.b)!;
            const same = a.x === b.x;
            const path = same ? `M${a.x + W},${a.y + H / 2} C${a.x + W + 34},${a.y + H / 2} ${b.x + W + 34},${b.y + H / 2} ${b.x + W},${b.y + H / 2}` : `M${a.x + W / 2},${a.y + H / 2} L${b.x + W / 2},${b.y + H / 2}`;
            return <path key={`${l.a}-${l.b}-${l.kind}`} d={path} fill="none" stroke={l.kind === "overlap" ? "var(--warn)" : "var(--faint)"} strokeWidth={1.25} strokeDasharray={l.kind === "contract" ? "4 3" : undefined} />;
          })}
          {edges.map((e) => {
            const a = pos.get(e.from)!;
            const b = pos.get(e.to)!;
            return <path key={`${e.from}>${e.to}`} d={`M${a.x + W},${a.y + H / 2} C${a.x + W + GX / 2},${a.y + H / 2} ${b.x - GX / 2},${b.y + H / 2} ${b.x - 2},${b.y + H / 2}`} fill="none" stroke="var(--muted)" strokeWidth={1.25} markerEnd="url(#coord-arrow)" />;
          })}
          {involved.map((id) => {
            const p = pos.get(id)!;
            const t = byId.get(id)!;
            return (
              <g key={id} transform={`translate(${p.x},${p.y})`} onClick={() => onOpen(id)} className="cursor-pointer" role="button" aria-label={`${id}: ${STATUS[t.status].label}`}>
                <rect width={W} height={H} rx={4} fill="var(--panel-2)" stroke="var(--rule-strong)" />
                <circle cx={12} cy={H / 2} r={3.5} fill={TONE[STATUS[t.status].tone]!.color} />
                <text x={22} y={H / 2 + 4} fontSize={11.5} fontFamily="var(--font-mono)" fill="var(--ink)">
                  {id}
                </text>
                <text x={W - 8} y={H / 2 + 4} fontSize={10.5} textAnchor="end" fill="var(--muted)">
                  {STATUS[t.status].label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}
