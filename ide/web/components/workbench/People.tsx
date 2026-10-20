"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Bot, Crosshair, Eye, EyeOff, UserPlus, UserX } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { Presence } from "@/lib/useProject";
import type { Member } from "@/lib/types";
import { Avatar, timeAgo } from "../ui";
import { Section, ViewHeader } from "./Views";

interface Totals {
  sessions: number;
  files: number;
  inserted: number;
  deleted: number;
  wsInserted: number;
  wsDeleted: number;
  lastAt: string;
}
interface Person {
  id: string;
  name: string;
  kind: "human" | "agent";
  role: string;
  color: string;
  status: "active" | "idle" | "away" | "online" | "offline";
  path: string | null;
  lastActive: string | null;
  typing: boolean;
  totals: Totals | null;
}
interface Session {
  id: string;
  path: string;
  startedAt: string;
  endedAt: string;
  inserted: number;
  deleted: number;
  wsInserted: number;
  wsDeleted: number;
  edits: number;
  lineMin: number | null;
  lineMax: number | null;
  open: boolean;
}
interface Detail {
  id: string;
  sessions: Session[];
  files: { path: string; inserted: number; deleted: number; wsInserted: number; wsDeleted: number; sessions: number; lastAt: string }[];
  surviving: { path: string; exists: boolean; lines: number[]; shared: number[] }[];
  now: { path: string; at: string } | null;
}
interface DiffLine {
  kind: "context" | "add" | "del" | "hunk";
  text: string;
  oldLine?: number;
  newLine?: number;
}

const STATUS_LABEL: Record<Person["status"], string> = { active: "active", idle: "idle", away: "away", online: "online, no file open", offline: "offline" };
const statusDot = (s: Person["status"]) => (s === "active" ? "bg-ok" : s === "idle" || s === "online" ? "bg-warn" : "bg-faint");
/** Consecutive line numbers as ranges: 3,4,5,9 -> "3-5, 9". */
function ranges(lines: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[j]! + 1) j++;
    out.push(i === j ? `${lines[i]}` : `${lines[i]}-${lines[j]}`);
    i = j;
  }
  return out.join(", ");
}

/**
 * People and their contributions. Live presence comes from the server's presence feed; history and surviving lines
 * come from the attribution API, which reads the collaboration log and the live documents (see docs/15).
 */
