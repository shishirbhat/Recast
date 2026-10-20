"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Check, CircleDot, Play, Plus, X } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { timeAgo } from "../ui";

type Source = { type: string; ref: string; pin?: string };
type SourceStatus = Source & { state: "current" | "changed" | "missing" | "unchecked"; detail?: string };
interface Investigation {
  id: string;
  title: string;
  description: string;
  status: string;
  owner: string;
  revision: string;
  taskId: string | null;
  updatedAt: string;
  entries?: number;
}
interface Entry {
  id: string;
  kind: string;
  body: string;
  status: string | null;
  sources: Source[];
  sourceStatus: SourceStatus[];
  verified: boolean;
  redactions: number;
  revision: string;
  author: string;
  createdAt: string;
}
interface Decision {
  id: string;
  title: string;
  kind: string;
  context: string;
  decision: string;
  alternatives: { option: string; rejectedBecause: string }[];
  scope: string[];
  status: string;
  supersedes: string | null;
  supersededBy: string | null;
  statusReason: string | null;
  createdBy: string;
  decidedBy: string | null;
  sourceStatus: SourceStatus[];
}

const KINDS = ["hypothesis", "experiment", "finding", "assumption", "attempt", "repro", "failing_test", "log", "file", "next_step", "note"];
const parseSources = (s: string): Source[] =>
  s
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((x) => {
      const i = x.indexOf(":");
      const known = ["file", "commit", "test", "evidence", "contract", "decision", "url"];
      const type = i > 0 ? x.slice(0, i) : "";
      return known.includes(type) ? { type, ref: x.slice(i + 1) } : { type: "file", ref: x };
    });

function SourceChips({ list }: { list: SourceStatus[] }) {
  if (!list.length) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {list.map((s, i) => (
        <span key={i} title={s.detail ?? s.state} className={`rounded-sm border px-1 font-mono text-[10.5px] ${s.state === "current" ? "border-rule text-muted" : s.state === "unchecked" ? "border-rule text-faint" : "border-warn/40 bg-warn-soft text-warn"}`}>
          {s.type}:{s.ref}
          {s.state === "changed" || s.state === "missing" ? ` · ${s.state}` : ""}
        </span>
      ))}
    </span>
  );
}

