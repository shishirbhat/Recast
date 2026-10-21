"use client";

import { useEffect, useRef, useState } from "react";
import { Eye, History, LocateFixed, UserPlus, X } from "lucide-react";
import { api } from "@/lib/api";
import type { Member } from "@/lib/types";
import { initials } from "../ui";

interface Participant {
  memberId: string;
  path: string;
  at: number;
  typedAt: number | null;
  typing: boolean;
}

/**
 * Who is in the project right now, as Google Docs shows it: overlapping coloured avatars at the top (you included),
 * a pencil dot on whoever is typing, "+N" past five, and a card per person with where they are and Go to / Follow.
 * Colours are each member's own, the same as their caret and name flag in the editor and their line-authorship bar.
 */
export function PresenceBar({ me, members, online, participants, following, onJump, onFollow, onOpen, onInvite, canInvite }: { me: Member; members: Member[]; online: string[]; participants: Participant[]; following: string | null; onJump: (id: string) => void; onFollow: (id: string | null) => void; onOpen: (path: string) => void; onInvite: () => void; canInvite: boolean }) {
  const [open, setOpen] = useState<string | "all" | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(null);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("mousedown", off);
    window.addEventListener("keydown", esc);
    return () => (window.removeEventListener("mousedown", off), window.removeEventListener("keydown", esc));
  }, [open]);

  const where = (id: string) => participants.find((p) => p.memberId === id);
  const here = members.filter((m) => m.id === me.id || online.includes(m.id) || where(m.id));
  // Typing first, then people in a file, then the rest; you last, as in Docs.
  const rank = (m: Member) => (m.id === me.id ? 3 : where(m.id)?.typing ? 0 : where(m.id) ? 1 : 2);
  const ordered = [...here].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const shown = ordered.slice(0, 5);
  const extra = ordered.length - shown.length;
  const label = (m: Member) => {
    const w = where(m.id);
    return `${m.name}${m.id === me.id ? " (you)" : ""}${w ? ` · ${w.typing ? "typing in" : "in"} ${w.path}` : " · online"}`;
  };

  const card = (m: Member) => {
    const w = where(m.id);
    const isMe = m.id === me.id;
    return (
      <div key={m.id} className="flex items-start gap-2.5 px-3 py-2" data-testid={`presence-card-${m.id}`}>
        <span className="relative mt-0.5 grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white" style={{ background: m.color }}>
          {initials(m.name)}
          <span className={`absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-[var(--panel-2)] ${online.includes(m.id) || isMe ? "bg-ok" : "bg-faint"}`} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-[13px] text-ink">
            <span className="truncate">{m.name}</span>
            {isMe && <span className="text-[11.5px] text-muted">(you)</span>}
            <span className="ml-auto text-[11px] text-faint">{m.role}</span>
          </span>
          {w ? (
            <button onClick={() => (onOpen(w.path), setOpen(null))} className="block max-w-full truncate font-mono text-[11.5px] text-muted hover:text-ink hover:underline" title={`Open ${w.path}`}>
              {w.typing ? "typing in " : ""}
              {w.path}
            </button>
          ) : (
            <span className="block text-[11.5px] text-faint">{online.includes(m.id) || isMe ? "Online, no file open" : "Offline"}</span>
          )}
          {!isMe && w && (
            <span className="mt-1.5 flex gap-1">
              <button onClick={() => (onJump(m.id), setOpen(null))} className="inline-flex h-[22px] items-center gap-1 rounded-sm border border-rule px-1.5 text-[11.5px] text-ink-2 hover:bg-hover" data-testid={`presence-goto-${m.id}`}>
                <LocateFixed size={11} /> Go to
              </button>
              <button onClick={() => (onFollow(following === m.id ? null : m.id), setOpen(null))} className={`inline-flex h-[22px] items-center gap-1 rounded-sm border px-1.5 text-[11.5px] hover:bg-hover ${following === m.id ? "border-accent-line text-accent-ink" : "border-rule text-ink-2"}`} data-testid={`presence-follow-${m.id}`}>
                <Eye size={11} /> {following === m.id ? "Stop following" : "Follow"}
              </button>
            </span>
          )}
        </span>
      </div>
    );
  };

  return (
    <div ref={root} className="relative mr-1.5 hidden items-center gap-2 sm:flex" data-testid="presence-bar">
      <div role="list" aria-label={`${here.length} ${here.length === 1 ? "person" : "people"} in this project now`} className="flex items-center">
        {shown.map((m, i) => {
          const w = where(m.id);
          return (
            <button
              key={m.id}
              role="listitem"
              aria-label={label(m)}
              title={label(m)}
              onClick={() => setOpen(open === m.id ? null : m.id)}
              data-testid={`presence-${m.id}`}
              className="relative grid size-[26px] shrink-0 place-items-center rounded-full text-[10.5px] font-semibold text-white transition-transform hover:z-10 hover:-translate-y-px focus-visible:z-10"
              style={{ background: m.color, marginLeft: i ? -6 : 0, zIndex: shown.length - i, boxShadow: `0 0 0 2px var(--chrome)${following === m.id ? `, 0 0 0 3.5px ${m.color}` : ""}` }}
            >
              {initials(m.name)}
              {w?.typing && (
                <span className="absolute -bottom-1 -right-1 grid size-[12px] place-items-center rounded-full bg-[var(--chrome)]" aria-hidden>
                  <span className="size-[7px] rounded-full" style={{ background: m.color, boxShadow: "0 0 0 1px var(--chrome)" }} />
                </span>
              )}
            </button>
          );
        })}
        {extra > 0 && (
          <button onClick={() => setOpen(open === "all" ? null : "all")} aria-label={`${extra} more people`} className="relative -ml-1.5 grid size-[26px] place-items-center rounded-full bg-sunken text-[10px] font-semibold text-ink-2" style={{ boxShadow: "0 0 0 2px var(--chrome)" }}>
            +{extra}
          </button>
        )}
      </div>
      <button onClick={() => setOpen(open === "all" ? null : "all")} className="tnum text-[11.5px] text-muted hover:text-ink" data-testid="presence-count" title="Everyone in this project">
        {here.length} here
      </button>
      {canInvite && (
        <button onClick={onInvite} className="inline-flex h-[24px] items-center gap-1.5 rounded-sm border border-rule-strong px-2 text-[12px] font-medium text-ink-2 hover:bg-hover hover:text-ink" title="Invite someone to this project">
          <UserPlus size={12} /> Share
        </button>
      )}
      {open && (
        <div role="dialog" aria-label="People in this project" className="glass absolute right-0 top-full z-50 mt-1.5 max-h-[70vh] w-80 overflow-y-auto rounded-md border border-rule-strong py-1">
          {open === "all" ? (
            <>
              <p className="px-3 pb-1 pt-1.5 text-[12px] text-muted">
                {here.length} here now · {members.length} {members.length === 1 ? "member" : "members"}
              </p>
              {ordered.map(card)}
              {members.filter((m) => !here.includes(m)).map(card)}
            </>
          ) : (
            card(members.find((m) => m.id === open)!)
          )}
        </div>
      )}
    </div>
  );
}

