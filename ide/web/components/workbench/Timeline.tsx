"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { api } from "@/lib/api";

/** Mirrors src/analysis/timeline.ts. */
type Kind = "task" | "agent" | "check" | "integration" | "decision" | "contract" | "file" | "edit" | "git" | "member" | "investigation" | "other";
interface Entry {
  id: string;
  kind: Kind;
  type: string;
  recordedAt: string;
  occurredAt: { from: string; to: string | null } | null;
  actor: string;
  task: string | null;
  tasks: string[];
  summary: string;
}

const KINDS: { id: Kind; label: string }[] = [
  { id: "task", label: "Tasks" },
  { id: "agent", label: "Agents" },
  { id: "check", label: "Checks" },
  { id: "integration", label: "Integrations" },
  { id: "decision", label: "Decisions" },
  { id: "contract", label: "Contracts" },
  { id: "edit", label: "Edits" },
  { id: "file", label: "Files" },
  { id: "git", label: "Git" },
];

/** Who, in words: actors are recorded as kind:id (human:Ada, agent:claude-code, system:runner). */
const who = (actor: string) => {
  const [kind, id] = actor.includes(":") ? [actor.slice(0, actor.indexOf(":")), actor.slice(actor.indexOf(":") + 1)] : ["", actor];
  if (kind === "system") return id === "relay" ? "Relay" : `Relay (${id})`;
  if (kind === "agent") return `Agent ${id}`;
  return id;
};
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const day = (iso: string) => new Date(iso).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" });

/**
 * The flight recorder: everything Relay recorded, people's edit sessions and git commits, newest first, searchable and
 * filterable. When something happened is shown apart from when it was recorded whenever the two differ.
 */
export function TimelineView({ tick, onOpenTask }: { tick: number; onOpenTask: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [task, setTask] = useState("");
  const [kinds, setKinds] = useState<Kind[]>([]);
  const [data, setData] = useState<{ entries: Entry[]; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    const p = new URLSearchParams({ limit: "300" });
    if (q.trim()) p.set("q", q.trim());
    if (task.trim()) p.set("task", task.trim());
    if (kinds.length) p.set("kinds", kinds.join(","));
    api<{ entries: Entry[]; truncated: boolean }>("GET", `/timeline?${p}`).then(
      (d) => (setData(d), setError(null)),
      (e) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [q, task, kinds]);
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load, tick]);

  let lastDay = "";
  return (
    <div className="flex-1 overflow-y-auto" data-testid="timeline">
      <div className="mx-auto max-w-[1000px] px-6 pb-16 pt-5">
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-ink">Flight recorder</h1>
          <span className="text-[12px] text-faint">What happened in this project, newest first</span>
          <button onClick={load} aria-label="Refresh" title="Refresh" className="ml-auto grid size-7 place-items-center rounded-sm text-muted hover:bg-hover hover:text-ink">
            <RefreshCw size={13} />
          </button>
        </header>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <label className="flex h-[28px] min-w-[260px] flex-1 items-center gap-1.5 rounded-sm border border-rule bg-editor px-2 focus-within:border-accent">
            <Search size={13} className="text-faint" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search what happened, who, which task…" aria-label="Search the timeline" data-testid="timeline-search" className="min-w-0 flex-1 bg-transparent text-[13px] outline-none" />
          </label>
          <input value={task} onChange={(e) => setTask(e.target.value)} placeholder="Task id" aria-label="Only this task" data-testid="timeline-task" className="h-[28px] w-[110px] rounded-sm border border-rule bg-editor px-2 font-mono text-[12px] outline-none focus:border-accent" />
        </div>
        <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label="Show only">
          {KINDS.map((k) => {
            const on = kinds.includes(k.id);
            return (
              <button key={k.id} aria-pressed={on} onClick={() => setKinds((ks) => (on ? ks.filter((x) => x !== k.id) : [...ks, k.id]))} className={`h-[24px] rounded-sm border px-2 text-[12px] ${on ? "border-accent text-ink" : "border-rule text-muted hover:text-ink"}`}>
                {k.label}
              </button>
            );
          })}
        </div>
        {error && <p className="mt-4 text-[13px] text-danger">Couldn&apos;t load the timeline: {error}</p>}
        {!data && !error && <p className="mt-4 text-[13px] text-muted">Reading the record…</p>}
        {data && data.entries.length === 0 && <p className="mt-6 text-[13px] text-muted">Nothing matches.</p>}
        {data && data.entries.length > 0 && (
          <ol className="mt-4" data-testid="timeline-entries">
            {data.entries.map((e) => {
              const d = day(e.recordedAt);
              const head = d !== lastDay ? ((lastDay = d), <li key={`day:${d}`} className="sticky top-0 bg-editor pb-1 pt-3 text-[12px] font-medium text-muted">{d}</li>) : null;
              const occurred = e.occurredAt && (e.occurredAt.to ? `${time(e.occurredAt.from)}–${time(e.occurredAt.to)}` : `${day(e.occurredAt.from) === d ? "" : `${day(e.occurredAt.from)} `}${time(e.occurredAt.from)}`);
              return [
                head,
                <li key={e.id} className="flex gap-3 border-b border-rule py-1.5 text-[12.5px]" data-testid="timeline-entry" data-kind={e.kind}>
                  <span className="tnum w-[64px] shrink-0 font-mono text-[11.5px] text-faint" title={`Recorded ${e.recordedAt}`}>{time(e.recordedAt)}</span>
                  <span className="w-[78px] shrink-0 text-[11.5px] text-muted">{KINDS.find((k) => k.id === e.kind)?.label ?? "Other"}</span>
                  <span className="min-w-0 flex-1">
                    <span className="text-ink-2">{e.summary}</span>
                    <span className="mt-0.5 flex flex-wrap gap-x-2 text-[11.5px] text-faint">
                      <span>{who(e.actor)}</span>
                      {e.tasks.map((t) => (
                        <button key={t} onClick={() => onOpenTask(t)} className="font-mono hover:text-ink hover:underline">
                          {t}
                        </button>
                      ))}
                      {occurred && <span data-testid="occurred">{e.kind === "edit" ? `edits ${occurred}` : `happened ${occurred}`}, recorded {time(e.recordedAt)}</span>}
                    </span>
                  </span>
                </li>,
              ];
            })}
          </ol>
        )}
        {data?.truncated && <p className="mt-3 text-[12px] text-faint">Showing the newest 300. Search or filter to find older entries.</p>}
      </div>
    </div>
  );
}
