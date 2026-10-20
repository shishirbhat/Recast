"use client";

import { useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, Eye, TriangleAlert } from "lucide-react";
import type { ProjectState } from "@/lib/types";
import type { TestRunView } from "@/lib/useProject";

/**
 * "Is anything blocking me, and what should I do next?" Only situations that need a person are listed here; routine
 * activity (an agent working, a sync, a passing run) never is. Each item says what happened, why it matters, and offers
 * one next action.
 */
export interface AttentionItem {
  key: string;
  /** block: work can't proceed; review: someone has to look; info: worth knowing, nothing broken. */
  level: "block" | "review" | "info";
  title: string;
  why: string;
  action: { label: string; run: () => void };
}

export interface AttentionActions {
  openTask: (id: string) => void;
  openContracts: () => void;
  openFile: (path: string) => void;
  showTests: () => void;
}

export function attentionOf(state: ProjectState, tests: TestRunView | null, go: AttentionActions): AttentionItem[] {
  const out: AttentionItem[] = [];
  const isOwner = state.me.role === "owner";
  const accepted = new Map(state.contracts.map((c) => [c.id, c.history.filter((h) => h.status === "accepted").at(-1)?.version]));
  for (const t of state.tasks) {
    if (t.state === "completed" || t.state === "cancelled") continue;
    const open = { label: "Open task", run: () => go.openTask(t.id) };
    if (t.state === "review_required") out.push({ key: `review:${t.id}`, level: "review", title: `${t.id} is ready for review`, why: t.objective, action: { label: "Review", run: () => go.openTask(t.id) } });
    if (t.state === "proposed" && isOwner) out.push({ key: `proposed:${t.id}`, level: "review", title: `${t.id} is waiting for approval to start`, why: t.objective, action: { label: "Review plan", run: () => go.openTask(t.id) } });
    if (t.state === "blocked") out.push({ key: `blocked:${t.id}`, level: "block", title: `${t.id} is blocked`, why: "Work on it can't continue until the cause is resolved; the task shows why.", action: open });
    const run = t.runs.at(-1);
    if (t.state === "failed" || run?.status === "failed") out.push({ key: `failed:${t.id}:${run?.id ?? ""}`, level: "block", title: run?.status === "failed" ? `The agent on ${t.id} failed` : `${t.id} failed`, why: "Its log and the last error are in the task. It can be requeued once the cause is fixed.", action: { label: "Investigate", run: () => go.openTask(t.id) } });
    for (const [cid, v] of Object.entries(t.contracts)) {
      const cur = accepted.get(cid);
      if (cur !== undefined && cur > v) out.push({ key: `stale:${t.id}:${cid}:${cur}`, level: "block", title: `${t.id} is built on ${cid} v${v}, but v${cur} is accepted`, why: "Its work may not match what other tasks now expect, so it can't be integrated until it's updated to the current version.", action: open });
    }
    for (const s of run?.status === "running" ? run.staleInputs : []) out.push({ key: `input:${t.id}:${s.path}`, level: "info", title: `${s.by} edited ${s.path} while the agent on ${t.id} was working`, why: "The agent's copy is older. Relay checks this again before anything is applied.", action: open });
  }
  if (isOwner)
    for (const c of state.contracts)
      for (const h of c.history)
        if (h.status === "proposed") out.push({ key: `contract:${c.id}:${h.version}`, level: "review", title: `${c.id} v${h.version} is proposed`, why: "Tasks that depend on this contract keep building on the accepted version until an owner decides.", action: { label: "Review contract", run: go.openContracts } });
  for (const c of state.conflicts) {
    const path = c.doc.replace(/^file:/, "");
    out.push({ key: `conflict:${c.id}`, level: "block", title: `An outside edit to ${path} conflicted`, why: "Both versions were kept. Nothing was overwritten; the shared copy needs a person to merge them.", action: { label: "Open file", run: () => go.openFile(path) } });
  }
  const failing = tests && tests.status !== "running" && !tests.stale ? tests.results.filter((r) => r.status === "fail").length : 0;
  if (failing) out.push({ key: `tests:${tests!.id}`, level: "block", title: `${failing} test${failing === 1 ? "" : "s"} failing`, why: `From ${tests!.command}, run on the current files.`, action: { label: "Show tests", run: go.showTests } });
  const rank = { block: 0, review: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

const ICON = {
  block: <CircleAlert size={14} className="mt-px shrink-0 text-danger" />,
  review: <Eye size={14} className="mt-px shrink-0 text-warn" />,
  info: <TriangleAlert size={14} className="mt-px shrink-0 text-muted" />,
};

/** The title-bar control and its list. Quiet when there is nothing to do. */
export function AttentionButton({ items }: { items: AttentionItem[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => (window.removeEventListener("mousedown", close), window.removeEventListener("keydown", close));
  }, [open]);
  useEffect(() => {
    const toggle = () => setOpen((o) => !o);
    window.addEventListener("relay:attention", toggle);
    return () => window.removeEventListener("relay:attention", toggle);
  }, []);
  const needs = items.filter((i) => i.level !== "info");
  const blocking = items.some((i) => i.level === "block");
  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        data-testid="attention"
        aria-expanded={open}
        aria-label={needs.length ? `${needs.length} need${needs.length === 1 ? "s" : ""} you` : "Nothing needs you"}
        className={`flex h-[24px] items-center gap-1.5 rounded-sm px-2 text-[12.5px] transition-colors hover:bg-hover ${blocking ? "text-danger" : needs.length ? "text-warn" : "text-muted"}`}
      >
        {needs.length ? <span className={`size-1.5 rounded-full ${blocking ? "bg-danger" : "bg-warn"}`} /> : <CircleCheck size={13} />}
        {needs.length ? `${needs.length} need${needs.length === 1 ? "s" : ""} you` : "All clear"}
      </button>
      {open && (
        <div role="dialog" aria-label="What needs you" className="glass absolute right-0 top-full z-50 mt-1.5 w-[420px] max-w-[calc(100vw-24px)] overflow-hidden rounded-md border border-rule-strong" data-testid="attention-list">
          {items.length === 0 ? (
            <p className="px-4 py-4 text-[13px] text-muted">Nothing needs you. Agents and teammates keep working in the background; anything that needs a decision shows up here.</p>
          ) : (
            <ul className="max-h-[60vh] divide-y divide-rule overflow-y-auto">
              {items.map((i) => (
                <li key={i.key} className="flex gap-2.5 px-3.5 py-2.5" data-level={i.level}>
                  {ICON[i.level]}
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium leading-snug text-ink">{i.title}</p>
                    <p className="mt-0.5 text-[12.5px] leading-snug text-muted">{i.why}</p>
                  </div>
                  <button onClick={() => (setOpen(false), i.action.run())} className="h-[24px] shrink-0 self-center rounded-sm border border-rule px-2 text-[12px] text-ink-2 hover:border-rule-strong hover:bg-hover hover:text-ink">
                    {i.action.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