export function PeopleView({ me, members, presence, tick, following, onOpen, onJump, onFollow, onInvite, notify }: {
  me: Member;
  members: Member[];
  presence: Presence;
  tick: number;
  following: string | null;
  onOpen: (path: string, line?: number) => void;
  onJump: (memberId: string) => void;
  onFollow: (memberId: string | null) => void;
  onInvite: () => void;
  notify: (m: string, t?: "ok" | "danger") => void;
}) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const load = useCallback(() => void api<{ people: Person[] }>("GET", "/people").then((r) => setPeople(r.people), () => setPeople([])), []);
  useEffect(load, [load, tick, presence.participants.length, presence.online.length]);
  // Presence changes many times a second while people type; merge it locally instead of refetching.
  const live = useMemo(() => new Map(presence.participants.map((p) => [p.memberId, p])), [presence]);
  const withLive = (p: Person): Person => {
    const l = live.get(p.id);
    if (!l) return { ...p, status: presence.online.includes(p.id) ? (p.status === "offline" ? "online" : p.status) : p.kind === "agent" ? "offline" : "offline" };
    const idle = Date.now() - l.at;
    return { ...p, path: l.path, typing: l.typing, lastActive: new Date(l.at).toISOString(), status: idle < 60_000 ? "active" : idle < 600_000 ? "idle" : "away" };
  };

  if (selected) {
    const p = people?.find((x) => x.id === selected);
    return <PersonDetail person={p ? withLive(p) : null} id={selected} me={me} tick={tick} following={following} onBack={() => setSelected(null)} onOpen={onOpen} onJump={onJump} onFollow={onFollow} notify={notify} />;
  }
  const humans = (people ?? []).filter((p) => p.kind === "human").map(withLive);
  const agents = (people ?? []).filter((p) => p.kind === "agent");
  humans.sort((a, b) => ["active", "idle", "online", "away", "offline"].indexOf(a.status) - ["active", "idle", "online", "away", "offline"].indexOf(b.status) || a.name.localeCompare(b.name));
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="people-view">
      <ViewHeader
        title="People"
        actions={
          me.role === "owner" && (
            <button aria-label="Invite collaborator" title="Invite collaborator" onClick={onInvite} className="grid size-6 place-items-center rounded-sm text-muted hover:bg-hover hover:text-ink">
              <UserPlus size={13} />
            </button>
          )
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {people === null && <div className="mx-4 my-2 h-24 animate-pulse rounded-sm bg-sunken/50" />}
        <Section title="People" count={humans.length}>
          {humans.map((p) => (
            <div key={p.id} className="group flex items-center gap-2.5 px-4 py-1.5 hover:bg-hover" data-testid={`person-${p.id}`}>
              <button onClick={() => setSelected(p.id)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left" title={`${p.name}: contributions`}>
                <span className="relative shrink-0">
                  <Avatar name={p.name} color={p.color} size={22} />
                  <span className={`absolute -bottom-px -right-px size-2 rounded-full ring-2 ring-sidebar ${statusDot(p.status)}`} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] text-ink">
                    {p.name}
                    {p.id === me.id && <span className="text-faint"> (you)</span>}
                    {following === p.id && <span className="micro ml-1.5 text-accent">following</span>}
                  </span>
                  <span className="block truncate font-mono text-[10.5px] text-faint">
                    {STATUS_LABEL[p.status]}
                    {p.path ? ` · ${p.path}` : ""}
                    {p.typing ? " · typing" : ""}
                    {p.status === "offline" && p.lastActive ? ` · ${timeAgo(p.lastActive)}` : ""}
                  </span>
                </span>
              </button>
              {p.id !== me.id && p.path && (
                <span className="flex shrink-0 gap-0.5 opacity-60 group-hover:opacity-100">
                  <button aria-label={`Go to ${p.name}`} title={`Go to ${p.name}'s cursor`} onClick={() => onJump(p.id)} className="grid size-6 place-items-center rounded-sm text-muted hover:bg-sunken hover:text-ink">
                    <Crosshair size={13} />
                  </button>
                  <button aria-label={following === p.id ? `Stop following ${p.name}` : `Follow ${p.name}`} title={following === p.id ? "Stop following" : `Follow ${p.name}`} onClick={() => onFollow(following === p.id ? null : p.id)} className={`grid size-6 place-items-center rounded-sm hover:bg-sunken ${following === p.id ? "text-accent" : "text-muted hover:text-ink"}`}>
                    {following === p.id ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </span>
              )}
            </div>
          ))}
          {members.length > humans.length && people !== null && <p className="px-4 py-1 text-[11.5px] text-faint">Loading the rest…</p>}
        </Section>
        <Section title="Agents" count={agents.length}>
          {agents.length === 0 && <p className="px-5 py-1 text-[12px] text-muted">No agent has changed shared files yet.</p>}
          {agents.map((a) => (
            <button key={a.id} onClick={() => setSelected(a.id)} className="flex w-full items-center gap-2.5 px-4 py-1.5 text-left hover:bg-hover">
              <span className="grid size-[22px] shrink-0 place-items-center rounded-sm border border-rule-strong text-muted">
                <Bot size={12} />
              </span>
              <span className="min-w-0">
                <span className="block truncate font-mono text-[12px] text-ink">{a.name}</span>
                <span className="block truncate font-mono text-[10.5px] text-faint">
                  agent · {a.totals?.files ?? 0} file{a.totals?.files === 1 ? "" : "s"} · {a.lastActive ? timeAgo(a.lastActive) : ""}
                </span>
              </span>
            </button>
          ))}
        </Section>
      </div>
    </div>
  );
}

