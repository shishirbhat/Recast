"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, CircleAlert, FileCode2, GitBranch, RefreshCw, TriangleAlert, X } from "lucide-react";
import { api } from "@/lib/api";
import type { Member, ProjectState, RelayEvent } from "@/lib/types";
import { describe } from "../Coordination";
import { GitHubPanel } from "./GitHub";

/* ---------- small shared pieces ---------- */

export function ViewHeader({ title, actions }: { title: string; actions?: React.ReactNode }) {
  return (
    <div className="flex h-[35px] shrink-0 items-center justify-between pl-5 pr-2">
      <span className="micro text-muted">{title}</span>
      <span className="flex items-center">{actions}</span>
    </div>
  );
}

export function Section({ title, count, children, defaultOpen = true }: { title: string; count?: number; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-rule first:border-t-0">
      <button onClick={() => setOpen((o) => !o)} className="micro flex h-6.5 w-full items-center gap-1 px-2 text-ink-2 hover:bg-hover">
        <span className={`inline-block w-3 text-center text-faint transition-transform ${open ? "rotate-90" : ""}`}>›</span>
        {title}
        {count !== undefined && count > 0 && <span className="tnum ml-auto mr-1 rounded-sm border border-rule px-1 text-[10px] text-muted">{count}</span>}
      </button>
      {open && <div className="pb-1.5">{children}</div>}
    </div>
  );
}

/* ---------- Search ---------- */

interface Hit {
  path: string;
  line: number;
  text: string;
}

function highlight(text: string, q: string) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0 || !q) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-[3px] bg-attention-soft px-px text-ink ring-1 ring-attention/30">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