interface Origin {
  author: string;
  kind: "member" | "agent" | "baseline" | "disk" | "unknown";
  text: string;
  at: string | null;
  seq: number | null;
  session: string | null;
}

/**
 * One line's history: every part of it with who wrote it, when, and the edit session it came from (which opens as a
 * diff). Read from Relay's update log and authorship records, so it survives restarts and is the same for everyone.
 */
export function LineHistory({ path, line, members, onClose, onShowSession }: { path: string; line: number; members: Member[]; onClose: () => void; onShowSession: (id: string) => void }) {
  const [origins, setOrigins] = useState<Origin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setOrigins(null);
    setError(null);
    api<{ origins: Origin[] }>("GET", `/attribution/line?path=${encodeURIComponent(path)}&line=${line}`).then(
      (r) => setOrigins(r.origins),
      (e) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [path, line]);
  const who = (o: Origin) => {
    const m = members.find((x) => x.id === o.author);
    if (m) return { name: m.name, color: m.color };
    if (o.kind === "agent") return { name: `Agent ${o.author.replace(/^agent:/, "")}`, color: "var(--accent)" };
    if (o.kind === "baseline") return { name: "Already in the file", color: "var(--faint)" };
    if (o.kind === "disk") return { name: "Changed outside Relay", color: "var(--faint)" };
    return { name: o.author, color: "var(--muted)" };
  };
  const when = (iso: string) => new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  return (
    <div role="dialog" aria-label={`History of line ${line}`} className="glass fixed bottom-8 right-4 z-50 w-[420px] max-w-[calc(100vw-32px)] rounded-md border border-rule-strong" data-testid="line-history">
      <div className="flex items-center gap-2 border-b border-rule px-3 py-2">
        <History size={13} className="text-muted" />
        <span className="text-[12.5px] font-medium text-ink">Who wrote line {line}</span>
        <span className="truncate font-mono text-[11px] text-faint">{path}</span>
        <button aria-label="Close" onClick={onClose} className="ml-auto grid size-6 place-items-center rounded-sm text-muted hover:bg-hover hover:text-ink">
          <X size={13} />
        </button>
      </div>
      <div className="max-h-72 overflow-y-auto py-1">
        {error && <p className="px-3 py-2 text-[12.5px] text-danger">{error}</p>}
        {!origins && !error && <p className="px-3 py-2 text-[12.5px] text-muted">Reading the edit history…</p>}
        {origins?.length === 0 && <p className="px-3 py-2 text-[12.5px] text-muted">This line is blank.</p>}
        {origins?.map((o, i) => {
          const w = who(o);
          return (
            <div key={i} className="flex items-start gap-2.5 px-3 py-1.5" data-testid="line-origin">
              <span className="mt-[5px] size-2.5 shrink-0 rounded-full" style={{ background: w.color }} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2 text-[12.5px]">
                  <span className="font-medium text-ink">{w.name}</span>
                  {o.at && <span className="tnum text-[11.5px] text-faint">{o.kind === "baseline" ? `loaded ${when(o.at)}` : when(o.at)}</span>}
                </span>
                <code className="mt-0.5 block truncate rounded-sm bg-sunken px-1.5 py-0.5 font-mono text-[11.5px] text-ink-2">{o.text.trim()}</code>
              </span>
              {o.session && (
                <button onClick={() => onShowSession(o.session!)} className="mt-0.5 shrink-0 rounded-sm px-1.5 py-0.5 text-[11.5px] text-accent-ink hover:bg-hover" title="Open the edit session that wrote this, as a diff">
                  Show change
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