function PersonDetail({ person, id, me, tick, following, onBack, onOpen, onJump, onFollow, notify }: {
  person: Person | null;
  id: string;
  me: Member;
  tick: number;
  following: string | null;
  onBack: () => void;
  onOpen: (path: string, line?: number) => void;
  onJump: (memberId: string) => void;
  onFollow: (memberId: string | null) => void;
  notify: (m: string, t?: "ok" | "danger") => void;
}) {
  const [d, setD] = useState<Detail | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ diff: DiffLine[]; concurrent: string[]; available: boolean } | null>(null);
  useEffect(() => void api<Detail>("GET", `/people/${encodeURIComponent(id)}`).then(setD, () => setD(null)), [id, tick]);
  useEffect(() => {
    setDiff(null);
    if (open) void api<{ diff: DiffLine[]; concurrent: string[]; available: boolean }>("GET", `/sessions/${open}/diff`).then(setDiff, () => setDiff({ diff: [], concurrent: [], available: false }));
  }, [open]);
  const totals = d?.files.reduce((a, f) => ({ ins: a.ins + f.inserted, del: a.del + f.deleted, wsIns: a.wsIns + f.wsInserted, wsDel: a.wsDel + f.wsDeleted }), { ins: 0, del: 0, wsIns: 0, wsDel: 0 });
  const surviving = d?.surviving.reduce((a, s) => ({ own: a.own + s.lines.length, shared: a.shared + s.shared.length }), { own: 0, shared: 0 });
  const name = person?.name ?? id;
  const isAgent = id.startsWith("agent:");
  const byFile = new Map<string, Session[]>();
  for (const s of d?.sessions ?? []) byFile.set(s.path, [...(byFile.get(s.path) ?? []), s]);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="person-detail">
      <div className="flex items-center gap-2 border-b border-rule px-3 py-2">
        <button onClick={onBack} aria-label="Back to people" className="grid size-6 place-items-center rounded-sm text-muted hover:bg-hover hover:text-ink">
          <ArrowLeft size={14} />
        </button>
        {person && !isAgent && <Avatar name={person.name} color={person.color} size={22} />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-ink">{name}</span>
          <span className="block truncate font-mono text-[10.5px] text-faint">
            {isAgent ? "agent" : `${person?.role ?? ""} · ${person ? STATUS_LABEL[person.status] : ""}`}
            {person?.path ? ` · ${person.path}` : ""}
          </span>
        </span>
        {person?.path && id !== me.id && (
          <>
            <button onClick={() => onJump(id)} className="h-[22px] shrink-0 rounded-sm border border-rule px-2 text-[11.5px] text-ink-2 hover:bg-hover">
              Go to
            </button>
            <button onClick={() => onFollow(following === id ? null : id)} className={`h-[22px] shrink-0 rounded-sm px-2 text-[11.5px] ${following === id ? "bg-accent text-accent-fg" : "border border-rule text-ink-2 hover:bg-hover"}`}>
              {following === id ? "Stop following" : "Follow"}
            </button>
          </>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!d && <div className="mx-4 my-3 h-32 animate-pulse rounded-sm bg-sunken/50" />}
        {d && (
          <>
            <div className="grid grid-cols-2 gap-px border-b border-rule bg-rule">
              <div className="bg-sidebar px-4 py-2.5">
                <p className="micro text-faint">Historical</p>
                <p className="tnum mt-1 font-mono text-[13px]">
                  <span className="text-ok">+{totals!.ins - totals!.wsIns}</span> <span className="text-danger">−{totals!.del - totals!.wsDel}</span>
                  <span className="text-faint"> chars</span>
                </p>
                <p className="tnum font-mono text-[10.5px] text-faint">
                  +{totals!.wsIns} −{totals!.wsDel} whitespace-only · {d.sessions.length} session{d.sessions.length === 1 ? "" : "s"}
                </p>
              </div>
              <div className="bg-sidebar px-4 py-2.5">
                <p className="micro text-faint">Surviving now</p>
                <p className="tnum mt-1 font-mono text-[13px]">
                  {surviving!.own} <span className="text-faint">lines theirs</span>
                </p>
                <p className="tnum font-mono text-[10.5px] text-faint">{surviving!.shared} shared with others</p>
              </div>
            </div>
            <details className="border-b border-rule px-4 py-2 text-[11.5px] text-muted">
              <summary className="cursor-pointer text-faint">How this is counted</summary>
              <p className="mt-1 leading-snug">
                Historical counts are characters this author inserted and deleted, as their edits arrived; whitespace-only changes are counted apart. Surviving lines come from the current text: a line is theirs only if every non-whitespace character on it is; lines that mix authors are shared. Characters are not effort, and nothing here counts lines they didn&apos;t write.
              </p>
            </details>
            {d.files.length === 0 && <p className="px-4 py-3 text-[12.5px] text-muted">{isAgent ? "This agent hasn't changed any shared file." : `${name} hasn't edited a shared file yet.`}</p>}
            {d.files.map((f) => {
              const sv = d.surviving.find((s) => s.path === f.path);
              return (
                <div key={f.path} className="border-b border-rule px-4 py-2.5">
                  <div className="flex items-baseline gap-2">
                    <button onClick={() => onOpen(f.path)} className="min-w-0 truncate font-mono text-[12px] text-ink hover:text-accent-ink">
                      {f.path}
                    </button>
                    <span className="tnum ml-auto shrink-0 font-mono text-[11px]">
                      <span className="text-ok">+{f.inserted}</span> <span className="text-danger">−{f.deleted}</span>
                    </span>
                  </div>
                  {sv && !sv.exists && <p className="font-mono text-[10.5px] text-faint">file no longer exists</p>}
                  {sv && sv.exists && (sv.lines.length > 0 || sv.shared.length > 0) && (
                    <p className="mt-0.5 font-mono text-[10.5px] text-muted">
                      {sv.lines.length > 0 && (
                        <>
                          theirs: {sv.lines.slice(0, 40).map((n, i) => (
                            <button key={n} onClick={() => onOpen(f.path, n)} className="hover:text-accent-ink" title={`Open ${f.path}:${n}`}>
                              {n}
                              {i < Math.min(sv.lines.length, 40) - 1 ? "," : ""}
                            </button>
                          ))}
                          {sv.lines.length > 40 ? ` … (${ranges(sv.lines)})` : ""}
                        </>
                      )}
                      {sv.shared.length > 0 && <span className="text-faint"> · shared: {ranges(sv.shared)}</span>}
                    </p>
                  )}
                  {sv && sv.exists && sv.lines.length === 0 && sv.shared.length === 0 && <p className="font-mono text-[10.5px] text-faint">none of their lines survive in the current text</p>}
                  <ol className="mt-1.5 space-y-1 border-l border-rule pl-2.5">
                    {(byFile.get(f.path) ?? []).map((s) => (
                      <li key={s.id}>
                        <button onClick={() => setOpen(open === s.id ? null : s.id)} className="flex w-full items-baseline gap-2 text-left hover:text-ink" aria-expanded={open === s.id}>
                          <span className="tnum font-mono text-[10.5px] text-faint">{new Date(s.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                          <span className="tnum font-mono text-[10.5px]">
                            <span className="text-ok">+{s.inserted}</span> <span className="text-danger">−{s.deleted}</span>
                          </span>
                          <span className="font-mono text-[10.5px] text-faint">{s.lineMin ? `L${s.lineMin}${s.lineMax && s.lineMax !== s.lineMin ? `-${s.lineMax}` : ""}` : ""}</span>
                          {s.open && <span className="micro text-accent">editing now</span>}
                        </button>
                        {open === s.id && (
                          <div className="mt-1 overflow-x-auto rounded-sm border border-rule bg-editor" data-testid="session-diff">
                            {!diff && <p className="micro px-2 py-1.5 text-faint">Loading diff</p>}
                            {diff && !diff.available && <p className="px-2 py-1.5 text-[11.5px] text-muted">This revision is older than the retained history.</p>}
                            {diff && diff.available && diff.concurrent.length > 0 && <p className="border-b border-rule bg-warn-soft px-2 py-1 text-[11px] text-warn">Others edited this file during the session; their changes are in this diff too: {diff.concurrent.join(", ")}</p>}
                            {diff?.diff.map((l, i) =>
                              l.kind === "hunk" ? (
                                <div key={i} className="bg-sunken px-2 font-mono text-[10.5px] text-faint">
                                  {l.text}
                                </div>
                              ) : (
                                <button
                                  key={i}
                                  onClick={() => l.newLine && onOpen(f.path, l.newLine)}
                                  className={`flex w-full gap-2 px-2 text-left font-mono text-[11px] leading-[17px] ${l.kind === "add" ? "bg-ok-soft text-ink" : l.kind === "del" ? "bg-danger-soft text-ink-2" : "text-muted"}`}
                                >
                                  <span className="w-7 shrink-0 text-right text-faint">{l.newLine ?? l.oldLine}</span>
                                  <span className="w-2 shrink-0">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
                                  <span className="whitespace-pre">{l.text}</span>
                                </button>
                              ),
                            )}
                          </div>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              );
            })}
            {me.role === "owner" && !isAgent && id !== me.id && (
              <div className="px-4 py-3">
                <RevokeButton id={id} name={name} notify={notify} onDone={onBack} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function RevokeButton({ id, name, notify, onDone }: { id: string; name: string; notify: (m: string, t?: "ok" | "danger") => void; onDone: () => void }) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming)
    return (
      <button onClick={() => setConfirming(true)} className="inline-flex h-[24px] items-center gap-1.5 rounded-sm border border-rule px-2 text-[11.5px] text-danger hover:bg-danger-soft">
        <UserX size={12} /> Remove from project…
      </button>
    );
  return (
    <div className="space-y-1.5 rounded-sm border border-danger/40 bg-danger-soft p-2 text-[12px]">
      <p className="text-ink-2">{name} loses access now: open files, the event feed and terminals close, and old links stop working.</p>
      <div className="flex gap-1.5">
        <button
          onClick={() =>
            void api("POST", `/members/${encodeURIComponent(id)}/revoke`).then(
              () => (notify(`${name} no longer has access.`), onDone()),
              (e) => notify(e instanceof ApiError ? e.message : String(e), "danger"),
            )
          }
          className="h-[22px] rounded-sm bg-danger px-2 text-[11.5px] text-panel"
        >
          Remove {name}
        </button>
        <button onClick={() => setConfirming(false)} className="h-[22px] rounded-sm px-2 text-[11.5px] text-muted hover:bg-hover">
          Cancel
        </button>
      </div>
    </div>
  );
}