export function SearchView({ onOpen, focusNonce }: { onOpen: (path: string, line?: number) => void; focusNonce: number }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<{ hits: Hit[]; truncated: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), [focusNonce]);
  useEffect(() => {
    if (!q.trim()) return setRes(null);
    setBusy(true);
    const t = setTimeout(() => {
      api<{ hits: Hit[]; truncated: boolean }>("GET", `/search?q=${encodeURIComponent(q)}`)
        .then(setRes)
        .finally(() => setBusy(false));
    }, 180);
    return () => clearTimeout(t);
  }, [q]);
  const groups = useMemo(() => {
    const m = new Map<string, Hit[]>();
    for (const h of res?.hits ?? []) m.set(h.path, [...(m.get(h.path) ?? []), h]);
    return [...m.entries()];
  }, [res]);
  return (
    <div className="flex h-full flex-col">
      <ViewHeader title="Search" />
      <div className="px-3 pb-2">
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search"
          data-testid="search-input"
          className="h-7.5 w-full rounded-md border border-rule bg-editor px-2.5 text-[13px] outline-none focus:border-accent focus-visible:outline-none"
        />
        <p className="mt-1.5 text-[11.5px] text-muted">{busy ? "Searching…" : res ? `${res.hits.length}${res.truncated ? "+" : ""} results in ${groups.length} files` : "Literal, case-insensitive, across shared files"}</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {groups.map(([path, hits]) => (
          <div key={path}>
            <button onClick={() => onOpen(path)} className="flex h-6 w-full items-center gap-1.5 px-3 text-[13px] hover:bg-hover">
              <FileCode2 size={13} className="text-faint" />
              <span className="font-medium text-ink">{path.split("/").pop()}</span>
              <span className="truncate text-[11.5px] text-faint">{path.split("/").slice(0, -1).join("/")}</span>
              <span className="tnum ml-auto rounded-sm border border-rule px-1 text-[10px] text-muted">{hits.length}</span>
            </button>
            {hits.map((h) => (
              <button key={h.line} onClick={() => onOpen(h.path, h.line)} className="flex h-6 w-full items-center gap-2 pl-8 pr-3 text-left font-mono text-[12px] text-ink-2 hover:bg-hover">
                <span className="w-7 shrink-0 text-right text-faint">{h.line}</span>
                <span className="truncate">{highlight(h.text.trimStart(), q)}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Source control ---------- */

const STATUS_LETTER: Record<string, { l: string; cls: string }> = {
  modified: { l: "M", cls: "text-warn" },
  added: { l: "A", cls: "text-ok" },
  untracked: { l: "U", cls: "text-ok" },
  deleted: { l: "D", cls: "text-danger" },
  renamed: { l: "R", cls: "text-accent-ink" },
};

export function SourceControlView({ onOpen, tick, canShip, notify }: { onOpen: (path: string) => void; tick: number; canShip: boolean; notify: (msg: string, tone?: "ok" | "danger") => void }) {
  const [st, setSt] = useState<{ branch: string | null; head: string | null; changes: { path: string; status: string }[] } | null>(null);
  const load = () => void api<typeof st>("GET", "/git").then(setSt);
  useEffect(load, [tick]);
  return (
    <div className="flex h-full flex-col">
      <ViewHeader
        title="Source Control"
        actions={
          <button aria-label="Refresh" title="Refresh" onClick={load} className="grid size-6 place-items-center rounded text-muted hover:bg-hover hover:text-ink">
            <RefreshCw size={13} />
          </button>
        }
      />
      <div className="px-4 pb-2 text-[12px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <GitBranch size={12} /> {st?.branch ?? "…"} <span className="font-mono text-faint">{st?.head}</span>
        </span>
      </div>
      <GitHubPanel canShip={canShip} tick={tick} notify={notify} />
      <Section title="Changes" count={st?.changes.length}>
        {st?.changes.length === 0 && <p className="px-5 py-1 text-[12.5px] text-muted">Working tree clean.</p>}
        {st?.changes.map((c) => (
          <button key={c.path} onClick={() => c.status !== "deleted" && onOpen(c.path)} className="flex h-6 w-full items-center gap-1.5 pl-5 pr-3 text-[13px] hover:bg-hover">
            <FileCode2 size={13} className="text-faint" />
            <span className={c.status === "deleted" ? "text-muted line-through" : "text-ink"}>{c.path.split("/").pop()}</span>
            <span className="truncate text-[11.5px] text-faint">{c.path.split("/").slice(0, -1).join("/")}</span>
            <span className={`ml-auto font-mono text-[11.5px] font-bold ${STATUS_LETTER[c.status]?.cls}`}>{STATUS_LETTER[c.status]?.l}</span>
          </button>
        ))}
      </Section>
    </div>
  );
}

/* ---------- Problems: Relay's coordination problems, in the place IDEs show diagnostics ---------- */

export interface Problem {
  severity: "error" | "warning";
  text: string;
  taskId?: string;
  path?: string;
}

export function problemsOf(state: ProjectState): Problem[] {
  const out: Problem[] = [];
  const current = new Map(state.contracts.map((c) => [c.id, c.history.filter((h) => h.status === "accepted").at(-1)?.version]));
  for (const t of state.tasks) {
    if (t.state === "completed" || t.state === "cancelled") continue;
    for (const [cid, v] of Object.entries(t.contracts)) {
      const cur = current.get(cid);
      if (cur !== undefined && cur > v) out.push({ severity: "error", text: `${t.id} is built on ${cid} v${v}; the accepted contract is v${cur}`, taskId: t.id });
    }
    if (t.state === "blocked") out.push({ severity: "error", text: `${t.id} is blocked`, taskId: t.id });
    if (t.state === "failed") out.push({ severity: "warning", text: `${t.id} failed and can be requeued`, taskId: t.id });
    for (const r of t.runs) for (const s of r.staleInputs) out.push({ severity: "warning", text: `${s.by} edited ${s.path} after the agent on ${t.id} started`, taskId: t.id, path: s.path });
  }
  for (const c of state.conflicts) out.push({ severity: "error", text: `An outside edit to ${c.doc.replace(/^file:/, "")} conflicted with the shared copy and was kept for review`, path: c.doc.replace(/^file:/, "") });
  for (const c of state.contracts) for (const h of c.history) if (h.status === "proposed") out.push({ severity: "warning", text: `${c.id} v${h.version} is proposed and waiting for an owner`, taskId: undefined });
  return out;
}

export type PanelTab = "terminal" | "problems" | "output" | "agents" | "activity";

export function BottomPanel({ tab, setTab, state, events, members, onTask, onOpen, onClose, terminal, output }: { tab: PanelTab; setTab: (t: PanelTab) => void; state: ProjectState; events: RelayEvent[]; members: Member[]; onTask: (id: string) => void; onOpen: (p: string) => void; onClose: () => void; terminal: React.ReactNode; output: React.ReactNode }) {
  const problems = problemsOf(state);
  const runs = state.tasks.flatMap((t) => t.runs.map((r) => ({ ...r, taskId: t.id }))).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const tabs: [PanelTab, string, number?][] = [
    ["terminal", "Terminal"],
    ["problems", "Problems", problems.length],
    ["output", "Output"],
    ["agents", "Agents", runs.filter((r) => r.status === "running").length],
    ["activity", "Activity"],
  ];
  return (
    <div className="flex h-full flex-col bg-editor">
      <div role="tablist" aria-label="Panel" className="flex h-[35px] shrink-0 items-center gap-4 pl-4 pr-2">
        {tabs.map(([id, label, n]) => (
          <button key={id} role="tab" aria-selected={tab === id} data-testid={`panel-tab-${id}`} onClick={() => setTab(id)} className={`relative flex h-full items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.04em] ${tab === id ? "text-ink" : "text-muted hover:text-ink"}`}>
            {label}
            {!!n && <span className={`tnum rounded-sm px-1 font-mono text-[10px] ${id === "problems" ? "bg-danger-soft text-danger" : "bg-accent-soft text-accent-ink"}`}>{n}</span>}
            {tab === id && <span className="absolute inset-x-0 bottom-1 h-px bg-ink" />}
          </button>
        ))}
        <button aria-label="Close panel" title="Close panel" onClick={onClose} className="ml-auto grid size-6 place-items-center rounded text-muted hover:bg-hover hover:text-ink">
          <X size={14} />
        </button>
      </div>
      {/* The terminal stays mounted while other tabs are shown, so its sessions keep running. */}
      <div className={`min-h-0 flex-1 ${tab === "terminal" ? "" : "hidden"}`}>{terminal}</div>
      {tab === "output" && <div className="min-h-0 flex-1 overflow-y-auto">{output}</div>}
      <div className={`min-h-0 flex-1 overflow-y-auto py-1 font-mono text-[12.5px] ${tab === "terminal" || tab === "output" ? "hidden" : ""}`}>
        {tab === "problems" &&
          (problems.length === 0 ? (
            <p className="px-4 py-2 font-sans text-[13px] text-muted">No coordination problems. Contracts, tasks and shared files agree.</p>
          ) : (
            problems.map((p, i) => (
              <button key={i} onClick={() => (p.taskId ? onTask(p.taskId) : p.path && onOpen(p.path))} className="flex w-full items-center gap-2 px-4 py-1 text-left hover:bg-hover">
                {p.severity === "error" ? <CircleAlert size={13} className="shrink-0 text-danger" /> : <TriangleAlert size={13} className="shrink-0 text-warn" />}
                <span className="font-sans text-[13px] text-ink-2">{p.text}</span>
                {p.taskId && <span className="ml-auto text-[11.5px] text-faint">{p.taskId}</span>}
              </button>
            ))
          ))}
        {tab === "agents" &&
          (runs.length === 0 ? (
            <p className="px-4 py-2 font-sans text-[13px] text-muted">No agent runs yet. Start one from a ready task in the Relay side bar.</p>
          ) : (
            runs.map((r) => (
              <div key={r.id} className="border-b border-rule/70 px-4 py-2 last:border-0">
                <button onClick={() => onTask(r.taskId)} className="flex items-center gap-2 font-sans text-[13px] hover:underline">
                  <Bot size={13} className="text-accent" /> <strong>{r.taskId}</strong> <span className="text-muted">· Claude Code · {r.status}</span>
                  {r.costUsd !== null && <span className="text-faint">· ${r.costUsd.toFixed(2)}</span>}
                </button>
                <ol className="mt-1 space-y-px">
                  {r.activity.filter((a) => a.kind !== "text").slice(-12).map((a, i) => (
                    <li key={i} className={`flex gap-3 ${a.kind === "denied" || a.kind === "error" ? "text-danger" : "text-ink-2"}`}>
                      <span className="w-16 shrink-0 text-faint">{new Date(a.at).toLocaleTimeString([], { hour12: false })}</span>
                      <span className="truncate">{a.kind === "tool" ? `${a.tool} ${a.target ?? ""}` : (a.detail ?? a.kind)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ))
          ))}
        {tab === "activity" &&
          events
            .slice(-200)
            .reverse()
            .map((e) => (
              <div key={e.id} className="flex gap-3 px-4 py-0.5 hover:bg-hover">
                <span className="w-16 shrink-0 text-faint">{new Date(e.at).toLocaleTimeString([], { hour12: false })}</span>
                <span className={`font-sans text-[13px] ${e.type === "enforcement.decision" && e.data.decision === "deny" ? "text-danger" : "text-ink-2"}`}>{describe(e, members)}</span>
              </div>
            ))}
      </div>
    </div>
  );
}