/** Investigations and decision records, shared by everyone in the project. Every claim shows its sources and their freshness. */
export function RecordsPanel({ tick, role, notify }: { tick: number; role: string; notify: (m: string, t?: "ok" | "danger") => void }) {
  const [view, setView] = useState<"investigations" | "decisions">("investigations");
  const [list, setList] = useState<Investigation[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const canEdit = role !== "viewer";
  const fail = (e: unknown) => notify(e instanceof ApiError ? e.message : String(e), "danger");
  const load = useCallback(() => {
    void api<{ investigations: Investigation[] }>("GET", "/investigations").then((r) => setList(r.investigations), () => {});
    void api<{ decisions: Decision[] }>("GET", "/decisions").then((r) => setDecisions(r.decisions), () => {});
  }, []);
  useEffect(load, [load, tick]);

  if (open) return <InvestigationView id={open} tick={tick} role={role} onBack={() => (setOpen(null), load())} fail={fail} />;
  return (
    <div className="flex h-full flex-col" data-testid="records-panel">
      <div className="flex items-center gap-1 px-3 py-2">
        {(["investigations", "decisions"] as const).map((v) => (
          <button key={v} onClick={() => setView(v)} className={`h-[22px] rounded-sm px-2 text-[12px] capitalize ${view === v ? "bg-hover text-ink" : "text-muted hover:text-ink"}`}>
            {v}
          </button>
        ))}
        {canEdit && view === "investigations" && (
          <button onClick={() => setCreating((c) => !c)} aria-label="New investigation" title="New investigation" className="ml-auto grid size-6 place-items-center rounded-sm text-muted hover:bg-hover hover:text-ink">
            <Plus size={14} />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {view === "investigations" && (
          <>
            {creating && <NewInvestigation onDone={(id) => (setCreating(false), id && setOpen(id), load())} fail={fail} />}
            {list.length === 0 && !creating && <p className="px-4 py-2 text-[12.5px] text-muted">No investigations. Start one when a bug needs more than one person or session.</p>}
            {list.map((i) => (
              <button key={i.id} onClick={() => setOpen(i.id)} data-testid={`investigation-${i.id}`} className="block w-full border-b border-rule px-4 py-2 text-left hover:bg-hover">
                <span className="flex items-center gap-2">
                  <span className={`size-1.5 rounded-full ${i.status === "open" ? "bg-accent" : "bg-ok"}`} />
                  <span className="truncate text-[13px] text-ink">{i.title}</span>
                </span>
                <span className="mt-0.5 block font-mono text-[10.5px] text-faint">
                  {i.id} · {i.status} · {i.owner} · @{i.revision} · {i.entries ?? 0} entries · {timeAgo(i.updatedAt)}
                </span>
              </button>
            ))}
          </>
        )}
        {view === "decisions" && (
          <>
            {decisions.length === 0 && <p className="px-4 py-2 text-[12.5px] text-muted">No decision records yet. Propose one with POST /api/decisions or `relay decision`; owners accept them.</p>}
            {decisions.map((d) => (
              <div key={d.id} className={`border-b border-rule px-4 py-2 ${d.status === "superseded" || d.status === "invalidated" || d.status === "rejected" ? "opacity-60" : ""}`}>
                <div className="flex items-center gap-2">
                  <span className="micro text-faint">{d.kind}</span>
                  <span className="truncate text-[13px] text-ink">{d.title}</span>
                  <span className={`micro ml-auto shrink-0 ${d.status === "accepted" ? "text-ok" : d.status === "proposed" ? "text-accent" : "text-faint"}`}>{d.status}</span>
                </div>
                <p className="mt-1 text-[12.5px] leading-snug text-ink-2">{d.decision}</p>
                {d.alternatives.map((a, k) => (
                  <p key={k} className="text-[11.5px] text-muted">
                    Rejected: {a.option}, because {a.rejectedBecause}
                  </p>
                ))}
                <p className="mt-0.5 font-mono text-[10.5px] text-faint">
                  {d.id} · {d.scope.join(", ") || "no scope"}
                  {d.supersededBy ? ` · superseded by ${d.supersededBy}` : ""}
                  {d.statusReason && !d.supersededBy ? ` · ${d.statusReason}` : ""}
                </p>
                <SourceChips list={d.sourceStatus} />
                {role === "owner" && d.status === "proposed" && (
                  <span className="mt-1.5 flex gap-1.5">
                    <button onClick={() => api("POST", `/decisions/${d.id}/accept`).then(load, fail)} className="inline-flex h-[22px] items-center gap-1 rounded-sm bg-accent px-2 text-[11.5px] text-accent-fg hover:brightness-110">
                      <Check size={11} /> Accept
                    </button>
                    <button onClick={() => api("POST", `/decisions/${d.id}/reject`, { reason: "rejected in review" }).then(load, fail)} className="inline-flex h-[22px] items-center gap-1 rounded-sm border border-rule px-2 text-[11.5px] text-ink-2 hover:bg-hover">
                      <X size={11} /> Reject
                    </button>
                  </span>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function NewInvestigation({ onDone, fail }: { onDone: (id: string | null) => void; fail: (e: unknown) => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  return (
    <form
      className="space-y-1.5 border-b border-rule px-4 pb-3"
      onSubmit={(e) => {
        e.preventDefault();
        void api<{ id: string }>("POST", "/investigations", { title, description }).then((r) => onDone(r.id), fail);
      }}
    >
      <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What's wrong?" aria-label="Investigation title" className="h-[26px] w-full rounded-sm border border-rule bg-sunken px-2 text-[12.5px] outline-none focus:border-accent-line" />
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What you see, where, and how to reproduce it" aria-label="Description" rows={3} className="w-full resize-none rounded-sm border border-rule bg-sunken px-2 py-1 text-[12.5px] outline-none focus:border-accent-line" />
      <div className="flex justify-end gap-1.5">
        <button type="button" onClick={() => onDone(null)} className="h-[24px] rounded-sm px-2 text-[12px] text-muted hover:bg-hover">
          Cancel
        </button>
        <button disabled={!title.trim() || !description.trim()} className="h-[24px] rounded-sm bg-accent px-2.5 text-[12px] text-accent-fg disabled:opacity-40">
          Start investigation
        </button>
      </div>
    </form>
  );
}

function InvestigationView({ id, tick, role, onBack, fail }: { id: string; tick: number; role: string; onBack: () => void; fail: (e: unknown) => void }) {
  const [data, setData] = useState<{ investigation: Investigation; entries: Entry[] } | null>(null);
  const [kind, setKind] = useState("hypothesis");
  const [body, setBody] = useState("");
  const [sources, setSources] = useState("");
  const [cmd, setCmd] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => void api<{ investigation: Investigation; entries: Entry[] }>("GET", `/investigations/${id}`).then(setData, fail), [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(load, [load, tick]);
  if (!data) return <p className="micro px-4 py-3 text-faint">Loading</p>;
  const inv = data.investigation;
  const canEdit = role !== "viewer";
  const add = () => {
    setBusy(true);
    void api("POST", `/investigations/${id}/entries`, { kind, body, sources: parseSources(sources) })
      .then(() => (setBody(""), setSources(""), load()), fail)
      .finally(() => setBusy(false));
  };
  return (
    <div className="flex h-full flex-col" data-testid="investigation-view">
      <div className="flex items-center gap-2 border-b border-rule px-3 py-2">
        <button onClick={onBack} aria-label="Back to records" className="grid size-6 place-items-center rounded-sm text-muted hover:bg-hover hover:text-ink">
          <ArrowLeft size={14} />
        </button>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-ink">{inv.title}</span>
          <span className="block font-mono text-[10.5px] text-faint">
            {inv.id} · {inv.status} · owner {inv.owner} · opened @{inv.revision}
          </span>
        </span>
        {canEdit && inv.status === "open" && (
          <button onClick={() => api("POST", `/investigations/${id}`, { status: "resolved" }).then(load, fail)} className="h-[22px] shrink-0 rounded-sm border border-rule px-2 text-[11.5px] text-ink-2 hover:bg-hover">
            Resolve
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        <p className="mb-3 whitespace-pre-wrap text-[12.5px] leading-snug text-ink-2">{inv.description}</p>
        <ol className="space-y-2.5 border-l border-rule pl-3">
          {data.entries.map((e) => (
            <li key={e.id} className="relative">
              <span className={`absolute -left-[16.5px] top-1 size-2 rounded-full ring-2 ring-sidebar ${e.kind === "finding" ? "bg-ok" : e.kind === "command" ? (e.status === "passed" ? "bg-ok" : "bg-danger") : e.kind === "assumption" ? "bg-warn" : "bg-faint"}`} />
              <span className="flex items-center gap-1.5">
                <span className="micro text-muted">{e.kind.replace("_", " ")}</span>
                {e.status && <span className="font-mono text-[10.5px] text-faint">{e.status}</span>}
                <span className={`font-mono text-[10px] ${e.verified ? "text-ok" : "text-faint"}`}>{e.verified ? (e.kind === "command" ? "run by relay" : "sourced") : "unverified"}</span>
                <span className="ml-auto font-mono text-[10px] text-faint">
                  {e.author} · @{e.revision}
                </span>
              </span>
              <p className={`mt-0.5 whitespace-pre-wrap text-[12.5px] leading-snug ${e.kind === "command" ? "max-h-48 overflow-y-auto rounded-sm bg-sunken p-2 font-mono text-[11px] text-ink-2" : "text-ink"}`}>{e.body}</p>
              {e.redactions > 0 && <p className="font-mono text-[10.5px] text-warn">{e.redactions} secret{e.redactions > 1 ? "s" : ""} redacted</p>}
              <SourceChips list={e.sourceStatus} />
            </li>
          ))}
        </ol>
      </div>
      {canEdit && inv.status === "open" && (
        <div className="space-y-1.5 border-t border-rule p-3">
          <div className="flex gap-1.5">
            <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Entry kind" className="h-[26px] rounded-sm border border-rule bg-sunken px-1 text-[12px]">
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k.replace("_", " ")}
                </option>
              ))}
            </select>
            <input value={sources} onChange={(e) => setSources(e.target.value)} placeholder="sources: file:path:line test:path commit:sha evidence:id" aria-label="Sources" className="h-[26px] min-w-0 flex-1 rounded-sm border border-rule bg-sunken px-2 font-mono text-[11px] outline-none focus:border-accent-line" />
          </div>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} placeholder={kind === "finding" ? "A finding must cite a source" : "Add to the investigation"} aria-label="Entry" className="w-full resize-none rounded-sm border border-rule bg-sunken px-2 py-1 text-[12.5px] outline-none focus:border-accent-line" />
          <div className="flex items-center gap-1.5">
            {role === "owner" && (
              <>
                <input value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="run a command, e.g. npm test" aria-label="Command" className="h-[24px] min-w-0 flex-1 rounded-sm border border-rule bg-sunken px-2 font-mono text-[11px] outline-none focus:border-accent-line" />
                <button disabled={!cmd.trim() || busy} onClick={() => (setBusy(true), void api("POST", `/investigations/${id}/run`, { command: cmd }).then(() => (setCmd(""), load()), fail).finally(() => setBusy(false)))} className="inline-flex h-[24px] items-center gap-1 rounded-sm border border-rule px-2 text-[11.5px] text-ink-2 hover:bg-hover disabled:opacity-40">
                  <Play size={11} /> Run
                </button>
              </>
            )}
            <button disabled={!body.trim() || busy} onClick={add} className="ml-auto inline-flex h-[24px] items-center gap-1 rounded-sm bg-accent px-2.5 text-[11.5px] text-accent-fg disabled:opacity-40">
              <CircleDot size={11} /> Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
