"use client";

import { useEffect, useState } from "react";
import { Box, Braces, ChevronRight, Circle, FileCode2, GitCommitHorizontal, Hash, Pencil, Variable, X } from "lucide-react";
import { api } from "@/lib/api";
import type { Member } from "@/lib/types";
import { timeAgo } from "../ui";

/**
 * The lower Explorer sections, as VS Code has them: Open Editors, Outline (symbols of the active file, from the
 * server's parser) and Timeline (the file's Git commits and Relay edit sessions, newest first).
 */

function Pane({ title, count, open, setOpen, actions, children, grow = false, testId }: { title: string; count?: number; open: boolean; setOpen: (b: boolean) => void; actions?: React.ReactNode; children: React.ReactNode; grow?: boolean; testId?: string }) {
  return (
    <div className={`flex min-h-0 flex-col border-t border-rule ${open && grow ? "max-h-[38%] shrink" : "shrink-0"}`} data-testid={testId}>
      <div className="group flex h-[24px] shrink-0 items-center gap-1 pl-1 pr-2">
        <button onClick={() => setOpen(!open)} aria-expanded={open} className="micro flex min-w-0 flex-1 items-center gap-1 text-left text-muted hover:text-ink">
          <ChevronRight size={13} className={`shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} />
          <span className="truncate">{title}</span>
          {count !== undefined && count > 0 && <span className="tnum ml-1 text-[11px] font-normal text-faint">{count}</span>}
        </button>
        {open && actions}
      </div>
      {open && <div className="min-h-0 overflow-y-auto pb-1.5">{children}</div>}
    </div>
  );
}

export function OpenEditorsPane({ tabs, active, title, onOpen, onClose }: { tabs: string[]; active: string | null; title: (t: string) => string; onOpen: (t: string) => void; onClose: (t: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Pane title="Open Editors" count={tabs.length} open={open} setOpen={setOpen} testId="open-editors">
      {tabs.length === 0 && <p className="px-5 py-1 text-[12.5px] text-muted">No editors are open.</p>}
      {tabs.map((t) => (
        <div key={t} className={`group flex h-[22px] items-center gap-1.5 pl-3 pr-2 text-[13px] ${t === active ? "bg-hover text-ink" : "text-ink-2 hover:bg-hover"}`}>
          <button aria-label={`Close ${t}`} onClick={() => onClose(t)} className="grid size-4 place-items-center text-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100">
            <X size={12} />
          </button>
          <button onClick={() => onOpen(t)} className="min-w-0 truncate text-left">
            {title(t)} <span className="text-[11.5px] text-faint">{t.includes("/") && !t.includes(":") ? t.split("/").slice(0, -1).join("/") : ""}</span>
          </button>
        </div>
      ))}
    </Pane>
  );
}

const KIND_ICON: Record<string, React.ReactNode> = {
  function: <Box size={13} className="text-[var(--syn-fn)]" />,
  method: <Box size={13} className="text-[var(--syn-fn)]" />,
  class: <Braces size={13} className="text-[var(--syn-type)]" />,
  interface: <Braces size={13} className="text-[var(--syn-type)]" />,
  type: <Braces size={13} className="text-[var(--syn-type)]" />,
  enum: <Braces size={13} className="text-[var(--syn-type)]" />,
  variable: <Variable size={13} className="text-[var(--syn-prop)]" />,
  constant: <Variable size={13} className="text-[var(--syn-number)]" />,
  property: <Circle size={10} className="text-[var(--syn-prop)]" />,
  heading: <Hash size={13} className="text-muted" />,
};

export function OutlinePane({ path, symbols, cursorLine, onGo }: { path: string | null; symbols: { name: string; kind: string; line: number; endLine: number; depth: number }[]; cursorLine: number; onGo: (line: number) => void }) {
  const [open, setOpen] = useState(true);
  const here = symbols.filter((s) => s.line <= cursorLine && cursorLine <= s.endLine).at(-1);
  return (
    <Pane title="Outline" count={symbols.length} open={open} setOpen={setOpen} grow testId="outline">
      {!path && <p className="px-5 py-1 text-[12.5px] text-muted">The active editor cannot provide outline information.</p>}
      {path && symbols.length === 0 && <p className="px-5 py-1 text-[12.5px] text-muted">No symbols found in {path.split("/").pop()}.</p>}
      {symbols.map((s, i) => (
        <button key={`${s.name}${s.line}${i}`} onClick={() => onGo(s.line)} className={`flex h-[22px] w-full items-center gap-1.5 pr-2 text-left text-[13px] ${s === here ? "bg-hover text-ink" : "text-ink-2 hover:bg-hover"}`} style={{ paddingLeft: 14 + s.depth * 14 }}>
          {KIND_ICON[s.kind] ?? <FileCode2 size={13} className="text-faint" />}
          <span className="truncate">{s.name}</span>
          <span className="ml-auto shrink-0 font-mono text-[10.5px] text-faint">{s.line}</span>
        </button>
      ))}
    </Pane>
  );
}

interface History {
  sessions: { id: string; author: string; startedAt: string; endedAt: string; inserted: number; deleted: number; lineMin: number | null; lineMax: number | null }[];
  commits: { sha: string; author: string; date: string; subject: string }[];
}

export function TimelinePane({ path, tick, members, onCommit, onSession }: { path: string | null; tick: number; members: Member[]; onCommit: (sha: string) => void; onSession: (author: string) => void }) {
  const [open, setOpen] = useState(false);
  const [h, setH] = useState<History | null>(null);
  useEffect(() => {
    if (!open || !path) return setH(null);
    let live = true;
    const t = setTimeout(() => void api<History>("GET", `/history?path=${encodeURIComponent(path)}`).then((r) => live && setH(r), () => live && setH({ sessions: [], commits: [] })), 200);
    return () => ((live = false), clearTimeout(t));
  }, [open, path, tick]);
  const name = (id: string) => members.find((m) => m.id === id)?.name ?? id.replace(/^relay:/, "").replace(/^agent:/, "agent ");
  const rows = h
    ? [
        ...h.commits.map((c) => ({ key: `c${c.sha}`, at: c.date, kind: "commit" as const, title: c.subject, who: c.author, detail: c.sha, run: () => onCommit(c.sha) })),
        ...h.sessions.map((s) => ({ key: `s${s.id}`, at: s.endedAt, kind: "edit" as const, title: `Edited${s.lineMin !== null ? ` lines ${s.lineMin}–${s.lineMax}` : ""}`, who: name(s.author), detail: `+${s.inserted} −${s.deleted}`, run: () => onSession(s.author) })),
      ].sort((a, b) => b.at.localeCompare(a.at))
    : [];
  return (
    <Pane title="Timeline" count={rows.length} open={open} setOpen={setOpen} grow testId="timeline">
      {!path && <p className="px-5 py-1 text-[12.5px] text-muted">The active editor cannot provide timeline information.</p>}
      {path && !h && <p className="px-5 py-1 text-[12.5px] text-muted">Loading…</p>}
      {path && h && rows.length === 0 && <p className="px-5 py-1 text-[12.5px] text-muted">No commits or Relay edits for this file yet.</p>}
      {rows.map((r) => (
        <button key={r.key} onClick={r.run} className="flex w-full items-start gap-1.5 px-3 py-[3px] text-left text-[13px] hover:bg-hover" title={r.kind === "commit" ? "Open the changes in this commit" : "Show this person's contributions"}>
          {r.kind === "commit" ? <GitCommitHorizontal size={13} className="mt-[3px] shrink-0 text-muted" /> : <Pencil size={12} className="mt-[3px] shrink-0 text-muted" />}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-ink-2">{r.title}</span>
            <span className="block truncate text-[11.5px] text-faint">
              {r.who} · {timeAgo(r.at)} · <span className="font-mono">{r.detail}</span>
            </span>
          </span>
        </button>
      ))}
    </Pane>
  );
}
